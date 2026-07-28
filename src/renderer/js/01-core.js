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
  // Tag names the remote is known to have, or null when we have never asked (see
  // refreshRemoteTags). null and empty mean different things: null suppresses the
  // "unpublished" marker entirely rather than claiming every tag is unpushed.
  remoteTags: null,
  remoteTagsRemote: null,
  selectedCommit: null,
  selectedFile: null,
  selectedFileStaged: false,
  // Which file the diff pane is currently *showing* ("staged:path"/"unstaged:path", or null
  // when it holds the empty state). selectFile uses it to tell a fresh selection from a
  // re-render of the file already on screen — the watcher does the latter on every save,
  // and blanking the pane to a spinner each time reads as a flicker.
  diffRenderedKey: null,
  currentTab: 'graph',
  // Multi-selection state (keyed "staged:path" or "unstaged:path" to handle a path in both lists)
  multiSelected: new Set(),
  lastClickedKey: null,        // Anchor row for shift-click range selection (Windows-style)
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
  graphHideLocal: false,   // when true, don't draw local-branch ref pills in the graph
  graphStripRemotePrefix: false, // when true, show remote branches without their "<remote>/" prefix
  graphHideLocalCommits: false,  // when true, hide commits not reachable from any remote (unpushed)
  collapsedCommits: null,  // Set<hash>: commits whose same-lane descendant chain is folded
  graphFilter: '',         // text filter for the graph tab
  graphFilterMode: 'message', // 'message' | 'files' | 'all'
  historyFilter: '',       // text filter for the history tab
  historyFilterMode: 'message',
  detachedFrom: null,      // branch name we were on before checking out a commit (detached HEAD)
  diffMode: 'unified',     // 'unified' | 'split' — diff display style
  diffIgnoreWhitespace: false, // -w: hide whitespace-only changes (disables partial staging)
  diffSyntax: true,        // syntax-highlight diff content
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

// Pickaxe (diff-content) search results, cached per query. The 'content' filter mode asks
// git which commits changed a given pattern (see repo:searchDiffContent); we cache the
// resulting hash set per query so the render functions can stay synchronous. The cache is
// cleared on refreshAll() since new commits can change the answer.
const _contentMatchCache = new Map();   // trimmed query -> Set<hash>
const _contentMatchLoading = new Map(); // trimmed query -> Promise<Set<hash>>

// The diff-content search that is currently in flight. The main process streams matches on
// the `search:progress` channel as git finds them; applyContentSearchProgress (below) folds
// those into `set` and repaints the active view so results appear progressively instead of
// all-at-once when the (potentially slow) search finishes.
let _activeContentSearch = null; // { query, set }

// Ensure the diff-content match set for `query` is loaded and cached. Callers must await
// this before rendering a 'content'-mode filter, otherwise commitMatchesFilter sees no set
// and filters everything out. Concurrent callers for the same query share one request.
//
// The search is streamed and cancellable in the main process: starting a new query kills the
// git process for the previous one, and a hard timeout there caps the wait. A result flagged
// `cancelled` is partial and NOT cached (so retyping that query re-runs a full search); a
// `timedOut` result is cached but the user is warned it may be incomplete.
async function ensureContentMatches(query) {
  const q = (query || '').trim();
  if (!q) return new Set();
  if (_contentMatchCache.has(q)) return _contentMatchCache.get(q);
  if (_contentMatchLoading.has(q)) return _contentMatchLoading.get(q);
  const p = (async () => {
    // Share one Set with the streaming handler so partial matches land here as they arrive.
    const set = new Set();
    _activeContentSearch = { query: q, set };
    setContentSearchBusy(true);
    let cancelled = false, timedOut = false;
    try {
      const r = await gs.searchDiffContent({ query: q, limit: 2000 });
      if (r && r.ok && r.data) {
        (r.data.hashes || []).forEach(h => set.add(h));
        cancelled = !!r.data.cancelled;
        timedOut = !!r.data.timedOut;
      }
    } catch (e) { /* leave partial set on error (e.g. an invalid pattern) */ }
    _contentMatchLoading.delete(q);
    // A cancelled search was superseded by a newer query; don't cache its partial result and
    // don't touch UI state — the newer search owns _activeContentSearch and the busy flag now.
    // Evict any partial set the streaming handler may have written so retyping re-runs a full
    // search rather than reusing incomplete results.
    if (cancelled) { _contentMatchCache.delete(q); return set; }
    if (_activeContentSearch && _activeContentSearch.query === q) _activeContentSearch = null;
    setContentSearchBusy(false);
    _contentMatchCache.set(q, set);
    // Keep only the most recent handful of queries.
    while (_contentMatchCache.size > 12) {
      _contentMatchCache.delete(_contentMatchCache.keys().next().value);
    }
    if (timedOut) {
      showToast(`Diff search timed out — showing ${set.size} match${set.size === 1 ? '' : 'es'} found so far. Narrow the query for complete results.`, 'error', 6000);
    }
    return set;
  })();
  _contentMatchLoading.set(q, p);
  return p;
}

// Fold a streamed batch of pickaxe matches into the in-flight search and repaint the active
// view. Called from the `search:progress` subscription (wired in 07-graph.js init).
function applyContentSearchProgress(payload) {
  if (!payload || !_activeContentSearch) return;
  if (payload.query !== _activeContentSearch.query) return; // stale batch from a previous query
  let added = false;
  for (const h of (payload.hashesDelta || [])) {
    if (!_activeContentSearch.set.has(h)) { _activeContentSearch.set.add(h); added = true; }
  }
  // The live Set isn't in _contentMatchCache yet, but commitMatchesFilter reads the cache by
  // query. Expose the partial set there so a repaint mid-search shows the matches so far.
  if (added) _contentMatchCache.set(payload.query, _activeContentSearch.set);
  if (added) _scheduleContentRepaint();
}

