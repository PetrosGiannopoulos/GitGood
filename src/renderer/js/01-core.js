// ============================================
// GITGOOD — Renderer
// ============================================

// Verify the preload bridge loaded. If it didn't, show a clear error.
// Note: window.gs is automatically accessible as the global `gs` in the renderer,
// so we don't need to (and can't) re-declare it with `const`.
if (!window.gs) {
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.getElementById('error-banner');
    const text = document.getElementById('error-text');
    if (banner && text) {
      text.textContent = 'window.gs is undefined — preload script did not load. Check main.js preload path.';
      banner.classList.add('show');
    }
  });
  throw new Error('Preload bridge (window.gs) missing — preload.js failed to load');
}

// App state
const state = {
  repo: null,
  status: null,
  branches: { local: { all: [], current: '' }, remotes: { all: [], branches: {} } },
  log: { all: [] },
  stashes: [],
  remotes: [],
  selectedCommit: null,
  selectedFile: null,
  selectedFileStaged: false,
  currentTab: 'graph',
  // Multi-selection state (keyed "staged:path" or "unstaged:path" to handle a path in both lists)
  multiSelected: new Set(),
  lastClickedKey: null,        // For shift-click range selection
  // Cached file lists from the last render — needed for shift-click ranges and bulk actions
  stagedFiles: [],
  unstagedFiles: [],
  // Search filter
  searchQuery: '',
  // Graph state
  graph: { commits: [], head: '', positions: new Map(), edges: [], laneCount: 0 },
  graphLimit: 300,
  selectedGraphHash: null,
  graphLoading: false,
  graphCollapsed: false,   // when true, hide the middle of long history (show newest few)
  collapsedCommits: null,  // Set<hash>: commits whose same-lane descendant chain is folded
  graphFilter: '',         // text filter for the graph tab
  graphFilterMode: 'message', // 'message' | 'files' | 'all'
  historyFilter: '',       // text filter for the history tab
  historyFilterMode: 'message',
  detachedFrom: null,      // branch name we were on before checking out a commit (detached HEAD)
  diffMode: 'unified',     // 'unified' | 'split' — diff display style
  // Branches tab state
  branchesFilter: '',
  checkoutTarget: null,
  mergeTarget: null,
  // Conflict state — populated by refreshStatus
  conflicts: { operation: null, files: [] }
};

// ============================================
// UTILITY
// ============================================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Does a commit match a free-text filter query? Matches against the commit message,
// author name/email, and hash (full or short). Case-insensitive; supports multiple
// space-separated terms (ALL must match somewhere — AND semantics).
// Cache of commit-hash -> [files]. Lazily populated when a file-based filter is used.
let _commitFilesMap = null;
let _commitFilesLoading = null;

async function ensureCommitFilesMap() {
  if (_commitFilesMap) return _commitFilesMap;
  if (_commitFilesLoading) return _commitFilesLoading;
  _commitFilesLoading = (async () => {
    try {
      const r = await gs.commitFiles({ limit: 2000 });
      _commitFilesMap = (r && r.ok) ? r.data : {};
    } catch (e) {
      _commitFilesMap = {};
    }
    _commitFilesLoading = null;
    return _commitFilesMap;
  })();
  return _commitFilesLoading;
}

// mode: 'message' (default) matches message/author/email/hash; 'files' matches changed
// file paths; 'all' matches either. The files map is consulted only for files/all.
function commitMatchesFilter(commit, query, mode) {
  if (!query) return true;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  mode = mode || 'message';

  const msgHay = [
    commit.message,
    commit.author_name,
    commit.author_email,
    commit.hash
  ].filter(Boolean).join(' ').toLowerCase();

  let fileHay = '';
  if (mode === 'files' || mode === 'all') {
    const files = (_commitFilesMap && _commitFilesMap[commit.hash]) || [];
    fileHay = files.join('\n').toLowerCase();
  }

  if (mode === 'message') return terms.every(t => msgHay.includes(t));
  if (mode === 'files')   return terms.every(t => fileHay.includes(t));
  // 'all' — each term may match either the message or the files
  return terms.every(t => msgHay.includes(t) || fileHay.includes(t));
}

function showToast(message, type = 'info', timeout = 3500) {
  const icons = { info: 'ℹ', success: '✓', error: '✗' };
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fadeout');
    setTimeout(() => toast.remove(), 300);
  }, timeout);
}