// Coalesce the progressive repaints so a fast stream doesn't relayout the graph per batch.
let _contentRepaintTimer = null;
function _scheduleContentRepaint() {
  if (_contentRepaintTimer) return;
  _contentRepaintTimer = setTimeout(() => {
    _contentRepaintTimer = null;
    const tab = (typeof state !== 'undefined' && state.currentTab) || 'graph';
    if (tab === 'history' && typeof renderHistory === 'function') renderHistory();
    else if (typeof relayoutGraph === 'function') relayoutGraph();
  }, 150);
}

// Abort an in-flight diff-content search — called when the filter box is cleared, Escape is
// pressed, or the filter mode changes away from 'content'. Kills the git process in main so
// it stops churning, and settles the spinner immediately rather than waiting for it to finish.
function cancelContentSearch() {
  if (!_activeContentSearch) return;
  _activeContentSearch = null;
  setContentSearchBusy(false);
  try { if (gs.cancelDiffSearch) gs.cancelDiffSearch(); } catch (e) { /* best effort */ }
}

// Toggle the spinner on whichever filter input is visible while a content search runs.
function setContentSearchBusy(busy) {
  ['#graph-search', '#history-search'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.classList.toggle('searching', !!busy);
  });
}

function clearContentMatchCache() {
  _contentMatchCache.clear();
  _contentMatchLoading.clear();
  _activeContentSearch = null;
  setContentSearchBusy(false);
}

// Local-only (unpushed) commits — the set of hashes reachable from some ref but NOT from any
// remote. Loaded lazily and cached; cleared on refreshAll() since fetch/commit/push change it.
// Used by the graph's "hide local commits" option (see relayoutGraph).
let _localOnlyCommits = null;   // Set<hash>, or null until loaded
let _localOnlyLoading = null;   // Promise<Set<hash>> while loading
async function ensureLocalOnlyCommits() {
  if (_localOnlyCommits) return _localOnlyCommits;
  if (_localOnlyLoading) return _localOnlyLoading;
  _localOnlyLoading = (async () => {
    let set = new Set();
    try {
      const r = await gs.localOnlyCommits();
      if (r && r.ok) set = new Set(r.data || []);
    } catch (e) { /* leave empty on error — show everything rather than hide wrongly */ }
    _localOnlyCommits = set;
    _localOnlyLoading = null;
    return set;
  })();
  return _localOnlyLoading;
}
// Current local-only set for synchronous readers (relayoutGraph). Returns null if not yet loaded.
function localOnlyCommitSet() { return _localOnlyCommits; }
function clearLocalOnlyCommits() { _localOnlyCommits = null; _localOnlyLoading = null; }

// mode: 'message' (default) matches message/author/email/hash; 'files' matches changed
// file paths; 'all' matches either; 'content' matches commits whose diff content changed
// the query (git pickaxe -G, resolved by ensureContentMatches into a hash set).
function commitMatchesFilter(commit, query, mode) {
  if (!query) return true;
  mode = mode || 'message';
  // Diff-content (pickaxe) mode: membership in the precomputed match set for this query.
  if (mode === 'content') {
    const set = _contentMatchCache.get(query.trim());
    return set ? set.has(commit.hash) : false;
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;

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

// Copy text to the clipboard. Prefers Electron's native clipboard (via IPC) because
// navigator.clipboard.writeText is denied when invoked from a context-menu click —
// the document isn't focused at that moment, so Chromium blocks the Async Clipboard
// API. Falls back to the web API if the IPC route is somehow unavailable.
async function copyText(text, successMsg = 'Copied') {
  const value = text == null ? '' : String(text);
  try {
    const r = await gs.copyText(value);
    if (r && r.ok) { if (successMsg) showToast(successMsg, 'success'); return true; }
  } catch (e) { /* fall through to web API */ }
  try {
    await navigator.clipboard.writeText(value);
    if (successMsg) showToast(successMsg, 'success');
    return true;
  } catch (e) {
    showToast('Copy failed: ' + (e.message || e), 'error');
    return false;
  }
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
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      resolve();
    };

    // The deadline runs on a real timer, NOT only inside the rAF loop below. Chromium
    // suspends requestAnimationFrame for a window that is hidden, minimized or fully
    // occluded, so a deadline checked only inside tick() is never reached in those
    // states — the blocking overlay would stay up forever and the app would look frozen
    // to anyone who minimized it while a repo was opening. setTimeout keeps running.
    const hardDeadline = setTimeout(finish, maxWaitMs);

    const tick = (now) => {
      if (settled) return;
      const frameDur = now - lastFrameTs;
      lastFrameTs = now;
      if (frameDur <= SMOOTH_FRAME_MS) smoothInARow++;
      else smoothInARow = 0;

      const elapsed = now - start;
      if (smoothInARow >= NEEDED_SMOOTH_FRAMES) {
        // We have a responsive thread; also yield once via setTimeout(0) so any pending
        // microtasks/promises queued by the last renders run before we hide the overlay.
        setTimeout(finish, 0);
        return;
      }
      if (elapsed >= maxWaitMs) {
        // Safety valve: don't hold the overlay forever on pathological repos.
        finish();
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