// ============================================
// STATUS-BAR PROGRESS WIDGET
// ============================================
// A small controller for the bottom-right progress bar (left of the status message).
// It shows during ANY action via withLoading() with an indeterminate animation, and
// is upgraded to a real percentage when git emits transfer progress (op:progress).
const opProgress = {
  _box: null, _label: null, _fill: null, _pct: null, _hideTimer: null,
  // How many overlapping operations are active (so nested withLoading calls don't
  // hide the bar prematurely).
  _active: 0,
  // True once a real percentage has arrived for the current operation, so the
  // indeterminate animation doesn't fight the real value.
  _hasReal: false,

  _els() {
    this._box = document.getElementById('op-progress');
    this._label = document.getElementById('op-progress-label');
    this._fill = document.getElementById('op-progress-fill');
    this._pct = document.getElementById('op-progress-pct');
  },

  // Begin an indeterminate operation with a label.
  begin(label) {
    this._els();
    if (!this._box) return;
    this._active++;
    this._hasReal = false;
    clearTimeout(this._hideTimer);
    this._box.classList.remove('hidden');
    if (this._label) this._label.textContent = (label || 'Working').replace(/\.\.\.$/, '');
    if (this._fill) { this._fill.classList.add('indeterminate'); this._fill.style.width = ''; }
    if (this._pct) this._pct.textContent = '…';
  },

  // Show an indeterminate bar + label WITHOUT changing the active-operation count.
  // Used by streamed progress events (op:progress) that arrive during a withLoading
  // operation, so they don't unbalance begin()/end().
  indeterminate(label) {
    this._els();
    if (!this._box) return;
    if (this._hasReal) return; // a real % already showing; don't downgrade
    clearTimeout(this._hideTimer);
    this._box.classList.remove('hidden');
    if (label && this._label) this._label.textContent = label;
    if (this._fill) { this._fill.classList.add('indeterminate'); this._fill.style.width = ''; }
    if (this._pct) this._pct.textContent = '…';
  },

  // Update with a real percentage (0-100) and optional label.
  setPercent(v, label) {
    this._els();
    if (!this._box) return;
    this._hasReal = true;
    this._box.classList.remove('hidden');
    clearTimeout(this._hideTimer);
    const pct = Math.max(0, Math.min(100, Math.round(v)));
    if (this._fill) { this._fill.classList.remove('indeterminate'); this._fill.style.width = pct + '%'; }
    if (this._pct) this._pct.textContent = pct + '%';
    if (label && this._label) this._label.textContent = label;
  },

  // Finish one operation. When the last active operation ends, show 100% briefly,
  // then hide.
  end(failed) {
    this._els();
    if (!this._box) return;
    this._active = Math.max(0, this._active - 1);
    if (this._active > 0) return; // other operations still running
    if (this._fill) {
      this._fill.classList.remove('indeterminate');
      this._fill.style.width = '100%';
    }
    if (this._pct) this._pct.textContent = failed ? '—' : '100%';
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      if (this._active === 0 && this._box) this._box.classList.add('hidden');
    }, 500);
  }
};

function setStatus(message) {
  const el = document.getElementById('status-message');
  if (el) el.textContent = message;
}

async function withLoading(message, fn) {
  setStatus(message + '...');
  opProgress.begin(message);
  try {
    const result = await fn();
    setStatus('Ready');
    opProgress.end(false);
    return result;
  } catch (err) {
    setStatus('Failed');
    opProgress.end(true);
    throw err;
  }
}

// ============================================
// FULL-SCREEN LOADING OVERLAY
// Blocks all interaction while a repository is opening/loading so the user can't
// click into a half-loaded graph or changes list.
// ============================================
const loadingOverlay = {
  show(title, sub) {
    const el = document.getElementById('loading-overlay');
    if (!el) return;
    el.classList.remove('closing', 'hidden');
    el.setAttribute('aria-hidden', 'false');
    const t = document.getElementById('loading-overlay-title');
    const s = document.getElementById('loading-overlay-sub');
    if (t && title) t.textContent = title;
    if (s) s.textContent = sub || '';
  },
  setSub(sub) {
    const s = document.getElementById('loading-overlay-sub');
    if (s) s.textContent = sub || '';
  },
  hide() {
    const el = document.getElementById('loading-overlay');
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('closing');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(() => { el.classList.add('hidden'); el.classList.remove('closing'); }, 220);
  }
};

// Wait until the main thread has settled and the browser has painted, so the app is
// actually responsive (not just done fetching data). Heavy rendering — especially the
// commit graph DOM — keeps running after data resolves; if we drop the overlay too early
// the window freezes (Windows shows the "not responding" spinner). We wait for a couple
// of animation frames to let any pending rAF renders run and the browser paint, then for
// an idle slice of the main thread, with a hard timeout so we never hang forever.
// Wait until the main thread is genuinely responsive — not just two animation frames.
// Polls frame durations: when several consecutive frames render in under the "smooth"
// threshold, the thread is idle and the UI is ready for input. This covers the case
// where heavy renderers (large graph SVG, history list) continue churning AFTER the
// initial data load resolves, so the overlay shouldn't hide while clicks would queue.
function waitUntilIdle(maxWaitMs = 15000) {
  return new Promise(resolve => {
    const start = performance.now();
    const SMOOTH_FRAME_MS = 32;       // ≤ 2 frames at 60 Hz is considered smooth
    const NEEDED_SMOOTH_FRAMES = 4;   // require 4 consecutive smooth frames
    let smoothInARow = 0;
    let lastFrameTs = performance.now();

    const tick = (now) => {
      const frameDur = now - lastFrameTs;
      lastFrameTs = now;
      if (frameDur <= SMOOTH_FRAME_MS) smoothInARow++;
      else smoothInARow = 0;

      const elapsed = now - start;
      if (smoothInARow >= NEEDED_SMOOTH_FRAMES) {
        // We have a responsive thread; also yield once via setTimeout(0) so any pending
        // microtasks/promises queued by the last renders run before we hide the overlay.
        setTimeout(resolve, 0);
        return;
      }
      if (elapsed >= maxWaitMs) {
        // Safety valve: don't hold the overlay forever on pathological repos.
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// Run an async repo-open routine behind the blocking overlay. Keeps the overlay up until
// the data has loaded AND the UI has finished rendering and the thread is idle, so the
// app is genuinely responsive when the overlay clears. Guaranteed to remove the overlay
// even if loading throws.
async function withRepoOpen(title, fn) {
  loadingOverlay.show(title || 'Summoning the chronicle…', 'Preparing thy realm');
  try {
    const result = await fn();
    loadingOverlay.setSub('Polishing the parapets…');
    await waitUntilIdle();
    return result;
  } finally {
    loadingOverlay.hide();
  }
}

function handleResult(result, successMsg) {
  if (!result) return false;
  if (result.canceled) return false;
  if (!result.ok) {
    showToast(result.error || 'Operation failed', 'error', 5000);
    return false;
  }
  if (successMsg) showToast(successMsg, 'success');
  return true;
}

function relativeTime(date) {
  const d = new Date(date);
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

// ============================================
// MODAL SYSTEM
// ============================================
const modal = {
  show({ title, body, footer }) {
    $('#modal-title').textContent = title || '';
    const bodyEl = $('#modal-body');
    bodyEl.innerHTML = '';
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);

    const footerEl = $('#modal-footer');
    footerEl.innerHTML = '';
    if (footer) {
      (Array.isArray(footer) ? footer : [footer]).forEach(b => footerEl.appendChild(b));
    }

    $('#modal-overlay').classList.remove('hidden');
    const firstInput = bodyEl.querySelector('input, textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
  },
  hide() {
    $('#modal-overlay').classList.add('hidden');
    // If a confirm() is awaiting, resolve it as "cancelled" so callers never hang when
    // the modal is dismissed via Esc or the ✕ button.
    if (this._pendingResolve) {
      const r = this._pendingResolve;
      this._pendingResolve = null;
      r(false);
    }
  },
  _pendingResolve: null,
  confirm({ title, message, danger, confirmText = 'Confirm', cancelText = 'Cancel' }) {
    return new Promise(resolve => {
      // Track so hide() (Esc / ✕) can resolve the promise as cancelled.
      this._pendingResolve = resolve;
      const done = (val) => {
        if (this._pendingResolve) { this._pendingResolve = null; modal.hide(); resolve(val); }
      };

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-medieval';
      cancelBtn.textContent = cancelText;
      cancelBtn.onclick = () => done(false);

      const okBtn = document.createElement('button');
      okBtn.className = 'btn-medieval ' + (danger ? 'danger' : 'primary');
      okBtn.textContent = confirmText;
      okBtn.onclick = () => done(true);

      modal.show({ title, body: `<p class="modal-text" style="white-space:pre-line">${escapeHtml(message)}</p>`, footer: [cancelBtn, okBtn] });
    });
  }
};

$('#modal-close').onclick = () => modal.hide();
// Clicking outside the dialog (on the dimmed backdrop) intentionally does NOT close it,
// to prevent accidental dismissal. Use the ✕ button, a Cancel action, or Esc instead.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    modal.hide();
    hideContextMenu();
  }
});

// ============================================
// CONTEXT MENU
// ============================================
function showContextMenu(items, x, y) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  items.forEach(item => {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'context-sep';
      menu.appendChild(sep);
      return;
    }
    const el = document.createElement('div');
    el.className = 'context-item' + (item.danger ? ' danger' : '');
    el.innerHTML = `<span>${item.icon || ''}</span><span>${escapeHtml(item.label)}</span>`;
    el.onclick = () => {
      hideContextMenu();
      item.action();
    };
    menu.appendChild(el);
  });
  menu.classList.remove('hidden');
  // Position, keeping within viewport
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';
}

function hideContextMenu() {
  $('#context-menu').classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('[data-context]')) hideContextMenu();
});

// ============================================
