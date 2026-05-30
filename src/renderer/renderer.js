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
  historyFilter: '',       // text filter for the history tab
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
function commitMatchesFilter(commit, query) {
  if (!query) return true;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    commit.message,
    commit.author_name,
    commit.author_email,
    commit.hash
  ].filter(Boolean).join(' ').toLowerCase();
  return terms.every(t => haystack.includes(t));
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

// Run an async repo-open routine behind the blocking overlay. Guarantees the overlay
// is removed even if loading throws.
async function withRepoOpen(title, fn) {
  loadingOverlay.show(title || 'Summoning the chronicle…', 'Preparing thy realm');
  try {
    return await fn();
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
  },
  confirm({ title, message, danger, confirmText = 'Confirm' }) {
    return new Promise(resolve => {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-medieval';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => { modal.hide(); resolve(false); };

      const okBtn = document.createElement('button');
      okBtn.className = 'btn-medieval ' + (danger ? 'danger' : 'primary');
      okBtn.textContent = confirmText;
      okBtn.onclick = () => { modal.hide(); resolve(true); };

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
// WELCOME SCREEN
// ============================================
async function showWelcome() {
  $('#welcome-screen').classList.remove('hidden');
  $('#app-screen').classList.add('hidden');
  await loadRecentRepos();
}

async function loadRecentRepos() {
  const result = await gs.getRecentRepos();
  const list = $('#recent-list');
  const panel = $('#welcome-recent');
  list.innerHTML = '';
  if (!result.ok || !result.data || !result.data.length) {
    if (panel) panel.classList.add('is-empty');
    return;
  }
  if (panel) panel.classList.remove('is-empty');
  result.data.forEach(p => {
    const item = document.createElement('button');
    item.className = 'recent-item';
    const parts = p.replace(/\\/g, '/').split('/');
    const name = parts[parts.length - 1];
    item.innerHTML = `
      <div class="recent-name">${escapeHtml(name)}</div>
      <div class="recent-path">${escapeHtml(p)}</div>
    `;
    item.onclick = () => openRepoByPath(p);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        { label: 'Open', icon: '📜', action: () => openRepoByPath(p) },
        { label: 'Copy path', icon: '⎘', action: () => { navigator.clipboard.writeText(p); showToast('Path copied', 'success'); } },
        'sep',
        { label: 'Remove from list', icon: '✗', danger: true, action: () => removeRecentRepo(p) },
        { label: 'Clear all recent', icon: '⌫', danger: true, action: () => clearRecentRepos() }
      ], e.pageX, e.pageY);
    };
    list.appendChild(item);
  });
}

// Remove a single repo from the recent list, then refresh the welcome list.
async function removeRecentRepo(p) {
  const r = await gs.removeRecentRepo(p);
  if (r && r.ok) {
    showToast('Removed from recent', 'success');
    await loadRecentRepos();
  } else {
    showToast((r && r.error) || 'Could not remove', 'error');
  }
}

// Clear the entire recent list (with confirmation).
async function clearRecentRepos() {
  const ok = await modal.confirm({
    title: 'Clear Recent Chronicles',
    message: 'Remove all repositories from the recent list? This does not delete anything on disk.',
    confirmText: 'Clear All',
    cancelText: 'Cancel'
  });
  if (!ok) return;
  const r = await gs.clearRecentRepos();
  if (r && r.ok) {
    showToast('Recent list cleared', 'success');
    await loadRecentRepos();
  }
}

$('#welcome-open').onclick = () => openRepoDialog();
$('#welcome-clone').onclick = () => showCloneDialog();
$('#welcome-init').onclick = () => showInitDialog();
const _sshBtn = $('#welcome-sshkey');
if (_sshBtn) _sshBtn.onclick = () => showSshKeyGenerator();

async function openRepoDialog() {
  const sel = await gs.selectDirectory();
  if (!sel.ok) return;
  await openRepoByPath(sel.data);
}

async function openRepoByPath(p) {
  const result = await withLoading('Opening repository', () => gs.openRepo(p));
  if (!result.ok) {
    showToast(result.error || 'Failed to open repository', 'error', 5000);
    return;
  }
  state.repo = result.data;
  clearCommitCache();
  state.collapsedCommits = null;
  state.graphCollapsed = false;
  state.graphFilter = "";
  state.historyFilter = "";
  state.detachedFrom = null;
  { const gs1 = document.getElementById('graph-search'); if (gs1) gs1.value = '';
    const hs1 = document.getElementById('history-search'); if (hs1) hs1.value = ''; }
  _diskState.loaded = false;
  _diskState.lastData = null;
  clearDiskStale();
  $('#welcome-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  updateRepoInfo();
  // Block interaction behind the overlay until the full initial load completes, so the
  // user can't click into a half-rendered graph or changes list.
  await withRepoOpen(`Opening “${result.data.name}”`, () => refreshAll());
  showToast(`Opened "${result.data.name}"`, 'success');
}

async function showInitDialog() {
  const sel = await gs.selectFolder('Choose a folder for the new repository');
  if (!sel.ok) return;
  const confirmed = await modal.confirm({
    title: 'Initialize Repository',
    message: `Create a new git repository at:\n${sel.data}`,
    confirmText: 'Initialize'
  });
  if (!confirmed) return;
  const result = await withLoading('Initializing repository', () => gs.initRepo(sel.data));
  if (!result.ok) {
    showToast(result.error, 'error', 5000);
    return;
  }
  state.repo = result.data;
  $('#welcome-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  updateRepoInfo();
  await withRepoOpen('Forging repository', () => refreshAll());
  showToast('Repository forged', 'success');
}

// ============================================
// SSH KEY GENERATOR
// ============================================
async function showSshKeyGenerator() {
  // Fetch defaults (username, hostname, ~/.ssh path)
  const idR = await gs.sshDefaultIdentity();
  const ident = (idR && idR.ok) ? idR.data : { username: 'user', hostname: 'host', sshDir: '~/.ssh' };
  const defaultComment = `${ident.username}@${ident.hostname}`;

  // Track latest generated key in closure
  let lastKey = null;
  let showingPrivate = false;

  const body = document.createElement('div');
  body.className = 'ssh-key-gen';
  body.innerHTML = `
    <div class="skg-grid">
      <div class="skg-field">
        <label>Key Type</label>
        <div class="skg-segmented" id="skg-type">
          <button type="button" class="skg-seg active" data-value="ed25519">Ed25519</button>
          <button type="button" class="skg-seg" data-value="rsa">RSA</button>
          <button type="button" class="skg-seg" data-value="ecdsa">ECDSA</button>
        </div>
        <div class="skg-hint" id="skg-type-hint">Modern, fast, recommended default.</div>
      </div>

      <div class="skg-field" id="skg-bits-field" style="display:none">
        <label>RSA Bits</label>
        <div class="skg-segmented" id="skg-bits">
          <button type="button" class="skg-seg" data-value="2048">2048</button>
          <button type="button" class="skg-seg active" data-value="3072">3072</button>
          <button type="button" class="skg-seg" data-value="4096">4096</button>
        </div>
      </div>

      <div class="skg-field" id="skg-curve-field" style="display:none">
        <label>ECDSA Curve</label>
        <div class="skg-segmented" id="skg-curve">
          <button type="button" class="skg-seg active" data-value="P-256">P-256</button>
          <button type="button" class="skg-seg" data-value="P-384">P-384</button>
          <button type="button" class="skg-seg" data-value="P-521">P-521</button>
        </div>
      </div>

      <div class="skg-field">
        <label>Comment (label for the key)</label>
        <input class="modal-input" id="skg-comment" value="${escapeHtml(defaultComment)}" placeholder="user@host" />
      </div>

      <div class="skg-field">
        <label>Passphrase (optional, encrypts the private key)</label>
        <input class="modal-input" type="password" id="skg-pass" placeholder="Leave empty for no passphrase" />
      </div>
      <div class="skg-field" id="skg-pass2-field" style="display:none">
        <label>Confirm Passphrase</label>
        <input class="modal-input" type="password" id="skg-pass2" />
      </div>
    </div>

    <div class="skg-entropy">
      <div class="skg-entropy-label">⚜ Entropy of the Realm</div>
      <div class="skg-entropy-bar"><div class="skg-entropy-fill" id="skg-entropy-fill"></div></div>
      <div class="skg-entropy-hint" id="skg-entropy-hint">Move thy mouse to gather entropy (optional flair — the keys use OS cryptographic randomness regardless).</div>
    </div>

    <div class="skg-actions-row">
      <button class="btn-medieval primary" id="skg-roll" type="button">
        <span class="btn-icon">⚷</span> <span id="skg-roll-text">Forge Key</span>
      </button>
      <button class="btn-medieval" id="skg-reroll" type="button" style="display:none">
        <span class="btn-icon">⟳</span> Re-roll
      </button>
    </div>

    <div class="skg-output" id="skg-output" style="display:none">
      <div class="skg-out-section">
        <div class="skg-out-header">
          <span>⚜ Public Key</span>
          <span class="skg-fp" id="skg-fp"></span>
        </div>
        <textarea class="skg-textarea" id="skg-public" readonly></textarea>
        <div class="skg-out-actions">
          <button class="mini-btn" id="skg-copy-pub" type="button">⎘ Copy</button>
          <button class="mini-btn" id="skg-save-pub" type="button">⌬ Save .pub File</button>
        </div>
      </div>

      <div class="skg-out-section">
        <div class="skg-out-header">
          <span>⚷ Private Key</span>
          <button class="mini-btn" id="skg-toggle-priv" type="button">👁 Show</button>
        </div>
        <textarea class="skg-textarea private" id="skg-private" readonly></textarea>
        <div class="skg-out-actions">
          <button class="mini-btn" id="skg-copy-priv" type="button">⎘ Copy</button>
          <button class="mini-btn" id="skg-save-priv" type="button">⌬ Save Private Key</button>
        </div>
        <div class="skg-warn">
          <strong>⚠ Keep the private key secret.</strong> Never share it, never commit it to a repository. Save it to <code>${escapeHtml(ident.sshDir)}</code> with restricted permissions.
        </div>
      </div>
    </div>
  `;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-medieval';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => modal.hide();

  modal.show({ title: '⚷ SSH Key Generator', body, footer: [closeBtn] });

  // ------------------- Wiring -------------------

  // Segmented control: type
  let selectedType = 'ed25519';
  let selectedBits = 3072;
  let selectedCurve = 'P-256';

  const typeHints = {
    'ed25519': 'Modern, fast, recommended default.',
    'rsa': 'Classic, widely compatible. Use 3072 bits or higher.',
    'ecdsa': 'Elliptic curve. Smaller and faster than RSA at equivalent security.'
  };

  body.querySelectorAll('#skg-type .skg-seg').forEach(btn => {
    btn.onclick = () => {
      selectedType = btn.dataset.value;
      body.querySelectorAll('#skg-type .skg-seg').forEach(b => b.classList.toggle('active', b === btn));
      $('#skg-bits-field').style.display = selectedType === 'rsa' ? '' : 'none';
      $('#skg-curve-field').style.display = selectedType === 'ecdsa' ? '' : 'none';
      $('#skg-type-hint').textContent = typeHints[selectedType] || '';
    };
  });
  body.querySelectorAll('#skg-bits .skg-seg').forEach(btn => {
    btn.onclick = () => {
      selectedBits = parseInt(btn.dataset.value, 10);
      body.querySelectorAll('#skg-bits .skg-seg').forEach(b => b.classList.toggle('active', b === btn));
    };
  });
  body.querySelectorAll('#skg-curve .skg-seg').forEach(btn => {
    btn.onclick = () => {
      selectedCurve = btn.dataset.value;
      body.querySelectorAll('#skg-curve .skg-seg').forEach(b => b.classList.toggle('active', b === btn));
    };
  });

  // Passphrase: show confirm field when first field has content
  const passInput = $('#skg-pass');
  passInput.addEventListener('input', () => {
    $('#skg-pass2-field').style.display = passInput.value ? '' : 'none';
  });

  // Entropy bar: mouse movement adds to it. Caps at 100%.
  // (Purely visual — generation uses OS RNG.)
  const fill = $('#skg-entropy-fill');
  const hint = $('#skg-entropy-hint');
  let entropy = 0;
  let lastEnt = { x: 0, y: 0, t: 0 };
  const onMouseMove = (e) => {
    const now = Date.now();
    if (now - lastEnt.t < 30) return;
    const dx = Math.abs(e.clientX - lastEnt.x);
    const dy = Math.abs(e.clientY - lastEnt.y);
    const delta = Math.min(2, Math.sqrt(dx * dx + dy * dy) / 50);
    entropy = Math.min(100, entropy + delta);
    fill.style.width = entropy.toFixed(1) + '%';
    if (entropy >= 100) hint.textContent = '⚔ Entropy full — go forth and forge.';
    lastEnt = { x: e.clientX, y: e.clientY, t: now };
  };
  body.addEventListener('mousemove', onMouseMove);

  // -------- Generation --------
  async function generate() {
    const pass = passInput.value;
    const pass2 = $('#skg-pass2').value;
    if (pass && pass !== pass2) {
      showToast('Passphrases do not match', 'error');
      return;
    }

    const opts = {
      type: selectedType,
      comment: $('#skg-comment').value.trim(),
      passphrase: pass || undefined
    };
    if (selectedType === 'rsa') opts.bits = selectedBits;
    if (selectedType === 'ecdsa') opts.curve = selectedCurve;

    const rollBtn = $('#skg-roll');
    const rerollBtn = $('#skg-reroll');
    rollBtn.disabled = true;
    rerollBtn.disabled = true;
    $('#skg-roll-text').textContent = 'Forging…';

    try {
      const r = await gs.sshGenerateKey(opts);
      if (!r.ok) {
        showToast('Forging failed: ' + r.error, 'error', 6000);
        return;
      }
      lastKey = r.data;
      // Populate output
      $('#skg-output').style.display = 'block';
      $('#skg-public').value = lastKey.publicLine;
      // Always start with private key masked
      showingPrivate = false;
      const privEl = $('#skg-private');
      privEl.value = '••••• Private key generated. Click "Show" to reveal. •••••';
      privEl.classList.add('masked');
      $('#skg-toggle-priv').textContent = '👁 Show';
      $('#skg-fp').textContent = lastKey.fingerprint;
      // Update reroll visibility
      rerollBtn.style.display = '';
      $('#skg-roll-text').textContent = 'Forge Key';
      // Scroll the output into view
      $('#skg-output').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      showToast(`Forged ${selectedType} key`, 'success');
    } catch (err) {
      showToast('Forging failed: ' + (err.message || err), 'error', 6000);
    } finally {
      rollBtn.disabled = false;
      rerollBtn.disabled = false;
    }
  }

  $('#skg-roll').onclick = generate;
  $('#skg-reroll').onclick = generate;

  // Show / hide private key
  $('#skg-toggle-priv').onclick = () => {
    if (!lastKey) return;
    showingPrivate = !showingPrivate;
    const privEl = $('#skg-private');
    if (showingPrivate) {
      privEl.value = lastKey.privatePem;
      privEl.classList.remove('masked');
      $('#skg-toggle-priv').textContent = '👁 Hide';
    } else {
      privEl.value = '••••• Private key hidden. Click "Show" to reveal. •••••';
      privEl.classList.add('masked');
      $('#skg-toggle-priv').textContent = '👁 Show';
    }
  };

  // Copy buttons
  $('#skg-copy-pub').onclick = async () => {
    if (!lastKey) return;
    try {
      await navigator.clipboard.writeText(lastKey.publicLine);
      showToast('Public key copied', 'success');
    } catch (e) {
      showToast('Copy failed', 'error');
    }
  };
  $('#skg-copy-priv').onclick = async () => {
    if (!lastKey) return;
    try {
      await navigator.clipboard.writeText(lastKey.privatePem);
      showToast('Private key copied — handle with care', 'success', 4000);
    } catch (e) {
      showToast('Copy failed', 'error');
    }
  };

  // Save buttons
  $('#skg-save-pub').onclick = async () => {
    if (!lastKey) return;
    const r = await gs.sshSaveKey({
      content: lastKey.publicLine + '\n',
      defaultName: lastKey.suggestedName + '.pub',
      kind: 'public'
    });
    if (!r.ok) { showToast('Save failed: ' + r.error, 'error', 6000); return; }
    if (r.data.saved) showToast('Saved to ' + r.data.filePath, 'success', 5000);
  };
  $('#skg-save-priv').onclick = async () => {
    if (!lastKey) return;
    const r = await gs.sshSaveKey({
      content: lastKey.privatePem.endsWith('\n') ? lastKey.privatePem : lastKey.privatePem + '\n',
      defaultName: lastKey.suggestedName,
      kind: 'private'
    });
    if (!r.ok) { showToast('Save failed: ' + r.error, 'error', 6000); return; }
    if (r.data.saved) showToast('Saved to ' + r.data.filePath, 'success', 5000);
  };
}


function showCloneDialog() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="modal-field">
      <label>Repository URL</label>
      <input class="modal-input" id="clone-url" placeholder="https://github.com/user/repo.git  or  git@github.com:user/repo.git" />
      <div id="clone-url-hint" style="margin-top:6px;font-size:11px;color:var(--muted-text);font-family:var(--font-mono)"></div>
    </div>
    <div class="modal-field">
      <label>Destination Folder (parent)</label>
      <div class="modal-row">
        <input class="modal-input" id="clone-dest" placeholder="Choose parent folder" readonly />
        <button class="btn-medieval" id="clone-browse" style="padding:8px 14px">Browse</button>
      </div>
    </div>
    <div class="modal-field" id="clone-ssh-field" style="display:none">
      <label>SSH Private Key (optional)</label>
      <div class="modal-row">
        <input class="modal-input" id="clone-ssh-key" placeholder="Leave blank to use default key / ssh-agent" />
        <button class="btn-medieval" id="clone-ssh-browse" style="padding:8px 14px">Browse</button>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted-text)">
        Tip: leave empty if you use ssh-agent or have <code>~/.ssh/id_rsa</code> (or <code>id_ed25519</code>) set up.
      </div>
    </div>
    <p class="modal-text text-muted" style="font-size:12px">The repository will be cloned into a sub-folder of the chosen destination.</p>
  `;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const cloneBtn = document.createElement('button');
  cloneBtn.className = 'btn-medieval primary';
  cloneBtn.innerHTML = '<span class="btn-icon">⚔</span> Clone';
  cloneBtn.onclick = async () => {
    const url = $('#clone-url').value.trim();
    const dest = $('#clone-dest').value.trim();
    const sshKeyPath = ($('#clone-ssh-key') && $('#clone-ssh-key').value.trim()) || undefined;
    if (!url) { showToast('URL required', 'error'); return; }
    if (!dest) { showToast('Destination required', 'error'); return; }
    modal.hide();
    const result = await withLoading('Cloning repository', () => gs.cloneRepo({ url, destination: dest, sshKeyPath }));
    if (!result.ok) {
      // Long auth/SSH errors get a modal instead of a toast — much more readable
      const errText = result.error || 'Clone failed';
      if (errText.length > 100 || /SSH|HTTPS|publickey|Authentication/i.test(errText)) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-medieval primary';
        closeBtn.textContent = 'Close';
        closeBtn.onclick = () => modal.hide();
        modal.show({
          title: 'Clone Failed',
          body: `<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;color:var(--text-dim);line-height:1.5;max-height:50vh;overflow:auto">${escapeHtml(errText)}</pre>`,
          footer: closeBtn
        });
      } else {
        showToast(errText, 'error', 8000);
      }
      return;
    }
    state.repo = result.data;
    $('#welcome-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    updateRepoInfo();
    await withRepoOpen(`Opening “${result.data.name}”`, () => refreshAll());
    showToast(`Cloned "${result.data.name}"`, 'success');
  };

  modal.show({ title: 'Clone Repository', body, footer: [cancelBtn, cloneBtn] });

  // Detect URL type as user types, show SSH key field if relevant
  const urlInput = $('#clone-url');
  const sshField = $('#clone-ssh-field');
  const hint = $('#clone-url-hint');
  urlInput.addEventListener('input', () => {
    const v = urlInput.value.trim();
    if (/^(git@|ssh:\/\/)/i.test(v)) {
      sshField.style.display = '';
      hint.textContent = '⚔ SSH URL detected — uses your SSH key';
      hint.style.color = 'var(--crusader-red-bright)';
    } else if (/^https?:\/\//i.test(v)) {
      sshField.style.display = 'none';
      hint.textContent = '⌬ HTTPS URL — for private repos use a Personal Access Token as password';
      hint.style.color = 'var(--muted-text)';
    } else {
      sshField.style.display = 'none';
      hint.textContent = '';
    }
  });

  $('#clone-browse').onclick = async () => {
    const sel = await gs.selectFolder('Choose destination folder');
    if (sel.ok) $('#clone-dest').value = sel.data;
  };

  $('#clone-ssh-browse').onclick = async () => {
    const sel = await gs.selectFile('Select SSH private key');
    if (sel.ok) $('#clone-ssh-key').value = sel.data;
  };
}

// ============================================
// MAIN APP — REFRESH PIPELINE
// ============================================
function updateRepoInfo() {
  if (!state.repo) {
    $('#repo-info').innerHTML = '<span class="repo-label">No realm</span>';
    return;
  }
  $('#repo-info').innerHTML = `
    <span class="repo-name">${escapeHtml(state.repo.name)}</span>
    <span class="repo-path">${escapeHtml(state.repo.path)}</span>
  `;
}

async function refreshAll() {
  // When the loading overlay is up (initial repo open), surface progress as each part
  // finishes. The .then() taps don't change behaviour when the overlay is hidden.
  const overlayUp = () => {
    const el = document.getElementById('loading-overlay');
    return el && !el.classList.contains('hidden');
  };
  const tap = (p, msg) => p.then(r => { if (overlayUp()) loadingOverlay.setSub(msg); return r; });

  await Promise.all([
    tap(refreshStatus(), 'Reading working tree…'),
    tap(refreshBranches(), 'Gathering banners…'),
    tap(refreshLog(), 'Reading the chronicle…'),
    tap(refreshGraph(), 'Drawing the lineage…'),
    tap(refreshStashes(), 'Checking the reserves…'),
    tap(refreshRemotes(), 'Contacting distant realms…')
  ]);
  // NOTE: Disk Management is intentionally NOT recalculated here. Disk scans can be
  // expensive on large repos, so they only run when the user explicitly asks for them
  // (expanding the section the first time, or clicking Refresh). We mark any existing
  // results as potentially stale so the UI can show a subtle "out of date" hint, but
  // we never trigger a scan automatically.
  if (typeof _diskState !== 'undefined' && _diskState.loaded) {
    _diskState.stale = true;
    markDiskStale();
  }
}

async function refreshStatus() {
  const result = await gs.status();
  if (!result.ok) {
    setStatus('Status failed: ' + result.error);
    return;
  }
  state.status = result.data;

  // Detect conflicts and ongoing operations (merge / rebase / cherry-pick / revert)
  try {
    const conflictResult = await gs.conflictState();
    if (conflictResult.ok) {
      state.conflicts = {
        operation: conflictResult.data.operation,
        files: conflictResult.data.conflicts || []
      };
    }
  } catch (e) {
    state.conflicts = { operation: null, files: [] };
  }

  renderConflictBanner();
  renderDetachedBanner();
  renderChanges();
  updateStatusBar();
}

// Show/hide the detached-HEAD banner based on git status. When detached, offers a
// one-click return to the branch we came from (or a generic message if unknown).
function renderDetachedBanner() {
  const banner = document.getElementById('detached-banner');
  if (!banner) return;
  const st = state.status;
  const detached = !!(st && st.detached);
  if (!detached) {
    banner.classList.add('hidden');
    // NOTE: we intentionally do NOT clear state.detachedFrom here. Status refreshes can
    // briefly report a non-detached state mid-checkout, which would wipe the remembered
    // origin before the detached banner ever shows. detachedFrom is only cleared when
    // the user explicitly returns to a branch, or when the repo is switched/closed.
    return;
  }
  banner.classList.remove('hidden');
  const sub = document.getElementById('detached-banner-subtitle');
  const head = (st.headHash) ? st.headHash : '';
  if (sub) {
    sub.textContent = state.detachedFrom
      ? `Viewing commit ${head} — return to “${state.detachedFrom}” when done`
      : `Viewing commit ${head} — not on any branch`;
  }
  const returnBtn = document.getElementById('detached-banner-return');
  if (returnBtn) {
    if (state.detachedFrom) {
      returnBtn.style.display = '';
      returnBtn.innerHTML = `↩ Return to ${escapeHtml(state.detachedFrom)}`;
    } else {
      // No remembered origin (e.g. repo opened already-detached). Fall back to a sensible
      // default branch if one exists so the button is still useful.
      const fallback = guessDefaultBranch();
      if (fallback) {
        returnBtn.style.display = '';
        returnBtn.innerHTML = `↩ Go to ${escapeHtml(fallback)}`;
        returnBtn.dataset.fallback = fallback;
      } else {
        returnBtn.style.display = 'none';
      }
    }
  }
}

// Pick a reasonable default branch to return to when we have no remembered origin.
function guessDefaultBranch() {
  const local = state.branches && state.branches.local;
  const names = (local && local.all) || [];
  for (const pref of ['main', 'master', 'develop', 'devel']) {
    if (names.includes(pref)) return pref;
  }
  return names[0] || null;
}

async function refreshBranches() {
  const result = await gs.branches();
  if (!result.ok) {
    showToast('Failed to load branches: ' + result.error, 'error');
    return;
  }
  state.branches = result.data;
  renderBranches();
  // The detached banner's fallback target depends on the branch list.
  if (typeof renderDetachedBanner === 'function') renderDetachedBanner();
  // Update the branches tab as well, if it's been rendered
  if (typeof renderBranchesTab === 'function') renderBranchesTab();
}

async function refreshLog() {
  const result = await gs.log({ limit: 200 });
  if (!result.ok) {
    // Empty repository — no commits yet — silently leave empty
    state.log = { all: [] };
    renderHistory();
    return;
  }
  state.log = result.data;
  renderHistory();
}

// Number of newest commits to keep visible when the graph is collapsed.
const GRAPH_COLLAPSE_VISIBLE = 5;

async function refreshGraph() {
  state.graphLoading = true;
  const result = await gs.graphLog({ limit: state.graphLimit || 300 });
  state.graphLoading = false;
  if (!result.ok) {
    state.graphAllCommits = [];
    state.graph = { commits: [], head: '', positions: new Map(), edges: [], laneCount: 0 };
    renderGraph();
    return;
  }
  const { commits, head } = result.data;
  state.graphAllCommits = commits;
  state.graphHead = head;
  relayoutGraph();
}

// Build the layout from the current commit list, applying the collapse settings.
// Two independent collapses can apply:
//   1. Global collapse (state.graphCollapsed): only the newest GRAPH_COLLAPSE_VISIBLE
//      commits are shown, the rest summarized by one clickable "hidden" row.
//   2. Per-commit collapse (state.collapsedCommits): clicking a commit's circle folds
//      its same-lane descendant chain (the commits below it on that branch line).
function relayoutGraph() {
  const all = state.graphAllCommits || [];
  const head = state.graphHead || '';
  let commits = all;
  let hiddenCount = 0;

  // 0. Text filter (search bar): keep only commits matching the query. This narrows
  //    the graph to matches; structural lines to filtered-out parents simply fade off.
  const query = (state.graphFilter || '').trim();
  if (query) {
    commits = commits.filter(c => commitMatchesFilter(c, query));
  }

  // 1. Global collapse (only when not filtering — filtering already narrows the view)
  if (!query && state.graphCollapsed && commits.length > GRAPH_COLLAPSE_VISIBLE) {
    hiddenCount = commits.length - GRAPH_COLLAPSE_VISIBLE;
    commits = commits.slice(0, GRAPH_COLLAPSE_VISIBLE);
  }

  // 2. Per-commit collapse: lay out once to learn lanes, then hide same-lane
  //    descendant chains of any collapsed commit, and re-lay-out.
  let perCommitHidden = 0;
  const collapsedSet = state.collapsedCommits;
  if (!query && collapsedSet && collapsedSet.size) {
    const probe = layoutGraph(commits);
    const hide = computeFoldedHashes(commits, probe.positions, collapsedSet);
    if (hide.size) {
      commits = commits.filter(c => !hide.has(c.hash));
      perCommitHidden = hide.size;
    }
  }

  const layout = layoutGraph(commits);
  state.graph = {
    commits, head, hiddenCount,
    perCommitHidden,
    filtered: !!query,
    // expose which collapsed commits are currently active so the renderer can mark them
    collapsedSet: collapsedSet || new Set(),
    ...layout
  };
  renderGraph();

  // Reflect "no matches" on the graph search box
  const searchBox = document.getElementById('graph-search');
  if (searchBox) searchBox.classList.toggle('has-no-matches', !!query && commits.length === 0);
}

// Given the laid-out commits and a set of collapsed commit hashes, return the set of
// hashes that should be HIDDEN. For each collapsed commit we walk its FIRST-PARENT
// chain (the mainline of that branch) and hide each ancestor as long as it stays on
// the same lane. We stop at: a lane change, a merge commit, a commit bearing a ref
// (branch tip / tag), or another collapse anchor — so important markers stay visible.
// Walking the first-parent chain (rather than adjacent rows) makes this work for
// merge commits, whose immediately-following row belongs to the merged-in branch.
function computeFoldedHashes(commits, positions, collapsedSet) {
  const hidden = new Set();
  const byHash = new Map();
  for (const c of commits) byHash.set(c.hash, c);

  for (const anchor of commits) {
    if (!collapsedSet.has(anchor.hash)) continue;
    const startPos = positions.get(anchor.hash);
    if (!startPos) continue;

    // Walk the first-parent chain downward, hiding each ancestor. We rely on row order
    // (parent below child) rather than lanes, which is robust for merge commits that
    // sit on a different lane than their mainline. Stop at structural boundaries so the
    // fold leaves meaningful anchors visible.
    let cur = anchor;
    let guard = 0;
    while (guard++ < commits.length + 1) {
      const fpHash = (cur.parents && cur.parents[0]) ? cur.parents[0] : null;
      if (!fpHash) break;
      const fp = byHash.get(fpHash);
      const fpPos = positions.get(fpHash);
      if (!fp || !fpPos) break;                 // parent not in view — stop (line fades)
      if (fpPos.row <= positions.get(cur.hash).row) break; // not below — stop
      if ((fp.parents || []).length > 1) break; // reached a merge — keep it visible, stop
      if (collapsedSet.has(fpHash)) break;       // another fold anchor — stop
      hidden.add(fpHash);
      cur = fp;
    }
  }
  return hidden;
}

async function refreshStashes() {
  const result = await gs.stashList();
  if (!result.ok) {
    state.stashes = [];
  } else {
    state.stashes = result.data.all || [];
  }
  renderStashes();
}

async function refreshRemotes() {
  const result = await gs.remotes();
  if (!result.ok) {
    state.remotes = [];
  } else {
    state.remotes = result.data || [];
  }
  renderRemotes();
}

// ============================================
// RENDER — SIDEBAR
// ============================================
function renderBranches() {
  const { local, remotes } = state.branches;
  const current = (local && local.current) || '';
  $('#current-branch').textContent = current ? '⑂ ' + current : '— no branch —';

  // Local
  const localList = $('#local-branches');
  localList.innerHTML = '';
  const localBranches = (local && local.all) || [];
  $('#local-count').textContent = localBranches.length;

  if (!localBranches.length) {
    localList.innerHTML = '<li class="sidebar-empty">No local branches</li>';
  } else {
    localBranches.forEach(b => {
      const li = document.createElement('li');
      li.className = 'sidebar-item' + (b === current ? ' active' : '');
      li.textContent = b;
      li.dataset.context = 'branch';
      li.onclick = () => {
        if (b !== current) checkoutBranch(b);
      };
      li.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu([
          { label: 'Checkout', icon: '⑂', action: () => checkoutBranch(b) },
          { label: 'Merge into current', icon: '⚒', action: () => mergeBranch(b) },
          'sep',
          { label: 'Delete branch', icon: '✗', danger: true, action: () => deleteBranch(b, false) },
          { label: 'Force delete', icon: '⚔', danger: true, action: () => deleteBranch(b, true) }
        ], e.pageX, e.pageY);
      };
      localList.appendChild(li);
    });
  }

  // Remote
  const remoteList = $('#remote-branches');
  remoteList.innerHTML = '';
  const remoteBranches = (remotes && remotes.all) || [];
  $('#remote-count').textContent = remoteBranches.length;

  if (!remoteBranches.length) {
    remoteList.innerHTML = '<li class="sidebar-empty">No remote branches</li>';
  } else {
    remoteBranches.forEach(b => {
      const li = document.createElement('li');
      li.className = 'sidebar-item';
      li.textContent = b;
      li.oncontextmenu = (e) => {
        e.preventDefault();
        // Extract local branch name from origin/main
        const localName = b.replace(/^[^/]+\//, '');
        showContextMenu([
          { label: 'Checkout as local', icon: '⑂', action: () => checkoutRemoteBranch(b, localName) }
        ], e.pageX, e.pageY);
      };
      remoteList.appendChild(li);
    });
  }
}

function renderStashes() {
  const list = $('#stash-list');
  list.innerHTML = '';
  $('#stash-count').textContent = state.stashes.length;
  if (!state.stashes.length) {
    list.innerHTML = '<li class="sidebar-empty">No stashes</li>';
    return;
  }
  state.stashes.forEach((stash, arrayIdx) => {
    // Use the stash's true index from the backend; fall back to array position
    const i = (typeof stash.index === 'number') ? stash.index : arrayIdx;
    const li = document.createElement('li');
    li.className = 'sidebar-item stash-item';
    li.textContent = `[${i}] ${stash.message || stash.hash || 'stash'}`;
    li.title = 'Click to browse files in this stash';
    li.onclick = () => showStashBrowser(i);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        { label: 'Browse files…', icon: '⚜', action: () => showStashBrowser(i) },
        'sep',
        { label: 'Apply (keep stash)', icon: '⌥', action: () => stashApply(i) },
        { label: 'Pop (apply & remove)', icon: '⌃', action: () => stashPop(i) },
        'sep',
        { label: 'Drop', icon: '✗', danger: true, action: () => stashDrop(i) }
      ], e.pageX, e.pageY);
    };
    list.appendChild(li);
  });
}

function renderRemotes() {
  const list = $('#remote-list');
  list.innerHTML = '';
  $('#remote-list-count').textContent = state.remotes.length;
  if (!state.remotes.length) {
    list.innerHTML = '<li class="sidebar-empty">No remotes</li>';
    return;
  }
  state.remotes.forEach(r => {
    const li = document.createElement('li');
    li.className = 'sidebar-item remote-item';
    const url = (r.refs && (r.refs.fetch || r.refs.push)) || '';
    li.title = url;
    li.textContent = r.name;
    li.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        { label: 'Copy URL', icon: '⎘', action: () => { navigator.clipboard.writeText(url); showToast('URL copied', 'success'); } },
        { label: 'Open in browser', icon: '↗', action: () => {
          let webUrl = url.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
          gs.openExternal(webUrl);
        }},
        'sep',
        { label: 'Remove remote', icon: '✗', danger: true, action: () => removeRemote(r.name) }
      ], e.pageX, e.pageY);
    };
    list.appendChild(li);
  });
}

// ============================================
// RENDER — HISTORY TAB
// ============================================
function renderHistory() {
  const list = $('#history-list');
  const allCommits = state.log.all || [];
  const query = (state.historyFilter || '').trim();
  const commits = query ? allCommits.filter(c => commitMatchesFilter(c, query)) : allCommits;

  // Reflect "no matches" on the search box
  const searchBox = $('#history-search');
  if (searchBox) searchBox.classList.toggle('has-no-matches', !!query && commits.length === 0);

  if (!allCommits.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📜</div>
        <p>No chronicles yet.<br/>Commit thy first deed.</p>
      </div>
    `;
    renderHistoryDetail(null);
    return;
  }

  if (!commits.length) {
    list.innerHTML = `<div class="filter-empty">No commits match “${escapeHtml(query)}”.</div>`;
    return;
  }

  list.innerHTML = '';
  commits.forEach(c => {
    const row = document.createElement('div');
    row.className = 'commit-row' + (state.selectedCommit && state.selectedCommit.hash === c.hash ? ' selected' : '');
    row.innerHTML = `
      <div class="commit-dot"></div>
      <div class="commit-body">
        <div class="commit-message">${escapeHtml(c.message)}</div>
        <div class="commit-meta">
          <span class="commit-author">${escapeHtml(c.author_name || 'unknown')}</span>
          <span>·</span>
          <span>${relativeTime(c.date)}</span>
        </div>
      </div>
      <div class="commit-hash">${escapeHtml((c.hash || '').slice(0, 7))}</div>
    `;
    row.onclick = (e) => selectCommit(c, e);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        { label: 'Copy hash', icon: '⎘', action: () => { navigator.clipboard.writeText(c.hash); showToast('Hash copied', 'success'); } },
        { label: 'Copy short hash', icon: '⎘', action: () => { navigator.clipboard.writeText(c.hash.slice(0, 7)); showToast('Short hash copied', 'success'); } },
        'sep',
        { label: 'Checkout this commit', icon: '⑂', action: () => checkoutCommit(c.hash) },
        { label: 'Create branch here...', icon: '+', action: () => showCreateBranchDialog(c.hash) }
      ], e.pageX, e.pageY);
    };
    list.appendChild(row);
  });

  if (state.selectedCommit) {
    // Render summary immediately, then fill in the diff (from cache when possible)
    // so the loading spinner gets replaced (refresh would otherwise leave it spinning).
    const sel = state.selectedCommit;
    renderHistoryDetail(sel);
    getCommitDetails(sel.hash).then(data => {
      // Only update if the selection hasn't changed during the fetch
      if (state.selectedCommit && state.selectedCommit.hash === sel.hash) {
        renderHistoryDetail(sel, data);
      }
    }).catch(err => console.error('History refresh: showCommit failed', err));
  }
}

// ============================================
// COMMIT DETAILS CACHE (in-memory LRU)
// ============================================
// Commit diffs are immutable (a commit's content never changes), so we can cache
// them aggressively. This makes re-selecting a commit — or coming back to it after
// an app refresh — instant instead of re-running `git show` each time.
const COMMIT_CACHE_MAX = 100;
const _commitCache = new Map(); // hash -> details ; Map preserves insertion order for LRU

function _commitCacheGet(hash) {
  if (!_commitCache.has(hash)) return null;
  // Touch: move to most-recently-used position
  const v = _commitCache.get(hash);
  _commitCache.delete(hash);
  _commitCache.set(hash, v);
  return v;
}
function _commitCacheSet(hash, details) {
  if (_commitCache.has(hash)) _commitCache.delete(hash);
  _commitCache.set(hash, details);
  // Evict oldest entries beyond the cap
  while (_commitCache.size > COMMIT_CACHE_MAX) {
    const oldest = _commitCache.keys().next().value;
    _commitCache.delete(oldest);
  }
}
// The cache is keyed by commit hash only, but a commit can be shown with different
// byte caps. We always request the same default cap, so this is safe. The cache is
// cleared when switching repositories.
function clearCommitCache() { _commitCache.clear(); }

// Fetch commit details, using the in-memory cache when possible. Returns the same
// shape as gs.showCommit's .data (or throws on error).
async function getCommitDetails(hash) {
  const cached = _commitCacheGet(hash);
  if (cached) return cached;
  const result = await gs.showCommit(hash);
  if (result && result.ok) {
    _commitCacheSet(hash, result.data);
    return result.data;
  }
  throw new Error(result && result.error ? result.error : 'Failed to load commit');
}

async function selectCommit(commit, evt) {
  state.selectedCommit = commit;
  $$('.commit-row').forEach(r => r.classList.remove('selected'));
  if (evt && evt.currentTarget) evt.currentTarget.classList.add('selected');
  renderHistoryDetail(commit);
  // Load full commit details (cached). Skip if user switched commits meanwhile.
  const requestedHash = commit.hash;
  try {
    const data = await getCommitDetails(requestedHash);
    if (state.selectedCommit && state.selectedCommit.hash === requestedHash) {
      renderHistoryDetail(commit, data);
    }
  } catch (err) {
    console.error('selectCommit: showCommit failed', err);
  }
}

function renderHistoryDetail(commit, details) {
  // Remember the diff data (keyed by hash) so the unified/split toggle can re-render
  // without refetching.
  if (details && commit) _historyDetailDiff = { hash: commit.hash, details };
  const panel = $('#history-detail');
  if (!commit) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚜</div>
        <p>Select a commit to inspect its deeds.</p>
      </div>
    `;
    return;
  }
  // Render the commit metadata immediately. Diff goes in a separate paint frame.
  panel.innerHTML = `
    <div class="detail-section">
      <div class="detail-header">⚜ Deed</div>
      <div class="detail-text">${escapeHtml(commit.message)}</div>
      ${commit.body && commit.body !== commit.message ? `<div class="detail-text" style="margin-top:8px;color:var(--text-dim);font-size:13px">${escapeHtml(commit.body)}</div>` : ''}
    </div>
    <div class="detail-section">
      <div class="detail-header">⚔ Author</div>
      <div class="detail-meta">${escapeHtml(commit.author_name || 'unknown')} <span>&lt;${escapeHtml(commit.author_email || '')}&gt;</span></div>
      <div class="detail-meta"><span>${new Date(commit.date).toLocaleString()}</span></div>
    </div>
    <div class="detail-section">
      <div class="detail-header">⚜ Hash</div>
      <div class="detail-meta text-mono" style="word-break:break-all">${escapeHtml(commit.hash)}</div>
    </div>
    <div class="detail-section">
      <div class="detail-header detail-header-row">
        <span>⚒ Changes</span>
        ${diffModeToggleHtml()}
      </div>
      <div class="diff-content" id="hist-diff-content" style="border:1px solid var(--border);max-height:50vh"><div class="empty-state"><span class="loading"></span></div></div>
    </div>
  `;

  if (!details) return;

  // Defer the diff render to a separate animation frame so the metadata paints first,
  // and so a huge diff doesn't freeze the UI before any feedback appears.
  requestAnimationFrame(() => {
    const diffEl = panel.querySelector('#hist-diff-content');
    if (!diffEl) return;
    renderCommitFileBrowser(diffEl, details.diff, {
      hash: commit.hash,
      diffTruncated: details.diffTruncated,
      diffBytes: details.diffBytes
    });
  });
}

// ============================================
// DIFF RENDERING
// ============================================
// Maximum diff lines to render at once. Beyond this we truncate with a notice;
// the user can still see the rest by switching to git CLI or by viewing per-file.
const DIFF_LINE_CAP = 20000;

function renderDiff(diffText, opts) {
  opts = opts || {};
  if (!diffText || !diffText.trim()) {
    return '<div class="empty-state"><p>No differences.</p></div>';
  }
  // Persist the last diff so the view-mode toggle can re-render without refetching.
  _lastDiff = { text: diffText, opts };
  return state.diffMode === 'split'
    ? renderDiffSplit(diffText, opts)
    : renderDiffUnified(diffText, opts);
}

// Remember the most recently rendered diff so toggling unified/split re-renders instantly.
let _lastDiff = null;
// Last commit-detail diff data for the History tab, so the toggle can re-render it.
let _historyDetailDiff = null;

// Returns HTML for a unified/split toggle reflecting the current mode. Used in the
// Changes pane header and the Graph/History commit-detail "Changes" headers. Clicks
// are handled by a single delegated listener (see below).
function diffModeToggleHtml() {
  const u = state.diffMode === 'split' ? '' : ' active';
  const s = state.diffMode === 'split' ? ' active' : '';
  return `<span class="diff-view-toggle">` +
    `<button class="diff-view-btn${u}" data-diffmode="unified" title="Unified view">☰ Unified</button>` +
    `<button class="diff-view-btn${s}" data-diffmode="split" title="Side-by-side view">◫ Split</button>` +
  `</span>`;
}

function renderDiffUnified(diffText, opts) {
  opts = opts || {};
  if (!diffText || !diffText.trim()) {
    return '<div class="empty-state"><p>No differences.</p></div>';
  }
  const allLines = diffText.split('\n');
  const totalLines = allLines.length;
  const cap = opts.lineCap || DIFF_LINE_CAP;
  const truncatedByCap = totalLines > cap;
  const lines = truncatedByCap ? allLines.slice(0, cap) : allLines;

  const out = [];
  let oldLine = 0, newLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Turn the raw "diff --git a/path b/path" into a clean file header, and drop the
    // other git plumbing lines (index, ---, +++, mode/rename/similarity) entirely.
    if (raw.startsWith('diff --git')) {
      const m = raw.match(/ b\/(.+)$/);
      const path = m ? m[1] : raw.replace('diff --git ', '');
      out.push(`<div class="diff-file-header">⚔ ${escapeHtml(path)}</div>`);
      continue;
    }
    if (raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') ||
        raw.startsWith('old mode ') || raw.startsWith('new mode ') ||
        raw.startsWith('deleted file mode ') || raw.startsWith('new file mode ') ||
        raw.startsWith('similarity index ') || raw.startsWith('rename from ') ||
        raw.startsWith('rename to ') || raw.startsWith('copy from ') || raw.startsWith('copy to ')) {
      continue; // drop git plumbing
    }
    if (raw.startsWith('Binary files')) {
      out.push(`<div class="diff-line hunk"><div class="diff-gutter"></div><div class="diff-gutter"></div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (m) { oldLine = parseInt(m[1]); newLine = parseInt(m[2]); }
      out.push(`<div class="diff-line hunk"><div class="diff-gutter"></div><div class="diff-gutter"></div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push(`<div class="diff-line add"><div class="diff-gutter"></div><div class="diff-gutter">${newLine}</div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
      newLine++;
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      out.push(`<div class="diff-line del"><div class="diff-gutter">${oldLine}</div><div class="diff-gutter"></div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
      oldLine++;
      continue;
    }
    if (raw.startsWith('\\')) {
      continue; // "\ No newline at end of file"
    }
    out.push(`<div class="diff-line"><div class="diff-gutter">${oldLine}</div><div class="diff-gutter">${newLine}</div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
    oldLine++; newLine++;
  }

  let html = out.join('');
  const truncated = truncatedByCap || opts.diffTruncated;
  if (truncated) {
    const reason = truncatedByCap
      ? `Showing first ${cap.toLocaleString()} of ${totalLines.toLocaleString()} lines.`
      : `Diff was truncated to ${Math.round((opts.diffBytes || 0) / 1024 / 1024 * 10) / 10} MB.`;
    html += `<div class="diff-line hunk" style="background:rgba(212,48,47,0.12);border-top:2px solid var(--crusader-red);padding:10px;"><div class="diff-gutter"></div><div class="diff-gutter"></div><div class="diff-text" style="white-space:pre-wrap;font-style:italic">⚔ ${escapeHtml(reason)} The diff is too large to render fully.</div></div>`;
  }
  return html;
}

// Side-by-side (split) diff. Parses the unified diff into hunks and pairs deleted lines
// on the left with added lines on the right; context lines appear on both sides.
function renderDiffSplit(diffText, opts) {
  opts = opts || {};
  const allLines = diffText.split('\n');
  const totalLines = allLines.length;
  const cap = opts.lineCap || DIFF_LINE_CAP;
  const truncatedByCap = totalLines > cap;
  const lines = truncatedByCap ? allLines.slice(0, cap) : allLines;

  // A row is { type, leftNum, leftText, rightNum, rightText }
  // type: 'meta' (file/hunk header, spans full width), 'context', 'change'
  const rows = [];
  let oldLine = 0, newLine = 0;

  // Buffer consecutive removals/additions so we can align them side-by-side.
  let pendingDel = [];   // {num, text}
  let pendingAdd = [];   // {num, text}
  const flushPending = () => {
    const n = Math.max(pendingDel.length, pendingAdd.length);
    for (let k = 0; k < n; k++) {
      const d = pendingDel[k];
      const a = pendingAdd[k];
      rows.push({
        type: 'change',
        leftNum: d ? d.num : '',
        leftText: d ? d.text : null,     // null => empty filler cell
        rightNum: a ? a.num : '',
        rightText: a ? a.text : null
      });
    }
    pendingDel = [];
    pendingAdd = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('diff --git')) {
      flushPending();
      const m = raw.match(/ b\/(.+)$/);
      const path = m ? m[1] : raw.replace('diff --git ', '');
      rows.push({ type: 'file', text: path });
      continue;
    }
    if (raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') ||
        raw.startsWith('old mode ') || raw.startsWith('new mode ') ||
        raw.startsWith('deleted file mode ') || raw.startsWith('new file mode ') ||
        raw.startsWith('similarity index ') || raw.startsWith('rename from ') ||
        raw.startsWith('rename to ') || raw.startsWith('copy from ') || raw.startsWith('copy to ')) {
      continue; // drop git plumbing
    }
    if (raw.startsWith('Binary files')) {
      flushPending();
      rows.push({ type: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('@@')) {
      flushPending();
      const m = raw.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (m) { oldLine = parseInt(m[1]); newLine = parseInt(m[2]); }
      rows.push({ type: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      pendingAdd.push({ num: newLine, text: raw.slice(1) });
      newLine++;
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      pendingDel.push({ num: oldLine, text: raw.slice(1) });
      oldLine++;
      continue;
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — attach as meta-ish, skip
      continue;
    }
    // Context line — flush any pending change block first, then add to both sides.
    flushPending();
    const text = raw.startsWith(' ') ? raw.slice(1) : raw;
    rows.push({
      type: 'context',
      leftNum: oldLine, leftText: text,
      rightNum: newLine, rightText: text
    });
    oldLine++; newLine++;
  }
  flushPending();

  const parts = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type === 'file') {
      parts[i] = `<div class="dsplit-row meta"><div class="dsplit-file">⚔ ${escapeHtml(r.text)}</div></div>`;
      continue;
    }
    if (r.type === 'meta') {
      parts[i] = `<div class="dsplit-row meta"><div class="dsplit-meta">${escapeHtml(r.text)}</div></div>`;
      continue;
    }
    const leftCls = r.type === 'change' && r.leftText !== null ? 'del' : (r.leftText === null ? 'empty' : '');
    const rightCls = r.type === 'change' && r.rightText !== null ? 'add' : (r.rightText === null ? 'empty' : '');
    const leftText = r.leftText === null ? '' : escapeHtml(r.leftText);
    const rightText = r.rightText === null ? '' : escapeHtml(r.rightText);
    const leftNum = r.leftText === null ? '' : r.leftNum;
    const rightNum = r.rightText === null ? '' : r.rightNum;
    parts[i] =
      `<div class="dsplit-row">` +
        `<div class="dsplit-side ${leftCls}"><span class="dsplit-num">${leftNum}</span><span class="dsplit-text">${leftText}</span></div>` +
        `<div class="dsplit-side ${rightCls}"><span class="dsplit-num">${rightNum}</span><span class="dsplit-text">${rightText}</span></div>` +
      `</div>`;
  }

  let html = `<div class="dsplit">${parts.join('')}</div>`;
  const truncated = truncatedByCap || opts.diffTruncated;
  if (truncated) {
    const reason = truncatedByCap
      ? `Showing first ${cap.toLocaleString()} of ${totalLines.toLocaleString()} lines.`
      : `Diff was truncated to ${Math.round((opts.diffBytes || 0) / 1024 / 1024 * 10) / 10} MB.`;
    html += `<div class="diff-line hunk" style="background:rgba(212,48,47,0.12);border-top:2px solid var(--crusader-red);padding:10px;"><div class="diff-text" style="white-space:pre-wrap;font-style:italic">⚔ ${escapeHtml(reason)} The diff is too large to render fully.</div></div>`;
  }
  return html;
}

// ============================================
// PER-FILE COMMIT DIFF BROWSER
// Splits a full multi-file unified diff into per-file chunks and shows a file list;
// clicking a file renders only that file's diff (so we don't paint everything at once).
// ============================================

// Split a unified diff into [{path, status, diff}] chunks, one per file.
function splitDiffByFile(diffText) {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  const files = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('diff --git')) {
      if (cur) files.push(cur);
      const m = raw.match(/ b\/(.+)$/);
      const path = m ? m[1] : raw.replace('diff --git ', '');
      cur = { path, status: 'modified', lines: [] };
      continue;
    }
    if (!cur) {
      // Lines before the first "diff --git" (rare) — start an unnamed chunk.
      cur = { path: '(diff)', status: 'modified', lines: [] };
    }
    if (raw.startsWith('new file mode')) cur.status = 'added';
    else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (raw.startsWith('rename from') || raw.startsWith('rename to')) cur.status = 'renamed';
    else if (raw.startsWith('Binary files')) cur.binary = true;
    cur.lines.push(raw);
  }
  if (cur) files.push(cur);
  return files.map(f => ({ path: f.path, status: f.status, binary: !!f.binary, diff: f.lines.join('\n') }));
}

const FILE_STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

// Render a commit's changes as a file list + a single-file diff pane into `panelEl`.
// `opts` carries diffTruncated/diffBytes for the truncation notice, and `opts.hash`
// (the commit) so files can be restored from it.
function renderCommitFileBrowser(panelEl, diffText, opts) {
  opts = opts || {};
  if (!panelEl) return;
  const files = splitDiffByFile(diffText);
  if (!files.length) {
    panelEl.innerHTML = '<div class="empty-state"><p>No differences.</p></div>';
    return;
  }

  const listHtml = files.map((f, idx) =>
    `<div class="cfile-item${idx === 0 ? ' active' : ''}" data-cfile="${idx}" title="${escapeHtml(f.path)}">` +
      `<input type="checkbox" class="cfile-check" data-cfile-check="${idx}" title="Select file">` +
      `<span class="cfile-status ${f.status}">${FILE_STATUS_LETTER[f.status] || 'M'}</span>` +
      `<span class="cfile-path">${escapeHtml(f.path)}</span>` +
    `</div>`
  ).join('');

  panelEl.innerHTML =
    `<div class="cfile-browser">` +
      `<div class="cfile-toolbar">` +
        `<label class="cfile-selall"><input type="checkbox" class="cfile-selall-check"> Select all</label>` +
        `<span class="cfile-selcount" aria-live="polite"></span>` +
        `<button class="cfile-restore-btn" type="button" disabled>↩ Restore selected</button>` +
      `</div>` +
      `<div class="cfile-list">${listHtml}</div>` +
      `<div class="cfile-diff diff-content" id="cfile-diff"></div>` +
    `</div>`;

  const diffEl = panelEl.querySelector('#cfile-diff');
  // Stash state on the panel so the diff-mode toggle can re-render the *current* file
  // in place, preserving the selected file and scroll positions.
  panelEl._cfiles = files;
  panelEl._cfileOpts = opts;
  panelEl._cfileActive = 0;
  panelEl._cfileHash = opts.hash || null;

  const renderOne = (idx) => {
    const f = files[idx];
    if (!f || !diffEl) return;
    panelEl._cfileActive = idx;
    try {
      diffEl.innerHTML = renderDiff(f.diff, opts);
    } catch (err) {
      diffEl.innerHTML = `<div class="empty-state"><p style="color:var(--crusader-red-bright)">⚔ Failed to render diff: ${escapeHtml(err.message || String(err))}</p></div>`;
    }
    diffEl.scrollTop = 0; // new file → start at top
  };

  // --- checkbox / selection plumbing ---
  const list = panelEl.querySelector('.cfile-list');
  const selAll = panelEl.querySelector('.cfile-selall-check');
  const count = panelEl.querySelector('.cfile-selcount');
  const restoreBtn = panelEl.querySelector('.cfile-restore-btn');

  const checkedPaths = () => Array.from(panelEl.querySelectorAll('.cfile-check:checked'))
    .map(cb => files[parseInt(cb.dataset.cfileCheck, 10)]).filter(Boolean).map(f => f.path);

  const syncSelectionUI = () => {
    const checks = Array.from(panelEl.querySelectorAll('.cfile-check'));
    const checkedCount = checks.filter(c => c.checked).length;
    if (count) count.textContent = checkedCount ? `${checkedCount} selected` : '';
    if (restoreBtn) restoreBtn.disabled = checkedCount === 0;
    if (selAll) {
      selAll.checked = checkedCount > 0 && checkedCount === checks.length;
      selAll.indeterminate = checkedCount > 0 && checkedCount < checks.length;
    }
  };

  list.addEventListener('click', (e) => {
    // Clicking the checkbox toggles selection without changing the previewed file.
    if (e.target.closest('.cfile-check')) { syncSelectionUI(); return; }
    const item = e.target.closest('.cfile-item');
    if (!item) return;
    panelEl.querySelectorAll('.cfile-item').forEach(el => el.classList.toggle('active', el === item));
    renderOne(parseInt(item.dataset.cfile, 10));
  });

  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.cfile-item');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = parseInt(item.dataset.cfile, 10);
    const rightClickedPath = files[idx] && files[idx].path;
    // Operate on the checked set if any; otherwise the right-clicked file.
    let targets = checkedPaths();
    if (!targets.length && rightClickedPath) targets = [rightClickedPath];
    showCommitFileContextMenu(panelEl._cfileHash, targets, rightClickedPath, e.pageX, e.pageY);
  });

  if (selAll) selAll.addEventListener('change', () => {
    panelEl.querySelectorAll('.cfile-check').forEach(c => { c.checked = selAll.checked; });
    syncSelectionUI();
  });

  if (restoreBtn) restoreBtn.addEventListener('click', () => {
    const paths = checkedPaths();
    if (paths.length) restoreFilesFromCommit(panelEl._cfileHash, paths);
  });

  // Show the first file by default.
  renderOne(0);
  syncSelectionUI();
}

// Context menu for a file (or selected files) within a commit preview.
function showCommitFileContextMenu(hash, targetPaths, rightClickedPath, x, y) {
  const many = targetPaths.length > 1;
  const label = many ? `Restore ${targetPaths.length} files to working tree`
                      : `Restore “${shortenPath(rightClickedPath || targetPaths[0])}” to working tree`;
  const items = [
    { label, icon: '↩', action: () => restoreFilesFromCommit(hash, targetPaths) },
    'sep',
    { label: 'Copy path' + (many ? 's' : ''), icon: '⎘', action: () => {
        navigator.clipboard.writeText(targetPaths.join('\n'));
        showToast('Path' + (many ? 's' : '') + ' copied', 'success');
      } }
  ];
  showContextMenu(items, x, y);
}

function shortenPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// Restore files from a commit into the current working tree (git checkout <hash> -- paths).
async function restoreFilesFromCommit(hash, paths) {
  if (!hash || !paths || !paths.length) return;
  const many = paths.length > 1;
  const confirmed = await modal.confirm({
    title: many ? `Restore ${paths.length} Files` : 'Restore File',
    message: many
      ? `Overwrite ${paths.length} files in your working tree with their version from commit ${hash.slice(0,7)}? This changes your working files.`
      : `Overwrite “${paths[0]}” in your working tree with its version from commit ${hash.slice(0,7)}? This changes your working file.`,
    confirmText: 'Restore',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;
  const r = await withLoading('Restoring', () => gs.restoreFromCommit(hash, paths));
  if (!r.ok) { showToast(r.error || 'Restore failed', 'error', 6000); return; }
  showToast(many ? `Restored ${paths.length} files` : 'File restored', 'success');
  await refreshAll();
}

// Re-render only the currently-selected file's diff in the active browser(s) — used by
// the unified/split toggle so it doesn't rebuild the whole pane (which would reset the
// selected file and scroll position).
function rerenderActiveCommitFile(panelEl) {
  if (!panelEl || !panelEl._cfiles) return false;
  const diffEl = panelEl.querySelector('#cfile-diff');
  if (!diffEl) return false;
  const f = panelEl._cfiles[panelEl._cfileActive || 0];
  if (!f) return false;
  const prevScroll = diffEl.scrollTop;
  try {
    diffEl.innerHTML = renderDiff(f.diff, panelEl._cfileOpts || {});
  } catch (err) {
    diffEl.innerHTML = `<div class="empty-state"><p style="color:var(--crusader-red-bright)">⚔ ${escapeHtml(err.message || String(err))}</p></div>`;
  }
  diffEl.scrollTop = prevScroll; // keep the diff scroll position across mode switch
  return true;
}
function classifyFile(file) {
  // Returns { status, letter, staged }
  const idx = (file.index || ' ').trim();
  const wt = (file.working_dir || ' ').trim();

  if (file.path && state.status && state.status.not_added && state.status.not_added.includes(file.path)) {
    return { status: 'untracked', letter: 'U', staged: false };
  }
  if (idx === '?' || wt === '?') return { status: 'untracked', letter: 'U', staged: false };

  const map = {
    A: { status: 'added', letter: 'A' },
    M: { status: 'modified', letter: 'M' },
    D: { status: 'deleted', letter: 'D' },
    R: { status: 'renamed', letter: 'R' },
    C: { status: 'renamed', letter: 'C' },
    U: { status: 'conflicted', letter: 'U' }
  };
  if (idx && idx !== ' ' && map[idx]) return { ...map[idx], staged: true };
  if (wt && wt !== ' ' && map[wt]) return { ...map[wt], staged: false };
  return { status: 'modified', letter: '?', staged: false };
}

// ============================================
// CONFLICT BANNER & SECTION RENDERING
// ============================================

// Operation label mapping
const OP_LABELS = {
  merge: 'Merge in Progress',
  rebase: 'Rebase in Progress',
  'cherry-pick': 'Cherry-pick in Progress',
  revert: 'Revert in Progress'
};

function renderConflictBanner() {
  const banner = $('#conflict-banner');
  if (!banner) return;
  const op = state.conflicts && state.conflicts.operation;
  const files = (state.conflicts && state.conflicts.files) || [];

  if (!op && !files.length) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  $('#conflict-banner-title').textContent = op ? (OP_LABELS[op] || `${op} in Progress`) : 'Conflicts';

  const unresolved = files.filter(f => f.hasMarkers || !f.looksResolved);
  // Also count files still appearing as conflicted in status (UU, UD, DU, AA)
  const stillConflicted = files.filter(f => /^[UAD]$/.test(f.indexStatus) || /^[UAD]$/.test(f.workingDir));
  const remaining = stillConflicted.length;

  const subtitle = remaining > 0
    ? `${remaining} file${remaining === 1 ? '' : 's'} still needing resolution`
    : files.length > 0
      ? 'All conflicts resolved — ready to continue'
      : 'No conflicts';

  $('#conflict-banner-subtitle').textContent = subtitle;

  // Continue button is only enabled if no conflicts remain
  const continueBtn = $('#conflict-banner-continue');
  continueBtn.disabled = remaining > 0;
  continueBtn.title = remaining > 0 ? 'Resolve all conflicts first' : 'Continue the ' + op;
}

// Wire up the banner buttons once
(() => {
  const viewBtn = $('#conflict-banner-view');
  if (viewBtn) viewBtn.onclick = () => {
    const files = (state.conflicts && state.conflicts.files) || [];
    // Find the first file that's still in conflict and is resolvable interactively
    const firstText = files.find(f => {
      const conflicted = /^U$/.test(f.indexStatus) || /^U$/.test(f.workingDir);
      return conflicted && !f.isBinary && !f.deletedInOurs && !f.deletedInTheirs;
    });
    if (firstText) {
      openConflictResolver(firstText.path);
      return;
    }
    // No text conflict to resolve — fall back to switching to Changes tab so the user
    // can use Keep File / Delete File / Use Ours / Use Theirs on the non-text conflicts.
    const tab = document.querySelector('.tab[data-tab="changes"]');
    if (tab) tab.click();
    setTimeout(() => {
      const first = document.querySelector('.conflict-file-item');
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  };

  const continueBtn = $('#conflict-banner-continue');
  if (continueBtn) continueBtn.onclick = async () => {
    const op = state.conflicts.operation || 'operation';
    const sure = await modal.confirm({
      title: 'Continue ' + (OP_LABELS[op] || op),
      message: `Continue the ${op}? All marked-resolved files will be used. A new commit will be created (where applicable).`,
      confirmText: 'Continue'
    });
    if (!sure) return;
    const r = await withLoading('Continuing ' + op, () => gs.operationContinue());
    if (handleResult(r, `Continued ${op}`)) await refreshAll();
  };

  const abortBtn = $('#conflict-banner-abort');
  if (abortBtn) abortBtn.onclick = async () => {
    const op = state.conflicts.operation || 'operation';
    const sure = await modal.confirm({
      title: 'Abort ' + (OP_LABELS[op] || op),
      message: `Abort the ${op} and return to the previous state? Any conflict resolution work will be lost.`,
      danger: true,
      confirmText: 'Abort'
    });
    if (!sure) return;
    const r = await withLoading('Aborting ' + op, () => gs.operationAbort());
    if (handleResult(r, `Aborted ${op}`)) await refreshAll();
  };
})();

// ============================================
// CONFLICT FILES SECTION (rendered inside Changes tab)
// ============================================
function renderConflictsSection() {
  try {
    _renderConflictsSection();
  } catch (err) {
    console.error('[GitGood renderConflictsSection ERROR]', err);
    const banner = document.getElementById('error-banner');
    const text = document.getElementById('error-text');
    if (banner && text) {
      text.textContent = 'Conflicts section error: ' + (err.message || err);
      banner.classList.add('show');
    }
  }
}

function _renderConflictsSection() {
  const files = (state.conflicts && state.conflicts.files) || [];
  // Remove any existing section first
  const existing = document.querySelector('.conflicts-section');
  if (existing) existing.remove();

  if (!files.length) return;

  // Filter: files still appearing as conflicted in status (U in either column,
  // or files reported by ls-files --unmerged at all — they are by definition unmerged)
  // We use a permissive filter so that conflicts always surface, even if the status
  // letters are unexpected (e.g. AA, DU, UA).
  const conflictedFiles = files.filter(f =>
    /^[UAD]$/.test(f.indexStatus || '') ||
    /^[UAD]$/.test(f.workingDir || '') ||
    !f.indexStatus || !f.workingDir
  );
  if (!conflictedFiles.length) return;

  // Insert at the top of the changes-files column (before the search wrap area's siblings)
  const stagedList = document.querySelector('#staged-files');
  if (!stagedList) {
    console.warn('[renderConflictsSection] #staged-files not in DOM');
    return;
  }
  const filesCol = stagedList.closest('.changes-files');
  if (!filesCol) {
    console.warn('[renderConflictsSection] .changes-files not in DOM');
    return;
  }

  const section = document.createElement('div');
  section.className = 'conflicts-section';
  section.innerHTML = `
    <div class="conflicts-header">
      <span>⚔ Conflicts (${conflictedFiles.length})</span>
      <button class="conflict-mini-btn" id="conflicts-resolve-all">⚜ Open Resolver</button>
    </div>
    <ul class="conflict-file-list" id="conflict-file-list"></ul>
  `;

  // Insert right after the search wrap and selection bar (i.e., before the first .changes-section)
  const firstChangesSec = filesCol.querySelector('.changes-section');
  if (firstChangesSec) filesCol.insertBefore(section, firstChangesSec);
  else filesCol.appendChild(section);

  const list = section.querySelector('#conflict-file-list');
  conflictedFiles.forEach(f => {
    let kindLabel = 'both modified';
    if (f.deletedInOurs && !f.deletedInTheirs) kindLabel = 'deleted by us · modified by them';
    else if (f.deletedInTheirs && !f.deletedInOurs) kindLabel = 'modified by us · deleted by them';
    else if (!f.base && f.ours && f.theirs) kindLabel = 'both added';
    if (f.isBinary) kindLabel += ' · binary';

    const li = document.createElement('li');
    li.className = 'conflict-file-item';

    // Three action sets depending on conflict kind
    let actionsHtml = '';
    if (f.deletedInOurs || f.deletedInTheirs) {
      actionsHtml = `
        <button class="conflict-mini-btn" data-action="keep" title="Keep the file (whichever side has it)">Keep File</button>
        <button class="conflict-mini-btn" data-action="delete" title="Delete the file">Delete File</button>
      `;
    } else if (f.isBinary) {
      actionsHtml = `
        <button class="conflict-mini-btn" data-action="ours" title="Take our version">Use Ours</button>
        <button class="conflict-mini-btn" data-action="theirs" title="Take their version">Use Theirs</button>
      `;
    } else {
      actionsHtml = `
        <button class="conflict-mini-btn" data-action="ours" title="Replace with our version">Use Ours</button>
        <button class="conflict-mini-btn" data-action="theirs" title="Replace with their version">Use Theirs</button>
        <button class="conflict-mini-btn primary" data-action="resolve" title="Open in three-way resolver">⚜ Resolve…</button>
      `;
    }

    li.innerHTML = `
      <div class="conflict-file-icon">⚔</div>
      <div class="conflict-file-info">
        <div class="conflict-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
        <div class="conflict-file-meta">${escapeHtml(kindLabel)}</div>
      </div>
      <div class="conflict-file-actions">${actionsHtml}</div>
    `;

    li.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'ours' || action === 'theirs') {
          const r = await withLoading(`Resolving with ${action}`, () => gs.conflictResolveSide({ filePath: f.path, side: action }));
          if (handleResult(r, `Resolved with ${action}`)) await refreshAll();
        } else if (action === 'keep') {
          const r = await withLoading('Keeping file', () => gs.conflictKeepFile(f.path));
          if (handleResult(r, 'File kept')) await refreshAll();
        } else if (action === 'delete') {
          const sure = await modal.confirm({
            title: 'Delete File',
            message: `Delete "${f.path}" as part of this conflict resolution? This stages the deletion.`,
            danger: true, confirmText: 'Delete'
          });
          if (!sure) return;
          const r = await withLoading('Deleting file', () => gs.conflictDeleteFile(f.path));
          if (handleResult(r, 'File deleted')) await refreshAll();
        } else if (action === 'resolve') {
          openConflictResolver(f.path);
        }
      };
    });

    // Click on the row itself (not buttons) opens the resolver for text files
    li.onclick = (e) => {
      if (e.target.closest('button')) return;
      if (!f.isBinary && !f.deletedInOurs && !f.deletedInTheirs) {
        openConflictResolver(f.path);
      }
    };

    list.appendChild(li);
  });

  // "Open Resolver" header button — opens first conflicted text file
  const resolveAllBtn = section.querySelector('#conflicts-resolve-all');
  if (resolveAllBtn) resolveAllBtn.onclick = () => {
    const first = conflictedFiles.find(f => !f.isBinary && !f.deletedInOurs && !f.deletedInTheirs);
    if (first) openConflictResolver(first.path);
    else showToast('No text conflicts to resolve interactively', 'info');
  };
}

// ============================================
// CONFLICT RESOLVER MODAL
// ============================================
async function openConflictResolver(filePath) {
  // Fetch parsed hunks and the three versions
  const parsedR = await withLoading('Loading conflict', () => gs.parseConflictFile(filePath));
  if (!parsedR.ok) {
    showToast('Could not parse: ' + parsedR.error, 'error', 6000);
    return;
  }
  const { hunks, eol } = parsedR.data;
  const fileEol = eol || '\n';

  // Per-hunk resolution: index → { type: 'ours' | 'theirs' | 'ours-theirs' | 'theirs-ours' | 'custom', custom: string[] }
  // Initialize: nothing resolved yet
  const resolutions = new Map();

  const body = document.createElement('div');
  body.className = 'conflict-resolver';
  body.innerHTML = `
    <div class="conflict-resolver-toolbar">
      <span class="text-red">⚔</span>
      <span class="text-mono">${escapeHtml(filePath)}</span>
      <span class="conflict-resolver-progress" id="cr-progress"></span>
    </div>
    <div class="conflict-resolver-body" id="cr-body"></div>
  `;

  const bodyEl = body.querySelector('#cr-body');
  const conflictHunkIndices = [];

  hunks.forEach((h, idx) => {
    if (h.type === 'common') {
      const div = document.createElement('div');
      div.className = 'cr-hunk-common';
      div.innerHTML = h.lines.map(l => `<div class="cr-hunk-common-line"><span class="cr-ln"></span><span>${escapeHtml(l) || '&nbsp;'}</span></div>`).join('');
      bodyEl.appendChild(div);
    } else {
      conflictHunkIndices.push(idx);
      const div = document.createElement('div');
      div.className = 'cr-hunk-conflict';
      div.dataset.hunkIdx = idx;
      div.innerHTML = `
        <div class="cr-hunk-actions">
          <span class="cr-label">Conflict #${conflictHunkIndices.length}</span>
          <button class="cr-action" data-pick="ours">Take Ours</button>
          <button class="cr-action" data-pick="theirs">Take Theirs</button>
          <button class="cr-action" data-pick="ours-theirs">Both (Ours, Theirs)</button>
          <button class="cr-action" data-pick="theirs-ours">Both (Theirs, Ours)</button>
          <button class="cr-action" data-pick="custom">✎ Edit</button>
        </div>
        <div class="cr-sides">
          <div class="cr-side ours">
            <div class="cr-side-header">⚔ Ours · ${escapeHtml(h.oursLabel || 'HEAD')}</div>
            ${(h.ours || []).map(l => `<div class="cr-side-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('')}
          </div>
          <div class="cr-side theirs">
            <div class="cr-side-header">⚔ Theirs · ${escapeHtml(h.theirsLabel || 'incoming')}</div>
            ${(h.theirs || []).map(l => `<div class="cr-side-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('')}
          </div>
        </div>
        <div class="cr-resolution" data-resolution style="display:none">
          <div class="cr-resolution-header">✓ Resolution</div>
          <div class="cr-resolution-content"></div>
        </div>
      `;

      div.querySelectorAll('button[data-pick]').forEach(btn => {
        btn.onclick = () => {
          const pick = btn.dataset.pick;
          if (pick === 'custom') {
            // Replace resolution area with a textarea pre-filled with current resolution or ours
            const existing = resolutions.get(idx);
            const initial = existing && existing.custom
              ? existing.custom.join('\n')
              : computeResolutionLines(h, existing ? existing.type : 'ours').join('\n');
            const resArea = div.querySelector('[data-resolution]');
            resArea.style.display = 'block';
            const contentDiv = resArea.querySelector('.cr-resolution-content');
            contentDiv.innerHTML = `<textarea class="cr-editor">${escapeHtml(initial)}</textarea>`;
            const ta = contentDiv.querySelector('textarea');
            ta.focus();
            ta.oninput = () => {
              resolutions.set(idx, { type: 'custom', custom: ta.value.split('\n') });
              renderProgress();
            };
            // Set initial state
            resolutions.set(idx, { type: 'custom', custom: ta.value.split('\n') });
            div.classList.add('resolved');
            // Update button states
            div.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === btn));
          } else {
            resolutions.set(idx, { type: pick });
            div.classList.add('resolved');
            div.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === btn));
            // Show resolution preview
            const resArea = div.querySelector('[data-resolution]');
            resArea.style.display = 'block';
            const contentDiv = resArea.querySelector('.cr-resolution-content');
            const lines = computeResolutionLines(h, pick);
            contentDiv.innerHTML = lines.map(l => `<div class="cr-resolution-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
          }
          renderProgress();
        };
      });

      bodyEl.appendChild(div);
    }
  });

  function computeResolutionLines(hunk, type) {
    if (type === 'ours') return hunk.ours || [];
    if (type === 'theirs') return hunk.theirs || [];
    if (type === 'ours-theirs') return [...(hunk.ours || []), ...(hunk.theirs || [])];
    if (type === 'theirs-ours') return [...(hunk.theirs || []), ...(hunk.ours || [])];
    return [];
  }

  function renderProgress() {
    const total = conflictHunkIndices.length;
    const done = conflictHunkIndices.filter(i => resolutions.has(i)).length;
    const progress = body.querySelector('#cr-progress');
    if (progress) progress.innerHTML = `Resolved <strong>${done}</strong> / ${total} hunks`;
    if (saveBtn) {
      saveBtn.disabled = done < total;
      saveBtn.title = done < total ? `${total - done} hunk(s) remain` : 'Save and mark as resolved';
    }
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const allOursBtn = document.createElement('button');
  allOursBtn.className = 'btn-medieval';
  allOursBtn.textContent = 'All Ours';
  allOursBtn.title = 'Take ours for every remaining conflict';
  allOursBtn.onclick = () => {
    conflictHunkIndices.forEach(i => {
      if (!resolutions.has(i)) {
        resolutions.set(i, { type: 'ours' });
        const hunkDiv = body.querySelector(`[data-hunk-idx="${i}"]`);
        if (hunkDiv) {
          hunkDiv.classList.add('resolved');
          const oursBtn = hunkDiv.querySelector('button[data-pick="ours"]');
          if (oursBtn) {
            hunkDiv.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === oursBtn));
          }
          const resArea = hunkDiv.querySelector('[data-resolution]');
          if (resArea) {
            resArea.style.display = 'block';
            const lines = hunks[i].ours || [];
            resArea.querySelector('.cr-resolution-content').innerHTML = lines.map(l => `<div class="cr-resolution-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
          }
        }
      }
    });
    renderProgress();
  };

  const allTheirsBtn = document.createElement('button');
  allTheirsBtn.className = 'btn-medieval';
  allTheirsBtn.textContent = 'All Theirs';
  allTheirsBtn.onclick = () => {
    conflictHunkIndices.forEach(i => {
      if (!resolutions.has(i)) {
        resolutions.set(i, { type: 'theirs' });
        const hunkDiv = body.querySelector(`[data-hunk-idx="${i}"]`);
        if (hunkDiv) {
          hunkDiv.classList.add('resolved');
          const theirsBtn = hunkDiv.querySelector('button[data-pick="theirs"]');
          if (theirsBtn) {
            hunkDiv.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === theirsBtn));
          }
          const resArea = hunkDiv.querySelector('[data-resolution]');
          if (resArea) {
            resArea.style.display = 'block';
            const lines = hunks[i].theirs || [];
            resArea.querySelector('.cr-resolution-content').innerHTML = lines.map(l => `<div class="cr-resolution-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
          }
        }
      }
    });
    renderProgress();
  };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-medieval primary';
  saveBtn.innerHTML = '<span class="btn-icon">✓</span> Save & Mark Resolved';
  saveBtn.disabled = true;
  saveBtn.onclick = async () => {
    // Build the final file content by walking hunks and substituting resolutions
    const out = [];
    hunks.forEach((h, idx) => {
      if (h.type === 'common') {
        out.push(...h.lines);
      } else {
        const r = resolutions.get(idx);
        if (!r) {
          // Should not happen since save is disabled until all resolved, but be safe
          out.push(`<<<<<<< ${h.oursLabel || 'HEAD'}`);
          out.push(...(h.ours || []));
          out.push('=======');
          out.push(...(h.theirs || []));
          out.push(`>>>>>>> ${h.theirsLabel || 'incoming'}`);
        } else if (r.type === 'custom') {
          out.push(...(r.custom || []));
        } else {
          out.push(...computeResolutionLines(h, r.type));
        }
      }
    });
    const content = out.join(fileEol);
    modal.hide();

    // Write the resolved file, then stage it
    const writeR = await gs.writeFile({ path: filePath, content });
    if (!writeR.ok) { showToast('Write failed: ' + writeR.error, 'error', 6000); return; }
    const markR = await gs.conflictMarkResolved(filePath);
    if (!handleResult(markR, `Resolved: ${filePath}`)) return;
    await refreshAll();
  };

  renderProgress();

  modal.show({
    title: 'Resolve Conflict',
    body,
    footer: [cancelBtn, allOursBtn, allTheirsBtn, saveBtn]
  });
}


// ============================================
// HIDDEN INFO PANEL (empty folders, gitignored files)
// ============================================
// Shown only when there are no actual changes, to explain why "I created a folder
// but nothing showed up" — git can't track empty folders, and .gitignore'd content
// is intentionally hidden.
let hiddenInfoCache = null;
let hiddenInfoCacheTime = 0;
// Per-section collapsed state for the Changes-tab hidden-info panels. Both start
// collapsed; the user can expand by clicking a header. State persists for the session.
const hiddenInfoCollapsed = { empty: true, ignored: true };

async function renderHiddenInfo() {
  const el = $('#hidden-info');
  if (!el) return;

  // Cache for 4 seconds so we don't re-walk the filesystem on every status refresh
  const now = Date.now();
  if (!hiddenInfoCache || now - hiddenInfoCacheTime > 4000) {
    try {
      const r = await gs.inspectHidden();
      hiddenInfoCache = r.ok ? r.data : { emptyFolders: [], ignored: [] };
    } catch (e) {
      hiddenInfoCache = { emptyFolders: [], ignored: [] };
    }
    hiddenInfoCacheTime = now;
  }
  const { emptyFolders = [], ignored = [] } = hiddenInfoCache;

  if (!emptyFolders.length && !ignored.length) {
    el.innerHTML = '';
    return;
  }

  const sections = [];

  if (emptyFolders.length) {
    const rows = emptyFolders.slice(0, 20).map(p => `
      <li class="hidden-info-row" data-path="${escapeHtml(p)}">
        <span class="info-icon">⌬</span>
        <span class="info-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
        <button class="conflict-mini-btn" data-action="gitkeep">+ .gitkeep</button>
      </li>
    `).join('');
    const collapsed = hiddenInfoCollapsed.empty;
    sections.push(`
      <div class="hidden-info-section${collapsed ? ' collapsed' : ''}" data-section="empty">
        <div class="hidden-info-header clickable" data-toggle="empty" role="button" tabindex="0" aria-expanded="${!collapsed}">
          <span class="hidden-info-caret">▸</span>
          <span>⌬ Empty Folders (${emptyFolders.length})</span>
        </div>
        <div class="hidden-info-body">
          <div class="hidden-info-note">
            Git tracks files, not folders. Empty folders are invisible to git. Add a placeholder file (commonly <code>.gitkeep</code>) inside a folder to make git track it.
          </div>
          <ul class="hidden-info-list">${rows}</ul>
          ${emptyFolders.length > 20 ? `<div class="hidden-info-note">…and ${emptyFolders.length - 20} more</div>` : ''}
        </div>
      </div>
    `);
  }

  if (ignored.length) {
    const rows = ignored.slice(0, 20).map(p => `
      <li class="hidden-info-row">
        <span class="info-icon">⌽</span>
        <span class="info-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
      </li>
    `).join('');
    const collapsed = hiddenInfoCollapsed.ignored;
    sections.push(`
      <div class="hidden-info-section${collapsed ? ' collapsed' : ''}" data-section="ignored">
        <div class="hidden-info-header clickable" data-toggle="ignored" role="button" tabindex="0" aria-expanded="${!collapsed}">
          <span class="hidden-info-caret">▸</span>
          <span>⌽ Ignored by .gitignore (${ignored.length})</span>
        </div>
        <div class="hidden-info-body">
          <div class="hidden-info-note">
            These paths match rules in a <code>.gitignore</code> file and won't appear as changes. To track one anyway, edit the rules or use <code>git add -f &lt;path&gt;</code>.
          </div>
          <ul class="hidden-info-list">${rows}</ul>
          ${ignored.length > 20 ? `<div class="hidden-info-note">…and ${ignored.length - 20} more</div>` : ''}
        </div>
      </div>
    `);
  }

  el.innerHTML = sections.join('');

  // Header click/keyboard toggles the section open/closed.
  el.querySelectorAll('.hidden-info-header.clickable').forEach(header => {
    const toggle = () => {
      const key = header.dataset.toggle;
      hiddenInfoCollapsed[key] = !hiddenInfoCollapsed[key];
      const section = header.closest('.hidden-info-section');
      if (section) section.classList.toggle('collapsed', hiddenInfoCollapsed[key]);
      header.setAttribute('aria-expanded', String(!hiddenInfoCollapsed[key]));
    };
    header.onclick = toggle;
    header.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
  });

  // Wire up gitkeep buttons
  el.querySelectorAll('button[data-action="gitkeep"]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const row = btn.closest('.hidden-info-row');
      const folderPath = row && row.dataset.path;
      if (!folderPath) return;
      const r = await gs.addGitkeep(folderPath);
      if (handleResult(r, `Added .gitkeep to "${folderPath}"`)) {
        hiddenInfoCache = null; // invalidate cache so it refreshes
        await refreshStatus();
      }
    };
  });
}


function renderChanges() {
  const status = state.status;
  if (!status) return;

  // Build unique staged and unstaged file lists from status.files
  const stagedMap = new Map();
  const unstagedMap = new Map();

  (status.files || []).forEach(f => {
    const idx = (f.index || ' ');
    const wt = (f.working_dir || ' ');
    if (idx !== ' ' && idx !== '?') {
      stagedMap.set(f.path, { path: f.path, status: classifyByCode(idx) });
    }
    if (wt !== ' ') {
      unstagedMap.set(f.path, { path: f.path, status: wt === '?' ? 'untracked' : classifyByCode(wt) });
    }
  });

  state.stagedFiles = [...stagedMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  state.unstagedFiles = [...unstagedMap.values()].sort((a, b) => a.path.localeCompare(b.path));

  // Filter by search query (case-insensitive substring)
  const q = state.searchQuery.trim().toLowerCase();
  const matches = (f) => !q || f.path.toLowerCase().includes(q);
  const visibleStaged = state.stagedFiles.filter(matches);
  const visibleUnstaged = state.unstagedFiles.filter(matches);

  // Clean up multiSelected: remove keys for files that no longer exist
  const allValidKeys = new Set();
  state.stagedFiles.forEach(f => allValidKeys.add('staged:' + f.path));
  state.unstagedFiles.forEach(f => allValidKeys.add('unstaged:' + f.path));
  for (const key of [...state.multiSelected]) {
    if (!allValidKeys.has(key)) state.multiSelected.delete(key);
  }

  renderFileList($('#staged-files'), visibleStaged, true);
  renderFileList($('#unstaged-files'), visibleUnstaged, false);

  // Render the Conflicts section at the top of the changes-files column
  renderConflictsSection();

  // Render the hidden-info panel (empty folders, ignored files)
  // Only show it if there are no actual changes — otherwise it adds noise
  if (state.stagedFiles.length === 0 && state.unstagedFiles.length === 0) {
    renderHiddenInfo();
  } else {
    const el = $('#hidden-info');
    if (el) el.innerHTML = '';
  }

  const totalChanges = state.stagedFiles.length + state.unstagedFiles.length;
  const badge = $('#changes-tab-badge');
  if (totalChanges > 0) {
    badge.textContent = totalChanges;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  updateSelectionBar();

  // If selected file is no longer in the list, clear
  if (state.selectedFile) {
    const list = state.selectedFileStaged ? state.stagedFiles : state.unstagedFiles;
    const exists = list.find(f => f.path === state.selectedFile);
    if (!exists) {
      state.selectedFile = null;
      $('#diff-content').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚔</div>
          <p>Select a file to behold its changes.</p>
        </div>
      `;
      $('#diff-header-label').textContent = 'No file selected';
    }
  }
}

function updateSelectionBar() {
  const bar = $('#selection-bar');
  const count = state.multiSelected.size;
  if (count > 1) {
    bar.classList.add('visible');
    $('#sel-count').textContent = count;
    // Show only relevant action buttons depending on what kinds of files are selected
    const keys = [...state.multiSelected];
    const hasStaged = keys.some(k => k.startsWith('staged:'));
    const hasUnstaged = keys.some(k => k.startsWith('unstaged:'));
    $('#sel-stage').style.display = hasUnstaged ? '' : 'none';
    $('#sel-unstage').style.display = hasStaged ? '' : 'none';
    const stashBtn = $('#sel-stash');
    if (stashBtn) stashBtn.style.display = hasUnstaged && !hasStaged ? '' : 'none';
    $('#sel-discard').style.display = hasUnstaged ? '' : 'none';
  } else {
    bar.classList.remove('visible');
  }
}

function classifyByCode(code) {
  const map = {
    'A': 'added', 'M': 'modified', 'D': 'deleted',
    'R': 'renamed', 'C': 'renamed', 'U': 'conflicted', '?': 'untracked'
  };
  return map[code] || 'modified';
}

function renderFileList(container, files, staged) {
  container.innerHTML = '';
  if (!files.length) {
    const msg = state.searchQuery
      ? `No matches for "${escapeHtml(state.searchQuery)}"`
      : (staged ? 'No staged changes' : 'No unstaged changes');
    container.innerHTML = `<li class="file-empty">${msg}</li>`;
    return;
  }
  files.forEach(f => {
    const key = (staged ? 'staged:' : 'unstaged:') + f.path;
    const isMulti = state.multiSelected.has(key);
    const isSelected = state.selectedFile === f.path && state.selectedFileStaged === staged;

    // Check if this file is currently in conflict
    const conflictFiles = (state.conflicts && state.conflicts.files) || [];
    const conflictEntry = conflictFiles.find(c => c.path === f.path);
    const isConflicted = f.status === 'conflicted' || !!conflictEntry;

    const li = document.createElement('li');
    li.className = 'file-item'
      + (isSelected ? ' selected' : '')
      + (isMulti ? ' multi-selected' : '')
      + (isConflicted ? ' is-conflicted' : '');
    li.dataset.path = f.path;
    li.dataset.staged = staged ? '1' : '0';
    li.dataset.key = key;
    li.dataset.context = 'file';

    const letter = ({
      added: 'A', modified: 'M', deleted: 'D', renamed: 'R',
      conflicted: '!', untracked: 'U'
    })[f.status] || 'M';

    let actionsInner;
    if (isConflicted) {
      // Conflicted files: surface resolve actions, no stage/discard
      const isResolvable = conflictEntry && !conflictEntry.isBinary && !conflictEntry.deletedInOurs && !conflictEntry.deletedInTheirs;
      actionsInner = `
        <button class="file-action-btn" data-action="cf-ours" title="Use our version">Ours</button>
        <button class="file-action-btn" data-action="cf-theirs" title="Use their version">Theirs</button>
        ${isResolvable ? `<button class="file-action-btn" data-action="cf-resolve" title="Open three-way resolver" style="border-color:var(--crusader-red);color:var(--crusader-red-bright)">⚜ Resolve</button>` : ''}
      `;
    } else if (staged) {
      actionsInner = `<button class="file-action-btn" data-action="unstage" title="Unstage">⇣</button>`;
    } else {
      actionsInner = `<button class="file-action-btn" data-action="stage" title="Stage">⇡</button>
                     <button class="file-action-btn" data-action="stash" title="Stash this file">⚿</button>
                     <button class="file-action-btn" data-action="discard" title="Discard">✕</button>`;
    }

    li.innerHTML = `
      <div class="file-checkbox" title="Select"></div>
      <div class="file-status ${f.status}">${letter}</div>
      <div class="file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
      <div class="file-actions">${actionsInner}</div>
    `;

    li.onclick = (e) => {
      // Quick-action buttons inside the row
      const btn = e.target.closest('.file-action-btn');
      if (btn) {
        const action = btn.dataset.action;
        e.stopPropagation();
        if (action === 'stage') stageFiles([f.path]);
        else if (action === 'unstage') unstageFiles([f.path]);
        else if (action === 'stash') showStashMenu({ paths: [f.path] });
        else if (action === 'discard') discardFiles([f.path]);
        else if (action === 'cf-ours') {
          (async () => {
            const r = await withLoading('Resolving with ours', () => gs.conflictResolveSide({ filePath: f.path, side: 'ours' }));
            if (handleResult(r, 'Resolved with ours')) await refreshAll();
          })();
        } else if (action === 'cf-theirs') {
          (async () => {
            const r = await withLoading('Resolving with theirs', () => gs.conflictResolveSide({ filePath: f.path, side: 'theirs' }));
            if (handleResult(r, 'Resolved with theirs')) await refreshAll();
          })();
        } else if (action === 'cf-resolve') {
          openConflictResolver(f.path);
        }
        return;
      }

      // Checkbox click = pure toggle, no view-diff
      const isCheckbox = e.target.classList.contains('file-checkbox');

      // Modifier keys: Ctrl/Cmd to toggle, Shift for range
      if (e.shiftKey && state.lastClickedKey) {
        selectRange(state.lastClickedKey, key);
      } else if (e.ctrlKey || e.metaKey || isCheckbox) {
        toggleMultiSelect(key);
      } else {
        // Plain click: clear multi-select, select single file
        state.multiSelected.clear();
        state.lastClickedKey = key;
        selectFile(f.path, staged);
        return;
      }

      state.lastClickedKey = key;
      // Re-render so the row visuals update
      renderFileList(container, files, staged);
      updateSelectionBar();
    };

    li.oncontextmenu = (e) => {
      e.preventDefault();
      // If the right-clicked item isn't in the multi-selection, treat it as a single
      if (!state.multiSelected.has(key)) {
        state.multiSelected.clear();
        state.multiSelected.add(key);
      }
      const selectedKeys = [...state.multiSelected];
      const selectedPaths = selectedKeys.map(k => k.split(':').slice(1).join(':'));
      const allStaged = selectedKeys.every(k => k.startsWith('staged:'));
      const allUnstaged = selectedKeys.every(k => k.startsWith('unstaged:'));

      const items = [];
      if (allUnstaged) items.push({ label: `Stage (${selectedPaths.length})`, icon: '⇡', action: () => stageFiles(selectedPaths) });
      if (allStaged) items.push({ label: `Unstage (${selectedPaths.length})`, icon: '⇣', action: () => unstageFiles(selectedPaths) });
      if (allUnstaged) items.push({ label: `Stash (${selectedPaths.length})`, icon: '⚿', action: () => showStashMenu({ paths: selectedPaths }) });
      if (allUnstaged) items.push({ label: `Discard (${selectedPaths.length})`, icon: '✕', danger: true, action: () => discardFiles(selectedPaths) });
      if (items.length) items.push('sep');
      items.push({ label: 'Copy path' + (selectedPaths.length > 1 ? 's' : ''), icon: '⎘', action: () => {
        navigator.clipboard.writeText(selectedPaths.join('\n'));
        showToast(`Copied ${selectedPaths.length} path${selectedPaths.length === 1 ? '' : 's'}`, 'success');
      }});
      if (selectedKeys.length > 1) {
        items.push('sep');
        items.push({ label: 'Clear selection', icon: '✕', action: () => {
          state.multiSelected.clear();
          renderChanges();
        }});
      }
      showContextMenu(items, e.pageX, e.pageY);
    };

    container.appendChild(li);
  });
}

function toggleMultiSelect(key) {
  if (state.multiSelected.has(key)) state.multiSelected.delete(key);
  else state.multiSelected.add(key);
}

function selectRange(fromKey, toKey) {
  // Build the visible ordered list of keys (staged first, then unstaged) considering filter
  const q = state.searchQuery.trim().toLowerCase();
  const matches = (f) => !q || f.path.toLowerCase().includes(q);
  const orderedKeys = [
    ...state.stagedFiles.filter(matches).map(f => 'staged:' + f.path),
    ...state.unstagedFiles.filter(matches).map(f => 'unstaged:' + f.path)
  ];
  const a = orderedKeys.indexOf(fromKey);
  const b = orderedKeys.indexOf(toKey);
  if (a < 0 || b < 0) {
    state.multiSelected.add(toKey);
    return;
  }
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) state.multiSelected.add(orderedKeys[i]);
}

async function selectFile(path, staged) {
  state.selectedFile = path;
  state.selectedFileStaged = staged;
  // Clear all selection visuals first
  $$('.file-item').forEach(el => {
    el.classList.remove('selected');
    el.classList.remove('multi-selected');
  });
  $$('.file-item').forEach(el => {
    if (el.dataset.path === path) {
      const inStaged = el.closest('#staged-files');
      if ((inStaged && staged) || (!inStaged && !staged)) {
        el.classList.add('selected');
      }
    }
  });
  updateSelectionBar();

  $('#diff-header-label').textContent = `${staged ? '⌃' : '⌄'} ${path}`;
  $('#diff-content').innerHTML = '<div class="empty-state"><span class="loading"></span></div>';

  const result = staged ? await gs.diffStaged(path) : await gs.diffUnstaged(path);
  if (!result.ok) {
    $('#diff-content').innerHTML = `<div class="empty-state"><p class="text-red">${escapeHtml(result.error)}</p></div>`;
    return;
  }

  if (!result.data || !result.data.trim()) {
    // Untracked file — show its raw content
    if (!staged) {
      const fileResult = await gs.fileContent(path);
      if (fileResult.ok && fileResult.data !== null) {
        const lines = (fileResult.data || '').split('\n');
        const html = lines.map((l, i) =>
          `<div class="diff-line add"><div class="diff-gutter"></div><div class="diff-gutter">${i + 1}</div><div class="diff-text">+${escapeHtml(l)}</div></div>`
        ).join('');
        $('#diff-content').innerHTML = html || '<div class="empty-state"><p>Empty file.</p></div>';
        return;
      }
    }
    $('#diff-content').innerHTML = '<div class="empty-state"><p>No textual differences (binary or empty).</p></div>';
    return;
  }

  $('#diff-content').innerHTML = renderDiff(result.data);
}

// ============================================
// STATUS BAR
// ============================================
function updateStatusBar() {
  const s = state.status;
  if (!s) return;
  $('#status-branch').textContent = '⑂ ' + (s.current || 'no branch');
  const changes = (s.files || []).length;
  $('#status-changes').textContent = `${changes} change${changes === 1 ? '' : 's'}`;
  $('#status-ahead-behind').textContent = `↑${s.ahead || 0} ↓${s.behind || 0}`;

  // Toolbar badges
  const pushBadge = $('#push-badge');
  const pullBadge = $('#pull-badge');
  if (s.ahead > 0) { pushBadge.textContent = s.ahead; pushBadge.style.display = 'inline-block'; }
  else pushBadge.style.display = 'none';
  if (s.behind > 0) { pullBadge.textContent = s.behind; pullBadge.style.display = 'inline-block'; }
  else pullBadge.style.display = 'none';
}

// ============================================
// GIT OPERATIONS — Wrappers
// ============================================
async function stageFiles(files) {
  const r = await gs.stage(files);
  if (handleResult(r)) {
    state.multiSelected.clear();
    await refreshStatus();
  }
}

async function unstageFiles(files) {
  const r = await gs.unstage(files);
  if (handleResult(r)) {
    state.multiSelected.clear();
    await refreshStatus();
  }
}

async function discardFiles(files) {
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return;

  // Detect if any are untracked — for those, "discard" means delete from disk
  const untrackedPaths = new Set();
  state.unstagedFiles.forEach(f => {
    if (f.status === 'untracked' && list.includes(f.path)) untrackedPaths.add(f.path);
  });
  const hasUntracked = untrackedPaths.size > 0;
  const hasTracked = list.some(p => !untrackedPaths.has(p));

  let title, message;
  if (list.length === 1) {
    title = hasUntracked ? 'Delete Untracked File' : 'Discard Changes';
    message = hasUntracked
      ? `Permanently delete "${list[0]}" from disk? This cannot be undone.`
      : `Permanently discard changes to "${list[0]}"? This cannot be undone.`;
  } else {
    title = `Discard / Delete (${list.length} files)`;
    const preview = list.slice(0, 8).join('\n') + (list.length > 8 ? `\n…and ${list.length - 8} more` : '');
    if (hasUntracked && hasTracked) {
      message = `${untrackedPaths.size} untracked file(s) will be deleted from disk, and changes to ${list.length - untrackedPaths.size} tracked file(s) will be discarded. This cannot be undone.\n\n${preview}`;
    } else if (hasUntracked) {
      message = `${list.length} untracked files will be deleted from disk. This cannot be undone.\n\n${preview}`;
    } else {
      message = `Permanently discard changes to ${list.length} files? This cannot be undone.\n\n${preview}`;
    }
  }

  const confirmed = await modal.confirm({
    title,
    message,
    danger: true,
    confirmText: hasUntracked && !hasTracked ? 'Delete' : 'Discard'
  });
  if (!confirmed) return;
  const r = await gs.discard(list);
  if (handleResult(r, list.length === 1 ? 'Done' : `Done — ${list.length} files`)) {
    state.multiSelected.clear();
    await refreshStatus();
  }
}

async function commitChanges() {
  const summary = $('#commit-summary').value.trim();
  const description = $('#commit-description').value.trim();
  if (!summary) {
    showToast('Summary required', 'error');
    $('#commit-summary').focus();
    return;
  }

  const stagedCount = $$('#staged-files .file-item').length;
  if (stagedCount === 0) {
    showToast('Nothing staged. Stage changes first.', 'error');
    return;
  }

  const r = await withLoading('Committing', () => gs.commit({ message: summary, description }));
  if (handleResult(r, 'Deed inscribed')) {
    $('#commit-summary').value = '';
    $('#commit-description').value = '';
    await refreshAll();
  }
}

// Marker used in stash messages so we can find auto-stashes bound to a branch.
// Format: "[GitGood auto] on <branch-name>"
const AUTO_STASH_MARKER = '[GitGood auto] on ';
// Legacy marker from when the app was named GitSouls — still matched on restore so
// existing auto-stashes aren't orphaned after the rename.
const AUTO_STASH_MARKER_LEGACY = '[GitSouls auto] on ';
function autoStashMarkerFor(branch) { return AUTO_STASH_MARKER + branch; }

// Safe checkout for a local branch. If the working tree has uncommitted changes,
// prompts the user to: Stash & Switch / Discard & Switch / Cancel.
// After successful switch, looks for auto-stashes bound to the new branch and
// offers to restore them.
async function checkoutBranch(name) {
  if (!name) return;
  // Checking out a named branch is a deliberate move onto a branch — forget any
  // remembered detached-HEAD origin so a stale "return to" target doesn't linger.
  state.detachedFrom = null;
  // Don't bother prompting if there are no changes
  const hasChanges = state.status && (state.status.files || []).length > 0;
  if (!hasChanges) {
    const r = await withLoading('Checking out ' + name, () => gs.checkoutSafe({ branch: name }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
    if (r.data && r.data.switched) {
      showToast(`Checked out ${name}`, 'success');
      await refreshAll();
      await maybeOfferAutoStashRestore(name);
    }
    return;
  }
  // Has changes — go through the safe flow
  await promptCheckoutWithDirty(name, /*isRemoteSetup*/ null);
}

// Checkout a specific commit (detached HEAD). Remembers the branch we left so the
// user can return to it with one click via the detached-HEAD banner.
async function checkoutCommit(hash) {
  if (!hash) return;
  const shortHash = hash.slice(0, 7);

  // Remember where we came from. Read a FRESH status so we never rely on a stale
  // state.status. Prefer the branch reported by status; if that's unavailable, fall
  // back to the local branches' current. Only record when we're NOT already detached.
  let originBranch = null;
  let freshHasChanges = false;
  try {
    const freshStatus = await gs.status();
    if (freshStatus.ok) {
      const st = freshStatus.data;
      freshHasChanges = (st.files || []).length > 0;
      const onBranch = st && !st.detached && st.current && st.current !== 'HEAD';
      if (onBranch) originBranch = st.current;
    }
  } catch (e) { /* ignore */ }
  // Secondary source: the local branch list's current marker.
  if (!originBranch) {
    const lc = state.branches && state.branches.local && state.branches.local.current;
    if (lc && lc !== 'HEAD') originBranch = lc;
  }
  if (originBranch) {
    state.detachedFrom = originBranch;
  }

  const hasChanges = freshHasChanges || (state.status && (state.status.files || []).length > 0);
  if (hasChanges) {
    const choice = await modal.confirm({
      title: 'Uncommitted Changes',
      message: `You have uncommitted changes. Checking out ${shortHash} will move HEAD. Auto-stash your changes first?`,
      confirmText: 'Stash & Checkout',
      cancelText: 'Cancel'
    });
    if (!choice) return;
    const r = await withLoading(`Checking out ${shortHash}`, () => gs.checkoutSafe({ branch: hash, autoStashAll: true }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  } else {
    const r = await withLoading(`Checking out ${shortHash}`, () => gs.checkoutSafe({ branch: hash }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  }
  showToast(`Checked out commit ${shortHash} (detached HEAD)`, 'success');
  await refreshAll();
}

// Return from a detached HEAD back to the branch we started on (or a default branch).
async function returnToBranch() {
  const target = state.detachedFrom || guessDefaultBranch();
  if (!target) {
    showToast('No branch to return to', 'error');
    return;
  }
  const hasChanges = state.status && (state.status.files || []).length > 0;
  if (hasChanges) {
    const choice = await modal.confirm({
      title: 'Uncommitted Changes',
      message: `You have uncommitted changes at this commit. Auto-stash them and return to “${target}”?`,
      confirmText: 'Stash & Return',
      cancelText: 'Cancel'
    });
    if (!choice) return;
    const r = await withLoading(`Returning to ${target}`, () => gs.checkoutSafe({ branch: target, autoStashAll: true }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  } else {
    const r = await withLoading(`Returning to ${target}`, () => gs.checkoutSafe({ branch: target }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  }
  state.detachedFrom = null;
  showToast(`Returned to ${target}`, 'success');
  await refreshAll();
  await maybeOfferAutoStashRestore(target);
}

// Same logic but for a remote branch: creates a local tracking branch.
async function checkoutRemoteBranch(remoteBranch, localName) {
  const hasChanges = state.status && (state.status.files || []).length > 0;
  if (!hasChanges) {
    const r = await withLoading('Checking out ' + localName, () => gs.rawCommand(['checkout', '-b', localName, remoteBranch]));
    if (!handleResult(r, `Checked out ${localName}`)) return;
    await refreshAll();
    await maybeOfferAutoStashRestore(localName);
    return;
  }
  // Dirty tree — use the same prompt but route to the remote-checkout flow on confirm
  await promptCheckoutWithDirty(localName, { remoteBranch, localName });
}

// Show the stash-or-discard prompt. Routes to the appropriate checkout backend on confirm.
async function promptCheckoutWithDirty(targetBranch, remoteSetup) {
  const status = state.status;
  const fromBranch = (status && status.current) || 'current branch';
  const fileCount = (status && status.files) ? status.files.length : 0;
  const filesPreview = (status && status.files) ? status.files.slice(0, 10).map(f => f.path) : [];

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Switching from <strong>${escapeHtml(fromBranch)}</strong> to <strong class="text-red">${escapeHtml(targetBranch)}</strong>, but thy working tree hath <strong>${fileCount}</strong> uncommitted change${fileCount === 1 ? '' : 's'}.</p>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);padding:8px;max-height:140px;overflow-y:auto;margin-bottom:14px">
      ${filesPreview.map(p => escapeHtml(p)).join('<br>')}
      ${fileCount > filesPreview.length ? `<br><span class="text-muted">…and ${fileCount - filesPreview.length} more</span>` : ''}
    </div>
    <p class="modal-text">Choose thy course:</p>
    <div class="merge-strategies">
      <label class="merge-strategy selected">
        <input type="radio" name="checkout-mode" value="stash" checked />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">⚿ Stash & Switch (recommended)</div>
          <div class="merge-strategy-desc">Save thy changes to a stash bound to <strong>${escapeHtml(fromBranch)}</strong> (including untracked files). When thou returnest to this banner, the stash shall be offered for restoration.</div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="checkout-mode" value="discard" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">✕ Discard & Switch ⚠</div>
          <div class="merge-strategy-desc">Permanently abandon all uncommitted changes (including untracked files) before switching. <strong>Cannot be undone.</strong></div>
        </div>
      </label>
    </div>
  `;

  body.querySelectorAll('.merge-strategy').forEach(card => {
    card.onclick = () => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
      body.querySelectorAll('.merge-strategy').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    };
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary';
  okBtn.innerHTML = '<span class="btn-icon">⑂</span> Switch';
  okBtn.onclick = async () => {
    const mode = body.querySelector('input[name="checkout-mode"]:checked').value;
    modal.hide();

    if (mode === 'discard') {
      const sure = await modal.confirm({
        title: 'Confirm Discard',
        message: 'All uncommitted changes (including untracked files) will be permanently lost. Continue?',
        danger: true, confirmText: 'Yes, discard'
      });
      if (!sure) return;
    }

    if (remoteSetup) {
      // For remote-branch checkout we need to handle stash/discard manually,
      // then run our remote checkout (-b localName remoteBranch).
      if (mode === 'stash') {
        const stashMsg = autoStashMarkerFor(fromBranch);
        const sr = await withLoading('Stashing', () => gs.stash({ message: stashMsg, includeUntracked: true }));
        if (!sr.ok) { showToast('Stash failed: ' + sr.error, 'error', 6000); return; }
      } else if (mode === 'discard') {
        const dr = await gs.rawCommand(['reset', '--hard', 'HEAD']);
        if (!dr.ok) { showToast('Reset failed: ' + dr.error, 'error', 6000); return; }
        const cr = await gs.rawCommand(['clean', '-fd']);
        if (!cr.ok) { showToast('Clean failed: ' + cr.error, 'error', 6000); return; }
      }
      const r = await withLoading('Checking out ' + remoteSetup.localName, () => gs.rawCommand(['checkout', '-b', remoteSetup.localName, remoteSetup.remoteBranch]));
      if (!handleResult(r, `Checked out ${remoteSetup.localName}`)) return;
      await refreshAll();
      if (mode === 'stash') showToast('Stashed and switched', 'success');
      await maybeOfferAutoStashRestore(remoteSetup.localName);
    } else {
      // Regular local branch — use the safe-checkout backend with the right flag
      const opts = { branch: targetBranch };
      if (mode === 'stash') opts.autoStashAll = true;
      else if (mode === 'discard') opts.discardAll = true;
      const r = await withLoading(`Switching to ${targetBranch}`, () => gs.checkoutSafe(opts));
      if (!r.ok) { showToast(r.error, 'error', 6000); return; }
      if (r.data && r.data.switched) {
        showToast(mode === 'stash' ? 'Stashed and switched' : 'Switched', 'success');
        await refreshAll();
        await maybeOfferAutoStashRestore(targetBranch);
      }
    }
  };

  modal.show({ title: 'Uncommitted Changes', body, footer: [cancelBtn, okBtn] });
}

// After arriving at a branch, look for auto-stashes bound to it and offer restore.
async function maybeOfferAutoStashRestore(branch) {
  if (!branch) return;
  // Search the current marker, then fall back to the legacy GitSouls marker.
  let r = await gs.stashFindByPrefix(autoStashMarkerFor(branch));
  let stashes = (r.ok && r.data) ? r.data : [];
  if (!stashes.length) {
    const legacy = await gs.stashFindByPrefix(AUTO_STASH_MARKER_LEGACY + branch);
    if (legacy.ok && legacy.data && legacy.data.length) stashes = legacy.data;
  }
  if (!stashes.length) return;
  // Show the most recent (lowest index) and offer restore-all
  const body = document.createElement('div');
  const rowsHtml = stashes.map(s => `
    <div class="merge-incoming-row">
      <span class="text-red text-mono">${escapeHtml(s.ref)}</span>
      <span>${escapeHtml(s.message)}</span>
      <span class="text-muted text-mono">${escapeHtml(s.date ? new Date(s.date).toLocaleString() : '')}</span>
    </div>
  `).join('');

  body.innerHTML = `
    <p class="modal-text">${stashes.length} auto-stash${stashes.length === 1 ? '' : 'es'} bound to <strong class="text-red">${escapeHtml(branch)}</strong> ${stashes.length === 1 ? 'was' : 'were'} found. Restore?</p>
    <div class="merge-incoming">${rowsHtml}</div>
    <p class="modal-text text-muted" style="font-size:12px">"Pop" applies the most recent stash and removes it from the stash list. "Apply" keeps the stash entry around.</p>
  `;

  const laterBtn = document.createElement('button');
  laterBtn.className = 'btn-medieval'; laterBtn.textContent = 'Not Now';
  laterBtn.onclick = () => modal.hide();

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-medieval'; applyBtn.innerHTML = '<span class="btn-icon">⌥</span> Apply Latest';
  applyBtn.onclick = async () => {
    modal.hide();
    // Apply the newest auto-stash (lowest index)
    const target = stashes[0];
    const r = await withLoading('Applying auto-stash', () => gs.stashApply(target.index));
    if (handleResult(r, 'Auto-stash applied')) await refreshAll();
  };

  const popBtn = document.createElement('button');
  popBtn.className = 'btn-medieval primary'; popBtn.innerHTML = '<span class="btn-icon">⌃</span> Pop Latest';
  popBtn.onclick = async () => {
    modal.hide();
    const target = stashes[0];
    const r = await withLoading('Popping auto-stash', () => gs.stashPop(target.index));
    if (handleResult(r, 'Auto-stash restored')) await refreshAll();
  };

  modal.show({ title: 'Restore Auto-Stash', body, footer: [laterBtn, applyBtn, popBtn] });
}

async function mergeBranch(name) {
  // Use the smart merge dialog
  await showSmartMergeDialog(name);
}

async function deleteBranch(name, force) {
  const confirmed = await modal.confirm({
    title: force ? 'Force Delete Branch' : 'Delete Branch',
    message: force
      ? `Force delete branch "${name}"? Unmerged commits will be lost.`
      : `Delete branch "${name}"?`,
    danger: true,
    confirmText: force ? 'Force Delete' : 'Delete'
  });
  if (!confirmed) return;
  const r = await gs.deleteBranch({ name, force });
  if (handleResult(r, `Deleted ${name}`)) {
    await refreshBranches();
  }
}

async function removeRemote(name) {
  const confirmed = await modal.confirm({
    title: 'Remove Remote',
    message: `Remove the remote "${name}"?`,
    danger: true,
    confirmText: 'Remove'
  });
  if (!confirmed) return;
  const r = await gs.removeRemote(name);
  if (handleResult(r, `Removed ${name}`)) {
    await refreshRemotes();
  }
}

async function stashApply(i) {
  const r = await gs.stashApply(i);
  if (handleResult(r, 'Stash applied')) {
    await refreshAll();
  }
}

async function stashPop(i) {
  const r = await gs.stashPop(i);
  if (handleResult(r, 'Stash popped')) {
    await refreshAll();
  }
}

async function stashDrop(i) {
  const confirmed = await modal.confirm({
    title: 'Drop Stash',
    message: `Permanently drop stash@{${i}}? This cannot be undone.`,
    danger: true,
    confirmText: 'Drop'
  });
  if (!confirmed) return;
  const r = await gs.stashDrop(i);
  if (handleResult(r, 'Stash dropped')) {
    await refreshStashes();
  }
}

// ============================================
// STASH BROWSER — selective unstash per file
// ============================================
async function showStashBrowser(stashIndex) {
  // Fetch file list of this stash
  const stash = state.stashes.find(s => s.index === stashIndex) || state.stashes[stashIndex];
  const listResult = await withLoading('Reading stash', () => gs.stashFiles(stashIndex));
  if (!listResult.ok) {
    showToast('Failed to read stash: ' + listResult.error, 'error', 6000);
    return;
  }
  const { tracked, untracked } = listResult.data;
  const allFiles = [
    ...tracked.map(f => ({ ...f })),
    ...untracked.map(f => ({ ...f }))
  ];

  if (!allFiles.length) {
    showToast('Stash is empty (no file changes)', 'error');
    return;
  }

  // Track selected file paths in a Set
  const selected = new Set(allFiles.map(f => f.path)); // default: all selected

  // Status letter map
  const letterFor = (status) => ({
    'A': 'A', 'M': 'M', 'D': 'D', 'R': 'R', 'C': 'R', 'T': 'T', '?': 'U'
  })[status] || 'M';
  const statusClass = (status) => ({
    'A': 'added', 'M': 'modified', 'D': 'deleted', 'R': 'renamed',
    'C': 'renamed', 'T': 'modified', '?': 'untracked'
  })[status] || 'modified';

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">
      <strong class="text-red">${escapeHtml(stash ? stash.ref : `stash@{${stashIndex}}`)}</strong>
      &nbsp;·&nbsp; ${escapeHtml(stash ? stash.message : '')}
    </p>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
      <span class="branches-label" style="margin:0">⚜ Files in this stash (<span id="sb-count">${selected.size}</span>/${allFiles.length} selected)</span>
      <div style="display:flex;gap:6px">
        <button class="mini-btn" id="sb-all">Select All</button>
        <button class="mini-btn" id="sb-none">Select None</button>
      </div>
    </div>
    <ul class="file-list" id="sb-files" style="max-height:340px;overflow-y:auto;border:1px solid var(--border)">
      ${allFiles.map(f => `
        <li class="file-item multi-selected" data-path="${escapeHtml(f.path)}">
          <div class="file-checkbox" title="Select"></div>
          <div class="file-status ${statusClass(f.status)}">${letterFor(f.status)}</div>
          <div class="file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
          <div class="file-actions">
            ${f.kind === 'untracked' ? '<span style="font-size:10px;color:var(--muted-text);font-family:var(--font-mono)">untracked</span>' : ''}
          </div>
        </li>
      `).join('')}
    </ul>
    <label class="modal-checkbox" style="margin-top:14px">
      <input type="checkbox" id="sb-drop-after" />
      Drop the stash after restoring (only if restoring all files)
    </label>
  `;

  // Wire up row selection (click = toggle)
  body.querySelectorAll('#sb-files .file-item').forEach(li => {
    const path = li.dataset.path;
    li.onclick = () => {
      if (selected.has(path)) {
        selected.delete(path);
        li.classList.remove('multi-selected');
      } else {
        selected.add(path);
        li.classList.add('multi-selected');
      }
      body.querySelector('#sb-count').textContent = selected.size;
      syncDropCheckbox();
    };
  });

  // Select all / none
  body.querySelector('#sb-all').onclick = () => {
    allFiles.forEach(f => selected.add(f.path));
    body.querySelectorAll('#sb-files .file-item').forEach(li => li.classList.add('multi-selected'));
    body.querySelector('#sb-count').textContent = selected.size;
    syncDropCheckbox();
  };
  body.querySelector('#sb-none').onclick = () => {
    selected.clear();
    body.querySelectorAll('#sb-files .file-item').forEach(li => li.classList.remove('multi-selected'));
    body.querySelector('#sb-count').textContent = selected.size;
    syncDropCheckbox();
  };

  function syncDropCheckbox() {
    const cb = body.querySelector('#sb-drop-after');
    if (selected.size < allFiles.length) {
      cb.checked = false;
      cb.disabled = true;
      cb.parentElement.style.opacity = '0.4';
    } else {
      cb.disabled = false;
      cb.parentElement.style.opacity = '1';
    }
  }
  syncDropCheckbox();

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Close';
  cancelBtn.onclick = () => modal.hide();

  const popAllBtn = document.createElement('button');
  popAllBtn.className = 'btn-medieval';
  popAllBtn.innerHTML = '<span class="btn-icon">⌃</span> Pop All';
  popAllBtn.title = 'Apply all files and remove the stash';
  popAllBtn.onclick = async () => {
    modal.hide();
    const r = await withLoading('Popping stash', () => gs.stashPop(stashIndex));
    if (handleResult(r, 'Stash popped')) await refreshAll();
  };

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-medieval primary';
  applyBtn.innerHTML = '<span class="btn-icon">⌥</span> Restore Selected';
  applyBtn.onclick = async () => {
    const paths = [...selected];
    if (!paths.length) { showToast('No files selected', 'error'); return; }
    const drop = body.querySelector('#sb-drop-after').checked && paths.length === allFiles.length;
    modal.hide();
    const r = await withLoading(`Restoring ${paths.length} file${paths.length === 1 ? '' : 's'}`,
      () => gs.stashApplyFiles({ index: stashIndex, paths, drop }));
    if (handleResult(r, drop ? 'Restored and dropped stash' : `Restored ${paths.length} file${paths.length === 1 ? '' : 's'}`)) {
      await refreshAll();
    }
  };

  modal.show({
    title: 'Stash Browser',
    body,
    footer: [cancelBtn, popAllBtn, applyBtn]
  });
}

// ============================================
// TOOLBAR ACTIONS
// ============================================
$('#btn-fetch').onclick = async () => {
  const r = await withLoading('Fetching', () => gs.fetch());
  if (handleResult(r, 'Fetched from remote')) {
    await refreshAll();
  }
};

$('#btn-pull').onclick = async () => {
  const r = await withLoading('Pulling', () => gs.pull());
  if (handleResult(r, 'Pulled from remote')) {
    await refreshAll();
  }
};

$('#btn-push').onclick = async () => {
  const r = await withLoading('Pushing', () => gs.push());
  if (!r.ok && /no upstream|has no upstream branch|set-upstream/i.test(r.error || '')) {
    // Offer set-upstream
    const branch = state.status && state.status.current;
    const confirmed = await modal.confirm({
      title: 'No Upstream Branch',
      message: `Branch "${branch}" has no upstream. Push and set upstream to "origin/${branch}"?`,
      confirmText: 'Push & Set Upstream'
    });
    if (!confirmed) return;
    const r2 = await withLoading('Pushing', () => gs.push({ setUpstream: true, remote: 'origin', branch }));
    if (handleResult(r2, 'Pushed and upstream set')) {
      await refreshAll();
    }
    return;
  }
  if (handleResult(r, 'Pushed to remote')) {
    await refreshAll();
  }
};

$('#btn-refresh').onclick = async () => {
  await refreshAll();
  showToast('Refreshed', 'success', 1500);
};

$('#btn-branch').onclick = () => {
  // Switch to the Branches tab
  const tab = document.querySelector('.tab[data-tab="branches"]');
  if (tab) tab.click();
};
$('#btn-stash').onclick = () => showStashMenu();

$('#btn-open-folder').onclick = () => {
  if (state.repo) gs.openInExplorer(state.repo.path);
};

$('#btn-close-repo').onclick = async () => {
  await gs.closeRepo();
  state.repo = null;
  state.status = null;
  state.selectedCommit = null;
  state.selectedFile = null;
  clearCommitCache();
  state.collapsedCommits = null;
  state.graphCollapsed = false;
  state.graphFilter = "";
  state.historyFilter = "";
  state.detachedFrom = null;
  _diskState.loaded = false;
  _diskState.lastData = null;
  showWelcome();
};

// ============================================
// BRANCH & STASH MENUS (modals)
// ============================================
function showBranchMenu() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="modal-field">
      <label>New Branch Name</label>
      <input class="modal-input" id="new-branch-name" placeholder="feature/holy-grail" />
    </div>
    <div class="modal-checkbox">
      <input type="checkbox" id="checkout-after" checked />
      <label for="checkout-after">Checkout after creation</label>
    </div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const createBtn = document.createElement('button');
  createBtn.className = 'btn-medieval primary';
  createBtn.innerHTML = '<span class="btn-icon">⑂</span> Create';
  createBtn.onclick = async () => {
    const name = $('#new-branch-name').value.trim();
    const checkout = $('#checkout-after').checked;
    if (!name) { showToast('Name required', 'error'); return; }
    modal.hide();
    const r = await gs.createBranch({ name, checkout });
    if (handleResult(r, `Branch ${name} forged`)) {
      await refreshAll();
    }
  };
  modal.show({ title: 'New Branch', body, footer: [cancelBtn, createBtn] });
}

function showCreateBranchDialog(fromHash) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Create a new branch from commit <code class="text-mono text-red">${escapeHtml(fromHash.slice(0,7))}</code></p>
    <div class="modal-field">
      <label>Branch Name</label>
      <input class="modal-input" id="new-branch-name" placeholder="branch-name" />
    </div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const createBtn = document.createElement('button');
  createBtn.className = 'btn-medieval primary';
  createBtn.textContent = 'Create';
  createBtn.onclick = async () => {
    const name = $('#new-branch-name').value.trim();
    if (!name) { showToast('Name required', 'error'); return; }
    modal.hide();
    const r = await gs.rawCommand(['branch', name, fromHash]);
    if (handleResult(r, `Branch ${name} created`)) {
      await refreshBranches();
    }
  };
  modal.show({ title: 'Create Branch', body, footer: [cancelBtn, createBtn] });
}

// Show the stash creation dialog. opts.paths = optional array of paths to stash (else: all).
function showStashMenu(opts) {
  opts = opts || {};
  const paths = Array.isArray(opts.paths) ? opts.paths : null;
  const scope = paths
    ? (paths.length === 1 ? `1 file (${paths[0]})` : `${paths.length} files`)
    : 'all changes (staged + unstaged + untracked)';

  // Detect whether untracked files exist among the targeted paths
  const willStashUntracked = (() => {
    if (paths) {
      const untrackedSet = new Set(state.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path));
      return paths.some(p => untrackedSet.has(p));
    }
    return state.unstagedFiles.some(f => f.status === 'untracked');
  })();

  const pathsPreview = paths
    ? `<div class="modal-field"><label>Files</label><div style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);padding:8px;max-height:120px;overflow-y:auto">${paths.slice(0, 30).map(p => escapeHtml(p)).join('<br>')}${paths.length > 30 ? `<br><span class="text-muted">…and ${paths.length - 30} more</span>` : ''}</div></div>`
    : '';

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Stash <strong class="text-red">${escapeHtml(scope)}</strong> for safekeeping.</p>
    ${pathsPreview}
    <div class="modal-field">
      <label>Stash Message (optional)</label>
      <input class="modal-input" id="stash-msg" placeholder="WIP on feature" />
    </div>
    <label class="modal-checkbox">
      <input type="checkbox" id="stash-untracked" ${willStashUntracked ? 'checked' : ''} />
      Include untracked files
    </label>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const stashBtn = document.createElement('button');
  stashBtn.className = 'btn-medieval primary';
  stashBtn.innerHTML = '<span class="btn-icon">⚿</span> Stash';
  stashBtn.onclick = async () => {
    const msg = $('#stash-msg').value.trim();
    const includeUntracked = $('#stash-untracked').checked;
    modal.hide();
    const r = await withLoading('Stashing', () => gs.stash({
      message: msg || undefined,
      paths: paths || undefined,
      includeUntracked
    }));
    if (handleResult(r, paths ? `Stashed ${paths.length} file${paths.length === 1 ? '' : 's'}` : 'Stashed')) {
      state.multiSelected.clear();
      await refreshAll();
    }
  };
  modal.show({ title: paths ? 'Stash Selected Files' : 'Stash All Changes', body, footer: [cancelBtn, stashBtn] });
}

// ============================================
// COMMIT BUTTON & STAGE/UNSTAGE ALL
// ============================================
$('#commit-btn').onclick = () => commitChanges();
$('#commit-summary').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitChanges();
});

$('#stage-all-btn').onclick = async () => {
  const r = await gs.stageAll();
  if (handleResult(r)) await refreshStatus();
};

$('#unstage-all-btn').onclick = async () => {
  const r = await gs.unstageAll();
  if (handleResult(r)) await refreshStatus();
};

// ============================================
// CHANGES SEARCH
// ============================================
(() => {
  const input = $('#changes-search');
  const clearBtn = $('#changes-search-clear');
  if (!input) return;
  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearBtn.classList.toggle('visible', !!input.value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = input.value;
      renderChanges();
    }, 100);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.searchQuery = '';
      clearBtn.classList.remove('visible');
      renderChanges();
    }
  });
  clearBtn.onclick = () => {
    input.value = '';
    state.searchQuery = '';
    clearBtn.classList.remove('visible');
    renderChanges();
    input.focus();
  };
})();

// ============================================
// SELECTION BAR ACTIONS
// ============================================
function getSelectedPaths(filterPrefix) {
  return [...state.multiSelected]
    .filter(k => !filterPrefix || k.startsWith(filterPrefix))
    .map(k => k.split(':').slice(1).join(':'));
}

$('#sel-stage').onclick = () => {
  const paths = getSelectedPaths('unstaged:');
  if (paths.length) stageFiles(paths);
};
$('#sel-unstage').onclick = () => {
  const paths = getSelectedPaths('staged:');
  if (paths.length) unstageFiles(paths);
};
const _selStashBtn = $('#sel-stash');
if (_selStashBtn) _selStashBtn.onclick = () => {
  const paths = getSelectedPaths('unstaged:');
  if (paths.length) showStashMenu({ paths });
};
$('#sel-discard').onclick = () => {
  const paths = getSelectedPaths('unstaged:');
  if (paths.length) discardFiles(paths);
};
$('#sel-clear').onclick = () => {
  state.multiSelected.clear();
  renderChanges();
};

// Section header "Stash All Unstaged" button
const _stashUnstagedBtn = $('#stash-unstaged-btn');
if (_stashUnstagedBtn) _stashUnstagedBtn.onclick = () => {
  // Stash all unstaged file paths
  const paths = state.unstagedFiles.map(f => f.path);
  if (!paths.length) { showToast('No unstaged changes', 'error'); return; }
  showStashMenu({ paths });
};

// ============================================
// AUTO-REFRESH ON WINDOW FOCUS
// ============================================
(() => {
  let focusRefreshTimer = null;
  let lastRefresh = 0;
  function scheduleFocusRefresh() {
    // Only refresh if a repo is open
    if (!state.repo) return;
    // Don't refresh if a modal is open (could disrupt user input)
    if (!$('#modal-overlay').classList.contains('hidden')) return;
    // Don't yank focus or interrupt active typing in the commit fields or search
    const active = document.activeElement;
    if (active && (active.id === 'commit-summary' || active.id === 'commit-description' || active.id === 'changes-search')) {
      // Still refresh, but only the lists/log — we skip nothing, since renderChanges preserves the input
      // The render functions don't touch input values, so this is actually fine.
    }
    // Throttle: at most one auto-refresh every 1.5 seconds
    const now = Date.now();
    if (now - lastRefresh < 1500) return;
    lastRefresh = now;
    // Debounce slightly so we coalesce rapid focus/blur cycles
    clearTimeout(focusRefreshTimer);
    focusRefreshTimer = setTimeout(() => {
      refreshAll().catch(err => console.error('Auto-refresh failed:', err));
    }, 150);
  }
  // Listen to main-process event (window focused)
  if (gs.onWindowFocus) gs.onWindowFocus(scheduleFocusRefresh);
  // Fallback DOM event for in-window focus return
  window.addEventListener('focus', scheduleFocusRefresh);
  // Also when the tab/document becomes visible (e.g., after being hidden)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleFocusRefresh();
  });
})();

// ============================================
// TABS
// ============================================
$$('.tab').forEach(tab => {
  tab.onclick = () => {
    const target = tab.dataset.tab;
    state.currentTab = target;
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === target));
    // Lazy-load tab data on first visit and on switch
    if (target === 'graph') refreshGraph();
    else if (target === 'branches') renderBranchesTab();
    else if (target === 'history') renderHistory();
  };
});

// ============================================
// DIFF VIEW MODE TOGGLE (unified / split) — applies everywhere the diff is shown
// ============================================
// Restore saved mode before any diff renders.
try {
  const saved = localStorage.getItem('gitgood:diff-mode');
  if (saved === 'split' || saved === 'unified') state.diffMode = saved;
} catch (err) {}

function setDiffMode(mode) {
  if (mode !== 'unified' && mode !== 'split') return;
  if (mode === state.diffMode) return;
  state.diffMode = mode;
  try { localStorage.setItem('gitgood:diff-mode', mode); } catch (err) {}
  // Reflect on every toggle currently on screen.
  document.querySelectorAll('.diff-view-toggle .diff-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.diffmode === mode));

  // Re-render the Changes-tab diff (from memory) in the new mode.
  if (_lastDiff) {
    const el = document.getElementById('diff-content');
    if (el) {
      const prev = el.scrollTop;
      el.innerHTML = renderDiff(_lastDiff.text, _lastDiff.opts);
      el.scrollTop = prev;
    }
  }

  // For the Graph/History commit previews, re-render ONLY the currently-selected file's
  // diff in place — this preserves the selected file and the scroll positions instead of
  // rebuilding the whole detail pane (which reset to the first file).
  const graphDiff = document.getElementById('graph-diff-content');
  if (graphDiff && !rerenderActiveCommitFile(graphDiff) && state.selectedGraphHash) {
    const c = (state.graph.commits || []).find(x => x.hash === state.selectedGraphHash);
    if (c) renderGraphDetail(c);
  }
  const histDiff = document.getElementById('hist-diff-content');
  if (histDiff && !rerenderActiveCommitFile(histDiff) && state.selectedCommit) {
    const d = (_historyDetailDiff && _historyDetailDiff.hash === state.selectedCommit.hash)
      ? _historyDetailDiff.details : null;
    renderHistoryDetail(state.selectedCommit, d);
  }
}

// One delegated listener handles every diff-view toggle (Changes pane + Graph/History
// detail headers), since those headers are re-created dynamically.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.diff-view-btn');
  if (!btn) return;
  setDiffMode(btn.dataset.diffmode);
});

// Reflect the restored mode on any static toggle present at load (the Changes header).
(() => {
  document.querySelectorAll('.diff-view-toggle .diff-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.diffmode === state.diffMode));
})();


// ============================================
// SIDEBAR TOGGLE (whole panel, horizontal) — frees width for the main content
// ============================================
const SIDEBAR_COLLAPSE_KEY = 'gitgood:sidebar-collapsed';
function setSidebarCollapsed(collapsed) {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  workspace.classList.toggle('sidebar-collapsed', collapsed);
  document.body.classList.toggle('sidebar-is-collapsed', collapsed);
  const btn = document.getElementById('sidebar-toggle');
  if (btn) btn.title = collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)';
  try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) {}
}
function toggleSidebar() {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  setSidebarCollapsed(!workspace.classList.contains('sidebar-collapsed'));
}
(() => {
  const btn = document.getElementById('sidebar-toggle');
  if (btn) btn.onclick = toggleSidebar;
  // Restore persisted state
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1'; } catch (e) {}
  if (collapsed) setSidebarCollapsed(true);
  // Keyboard shortcut: Ctrl/Cmd + B
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggleSidebar();
    }
  });
})();

// ============================================
// GRAPH LAYOUT ALGORITHM
// ============================================
// Standard "lane" commit-graph layout. Processes commits top-to-bottom (newest
// first). At every row we know which lanes are active and which commit each lane
// is currently "routing toward" (its next expected commit = the parent it follows).
//
// CRITICAL: edges only ever connect ONE row to the NEXT row. A vertical line that
// spans many rows is emitted as many short row→row+1 segments. A lane only bends
// (curves) at the single row boundary where it actually shifts columns. This is
// what keeps lines tracking their dots instead of swooping across the whole graph.
//
// Returns: { positions: Map<hash,{row,lane}>, edges: [{fromLane,toLane,fromRow,toRow,colorLane,type}], laneCount }
function layoutGraph(commits) {
  const positions = new Map();
  const edges = [];

  // lanes[i] = hash that lane i is currently routing toward (the next commit it
  // expects to land on), or null if the lane is free.
  let lanes = [];
  let maxLaneCount = 0;

  // Stable color assignment: once a lane gets a color index it keeps it until freed.
  // We color by the lane index directly (laneColor handles wrap-around), which is
  // simple and stable enough for our purposes.

  const findLane = (hash) => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === hash) return i;
    return -1;
  };
  const allocLane = () => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (let row = 0; row < commits.length; row++) {
    const c = commits[row];
    const parents = c.parents || [];

    // 1. Which lane is this commit on? The lane that was routing toward it.
    let myLane = findLane(c.hash);
    if (myLane === -1) myLane = allocLane();
    positions.set(c.hash, { row, lane: myLane });

    // 2. Collect every lane currently routing toward THIS commit (besides myLane).
    //    Those lanes converge into myLane at this row (merge of branch lines).
    const convergingLanes = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== myLane && lanes[i] === c.hash) convergingLanes.push(i);
    }

    // 3. Snapshot the lane state BEFORE this commit reassigns anything. We need it
    //    to draw the segments from THIS row down to the NEXT row.
    //    First, update lane assignments for the row below:
    //    - myLane now routes toward the first parent (continues the line straight).
    //    - converging lanes are freed (they joined myLane here).
    //    - extra parents (merge) claim lanes routing toward them.

    // Free converging lanes (they merged into myLane at this row)
    for (const i of convergingLanes) lanes[i] = null;

    // Assign myLane to follow the first parent
    if (parents.length > 0) {
      lanes[myLane] = parents[0];
    } else {
      lanes[myLane] = null; // root commit; lane ends
    }

    // Extra parents (merge commits): route each toward its parent in some lane.
    const mergeParentLanes = [];
    for (let p = 1; p < parents.length; p++) {
      const par = parents[p];
      let pl = findLane(par);
      if (pl === -1) {
        pl = allocLane();
        lanes[pl] = par;
      }
      mergeParentLanes.push({ parent: par, lane: pl });
    }

    // 4. Emit edges from THIS row (row) to the NEXT row (row+1) for every lane that
    //    is active after the reassignment. Each active lane draws a segment from its
    //    position at `row` to its position at `row+1`.
    //
    //    But a lane's column at `row` may differ from its column at `row+1` only when:
    //      (a) it's myLane and it just took over (came from myLane, continues at myLane) — vertical
    //      (b) it's a converging lane — handled below as a join segment into myLane
    //      (c) it's a merge-parent lane that was newly allocated at a different column
    //
    //    The simplest correct model: for each lane active in the NEXT row, draw a
    //    segment from where that lane's line was at THIS row to where it is at row+1.
    //    A lane that existed before at column X and still exists at column X → vertical.

    // Converging lanes are freed here; their visual descent into myLane is already
    // drawn by the first-parent carry segments emitted in pass 2 (the final segment
    // of each converging branch bends into myLane's column). No separate join edge
    // is needed, which avoids double-drawing.

    // For myLane continuing to first parent: the parent may be in a different column
    // than myLane (it usually isn't until the parent is actually placed). We DON'T know
    // the parent's final column yet, so we emit a per-row vertical "carry" below in pass 2.

    // Merge-parent connections (second+ parents) are drawn entirely in Pass 2c, where
    // every commit's final row/lane is known — so we can route the line in the correct
    // direction (the parent may be above OR below this merge commit). We only needed
    // the lane bookkeeping above (mergeParentLanes) to reserve lanes for the layout.
    void mergeParentLanes;

    if (lanes.length > maxLaneCount) maxLaneCount = lanes.length;
  }

  // ----- Pass 2: carry segments -----
  // For every commit, its first-parent line descends from this commit's row to the
  // parent's row, occupying myLane's column the whole way (until the parent, which
  // may shift columns at the very last segment). We emit one segment PER ROW so long
  // vertical runs are straight and only the final segment bends toward the parent's
  // column if it differs.
  for (let row = 0; row < commits.length; row++) {
    const c = commits[row];
    const pos = positions.get(c.hash);
    if (!pos) continue;
    const parents = c.parents || [];
    if (!parents.length) continue;

    const firstParent = parents[0];
    const fpPos = positions.get(firstParent);
    if (!fpPos) {
      // First parent is outside the loaded window. Draw the line continuing straight
      // down past the bottom edge so it reads as "history continues below" rather than
      // stopping mid-air at the commit's dot. Each row below this commit is owned by
      // another commit (which draws its own vertical), so we only need the segment(s)
      // from this commit's row down to the bottom, with the very last one fading off.
      const lastRow = commits.length - 1;
      for (let r = row; r <= lastRow; r++) {
        const isLast = (r === lastRow);
        edges.push({
          fromLane: pos.lane,
          toLane: pos.lane,
          fromRow: r,
          toRow: r + 1,
          colorLane: pos.lane,
          type: isLast ? 'continue-down' : 'carry'
        });
      }
      continue;
    }

    // Emit one straight vertical segment per row from row → fpPos.row-1 in pos.lane,
    // then a final segment from (pos.lane, fpPos.row-1) → (fpPos.lane, fpPos.row).
    for (let r = row; r < fpPos.row; r++) {
      const isLast = (r === fpPos.row - 1);
      edges.push({
        fromLane: pos.lane,
        toLane: isLast ? fpPos.lane : pos.lane,
        fromRow: r,
        toRow: r + 1,
        colorLane: pos.lane,
        type: 'carry'
      });
    }
  }

  // ----- Pass 2c: draw merge-parent (side branch) connections -----
  // For each merge commit, connect its dot to every extra parent (2nd, 3rd, ...).
  // The parent may sit BELOW (normal: branch merged in from history below) or ABOVE
  // (the merged-in branch tip is newer / drawn above the merge). We route per-row
  // segments in the correct direction so the side line is never cut off.
  for (let row = 0; row < commits.length; row++) {
    const c = commits[row];
    const pos = positions.get(c.hash);
    if (!pos) continue;
    const parents = c.parents || [];
    if (parents.length < 2) continue;

    for (let p = 1; p < parents.length; p++) {
      const par = parents[p];
      const pp = positions.get(par);
      if (!pp) {
        // Parent outside window — short stub down off this commit.
        edges.push({ fromLane: pos.lane, toLane: pos.lane, fromRow: row, toRow: row + 1, colorLane: pos.lane, type: 'merge-out' });
        continue;
      }
      if (pp.row > pos.row) {
        // Parent is BELOW: bend out from the merge dot to the parent's lane, then go down.
        // First segment bends from the merge lane toward the parent lane.
        edges.push({ fromLane: pos.lane, toLane: pp.lane, fromRow: row, toRow: row + 1, colorLane: pp.lane, type: 'merge-out' });
        // Fill straight down on the parent's lane to the parent row.
        for (let r = row + 1; r < pp.row; r++) {
          edges.push({ fromLane: pp.lane, toLane: pp.lane, fromRow: r, toRow: r + 1, colorLane: pp.lane, type: 'carry' });
        }
      } else if (pp.row < pos.row) {
        // Parent is ABOVE: connect upward. Draw from the parent's row down to the merge,
        // bending into the merge dot on the final segment. Use the parent's lane for the
        // vertical run, then bend into the merge dot's lane at the row just above it.
        for (let r = pp.row; r < row; r++) {
          const isLast = (r === row - 1);
          edges.push({
            fromLane: pp.lane,
            toLane: isLast ? pos.lane : pp.lane,
            fromRow: r,
            toRow: r + 1,
            colorLane: pp.lane,
            type: 'carry'
          });
        }
      }
    }
  }

  return { positions, edges, laneCount: Math.max(1, maxLaneCount) };
}

// ============================================
// GRAPH RENDERING
// ============================================
const GRAPH_ROW_H = 30;     // pixels per row
const GRAPH_LANE_W = 18;    // pixels per lane
const GRAPH_LANE_X0 = 14;   // left padding
const LANE_COLORS = [
  '#d4302f', // crusader red bright
  '#c8a04a', // gold
  '#6b8e23', // olive (allied)
  '#6db8c4', // teal
  '#b388d3', // purple
  '#e2a5a5', // rose
  '#c1d9a0', // pale green
  '#efe6d4'  // bone white
];
const laneColor = (lane) => LANE_COLORS[lane % LANE_COLORS.length];

function renderGraph() {
  const container = $('#graph-container');
  if (!container) return;
  const { commits, head, positions, edges, laneCount, hiddenCount, collapsedSet } = state.graph;

  if (!commits || !commits.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚔</div>
        <p>${state.graphLoading ? 'Summoning chronicle…' : 'No chronicles to display.'}</p>
      </div>
    `;
    renderGraphDetail(null);
    return;
  }

  // Build a hash → commit lookup once so click handlers don't do O(n) lookups
  const commitByHash = new Map();
  for (const c of commits) commitByHash.set(c.hash, c);

  const totalHeight = commits.length * GRAPH_ROW_H;
  const svgWidth = GRAPH_LANE_X0 + laneCount * GRAPH_LANE_W + 8;

  // Build SVG paths for edges (string array, joined at the end).
  // All edges span at most one row, so curves are small and local — a lane
  // only bends at the single boundary where it changes column.
  const edgeSvgParts = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const x1 = GRAPH_LANE_X0 + e.fromLane * GRAPH_LANE_W;
    const x2 = GRAPH_LANE_X0 + e.toLane * GRAPH_LANE_W;
    const color = laneColor(e.colorLane != null ? e.colorLane : e.fromLane);

    if (e.type === 'continue-down') {
      // Line continues toward a parent that isn't loaded — run it from the dot
      // straight down to the bottom edge of the SVG, fading out via a dashed stroke
      // that signals "history continues below".
      const yStart = e.fromRow * GRAPH_ROW_H + GRAPH_ROW_H / 2;
      const yEnd = totalHeight; // the very bottom edge
      edgeSvgParts[i] = `<line x1="${x1}" y1="${yStart}" x2="${x1}" y2="${yEnd}" stroke="${color}" stroke-width="2" stroke-dasharray="3 3" opacity="0.55"/>`;
      continue;
    }

    // 'carry' and 'merge-out' both span fromRow → toRow (one row apart)
    const y1 = e.fromRow * GRAPH_ROW_H + GRAPH_ROW_H / 2;
    const y2 = e.toRow * GRAPH_ROW_H + GRAPH_ROW_H / 2;
    if (x1 === x2) {
      edgeSvgParts[i] = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2"/>`;
    } else {
      const midY = y1 + (y2 - y1) / 2;
      edgeSvgParts[i] = `<path d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}" stroke="${color}" stroke-width="2" fill="none"/>`;
    }
  }

  // Build SVG circles for commits and the row list HTML
  const dotsSvg = new Array(commits.length);
  const rowsHtml = new Array(commits.length);
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const pos = positions.get(c.hash);
    if (!pos) { dotsSvg[i] = ''; rowsHtml[i] = ''; continue; }
    const cx = GRAPH_LANE_X0 + pos.lane * GRAPH_LANE_W;
    const cy = pos.row * GRAPH_ROW_H + GRAPH_ROW_H / 2;
    const color = laneColor(pos.lane);
    const isMerge = (c.parents || []).length > 1;
    const isHead = c.hash === head;
    const isCollapsed = collapsedSet && collapsedSet.has(c.hash);

    // A commit is collapsible if ANY parent is present in the view and sits below it
    // (there's a chain we can fold). Checking all parents — not just the first — means
    // merge commits fold even when their first parent is drawn above.
    let collapsible = isCollapsed;
    if (!collapsible) {
      for (const ph of (c.parents || [])) {
        const pp = positions.get(ph);
        if (pp && pp.row > pos.row) { collapsible = true; break; }
      }
    }

    const cls = 'commit-dot'
      + (isMerge ? ' merge' : '')
      + (isHead ? ' head' : '')
      + (isCollapsed ? ' collapsed' : '');
    const r = isMerge ? 6 : 5;
    // Left-click selects the commit & shows its diff; right-click folds/unfolds its
    // branch line (handled in the context-menu logic). We tag whether folding applies.
    let dot = `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="${isHead ? '#efe6d4' : '#0a0606'}" stroke-width="${isHead ? 2 : 1.5}" data-hash="${c.hash}" data-foldable="${collapsible ? '1' : ''}">`;
    if (collapsible) {
      dot += `<title style="pointer-events:none">${isCollapsed ? 'Right-click to expand this branch line' : 'Right-click to collapse this branch line'}</title>`;
    }
    dot += `</circle>`;
    dotsSvg[i] = dot;

    // Refs: build the pill HTML
    let refPills = '';
    if (c.refs && c.refs.length) {
      for (const r of c.refs) {
        if (r.type === 'tag') refPills += `<span class="ref-pill tag" data-ref-type="tag" data-ref-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>`;
        else if (r.type === 'local') {
          const headCls = r.isHead ? ' head' : '';
          refPills += `<span class="ref-pill local${headCls}" draggable="true" data-ref-type="local" data-ref-name="${escapeHtml(r.name)}" data-ref-hash="${escapeHtml(c.hash)}">${escapeHtml(r.name)}</span>`;
        } else if (r.type === 'remote') refPills += `<span class="ref-pill remote" data-ref-type="remote" data-ref-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>`;
        else if (r.type === 'head') refPills += `<span class="ref-pill head-only" data-ref-type="head">HEAD</span>`;
        else refPills += `<span class="ref-pill" data-ref-type="other">${escapeHtml(r.name)}</span>`;
      }
    }

    const shortHash = (c.hash || '').slice(0, 7);
    const dateStr = c.date ? relativeTime(c.date) : '';
    const selectedCls = state.selectedGraphHash === c.hash ? ' selected' : '';
    const headCls = isHead ? ' head' : '';
    // A clear, easy-to-click fold toggle at the start of the row for foldable commits.
    const foldToggle = collapsible
      ? `<button class="graph-fold-btn${isCollapsed ? ' collapsed' : ''}" data-fold="${c.hash}" title="${isCollapsed ? 'Expand branch line' : 'Collapse branch line'}" tabindex="-1">${isCollapsed ? '▸' : '▾'}</button>`
      : `<span class="graph-fold-spacer"></span>`;
    rowsHtml[i] =
      `<div class="graph-row${selectedCls}${headCls}" data-hash="${c.hash}" style="height:${GRAPH_ROW_H}px">` +
        foldToggle +
        `<span class="graph-row-msg">${refPills}${escapeHtml(c.message)}</span>` +
        `<span class="graph-row-author">${escapeHtml(c.author_name || '')}</span>` +
        `<span class="graph-row-date">${escapeHtml(dateStr)}</span>` +
        `<span class="graph-row-hash">${escapeHtml(shortHash)}</span>` +
      `</div>`;
  }

  // When collapsed, append a clickable summary row showing how many commits are hidden.
  const hiddenRowHtml = (hiddenCount && hiddenCount > 0)
    ? `<div class="graph-hidden-row" id="graph-hidden-row" title="Click to expand and show all commits">` +
        `<span class="graph-hidden-dots">⋯</span>` +
        `<span class="graph-hidden-label">${hiddenCount.toLocaleString()} earlier commit${hiddenCount === 1 ? '' : 's'} hidden — click to expand</span>` +
      `</div>`
    : '';

  container.innerHTML =
    `<div class="graph-svg-wrap" style="grid-template-columns: ${svgWidth}px 1fr">` +
      `<svg class="graph-svg" width="${svgWidth}" height="${totalHeight}" viewBox="0 0 ${svgWidth} ${totalHeight}">` +
        `<g class="graph-edges">${edgeSvgParts.join('')}</g>` +
        `<g class="graph-dots">${dotsSvg.join('')}</g>` +
      `</svg>` +
      `<div class="graph-rows" style="height:${totalHeight}px">${rowsHtml.join('')}</div>` +
    `</div>` +
    hiddenRowHtml;

  // ----- Event delegation ----- (one listener per kind on the container)
  // Cache for click handler — we look up commits via the map, no per-row .find()
  container._graphCommitsByHash = commitByHash;

  // Replace previously-attached delegated handlers (if any) to avoid stacking
  if (container._graphHandlers) {
    container.removeEventListener('click', container._graphHandlers.click);
    container.removeEventListener('dblclick', container._graphHandlers.dblclick);
    container.removeEventListener('contextmenu', container._graphHandlers.context);
    container.removeEventListener('dragstart', container._graphHandlers.dragstart);
    container.removeEventListener('dragend', container._graphHandlers.dragend);
    container.removeEventListener('dragover', container._graphHandlers.dragover);
    container.removeEventListener('dragleave', container._graphHandlers.dragleave);
    container.removeEventListener('drop', container._graphHandlers.drop);
  }

  const onClick = (e) => {
    // Click on the "hidden commits" summary row expands the global collapse.
    if (e.target.closest('.graph-hidden-row')) {
      state.graphCollapsed = false;
      updateGraphCollapseButton();
      relayoutGraph();
      return;
    }
    // Click on the inline fold toggle button folds/unfolds the commit's branch line.
    const foldBtn = e.target.closest('.graph-fold-btn');
    if (foldBtn && foldBtn.dataset.fold) {
      e.preventDefault();
      e.stopPropagation();
      toggleCommitFold(foldBtn.dataset.fold);
      return;
    }
    // Left-click on a commit dot OR its row selects the commit and shows its diff.
    const dot = e.target.closest('circle.commit-dot');
    const row = e.target.closest('.graph-row');
    const hash = (dot && dot.dataset.hash) || (row && row.dataset.hash);
    if (!hash) return;
    state.selectedGraphHash = hash;
    const prev = container.querySelector('.graph-row.selected');
    const targetRow = container.querySelector(`.graph-row[data-hash="${hash}"]`);
    if (prev && prev !== targetRow) prev.classList.remove('selected');
    if (targetRow) targetRow.classList.add('selected');
    const commit = container._graphCommitsByHash.get(hash);
    if (commit) renderGraphDetail(commit);
  };

  // Double-click a commit row or dot to fold/unfold its branch line (reliable,
  // easy-to-hit alternative to right-clicking the small dot).
  const onDblClick = (e) => {
    const dot = e.target.closest('circle.commit-dot');
    const row = e.target.closest('.graph-row');
    const hash = (dot && dot.dataset.hash) || (row && row.dataset.hash);
    if (!hash) return;
    const isCollapsed = state.collapsedCommits && state.collapsedCommits.has(hash);
    if (isCollapsed || commitIsFoldable(hash)) {
      e.preventDefault();
      toggleCommitFold(hash);
    }
  };

  const onContext = (e) => {
    // Ref-pill right click — handle ref menu instead
    const pill = e.target.closest('.ref-pill');
    if (pill) {
      e.preventDefault();
      e.stopPropagation();
      showRefContextMenu(pill.dataset.refType, pill.dataset.refName, e.pageX, e.pageY);
      return;
    }
    // Right-click directly on a commit DOT toggles folding of its branch line.
    const dot = e.target.closest('circle.commit-dot');
    if (dot && dot.dataset.hash) {
      const h = dot.dataset.hash;
      const isCollapsed = state.collapsedCommits && state.collapsedCommits.has(h);
      if (isCollapsed || commitIsFoldable(h)) {
        e.preventDefault();
        e.stopPropagation();
        toggleCommitFold(h);
        return;
      }
      // Not foldable — fall through to the normal commit context menu.
    }
    // Right-click elsewhere on the row shows the commit context menu.
    const row = e.target.closest('.graph-row');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    showCommitContextMenu(row.dataset.hash, e.pageX, e.pageY);
  };

  const onDragStart = (e) => {
    const pill = e.target.closest('.ref-pill[draggable="true"]');
    if (!pill) return;
    pill.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-gitgood-branch', pill.dataset.refName);
    e.dataTransfer.setData('text/plain', pill.dataset.refName);
  };

  const onDragEnd = (e) => {
    const pill = e.target.closest('.ref-pill.dragging');
    if (pill) pill.classList.remove('dragging');
  };

  const onDragOver = (e) => {
    if (!e.dataTransfer.types.includes('application/x-gitgood-branch')) return;
    const row = e.target.closest('.graph-row');
    if (!row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Avoid setting class on every move; only set if not already set
    if (!row.classList.contains('drop-allowed')) {
      // Clear previous highlight
      const prev = container.querySelector('.graph-row.drop-allowed');
      if (prev) prev.classList.remove('drop-allowed');
      row.classList.add('drop-allowed');
    }
  };

  const onDragLeave = (e) => {
    const row = e.target.closest('.graph-row');
    if (row && !row.contains(e.relatedTarget)) row.classList.remove('drop-allowed');
  };

  const onDrop = async (e) => {
    const row = e.target.closest('.graph-row');
    if (!row) return;
    row.classList.remove('drop-allowed');
    const branch = e.dataTransfer.getData('application/x-gitgood-branch');
    const targetHash = row.dataset.hash;
    if (!branch || !targetHash) return;
    e.preventDefault();
    await handleBranchDrop(branch, targetHash);
  };

  container.addEventListener('click', onClick);
  container.addEventListener('dblclick', onDblClick);
  container.addEventListener('contextmenu', onContext);
  container.addEventListener('dragstart', onDragStart);
  container.addEventListener('dragend', onDragEnd);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  container._graphHandlers = { click: onClick, dblclick: onDblClick, context: onContext, dragstart: onDragStart, dragend: onDragEnd, dragover: onDragOver, dragleave: onDragLeave, drop: onDrop };

  // If selection is still valid, show its detail; else clear
  if (state.selectedGraphHash) {
    const sel = commitByHash.get(state.selectedGraphHash);
    if (sel) renderGraphDetail(sel);
    else { state.selectedGraphHash = null; renderGraphDetail(null); }
  }
}

async function renderGraphDetail(commit) {
  const panel = $('#graph-detail');
  if (!panel) return;
  if (!commit) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚜</div>
        <p>Select a commit to inspect its deeds.</p>
      </div>
    `;
    return;
  }
  // Track the request so a slow load doesn't overwrite a newer selection
  const requestedHash = commit.hash;

  // Render metadata immediately
  panel.innerHTML = `
    <div class="detail-section">
      <div class="detail-header">⚜ Deed</div>
      <div class="detail-text">${escapeHtml(commit.message)}</div>
    </div>
    <div class="detail-section">
      <div class="detail-header">⚔ Author</div>
      <div class="detail-meta">${escapeHtml(commit.author_name || '')} <span>&lt;${escapeHtml(commit.author_email || '')}&gt;</span></div>
      <div class="detail-meta"><span>${commit.date ? new Date(commit.date).toLocaleString() : ''}</span></div>
    </div>
    <div class="detail-section">
      <div class="detail-header">⚜ Hash</div>
      <div class="detail-meta text-mono" style="word-break:break-all">${escapeHtml(commit.hash)}</div>
    </div>
    ${commit.parents && commit.parents.length > 1
      ? `<div class="detail-section"><div class="detail-header">⚒ Merge of ${commit.parents.length} parents</div><div class="detail-meta text-mono" style="word-break:break-all">${commit.parents.map(p => escapeHtml(p.slice(0,7))).join(' + ')}</div></div>`
      : ''}
    <div class="detail-section">
      <div class="detail-header detail-header-row">
        <span>⚒ Changes</span>
        ${diffModeToggleHtml()}
      </div>
      <div class="diff-content" id="graph-diff-content" style="border:1px solid var(--border);max-height:55vh"><div class="empty-state"><span class="loading"></span></div></div>
    </div>
  `;

  let details;
  try {
    details = await getCommitDetails(requestedHash);
  } catch (err) {
    const diffEl = panel.querySelector('#graph-diff-content');
    if (diffEl && state.selectedGraphHash === requestedHash) {
      diffEl.innerHTML = `<div class="empty-state"><p style="color:var(--crusader-red-bright)">⚔ Failed to load commit: ${escapeHtml(err.message || String(err))}</p></div>`;
    }
    return;
  }
  // Skip if user has selected a different commit while we were loading
  if (state.selectedGraphHash !== requestedHash) return;

  // Defer the diff render to a separate paint frame so metadata paints first.
  requestAnimationFrame(() => {
    // Re-check selection — user may have switched again during raf delay
    if (state.selectedGraphHash !== requestedHash) return;
    const diffEl = panel.querySelector('#graph-diff-content');
    if (!diffEl) return;
    renderCommitFileBrowser(diffEl, details.diff, {
      hash: requestedHash,
      diffTruncated: details.diffTruncated,
      diffBytes: details.diffBytes
    });
  });
}

// ============================================
// CONTEXT MENUS — commits and refs
// ============================================
function showCommitContextMenu(hash, x, y) {
  const shortHash = hash.slice(0, 7);
  const isCollapsed = state.collapsedCommits && state.collapsedCommits.has(hash);
  const foldable = isCollapsed || commitIsFoldable(hash);
  const items = [
    { label: 'Copy hash', icon: '⎘', action: () => { navigator.clipboard.writeText(hash); showToast('Hash copied', 'success'); } },
    { label: 'Copy short hash', icon: '⎘', action: () => { navigator.clipboard.writeText(shortHash); showToast('Short hash copied', 'success'); } },
    'sep',
    { label: `Checkout ${shortHash}`, icon: '⑂', action: () => checkoutCommit(hash) },
    { label: 'Create branch here…', icon: '+', action: () => showCreateBranchDialog(hash) },
    { label: 'Create tag here…', icon: '✠', action: () => showCreateTagDialog(hash) },
    'sep',
    { label: 'Cherry-pick onto current', icon: '⚒', action: () => doCherryPick(hash) },
    { label: 'Revert this commit', icon: '↶', action: () => doRevert(hash) },
    'sep',
    { label: 'Reset current branch to here…', icon: '↺', action: () => showResetDialog(hash) }
  ];
  if (foldable) {
    items.push('sep');
    items.push({
      label: isCollapsed ? 'Expand branch line below' : 'Collapse branch line below',
      icon: isCollapsed ? '⊞' : '⊟',
      action: () => toggleCommitFold(hash)
    });
  }
  showContextMenu(items, x, y);
}

// Is the commit currently foldable? Foldable when ANY of its parents is present in the
// view and sits below it (there's a chain we can fold away). We check all parents — not
// just the first — so merge commits whose first parent happens to be drawn above still
// fold via their other (below) parent. Lanes are not required to match.
function commitIsFoldable(hash) {
  const g = state.graph;
  if (!g || !g.positions) return false;
  const pos = g.positions.get(hash);
  if (!pos) return false;
  const c = (g.commits || []).find(x => x.hash === hash);
  if (!c) return false;
  const parents = c.parents || [];
  for (const ph of parents) {
    const pp = g.positions.get(ph);
    if (pp && pp.row > pos.row) return true;
  }
  return false;
}

// Toggle the per-commit fold for a given hash and re-render the graph.
function toggleCommitFold(hash) {
  if (!state.collapsedCommits) state.collapsedCommits = new Set();
  if (state.collapsedCommits.has(hash)) state.collapsedCommits.delete(hash);
  else state.collapsedCommits.add(hash);
  relayoutGraph();
}

function showRefContextMenu(refType, refName, x, y) {
  if (refType === 'local') {
    const current = state.branches.local && state.branches.local.current;
    const isCurrent = refName === current;
    const items = [];
    if (!isCurrent) {
      items.push({ label: `Checkout ${refName}`, icon: '⑂', action: () => checkoutBranch(refName) });
      items.push({ label: `Merge ${refName} into current (smart)`, icon: '⚒', action: () => showSmartMergeDialog(refName) });
    }
    items.push({ label: 'Rename branch…', icon: '✎', action: () => showRenameBranchDialog(refName) });
    items.push('sep');
    items.push({ label: 'Delete branch', icon: '✗', danger: true, action: () => deleteBranch(refName, false) });
    items.push({ label: 'Force delete', icon: '⚔', danger: true, action: () => deleteBranch(refName, true) });
    showContextMenu(items, x, y);
  } else if (refType === 'remote') {
    const local = refName.replace(/^[^/]+\//, '');
    showContextMenu([
      { label: `Checkout as local "${local}"`, icon: '⑂', action: () => checkoutRemoteBranch(refName, local) },
      { label: `Merge ${refName} into current (smart)`, icon: '⚒', action: () => showSmartMergeDialog(refName) },
      'sep',
      { label: 'Copy ref name', icon: '⎘', action: () => { navigator.clipboard.writeText(refName); showToast('Copied', 'success'); } }
    ], x, y);
  } else if (refType === 'tag') {
    showContextMenu([
      { label: `Checkout ${refName}`, icon: '⑂', action: () => checkoutCommit(refName) },
      { label: 'Copy tag name', icon: '⎘', action: () => { navigator.clipboard.writeText(refName); showToast('Copied', 'success'); } },
      'sep',
      { label: 'Delete tag', icon: '✗', danger: true, action: () => doDeleteTag(refName) }
    ], x, y);
  }
}

async function doCherryPick(hash) {
  const r = await withLoading('Cherry-picking', () => gs.cherryPick(hash));
  if (handleResult(r, 'Cherry-picked')) await refreshAll();
}
async function doRevert(hash) {
  const confirmed = await modal.confirm({
    title: 'Revert Commit',
    message: `Revert commit ${hash.slice(0, 7)}? A new commit will be created that undoes its changes.`,
    confirmText: 'Revert'
  });
  if (!confirmed) return;
  const r = await withLoading('Reverting', () => gs.revert(hash));
  if (handleResult(r, 'Reverted')) await refreshAll();
}
async function doDeleteTag(tagName) {
  const confirmed = await modal.confirm({
    title: 'Delete Tag',
    message: `Delete tag "${tagName}"?`,
    danger: true, confirmText: 'Delete'
  });
  if (!confirmed) return;
  const r = await gs.rawCommand(['tag', '-d', tagName]);
  if (handleResult(r, 'Tag deleted')) await refreshAll();
}

function showCreateTagDialog(hash) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Tag commit <code class="text-mono text-red">${escapeHtml(hash.slice(0,7))}</code></p>
    <div class="modal-field"><label>Tag Name</label><input class="modal-input" id="new-tag-name" placeholder="v1.0.0" /></div>
    <div class="modal-field"><label>Message (optional, creates annotated tag)</label><input class="modal-input" id="new-tag-msg" placeholder="Release notes…" /></div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const createBtn = document.createElement('button');
  createBtn.className = 'btn-medieval primary'; createBtn.textContent = 'Create Tag';
  createBtn.onclick = async () => {
    const name = $('#new-tag-name').value.trim();
    const msg = $('#new-tag-msg').value.trim();
    if (!name) { showToast('Tag name required', 'error'); return; }
    modal.hide();
    const args = ['tag'];
    if (msg) args.push('-a', name, '-m', msg, hash);
    else args.push(name, hash);
    const r = await gs.rawCommand(args);
    if (handleResult(r, `Tag ${name} forged`)) await refreshAll();
  };
  modal.show({ title: 'Create Tag', body, footer: [cancelBtn, createBtn] });
}

function showRenameBranchDialog(oldName) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Rename branch <code class="text-mono text-red">${escapeHtml(oldName)}</code></p>
    <div class="modal-field"><label>New Name</label><input class="modal-input" id="rename-branch-name" value="${escapeHtml(oldName)}" /></div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary'; okBtn.textContent = 'Rename';
  okBtn.onclick = async () => {
    const newName = $('#rename-branch-name').value.trim();
    if (!newName) { showToast('Name required', 'error'); return; }
    if (newName === oldName) { modal.hide(); return; }
    modal.hide();
    const r = await gs.rawCommand(['branch', '-m', oldName, newName]);
    if (handleResult(r, `Renamed to ${newName}`)) await refreshAll();
  };
  modal.show({ title: 'Rename Branch', body, footer: [cancelBtn, okBtn] });
}

function showResetDialog(hash) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Reset the current branch to <code class="text-mono text-red">${escapeHtml(hash.slice(0,7))}</code>.</p>
    <div class="merge-strategies">
      <label class="merge-strategy selected">
        <input type="radio" name="reset-mode" value="mixed" checked />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Mixed (default)</div>
          <div class="merge-strategy-desc">Move HEAD to this commit. Keep working tree changes but unstage them. <strong>Safe.</strong></div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="reset-mode" value="soft" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Soft</div>
          <div class="merge-strategy-desc">Move HEAD only. Keep everything staged and in the working tree. <strong>Safest.</strong></div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="reset-mode" value="hard" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Hard ⚠</div>
          <div class="merge-strategy-desc">Move HEAD and <strong>discard all uncommitted changes and staged files</strong>. Cannot be undone.</div>
        </div>
      </label>
    </div>
  `;
  // Radio selection visuals
  body.querySelectorAll('.merge-strategy').forEach(card => {
    card.onclick = (e) => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
      body.querySelectorAll('.merge-strategy').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    };
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval danger'; okBtn.textContent = 'Reset';
  okBtn.onclick = async () => {
    const mode = body.querySelector('input[name="reset-mode"]:checked').value;
    modal.hide();
    if (mode === 'hard') {
      const sure = await modal.confirm({
        title: 'Confirm Hard Reset',
        message: 'This will permanently discard uncommitted changes. Continue?',
        danger: true, confirmText: 'Yes, reset hard'
      });
      if (!sure) return;
    }
    const r = await withLoading('Resetting', () => gs.reset({ hash, mode }));
    if (handleResult(r, `Reset (${mode}) complete`)) await refreshAll();
  };
  modal.show({ title: 'Reset Current Branch', body, footer: [cancelBtn, okBtn] });
}

// ============================================
// BRANCH DROP — drag a branch pill onto a commit row
// ============================================
async function handleBranchDrop(branch, targetHash) {
  // Confirm — if it's the current branch, this triggers a reset-hard via moveBranch
  const isCurrent = state.branches.local && state.branches.local.current === branch;
  const message = isCurrent
    ? `Move the CURRENT branch "${branch}" to commit ${targetHash.slice(0,7)}? This performs a hard reset and discards uncommitted changes.`
    : `Move branch "${branch}" to commit ${targetHash.slice(0,7)}? (Uses git branch -f)`;
  const confirmed = await modal.confirm({
    title: isCurrent ? 'Move Current Branch (Hard Reset)' : 'Move Branch',
    message,
    danger: isCurrent,
    confirmText: 'Move'
  });
  if (!confirmed) return;
  const r = await withLoading('Moving branch', () => gs.moveBranch({ branch, hash: targetHash }));
  if (handleResult(r, `Moved ${branch}`)) await refreshAll();
}

// ============================================
// SMART MERGE MODAL
// ============================================
async function showSmartMergeDialog(branch) {
  if (!branch) return;
  // Fetch a preview from main
  const previewResult = await withLoading(`Analyzing merge of ${branch}`, () => gs.mergePreview(branch));
  if (!previewResult.ok) {
    showToast('Preview failed: ' + previewResult.error, 'error', 6000);
    return;
  }
  const preview = previewResult.data;
  const current = (state.branches.local && state.branches.local.current) || 'current branch';

  const incomingHtml = (preview.incoming || []).slice(0, 30).map(c => `
    <div class="merge-incoming-row">
      <span class="text-red text-mono">${escapeHtml(c.hash || '')}</span>
      <span>${escapeHtml(c.message || '')}</span>
      <span class="text-muted text-mono">${escapeHtml(c.author || '')}</span>
    </div>
  `).join('');

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Merge <strong class="text-red">${escapeHtml(branch)}</strong> into <strong>${escapeHtml(current)}</strong></p>

    <div class="merge-preview">
      <div class="merge-preview-row">
        <span>Incoming commits</span>
        <strong>${preview.behind || 0}</strong>
      </div>
      <div class="merge-preview-row">
        <span>Local-only commits</span>
        <strong>${preview.ahead || 0}</strong>
      </div>
      <div class="merge-preview-row">
        <span>Fast-forward possible</span>
        ${preview.canFastForward
          ? '<span class="merge-preview-ok">✓ Yes</span>'
          : '<span class="merge-preview-warn">✗ Diverged — merge commit needed</span>'}
      </div>
    </div>

    ${(preview.incoming && preview.incoming.length)
      ? `<label class="branches-label" style="display:block;margin-bottom:6px">⚒ Incoming Commits</label>
         <div class="merge-incoming">${incomingHtml}${preview.incoming.length > 30 ? `<div class="merge-incoming-row text-muted" style="grid-template-columns:1fr"><span>…and ${(preview.behind || 0) - 30} more</span></div>` : ''}</div>`
      : ''}

    <label class="branches-label" style="display:block;margin-bottom:6px">⚜ Strategy</label>
    <div class="merge-strategies" id="merge-strategy-cards">
      <label class="merge-strategy${preview.canFastForward ? ' selected' : ''}${!preview.canFastForward ? ' disabled' : ''}">
        <input type="radio" name="merge-strategy" value="ff-only" ${preview.canFastForward ? 'checked' : 'disabled'} />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Fast-forward (clean)</div>
          <div class="merge-strategy-desc">Just move the current branch pointer forward. ${preview.canFastForward ? 'Clean, no merge commit.' : 'Not available — branches have diverged.'}</div>
        </div>
      </label>
      <label class="merge-strategy${!preview.canFastForward ? ' selected' : ''}">
        <input type="radio" name="merge-strategy" value="auto" ${!preview.canFastForward ? 'checked' : ''} />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Default (auto)</div>
          <div class="merge-strategy-desc">Fast-forward if possible, otherwise create a merge commit.</div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="merge-strategy" value="no-ff" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Always create merge commit</div>
          <div class="merge-strategy-desc">Force a merge commit even when fast-forward is possible. Preserves branch history visually.</div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="merge-strategy" value="squash" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Squash</div>
          <div class="merge-strategy-desc">Combine all incoming commits into a single new commit on the current branch.</div>
        </div>
      </label>
    </div>

    <div class="modal-field" id="merge-msg-field" style="display:none">
      <label>Merge Commit Message</label>
      <input class="modal-input" id="merge-msg" placeholder="${escapeHtml(`Merge branch '${branch}' into ${current}`)}" />
    </div>
  `;

  // Radio interaction — toggle visual selection and show/hide message field
  const cards = body.querySelectorAll('.merge-strategy');
  const msgField = body.querySelector('#merge-msg-field');
  function syncSelectionUI() {
    const sel = body.querySelector('input[name="merge-strategy"]:checked');
    const val = sel ? sel.value : 'auto';
    cards.forEach(c => {
      const r = c.querySelector('input[type="radio"]');
      c.classList.toggle('selected', r && r.checked);
    });
    msgField.style.display = (val === 'no-ff' || val === 'squash') ? 'block' : 'none';
  }
  cards.forEach(card => {
    card.onclick = (e) => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio && !radio.disabled) {
        radio.checked = true;
        syncSelectionUI();
      }
    };
  });
  syncSelectionUI();

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary'; okBtn.innerHTML = '<span class="btn-icon">⚒</span> Merge';
  okBtn.onclick = async () => {
    const strategy = body.querySelector('input[name="merge-strategy"]:checked').value;
    const messageInput = body.querySelector('#merge-msg');
    const message = (messageInput && messageInput.value.trim()) || undefined;
    modal.hide();
    const r = await withLoading(`Merging ${branch}`, () => gs.merge({ branch, strategy, message }));
    if (!r.ok) {
      // Conflict — show a structured message
      if (/conflict/i.test(r.error)) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-medieval primary'; closeBtn.textContent = 'OK';
        closeBtn.onclick = () => modal.hide();
        const abortBtn = document.createElement('button');
        abortBtn.className = 'btn-medieval danger'; abortBtn.textContent = 'Abort Merge';
        abortBtn.onclick = async () => {
          modal.hide();
          const ar = await gs.mergeAbort();
          if (handleResult(ar, 'Merge aborted')) await refreshAll();
        };
        modal.show({
          title: 'Merge Conflict',
          body: `<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;color:var(--text-dim);line-height:1.5;max-height:50vh;overflow:auto">${escapeHtml(r.error)}</pre>`,
          footer: [abortBtn, closeBtn]
        });
        await refreshAll();
      } else {
        showToast(r.error, 'error', 8000);
      }
      return;
    }
    showToast(`Merged ${branch}`, 'success');
    await refreshAll();
  };
  modal.show({ title: 'Smart Merge', body, footer: [cancelBtn, okBtn] });
}

// ============================================
// CUSTOM SELECT DROPDOWN COMPONENT
// ============================================
// Used for the checkout / merge branch pickers in the Branches tab.
// Builds a styled dropdown with a search field, grouped by Local / Remote.
function setupCustomSelect({ triggerId, dropdownId, placeholder, onSelect, getCurrentValue }) {
  const trigger = document.getElementById(triggerId);
  const dropdown = document.getElementById(dropdownId);
  if (!trigger || !dropdown) return null;
  const container = trigger.parentElement;
  let currentSearch = '';
  let currentValue = null;

  function setLabel(value) {
    currentValue = value;
    const span = trigger.querySelector('.cs-text');
    if (!span) return;
    if (value) {
      span.textContent = value;
      span.classList.remove('placeholder');
    } else {
      span.textContent = placeholder || 'Select…';
      span.classList.add('placeholder');
    }
  }

  function close() {
    container.classList.remove('open');
    currentSearch = '';
  }

  function open() {
    // Close any other open dropdowns
    document.querySelectorAll('.custom-select.open').forEach(el => { if (el !== container) el.classList.remove('open'); });
    container.classList.add('open');
    rebuildOptions();
    setTimeout(() => {
      const s = dropdown.querySelector('.cs-search');
      if (s) s.focus();
    }, 50);
  }

  function rebuildOptions() {
    const { local, remotes } = state.branches || {};
    const localAll = (local && local.all) || [];
    const remoteAll = (remotes && remotes.all) || [];
    const currentBranch = (local && local.current) || '';
    const filter = currentSearch.trim().toLowerCase();

    const filteredLocal = localAll.filter(b => !filter || b.toLowerCase().includes(filter));
    const filteredRemote = remoteAll.filter(b => !filter || b.toLowerCase().includes(filter));

    const parts = [`
      <div class="cs-search-wrap">
        <input type="text" class="cs-search" placeholder="Filter branches…" value="${escapeHtml(currentSearch)}" />
      </div>
    `];

    if (filteredLocal.length) {
      parts.push(`<div class="cs-group-label">Local</div>`);
      for (const b of filteredLocal) {
        const isCurrent = b === currentBranch;
        const isSelected = currentValue === b;
        const meta = isCurrent ? '<span class="cs-option-meta">current</span>' : '';
        parts.push(`
          <div class="cs-option${isSelected ? ' selected' : ''}${isCurrent ? ' disabled' : ''}" data-value="${escapeHtml(b)}" data-is-current="${isCurrent}">
            <span class="cs-option-icon">⑂</span>
            <span>${escapeHtml(b)}</span>
            ${meta}
          </div>
        `);
      }
    }
    if (filteredRemote.length) {
      parts.push(`<div class="cs-group-label">Remote</div>`);
      for (const b of filteredRemote) {
        const isSelected = currentValue === b;
        parts.push(`
          <div class="cs-option${isSelected ? ' selected' : ''}" data-value="${escapeHtml(b)}">
            <span class="cs-option-icon" style="color:#6b8e23">⟁</span>
            <span>${escapeHtml(b)}</span>
          </div>
        `);
      }
    }
    if (!filteredLocal.length && !filteredRemote.length) {
      parts.push(`<div class="cs-empty">${filter ? 'No matches' : 'No branches'}</div>`);
    }

    dropdown.innerHTML = parts.join('');

    const searchInput = dropdown.querySelector('.cs-search');
    if (searchInput) {
      searchInput.oninput = () => {
        currentSearch = searchInput.value;
        rebuildOptions();
      };
      searchInput.onkeydown = (e) => {
        if (e.key === 'Escape') { close(); trigger.focus(); }
      };
    }
    dropdown.querySelectorAll('.cs-option').forEach(opt => {
      opt.onclick = () => {
        if (opt.classList.contains('disabled')) return;
        const val = opt.dataset.value;
        setLabel(val);
        close();
        if (onSelect) onSelect(val);
      };
    });
  }

  trigger.onclick = (e) => {
    e.stopPropagation();
    if (container.classList.contains('open')) close();
    else open();
  };
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) close();
  });

  // Initial label
  setLabel(getCurrentValue ? getCurrentValue() : null);

  return { setLabel, open, close, rebuild: rebuildOptions };
}

// ============================================
// BRANCHES TAB
// ============================================
let checkoutSelectCtl = null;
let mergeSelectCtl = null;

function renderBranchesTab() {
  // Update current banner card
  const card = $('#branches-current-card');
  if (card) {
    const current = (state.branches.local && state.branches.local.current) || '';
    card.textContent = current ? '⑂ ' + current : '— no branch —';
  }

  // Lazy-init the custom selects on first render
  if (!checkoutSelectCtl) {
    checkoutSelectCtl = setupCustomSelect({
      triggerId: 'checkout-trigger',
      dropdownId: 'checkout-dropdown',
      placeholder: 'Select a branch…',
      onSelect: (val) => { state.checkoutTarget = val; }
    });
  } else {
    checkoutSelectCtl.rebuild();
  }
  if (!mergeSelectCtl) {
    mergeSelectCtl = setupCustomSelect({
      triggerId: 'merge-trigger',
      dropdownId: 'merge-dropdown',
      placeholder: 'Select a branch to merge…',
      onSelect: (val) => { state.mergeTarget = val; }
    });
  } else {
    mergeSelectCtl.rebuild();
  }

  // Render the full branches list
  renderBranchesFullList();
}

function renderBranchesFullList() {
  const list = $('#branches-full-list');
  if (!list) return;
  const { local, remotes } = state.branches || {};
  const localAll = (local && local.all) || [];
  const remoteAll = (remotes && remotes.all) || [];
  const currentBranch = (local && local.current) || '';
  const filter = (state.branchesFilter || '').trim().toLowerCase();
  const matches = (b) => !filter || b.toLowerCase().includes(filter);

  const filteredLocal = localAll.filter(matches);
  const filteredRemote = remoteAll.filter(matches);

  const rows = [];

  filteredLocal.forEach(b => {
    const isCurrent = b === currentBranch;
    rows.push(`
      <li class="branch-row${isCurrent ? ' is-current' : ''}" data-branch="${escapeHtml(b)}" data-kind="local">
        <span class="branch-icon">⑂</span>
        <span class="branch-name">${escapeHtml(b)}</span>
        <span class="branch-type-pill">${isCurrent ? 'Current' : 'Local'}</span>
        <span class="branch-actions">
          ${!isCurrent ? `<button class="mini-btn" data-action="checkout">Checkout</button>` : ''}
          ${!isCurrent ? `<button class="mini-btn" data-action="merge">Merge</button>` : ''}
          ${!isCurrent ? `<button class="mini-btn" data-action="delete">Delete</button>` : ''}
        </span>
      </li>
    `);
  });
  filteredRemote.forEach(b => {
    rows.push(`
      <li class="branch-row is-remote" data-branch="${escapeHtml(b)}" data-kind="remote">
        <span class="branch-icon">⟁</span>
        <span class="branch-name">${escapeHtml(b)}</span>
        <span class="branch-type-pill">Remote</span>
        <span class="branch-actions">
          <button class="mini-btn" data-action="checkout-remote">Checkout</button>
          <button class="mini-btn" data-action="merge">Merge</button>
        </span>
      </li>
    `);
  });

  if (!rows.length) {
    list.innerHTML = `<li class="file-empty">${filter ? 'No matches' : 'No branches'}</li>`;
    return;
  }
  list.innerHTML = rows.join('');

  list.querySelectorAll('.branch-row').forEach(row => {
    const branch = row.dataset.branch;
    const kind = row.dataset.kind;
    row.oncontextmenu = (e) => {
      e.preventDefault();
      if (kind === 'local') showRefContextMenu('local', branch, e.pageX, e.pageY);
      else showRefContextMenu('remote', branch, e.pageX, e.pageY);
    };
    row.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const a = btn.dataset.action;
        if (a === 'checkout') checkoutBranch(branch);
        else if (a === 'checkout-remote') {
          const local = branch.replace(/^[^/]+\//, '');
          checkoutRemoteBranch(branch, local);
        }
        else if (a === 'merge') showSmartMergeDialog(branch);
        else if (a === 'delete') deleteBranch(branch, false);
      };
    });
  });
}

// Wire up branches tab buttons (once)
function wireBranchesTab() {
  const filter = $('#branches-filter');
  if (filter) {
    filter.oninput = () => { state.branchesFilter = filter.value; renderBranchesFullList(); };
  }
  const checkoutBtn = $('#checkout-btn');
  if (checkoutBtn) {
    checkoutBtn.onclick = () => {
      if (!state.checkoutTarget) { showToast('Select a branch first', 'error'); return; }
      const target = state.checkoutTarget;
      const remotes = (state.branches.remotes && state.branches.remotes.all) || [];
      if (remotes.includes(target)) {
        const local = target.replace(/^[^/]+\//, '');
        checkoutRemoteBranch(target, local);
      } else {
        checkoutBranch(target);
      }
    };
  }
  const mergeBtn = $('#merge-btn');
  if (mergeBtn) {
    mergeBtn.onclick = () => {
      if (!state.mergeTarget) { showToast('Select a branch first', 'error'); return; }
      showSmartMergeDialog(state.mergeTarget);
    };
  }
  const newBranchBtn = $('#new-branch-btn');
  if (newBranchBtn) {
    newBranchBtn.onclick = async () => {
      const name = $('#new-branch-input').value.trim();
      const checkout = $('#new-branch-checkout').checked;
      if (!name) { showToast('Branch name required', 'error'); return; }
      const r = await gs.createBranch({ name, checkout });
      if (handleResult(r, `Branch ${name} forged`)) {
        $('#new-branch-input').value = '';
        await refreshAll();
      }
    };
  }
  const newInput = $('#new-branch-input');
  if (newInput) {
    newInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#new-branch-btn').click();
    });
  }
}

// Wire up graph tab controls (once)
function wireGraphTab() {
  const limit = $('#graph-limit');
  if (limit) {
    limit.onchange = async () => {
      let v = parseInt(limit.value, 10);
      if (isNaN(v) || v < 50) return;
      // Hard cap — beyond this the renderer becomes unresponsive without virtual scrolling.
      const HARD_CAP = 5000;
      if (v > HARD_CAP) {
        const ok = await modal.confirm({
          title: 'Large Chronicle',
          message: `Rendering more than ${HARD_CAP.toLocaleString()} commits may slow the app or cause it to lock up. Continue with ${v.toLocaleString()}? (Recommended: keep at ${HARD_CAP.toLocaleString()} or below.)`,
          danger: true,
          confirmText: 'Continue'
        });
        if (!ok) {
          v = HARD_CAP;
          limit.value = v;
        }
      }
      state.graphLimit = v;
      refreshGraph();
    };
  }
  const refresh = $('#graph-refresh');
  if (refresh) refresh.onclick = () => refreshGraph();

  const collapseBtn = $('#graph-collapse-toggle');
  if (collapseBtn) collapseBtn.onclick = () => {
    state.graphCollapsed = !state.graphCollapsed;
    updateGraphCollapseButton();
    relayoutGraph();
  };
  updateGraphCollapseButton();

  // Graph search/filter (debounced so typing stays smooth on large graphs)
  const graphSearch = $('#graph-search');
  if (graphSearch) {
    let t = null;
    graphSearch.value = state.graphFilter || '';
    graphSearch.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.graphFilter = graphSearch.value;
        relayoutGraph();
      }, 180);
    };
    // Escape clears the filter
    graphSearch.onkeydown = (e) => {
      if (e.key === 'Escape') { graphSearch.value = ''; state.graphFilter = ''; relayoutGraph(); }
    };
  }

  // History search/filter
  const historySearch = $('#history-search');
  if (historySearch) {
    let t2 = null;
    historySearch.value = state.historyFilter || '';
    historySearch.oninput = () => {
      clearTimeout(t2);
      t2 = setTimeout(() => {
        state.historyFilter = historySearch.value;
        renderHistory();
      }, 180);
    };
    historySearch.onkeydown = (e) => {
      if (e.key === 'Escape') { historySearch.value = ''; state.historyFilter = ''; renderHistory(); }
    };
  }
}

// Reflect the collapse state on the toolbar button.
function updateGraphCollapseButton() {
  const btn = document.getElementById('graph-collapse-toggle');
  if (!btn) return;
  if (state.graphCollapsed) {
    btn.innerHTML = '⊞ Expand';
    btn.title = 'Show all commits';
    btn.classList.add('active');
  } else {
    btn.innerHTML = '⊟ Collapse';
    btn.title = `Collapse the middle of long history, showing only the newest ${GRAPH_COLLAPSE_VISIBLE} commits`;
    btn.classList.remove('active');
  }
}

// Call wiring on load (idempotent since onclick reassigns)
wireBranchesTab();
wireGraphTab();

// Detached-HEAD banner buttons
(() => {
  const ret = document.getElementById('detached-banner-return');
  if (ret) ret.onclick = () => returnToBranch();
  const nb = document.getElementById('detached-banner-newbranch');
  if (nb) nb.onclick = () => {
    const head = (state.status && state.status.headHash) || 'HEAD';
    showCreateBranchDialog(head);
  };
})();

// ============================================
// OPERATION PROGRESS (clone/pull/push/fetch/lfs) — feeds real % into opProgress
// ============================================
(() => {
  if (!gs.onOpProgress) return;

  // Human-friendly labels for simple-git's stage names
  const STAGE_LABELS = {
    'receiving': 'Receiving',
    'counting': 'Counting',
    'compressing': 'Compressing',
    'writing': 'Writing',
    'resolving': 'Resolving',
    'remote:': 'Remote'
  };

  gs.onOpProgress((p) => {
    if (p.done || p.active === false) {
      // The withLoading wrapper around the operation will call end(); but if a
      // transfer finished without that wrapper, make sure we settle the bar.
      // We only force-complete the bar's fill here; hiding is handled by end().
      opProgress.setPercent(100);
      return;
    }

    // Build label: "Method · Stage"
    const method = (p.method || '').toString();
    const stageRaw = (p.stage || '').toString().toLowerCase();
    const stage = STAGE_LABELS[stageRaw] || (p.stage || '');
    const label = [method, stage].filter(Boolean).join(' · ') || 'Working';

    const hasPct = typeof p.progress === 'number' && !isNaN(p.progress) && p.progress > 0;
    if (hasPct) {
      opProgress.setPercent(p.progress, label);
    } else {
      // No percentage yet — keep an indeterminate bar with the label (without
      // touching the active-operation counter that begin()/end() manage).
      opProgress.indeterminate(label);
    }
  });
})();


gs.onMenu('menu-open-repo', () => openRepoDialog());
gs.onMenu('menu-clone-repo', () => showCloneDialog());
gs.onMenu('menu-about', () => {
  modal.show({
    title: 'About GitGood',
    body: `
      <div style="text-align:center;padding:20px">
        <div style="font-family:var(--font-display);font-size:32px;color:var(--bone-white);letter-spacing:0.15em;margin-bottom:8px">GitGood</div>
        <div style="font-family:var(--font-ornament);color:var(--parchment-dim);margin-bottom:16px">⚜ Version 1.0.0 ⚜</div>
        <p class="modal-text">A medieval-themed Git GUI client forged in the fires of the crusade.</p>
        <p class="modal-text" style="font-size:12px;color:var(--muted-text)">Built with Electron and simple-git.</p>
      </div>
    `,
    footer: (() => {
      const b = document.createElement('button');
      b.className = 'btn-medieval primary';
      b.textContent = 'Close';
      b.onclick = () => modal.hide();
      return b;
    })()
  });
});

// ============================================
// DISK MANAGEMENT
// ============================================
const _diskState = { loaded: false, lastData: null, stale: false };

// Show a subtle hint that the disk figures may be out of date (repo changed since
// the last scan). We don't rescan automatically — the user clicks Refresh to update.
function markDiskStale() {
  const refreshBtn = document.getElementById('disk-refresh');
  if (refreshBtn && _diskState.loaded) {
    refreshBtn.classList.add('stale');
    refreshBtn.title = 'Figures may be out of date — click to recalculate';
  }
}
function clearDiskStale() {
  _diskState.stale = false;
  const refreshBtn = document.getElementById('disk-refresh');
  if (refreshBtn) {
    refreshBtn.classList.remove('stale');
    refreshBtn.title = 'Recalculate disk usage';
  }
}

function fmtBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Subscription handle for disk progress; we unsubscribe between scans.
let _diskProgressUnsub = null;

async function refreshDiskUsage() {
  const loading = $('#disk-loading');
  const summary = $('#disk-summary');
  const progress = $('#disk-progress');

  // Drop any previous progress subscription so its events don't bleed into this scan.
  if (_diskProgressUnsub) { try { _diskProgressUnsub(); } catch (e) {} _diskProgressUnsub = null; }

  // Subscribe to streaming progress for the upcoming scan. The backend automatically
  // cancels any in-flight scan when a new diskUsage() call arrives (token bump),
  // so we don't need a manual cancel here.
  _diskProgressUnsub = gs.onDiskProgress((payload) => {
    if (!progress) return;
    if (payload.done) {
      progress.classList.add('hidden');
      return;
    }
    progress.classList.remove('hidden');
    const label = payload.label || payload.phase || 'Scanning';
    const bytes = payload.bytes ? fmtBytes(payload.bytes) : '';
    const files = payload.files ? payload.files.toLocaleString() + ' files' : '';
    const detail = [bytes, files].filter(Boolean).join(' · ');
    const labelEl = progress.querySelector('.disk-progress-label');
    const detailEl = progress.querySelector('.disk-progress-detail');
    if (labelEl) labelEl.textContent = label + '…';
    if (detailEl) detailEl.textContent = detail;
  });

  // Show progress UI
  if (loading) loading.style.display = 'none';
  if (progress) progress.classList.remove('hidden');
  if (summary) summary.style.display = 'flex';

  let r;
  try {
    r = await gs.diskUsage();
  } finally {
    if (_diskProgressUnsub) { try { _diskProgressUnsub(); } catch (e) {} _diskProgressUnsub = null; }
    if (progress) progress.classList.add('hidden');
  }

  if (!r.ok) {
    if (loading) { loading.style.display = ''; loading.textContent = 'Failed: ' + r.error; }
    if (summary) summary.style.display = 'none';
    return;
  }
  if (r.data && r.data.cancelled) {
    if (loading) { loading.style.display = ''; loading.textContent = 'Cancelled — click to retry'; }
    return;
  }
  _diskState.lastData = r.data;
  _diskState.loaded = true;
  clearDiskStale();
  if (loading) loading.style.display = 'none';
  if (summary) summary.style.display = 'flex';

  const { sizes, counts, lfs } = r.data;
  const total = sizes.workingTree + sizes.gitTotal;

  $('#disk-grand-total').textContent = fmtBytes(total);
  $('#disk-total-pill').textContent = fmtBytes(total);
  $('#disk-working').textContent = fmtBytes(sizes.workingTree);
  $('#disk-gitdir').textContent = fmtBytes(sizes.gitTotal);
  $('#disk-packed').textContent = fmtBytes(sizes.objectsPacked);
  $('#disk-loose').textContent = fmtBytes(sizes.objectsLoose);
  $('#disk-logs').textContent = fmtBytes(sizes.logs);

  if (lfs.installed) {
    $('#disk-lfs-row').style.display = '';
    $('#disk-lfs').textContent = lfs.objectSize ? `${fmtBytes(lfs.objectSize)} (${lfs.objectCount} files)` : 'installed (no cache yet)';
    $('#disk-lfs-prune').style.display = '';
  } else {
    $('#disk-lfs-row').style.display = 'none';
    $('#disk-lfs-prune').style.display = 'none';
  }

  // Stacked bar
  const fill = $('#disk-bar-fill');
  const segs = [
    { cls: 'working', value: sizes.workingTree, label: 'Working' },
    { cls: 'packed',  value: sizes.objectsPacked, label: 'Packed' },
    { cls: 'loose',   value: sizes.objectsLoose,  label: 'Loose' },
    { cls: 'logs',    value: sizes.logs,          label: 'Logs' }
  ];
  if (lfs.installed && lfs.objectSize) {
    segs.push({ cls: 'lfs', value: lfs.objectSize, label: 'LFS' });
  }
  // "Other" = gitTotal - packed - loose - logs - lfs
  const accountedGit = sizes.objectsPacked + sizes.objectsLoose + sizes.logs + (lfs.installed ? lfs.objectSize : 0);
  const otherGit = Math.max(0, sizes.gitTotal - accountedGit);
  if (otherGit > 0) segs.push({ cls: 'other', value: otherGit, label: 'Other' });

  const sum = segs.reduce((a, s) => a + s.value, 0) || 1;
  fill.innerHTML = segs.filter(s => s.value > 0)
    .map(s => `<div class="disk-bar-seg ${s.cls}" style="width:${(s.value / sum * 100).toFixed(2)}%" title="${s.label}: ${fmtBytes(s.value)}"></div>`)
    .join('');

  // Legend (only segments with > 1% share)
  $('#disk-legend').innerHTML = segs.filter(s => s.value > 0)
    .map(s => `<span><span class="swatch" style="background:${segColor(s.cls)}"></span>${s.label}</span>`)
    .join('');

  // Counts
  $('#disk-c-local').textContent = counts.localBranches;
  $('#disk-c-remote').textContent = counts.remoteBranches;
  $('#disk-c-tags').textContent = counts.tags;
  $('#disk-c-stash').textContent = counts.stashes;
  $('#disk-c-reflog').textContent = counts.reflogEntries;
}

function segColor(cls) {
  return {
    working: '#6b8e23',
    packed: 'var(--crusader-red)',
    loose: 'var(--gold-accent)',
    logs: '#6db8c4',
    lfs: '#b388d3',
    other: 'var(--border-bright)'
  }[cls] || '#888';
}

// Wire up the disk management section
(() => {
  // Clicking the header loads data the first time
  const section = document.getElementById('section-disk');
  if (section) {
    const header = section.querySelector('.sidebar-header');
    if (header) {
      header.addEventListener('click', () => {
        // After the collapse toggle (handled elsewhere), if expanded and not yet loaded, load
        setTimeout(() => {
          if (!section.classList.contains('collapsed') && !_diskState.loaded && state.repo) {
            refreshDiskUsage();
          }
        }, 50);
      });
    }
  }

  // Loading placeholder click also triggers load
  const loading = $('#disk-loading');
  if (loading) loading.onclick = () => {
    if (state.repo) refreshDiskUsage();
    else showToast('Open a repository first', 'error');
  };

  // Action buttons
  const wire = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.onclick = handler;
  };

  wire('disk-refresh', () => refreshDiskUsage());
  wire('disk-progress-cancel', async () => {
    try { await gs.diskUsageCancel(); } catch (e) {}
  });

  wire('disk-gc', async () => {
    const ok = await modal.confirm({
      title: 'Run Git Garbage Collection',
      message: 'Pack loose objects and remove unreachable ones older than 2 weeks. This is the standard cleanup operation.',
      confirmText: 'Run GC'
    });
    if (!ok) return;
    const r = await withLoading('Running gc', () => gs.gc({}));
    if (handleResult(r, 'GC complete')) await refreshDiskUsage();
  });

  wire('disk-gc-aggressive', async () => {
    const ok = await modal.confirm({
      title: 'Aggressive Garbage Collection',
      message: 'Slower but achieves maximum compression by repacking everything. Use sparingly — may take minutes on large repos.',
      confirmText: 'Run Aggressive GC'
    });
    if (!ok) return;
    const r = await withLoading('Aggressive gc — this may take a while', () => gs.gc({ aggressive: true, prune: true, pruneSpec: 'now' }));
    if (handleResult(r, 'Aggressive GC complete')) await refreshDiskUsage();
  });

  wire('disk-prune', async () => {
    const ok = await modal.confirm({
      title: 'Prune Unreachable Objects',
      message: 'Permanently delete loose objects that aren\'t reachable from any branch, tag, or reflog. Anything in the reflog (within its expiry window) is preserved.',
      danger: true,
      confirmText: 'Prune'
    });
    if (!ok) return;
    const r = await withLoading('Pruning', () => gs.prune());
    if (handleResult(r, 'Prune complete')) await refreshDiskUsage();
  });

  wire('disk-repack', async () => {
    const ok = await modal.confirm({
      title: 'Repack Objects',
      message: 'Repack all objects into a single pack file. Useful after large pulls or merges.',
      confirmText: 'Repack'
    });
    if (!ok) return;
    const r = await withLoading('Repacking', () => gs.repack());
    if (handleResult(r, 'Repack complete')) await refreshDiskUsage();
  });

  wire('disk-reflog', async () => {
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="modal-text">Expire reflog entries to free disk space. The reflog records every HEAD update and grows over time.</p>
      <div class="merge-strategies">
        <label class="merge-strategy selected">
          <input type="radio" name="reflog-mode" value="all" checked />
          <div class="merge-strategy-body">
            <div class="merge-strategy-title">Expire All Now</div>
            <div class="merge-strategy-desc">Drop every reflog entry. <strong>You lose the ability to recover lost commits via the reflog.</strong></div>
          </div>
        </label>
        <label class="merge-strategy">
          <input type="radio" name="reflog-mode" value="unreachable" />
          <div class="merge-strategy-body">
            <div class="merge-strategy-title">Expire Unreachable</div>
            <div class="merge-strategy-desc">Drop only entries pointing to commits no longer reachable from refs. Safer.</div>
          </div>
        </label>
      </div>
    `;
    body.querySelectorAll('.merge-strategy').forEach(card => {
      card.onclick = () => {
        const radio = card.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
        body.querySelectorAll('.merge-strategy').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
      };
    });
    const cancel = document.createElement('button');
    cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
    cancel.onclick = () => modal.hide();
    const ok = document.createElement('button');
    ok.className = 'btn-medieval danger'; ok.textContent = 'Expire';
    ok.onclick = async () => {
      const mode = body.querySelector('input[name="reflog-mode"]:checked').value;
      modal.hide();
      const r = await withLoading('Expiring reflog', () => gs.reflogExpire(
        mode === 'all' ? { expire: 'now', expireUnreachable: 'now' } : { expire: 'never', expireUnreachable: 'now' }
      ));
      if (handleResult(r, 'Reflog expired')) await refreshDiskUsage();
    };
    modal.show({ title: 'Expire Reflog', body, footer: [cancel, ok] });
  });

  wire('disk-merged', async () => {
    const r = await withLoading('Listing branches', () => gs.mergedBranches());
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
    showBranchCleanupDialog(r.data);
  });

  wire('disk-largest', async () => {
    const r = await withLoading('Finding largest objects', () => gs.largestObjects(50));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
    showLargestObjectsDialog(r.data.objects);
  });

  wire('disk-lfs-prune', async () => {
    const ok = await modal.confirm({
      title: 'Prune Git LFS Objects',
      message: 'Remove LFS objects no longer referenced by any commit reachable from the current branch.',
      confirmText: 'Prune LFS'
    });
    if (!ok) return;
    const r = await withLoading('Pruning LFS', () => gs.lfsPrune());
    if (handleResult(r, 'LFS pruned')) await refreshDiskUsage();
  });

  wire('disk-lfs-manage', () => showLfsManager());
})();

// ============================================
// GIT LFS MANAGER
// ============================================
async function showLfsManager() {
  const infoR = await withLoading('Checking LFS', () => gs.lfsInfo());
  const info = (infoR && infoR.ok) ? infoR.data : { available: false };

  const body = document.createElement('div');
  body.className = 'lfs-manager';

  // Case 1: git-lfs not installed on the machine
  if (!info.available) {
    body.innerHTML = `
      <div class="lfs-status-banner not-available">
        <div class="lfs-status-icon">⚠</div>
        <div>
          <div class="lfs-status-title">Git LFS not found</div>
          <div class="lfs-status-text">The <code>git-lfs</code> command isn't installed or isn't on your PATH. Install it from <span class="text-mono">git-lfs.com</span>, then reopen this dialog.</div>
        </div>
      </div>
    `;
    const close = document.createElement('button');
    close.className = 'btn-medieval primary'; close.textContent = 'Close';
    close.onclick = () => modal.hide();
    modal.show({ title: '⛂ Git LFS', body, footer: [close] });
    return;
  }

  // Render the full manager
  function render() {
    const patterns = info.patterns || [];
    body.innerHTML = `
      <div class="lfs-status-banner ${info.initialized ? 'ok' : 'warn'}">
        <div class="lfs-status-icon">${info.initialized ? '✓' : '⚠'}</div>
        <div>
          <div class="lfs-status-title">${info.initialized ? 'Git LFS is active in this repository' : 'Git LFS not initialized here'}</div>
          <div class="lfs-status-text">
            ${escapeHtml(info.version || '')}
            ${info.initialized ? ` · ${info.trackedFiles} tracked file${info.trackedFiles === 1 ? '' : 's'}` : ' · click Initialize to set up hooks & filters'}
          </div>
        </div>
        ${info.initialized ? '' : '<button class="btn-medieval primary" id="lfs-init" type="button">⚜ Initialize</button>'}
      </div>

      <div class="lfs-section">
        <div class="lfs-section-title">⚒ Transfer</div>
        <div class="lfs-btn-row">
          <button class="mini-btn" id="lfs-pull" type="button" title="Download LFS objects for the current checkout">⇣ Pull</button>
          <button class="mini-btn" id="lfs-fetch" type="button" title="Download LFS objects without checking out">⇣ Fetch</button>
          <button class="mini-btn" id="lfs-fetch-all" type="button" title="Fetch ALL LFS objects (every ref)">⇣ Fetch All</button>
          <button class="mini-btn" id="lfs-push" type="button" title="Upload LFS objects for the current branch">⇡ Push</button>
          <button class="mini-btn" id="lfs-push-all" type="button" title="Upload ALL LFS objects">⇡ Push All</button>
          <button class="mini-btn" id="lfs-checkout" type="button" title="Populate working copy from local LFS cache">⌬ Checkout</button>
          <button class="mini-btn" id="lfs-prune2" type="button" title="Prune unreferenced LFS objects">✕ Prune</button>
        </div>
      </div>

      <div class="lfs-section">
        <div class="lfs-section-title">⚜ Tracked Patterns (${patterns.length})</div>
        <div class="lfs-track-add">
          <input type="text" class="modal-input" id="lfs-pattern" placeholder="e.g. *.psd  or  assets/**/*.bin" />
          <button class="mini-btn primary" id="lfs-track-btn" type="button">+ Track</button>
        </div>
        ${patterns.length ? `
          <ul class="lfs-pattern-list">
            ${patterns.map(p => `
              <li class="lfs-pattern-item">
                <span class="lfs-pattern-name text-mono">${escapeHtml(p)}</span>
                <button class="mini-btn" data-untrack="${escapeHtml(p)}" type="button">✕ Untrack</button>
              </li>
            `).join('')}
          </ul>
        ` : '<div class="lfs-empty">No patterns tracked yet. Add one above (e.g. <code>*.psd</code>).</div>'}
      </div>

      <div class="lfs-section">
        <div class="lfs-section-title">⌗ Managed Files</div>
        <button class="mini-btn" id="lfs-list-files" type="button">List LFS files…</button>
        <div id="lfs-files-result"></div>
      </div>

      <div class="lfs-section">
        <div class="lfs-section-title">⚔ Migrate</div>
        <div class="lfs-status-text" style="margin-bottom:8px">Convert existing files already in history into LFS pointers. <strong class="text-red">Rewrites history</strong> — coordinate with collaborators first.</div>
        <div class="lfs-track-add">
          <input type="text" class="modal-input" id="lfs-migrate-pattern" placeholder="e.g. *.zip,*.bin (comma-separated)" />
          <button class="mini-btn" id="lfs-migrate-btn" type="button">⚔ Migrate Import</button>
        </div>
      </div>
    `;

    // Re-fetch info and re-render
    async function reload() {
      const r = await gs.lfsInfo();
      if (r && r.ok) { info.initialized = r.data.initialized; info.patterns = r.data.patterns; info.trackedFiles = r.data.trackedFiles; info.version = r.data.version; }
      render();
    }

    const byId = (id) => body.querySelector('#' + id);

    if (byId('lfs-init')) byId('lfs-init').onclick = async () => {
      const r = await withLoading('Initializing LFS', () => gs.lfsInstall());
      if (handleResult(r, 'Git LFS initialized')) await reload();
    };

    byId('lfs-pull').onclick = async () => {
      const r = await withLoading('LFS pull', () => gs.lfsPull());
      handleResult(r, 'LFS objects pulled');
    };
    byId('lfs-fetch').onclick = async () => {
      const r = await withLoading('LFS fetch', () => gs.lfsFetch({}));
      handleResult(r, 'LFS objects fetched');
    };
    byId('lfs-fetch-all').onclick = async () => {
      const r = await withLoading('LFS fetch --all', () => gs.lfsFetch({ all: true }));
      handleResult(r, 'All LFS objects fetched');
    };
    byId('lfs-push').onclick = async () => {
      const r = await withLoading('LFS push', () => gs.lfsPush({ remote: 'origin' }));
      handleResult(r, 'LFS objects pushed');
    };
    byId('lfs-push-all').onclick = async () => {
      const r = await withLoading('LFS push --all', () => gs.lfsPush({ remote: 'origin', all: true }));
      handleResult(r, 'All LFS objects pushed');
    };
    byId('lfs-checkout').onclick = async () => {
      const r = await withLoading('LFS checkout', () => gs.lfsCheckout());
      handleResult(r, 'LFS checkout complete');
    };
    byId('lfs-prune2').onclick = async () => {
      const ok = await modal.confirm({ title: 'Prune LFS', message: 'Remove unreferenced LFS objects from local cache?', confirmText: 'Prune' });
      if (!ok) return;
      const r = await withLoading('Pruning LFS', () => gs.lfsPrune());
      handleResult(r, 'LFS pruned');
    };

    byId('lfs-track-btn').onclick = async () => {
      const pat = byId('lfs-pattern').value.trim();
      if (!pat) { showToast('Enter a pattern', 'error'); return; }
      const r = await withLoading('Tracking ' + pat, () => gs.lfsTrack(pat));
      if (handleResult(r, 'Now tracking ' + pat)) await reload();
    };
    byId('lfs-pattern').onkeydown = (e) => { if (e.key === 'Enter') byId('lfs-track-btn').click(); };

    body.querySelectorAll('[data-untrack]').forEach(btn => {
      btn.onclick = async () => {
        const pat = btn.dataset.untrack;
        const r = await withLoading('Untracking ' + pat, () => gs.lfsUntrack(pat));
        if (handleResult(r, 'Stopped tracking ' + pat)) await reload();
      };
    });

    byId('lfs-list-files').onclick = async () => {
      const out = byId('lfs-files-result');
      out.innerHTML = '<div class="lfs-empty">Loading…</div>';
      const r = await gs.lfsFiles();
      if (!r.ok) { out.innerHTML = `<div class="lfs-empty">Failed: ${escapeHtml(r.error)}</div>`; return; }
      const files = r.data.files || [];
      if (!files.length) { out.innerHTML = '<div class="lfs-empty">No LFS-managed files.</div>'; return; }
      out.innerHTML = `
        <ul class="lfs-files-list">
          ${files.slice(0, 200).map(f => `
            <li class="lfs-file-item">
              <span class="lfs-file-dl" title="${f.downloaded ? 'Downloaded' : 'Not downloaded'}">${f.downloaded ? '●' : '○'}</span>
              <span class="lfs-file-path text-mono" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
              <span class="lfs-file-size">${escapeHtml(f.size || '')}</span>
            </li>
          `).join('')}
          ${files.length > 200 ? `<li class="lfs-empty">…and ${files.length - 200} more</li>` : ''}
        </ul>
      `;
    };

    byId('lfs-migrate-btn').onclick = async () => {
      const raw = byId('lfs-migrate-pattern').value.trim();
      if (!raw) { showToast('Enter at least one pattern', 'error'); return; }
      const patterns = raw.split(',').map(s => s.trim()).filter(Boolean);
      const ok = await modal.confirm({
        title: 'Migrate to LFS',
        message: `Rewrite history to convert files matching [${patterns.join(', ')}] into LFS pointers? This changes commit hashes and requires a force-push. Make sure you have a backup and coordinate with collaborators.`,
        danger: true, confirmText: 'Migrate'
      });
      if (!ok) return;
      const r = await withLoading('Migrating to LFS', () => gs.lfsMigrateImport({ patterns }));
      if (handleResult(r, 'Migration complete')) await reload();
    };
  }

  render();

  const close = document.createElement('button');
  close.className = 'btn-medieval'; close.textContent = 'Close';
  close.onclick = () => { modal.hide(); refreshDiskUsage().catch(() => {}); };
  modal.show({ title: '⛂ Git LFS Manager', body, footer: [close] });
}

function showBranchCleanupDialog(data) {
  const merged = data.merged || [];
  const current = data.current || '';

  const body = document.createElement('div');
  if (!merged.length) {
    body.innerHTML = `
      <p class="modal-text">No merged branches found to clean up.</p>
      <p class="modal-text text-muted" style="font-size:12px">Current branch: <strong class="text-red">${escapeHtml(current)}</strong></p>
      ${data.unmerged && data.unmerged.length
        ? `<p class="modal-text text-muted" style="font-size:12px">${data.unmerged.length} branch(es) NOT merged (use the Branches tab if you want to force-delete those).</p>`
        : ''}
    `;
    const close = document.createElement('button');
    close.className = 'btn-medieval primary'; close.textContent = 'Close';
    close.onclick = () => modal.hide();
    modal.show({ title: 'Cleanup Merged Branches', body, footer: [close] });
    return;
  }

  // Default all selected
  const selected = new Set(merged.map(b => b.name));

  body.innerHTML = `
    <p class="modal-text">The following local branches are fully merged into <strong class="text-red">${escapeHtml(current)}</strong> and safe to delete:</p>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span class="branches-label" style="margin:0"><span id="cb-count">${selected.size}</span> / ${merged.length} selected</span>
      <div style="display:flex;gap:6px">
        <button class="mini-btn" id="cb-all" type="button">Select All</button>
        <button class="mini-btn" id="cb-none" type="button">Select None</button>
      </div>
    </div>
    <ul class="cleanup-branches-list" id="cb-list">
      ${merged.map(b => `
        <li class="cleanup-branch-item selected" data-name="${escapeHtml(b.name)}">
          <input type="checkbox" checked />
          <span>${escapeHtml(b.name)}</span>
        </li>
      `).join('')}
    </ul>
    ${data.unmerged && data.unmerged.length
      ? `<p class="modal-text text-muted" style="margin-top:12px;font-size:12px">⚔ ${data.unmerged.length} other branch(es) are NOT fully merged and are not listed here. Use the Branches tab to force-delete those if intentional.</p>`
      : ''}
  `;

  body.querySelectorAll('.cleanup-branch-item').forEach(li => {
    const name = li.dataset.name;
    li.onclick = () => {
      if (selected.has(name)) {
        selected.delete(name);
        li.classList.remove('selected');
        li.querySelector('input').checked = false;
      } else {
        selected.add(name);
        li.classList.add('selected');
        li.querySelector('input').checked = true;
      }
      body.querySelector('#cb-count').textContent = selected.size;
    };
  });
  body.querySelector('#cb-all').onclick = () => {
    merged.forEach(b => selected.add(b.name));
    body.querySelectorAll('.cleanup-branch-item').forEach(li => {
      li.classList.add('selected'); li.querySelector('input').checked = true;
    });
    body.querySelector('#cb-count').textContent = selected.size;
  };
  body.querySelector('#cb-none').onclick = () => {
    selected.clear();
    body.querySelectorAll('.cleanup-branch-item').forEach(li => {
      li.classList.remove('selected'); li.querySelector('input').checked = false;
    });
    body.querySelector('#cb-count').textContent = 0;
  };

  const cancel = document.createElement('button');
  cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
  cancel.onclick = () => modal.hide();
  const del = document.createElement('button');
  del.className = 'btn-medieval danger';
  del.innerHTML = '<span class="btn-icon">✕</span> Delete Selected';
  del.onclick = async () => {
    const list = [...selected];
    if (!list.length) { showToast('No branches selected', 'error'); return; }
    modal.hide();
    const r = await withLoading(`Deleting ${list.length} branch(es)`, () => gs.deleteBranches({ branches: list, force: false }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
    const { deleted, failed } = r.data;
    if (deleted.length) showToast(`Deleted ${deleted.length} branch(es)`, 'success');
    if (failed.length) {
      const msg = failed.map(f => `${f.branch}: ${f.error}`).join('\n');
      showToast(`${failed.length} failed:\n${msg}`, 'error', 8000);
    }
    await refreshAll();
    await refreshDiskUsage();
  };
  modal.show({ title: 'Cleanup Merged Branches', body, footer: [cancel, del] });
}

function showLargestObjectsDialog(objects) {
  const body = document.createElement('div');
  if (!objects || !objects.length) {
    body.innerHTML = '<p class="modal-text">No objects found.</p>';
  } else {
    body.innerHTML = `
      <p class="modal-text">The largest objects in the repository (across all history). Useful for identifying bloat — usually committed binaries or large files that should be in LFS or <code>.gitignore</code>.</p>
      <ul class="objects-list">
        ${objects.map(o => `
          <li class="object-row" title="${escapeHtml(o.path || '(no path)')}">
            <span class="obj-hash">${escapeHtml((o.hash || '').slice(0, 10))}</span>
            <span class="obj-type">${escapeHtml(o.type || '')}</span>
            <span class="obj-path">${escapeHtml(o.path || '—')}</span>
            <span class="obj-size">${fmtBytes(o.size)}</span>
          </li>
        `).join('')}
      </ul>
      <p class="modal-text text-muted" style="font-size:11px;margin-top:10px">
        ⚜ To physically remove a large object from history (advanced, rewrites history):<br/>
        <code class="text-mono">git filter-repo --path &lt;path&gt; --invert-paths</code>
      </p>
    `;
  }
  const close = document.createElement('button');
  close.className = 'btn-medieval primary'; close.textContent = 'Close';
  close.onclick = () => modal.hide();
  modal.show({ title: 'Largest Objects', body, footer: [close] });
}

// ============================================
// SETTINGS DIALOG
// ============================================

const AVAILABLE_THEMES = [
  { id: 'crusader', name: 'Crusader',  swatches: ['#0a0606', '#b22222', '#c8a04a', '#efe6d4'] },
  { id: 'tyrian',   name: 'Tyrian',    swatches: ['#0a0606', '#6e1b4e', '#c8a04a', '#efe6d4'] },
  { id: 'verdant',  name: 'Verdant',   swatches: ['#0a0606', '#2f5d3c', '#c8a04a', '#efe6d4'] },
  { id: 'midnight', name: 'Midnight',  swatches: ['#0a0606', '#2c4a7a', '#bfc7da', '#efe6d4'] },
  { id: 'sandstone', name: 'Sandstone', swatches: ['#1a1410', '#a14a22', '#d4b770', '#f5e8cf'] }
];

// Apply a theme: set the html class. Called on load (with saved theme) and from the picker.
function applyTheme(themeId) {
  const html = document.documentElement;
  // Remove any previous theme class
  for (const t of AVAILABLE_THEMES) html.classList.remove('theme-' + t.id);
  if (themeId && themeId !== 'crusader') html.classList.add('theme-' + themeId);
}

// Apply font scale by genuinely resizing fonts (not zooming layout). The UI uses
// many hardcoded px font sizes, so we walk every CSS rule once, record each rule's
// base font-size in px, and on scale change rewrite them to base*scale. This affects
// ONLY text size — paddings, widths, and layout stay put.
let _fontScaleBases = null; // [{ rule, basePx }]

function collectFontScaleBases() {
  const bases = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; } // skip cross-origin
    if (!rules) continue;
    for (const rule of rules) {
      // Only style rules with an explicit px font-size
      if (rule.style && rule.style.fontSize && rule.style.fontSize.endsWith('px')) {
        const basePx = parseFloat(rule.style.fontSize);
        if (!isNaN(basePx)) bases.push({ rule, basePx });
      }
    }
  }
  // Only cache once we actually found rules (avoids caching an empty list if the
  // stylesheet hasn't finished parsing yet).
  if (bases.length) _fontScaleBases = bases;
  return bases;
}

function applyFontScale(scale) {
  const v = Math.max(0.75, Math.min(1.5, parseFloat(scale) || 1.0));
  // Clear any leftover zoom from a previous build
  const welcome = document.getElementById('welcome-screen');
  const app = document.getElementById('app-screen');
  if (welcome) welcome.style.zoom = '';
  if (app) app.style.zoom = '';

  const bases = _fontScaleBases || collectFontScaleBases();
  if (!bases || !bases.length) return;

  for (const { rule, basePx } of bases) {
    try {
      rule.style.setProperty('font-size', (basePx * v).toFixed(2) + 'px', rule.style.getPropertyPriority('font-size'));
    } catch (e) { /* some rules are read-only; skip */ }
  }
}

async function showSettingsDialog() {
  // Load both app settings and git config in parallel
  const [appR, gitR] = await Promise.all([gs.getAppSettings(), gs.getGitConfig()]);
  const appSettings = (appR && appR.ok) ? appR.data : { ...DEFAULT_APP_SETTINGS_LOCAL };
  const gitConfig = (gitR && gitR.ok) ? gitR.data : { global: {}, local: {}, effective: {} };

  // Track pending changes so Save can submit them at once
  // appChanges: { key: value } for app-level prefs
  // gitChanges: [{ scope, key, value }]
  const appChanges = {};
  const gitChanges = [];

  const hasRepo = !!(state.repo && state.repo.path);
  const repoLabel = hasRepo ? (state.repo.name || state.repo.path) : '(no repository open)';

  // Helper to record a git config change
  function setGitChange(scope, key, value) {
    // Remove any previous pending change for this scope+key
    for (let i = gitChanges.length - 1; i >= 0; i--) {
      if (gitChanges[i].scope === scope && gitChanges[i].key === key) gitChanges.splice(i, 1);
    }
    gitChanges.push({ scope, key, value });
  }

  // Determine the current effective value for a git config key for the
  // currently-selected scope per row. Initially we show local if a repo is
  // open AND local has a value; otherwise show global.
  function currentScopeFor(key) {
    if (hasRepo && gitConfig.local && gitConfig.local[key] !== undefined) return 'local';
    return 'global';
  }
  function currentValueFor(key, scope) {
    const map = scope === 'local' ? gitConfig.local : gitConfig.global;
    return (map && map[key] !== undefined) ? map[key] : '';
  }

  // Build the dialog
  const body = document.createElement('div');
  body.className = 'settings-dialog';
  body.innerHTML = `
    <nav class="settings-nav">
      <button class="settings-nav-item active" data-tab="general"><span class="nav-icon">⚙</span> General</button>
      <button class="settings-nav-item" data-tab="appearance"><span class="nav-icon">⚜</span> Appearance</button>
      <button class="settings-nav-item" data-tab="git"><span class="nav-icon">⚔</span> Git Identity</button>
      <button class="settings-nav-item" data-tab="defaults"><span class="nav-icon">✠</span> Defaults</button>
      <button class="settings-nav-item" data-tab="about"><span class="nav-icon">⚜</span> About</button>
    </nav>
    <div class="settings-panel" id="settings-panel-content"></div>
  `;

  const panel = body.querySelector('#settings-panel-content');

  // -------------------- Panel renderers --------------------
  function renderGeneral() {
    panel.innerHTML = `
      <div class="settings-panel-title">General</div>
      <div class="settings-group">
        <div class="settings-group-title">Behavior</div>
        <div class="settings-row">
          <div class="label">Auto-refresh on window focus<small>Refresh the repo state when the window regains focus</small></div>
          <div class="control">
            <label class="medieval-toggle">
              <input type="checkbox" id="set-auto-focus" ${appSettings.autoFetchOnFocus ? 'checked' : ''} />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>
        <div class="settings-row">
          <div class="label">Confirm destructive actions<small>Extra confirmation before discard, force-push, hard reset, etc.</small></div>
          <div class="control">
            <label class="medieval-toggle">
              <input type="checkbox" id="set-confirm-destructive" ${appSettings.confirmDestructive ? 'checked' : ''} />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>
      </div>
    `;
    panel.querySelector('#set-auto-focus').onchange = (e) => { appChanges.autoFetchOnFocus = e.target.checked; };
    panel.querySelector('#set-confirm-destructive').onchange = (e) => { appChanges.confirmDestructive = e.target.checked; };
  }

  function renderAppearance() {
    panel.innerHTML = `
      <div class="settings-panel-title">Appearance</div>
      <div class="settings-group">
        <div class="settings-group-title">Theme</div>
        <p class="modal-text text-muted" style="font-size:12px;margin-bottom:10px">Pick a theme color family. Changes apply immediately as a preview; Save to keep.</p>
        <div class="theme-picker" id="theme-picker">
          ${AVAILABLE_THEMES.map(t => `
            <button class="theme-card ${appSettings.theme === t.id ? 'active' : ''}" type="button" data-theme="${t.id}">
              <div class="theme-swatches">
                ${t.swatches.map(c => `<span style="background:${c}"></span>`).join('')}
              </div>
              <div class="theme-card-name">${escapeHtml(t.name)}</div>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Typography</div>
        <div class="settings-row">
          <div class="label">Font size<small>Multiplier for the UI text size</small></div>
          <div class="control">
            <input type="number" id="set-font-scale" min="0.75" max="1.5" step="0.05" value="${appSettings.fontScale}" />
            <span style="color:var(--muted-text);font-size:11px">× (0.75–1.5)</span>
          </div>
        </div>
      </div>
    `;
    // Theme cards: live preview on click
    panel.querySelectorAll('.theme-card').forEach(card => {
      card.onclick = () => {
        const id = card.dataset.theme;
        appChanges.theme = id;
        applyTheme(id);
        panel.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c === card));
      };
    });
    // Font scale
    const fs = panel.querySelector('#set-font-scale');
    fs.onchange = () => {
      const v = parseFloat(fs.value);
      if (!isNaN(v)) {
        appChanges.fontScale = v;
        applyFontScale(v);
      }
    };
  }

  function renderGitIdentity() {
    // Each row has: label, scope toggle (Global/Local), value input
    const rows = [
      { key: 'user.name',         label: 'User name',          hint: 'Your name as it appears in commits.' },
      { key: 'user.email',        label: 'Email',              hint: 'Email shown on commits.' },
      { key: 'init.defaultBranch', label: 'Default branch',    hint: 'Branch name used when initializing a new repo (e.g. "main").' },
      { key: 'core.editor',       label: 'Editor command',     hint: 'External editor for commit messages, rebases, etc.' },
      { key: 'pull.rebase',       label: 'Pull strategy',      hint: 'true = rebase on pull, false = merge, interactive = interactive rebase.' }
    ];

    panel.innerHTML = `
      <div class="settings-panel-title">Git Identity & Behavior</div>
      <p class="modal-text text-muted" style="font-size:12px;margin-bottom:12px">
        ${hasRepo
          ? `<strong style="color:var(--bone-white)">Local</strong> applies only to <strong class="text-red">${escapeHtml(repoLabel)}</strong>. <strong style="color:var(--bone-white)">Global</strong> is your default across all repos. Local overrides global where set.`
          : `<strong style="color:var(--bone-white)">Global</strong> applies to all repos. Open a repo to set per-repo overrides.`}
      </p>
      <div class="settings-group">
        ${rows.map(r => {
          const scope = currentScopeFor(r.key);
          const val = currentValueFor(r.key, scope);
          return `
            <div class="settings-row" data-key="${r.key}">
              <div class="label">${escapeHtml(r.label)}<small>${escapeHtml(r.hint)}</small></div>
              <div class="control">
                <div class="scope-toggle" data-scope="${scope}">
                  <button type="button" data-set-scope="global" class="${scope === 'global' ? 'active' : ''}">Global</button>
                  <button type="button" data-set-scope="local" class="${scope === 'local' ? 'active' : ''}" ${hasRepo ? '' : 'disabled title="Open a repo to set local config"'}>Local</button>
                </div>
                <input type="text" data-value-for="${r.key}" value="${escapeHtml(val)}" placeholder="(unset)" />
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Wire up scope toggles & input changes
    panel.querySelectorAll('.settings-row[data-key]').forEach(row => {
      const key = row.dataset.key;
      const input = row.querySelector('input[data-value-for]');
      const scopeBox = row.querySelector('.scope-toggle');

      scopeBox.querySelectorAll('button[data-set-scope]').forEach(btn => {
        btn.onclick = () => {
          if (btn.disabled) return;
          const newScope = btn.dataset.setScope;
          scopeBox.dataset.scope = newScope;
          scopeBox.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
          // Repopulate the input to reflect the value at the newly-selected scope
          input.value = currentValueFor(key, newScope);
          // Remove any pending change for this key (user is switching scope mid-edit)
          for (let i = gitChanges.length - 1; i >= 0; i--) {
            if (gitChanges[i].key === key) gitChanges.splice(i, 1);
          }
        };
      });

      input.oninput = () => {
        const scope = scopeBox.dataset.scope;
        setGitChange(scope, key, input.value);
      };
    });
  }

  function renderDefaults() {
    panel.innerHTML = `
      <div class="settings-panel-title">App Defaults</div>
      <div class="settings-group">
        <div class="settings-group-title">Graph view</div>
        <div class="settings-row">
          <div class="label">Default commit limit<small>How many commits to load when opening a repo</small></div>
          <div class="control">
            <input type="number" id="set-graph-limit" min="50" max="5000" step="50" value="${appSettings.graphLimit}" />
            <span style="color:var(--muted-text);font-size:11px">commits</span>
          </div>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">SSH</div>
        <div class="settings-row">
          <div class="label">Default SSH key path<small>Pre-fills the SSH key picker in Clone dialogs</small></div>
          <div class="control">
            <input type="text" id="set-ssh-key" value="${escapeHtml(appSettings.defaultSshKeyPath || '')}" placeholder="~/.ssh/id_ed25519" />
            <button class="mini-btn" id="set-ssh-key-browse" type="button">…</button>
          </div>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Repository initialization</div>
        <div class="settings-row">
          <div class="label">Default branch name<small>Used when initializing a new repository</small></div>
          <div class="control">
            <input type="text" id="set-default-branch" value="${escapeHtml(appSettings.defaultBranchName || 'main')}" placeholder="main" />
          </div>
        </div>
      </div>
    `;
    panel.querySelector('#set-graph-limit').onchange = (e) => {
      const v = parseInt(e.target.value, 10);
      if (!isNaN(v) && v >= 50) appChanges.graphLimit = v;
    };
    panel.querySelector('#set-ssh-key').oninput = (e) => { appChanges.defaultSshKeyPath = e.target.value; };
    panel.querySelector('#set-ssh-key-browse').onclick = async () => {
      const r = await gs.selectFile('Select default SSH private key');
      if (r && r.ok) {
        panel.querySelector('#set-ssh-key').value = r.data;
        appChanges.defaultSshKeyPath = r.data;
      }
    };
    panel.querySelector('#set-default-branch').oninput = (e) => { appChanges.defaultBranchName = e.target.value; };
  }

  async function renderAbout() {
    const pathR = await gs.appSettingsPath();
    const settingsFile = (pathR && pathR.ok) ? pathR.data : '(unknown)';
    panel.innerHTML = `
      <div class="settings-panel-title">About GitGood</div>
      <div class="settings-group">
        <p class="modal-text">A medieval-themed Git client. All operations use real <code>git</code> via <code>simple-git</code> — no proprietary repository format.</p>
        <div class="settings-row">
          <div class="label">Settings file</div>
          <div class="control"><div class="settings-path">${escapeHtml(settingsFile)}</div></div>
        </div>
        <div class="settings-row">
          <div class="label">Reset preferences</div>
          <div class="control">
            <button class="btn-medieval danger" id="set-reset-app" type="button">⟲ Reset App Preferences</button>
          </div>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Tips</div>
        <p class="modal-text text-muted" style="font-size:12px">
          • Right-click commits in the Graph for checkout, cherry-pick, revert, and reset.<br/>
          • Drag a branch pill in the Graph to move it to another commit.<br/>
          • Hold <kbd>Shift</kbd> or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> while clicking files in Changes for multi-select.<br/>
          • Open developer tools with <kbd>Ctrl+Shift+I</kbd> if something goes sideways.
        </p>
      </div>
    `;
    panel.querySelector('#set-reset-app').onclick = async () => {
      const ok = await modal.confirm({
        title: 'Reset App Preferences',
        message: 'Restore all app preferences to defaults? This does NOT touch git config or your repositories.',
        danger: true, confirmText: 'Reset'
      });
      if (!ok) return;
      const r = await gs.resetAppSettings();
      if (r && r.ok) {
        Object.assign(appSettings, r.data);
        Object.keys(appChanges).forEach(k => delete appChanges[k]);
        applyTheme(appSettings.theme);
        applyFontScale(appSettings.fontScale);
        showToast('Preferences reset', 'success');
      }
    };
  }

  // Tab switching
  const renderers = { general: renderGeneral, appearance: renderAppearance, git: renderGitIdentity, defaults: renderDefaults, about: renderAbout };
  body.querySelectorAll('.settings-nav-item').forEach(item => {
    item.onclick = () => {
      body.querySelectorAll('.settings-nav-item').forEach(i => i.classList.toggle('active', i === item));
      renderers[item.dataset.tab]();
    };
  });

  // Render initial tab
  renderGeneral();

  // Footer buttons
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => {
    // Roll back any live theme/font preview changes
    applyTheme(appSettings.theme);
    applyFontScale(appSettings.fontScale);
    modal.hide();
  };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-medieval primary';
  saveBtn.innerHTML = '<span class="btn-icon">✓</span> Save';
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    let appOk = true;
    let gitFailed = [];

    // Save app preferences first
    if (Object.keys(appChanges).length) {
      const r = await gs.setAppSettings(appChanges);
      if (!r || !r.ok) {
        appOk = false;
        showToast('Failed to save app preferences: ' + (r && r.error), 'error', 6000);
      } else {
        Object.assign(appSettings, appChanges);
        Object.keys(appChanges).forEach(k => delete appChanges[k]);
        // Re-apply in case Save changed anything
        applyTheme(appSettings.theme);
        applyFontScale(appSettings.fontScale);
      }
    }

    // Save git config changes
    if (gitChanges.length) {
      const r = await gs.setGitConfigBatch(gitChanges);
      if (!r || !r.ok) {
        showToast('Failed to save git config: ' + (r && r.error), 'error', 6000);
      } else {
        gitFailed = r.data.filter(x => !x.ok);
        if (gitFailed.length) {
          showToast(`${gitFailed.length} git config update(s) failed`, 'error', 6000);
        }
      }
    }

    saveBtn.disabled = false;
    if (appOk && !gitFailed.length) {
      showToast('Settings saved', 'success');
      modal.hide();
    }
  };

  modal.show({ title: '⚙ Settings', body, footer: [cancelBtn, saveBtn] });
}

// Default values mirrored on the renderer side (for reset fallback if backend
// is unreachable, which shouldn't happen but is harmless to keep).
const DEFAULT_APP_SETTINGS_LOCAL = {
  theme: 'crusader',
  defaultBranchName: 'main',
  graphLimit: 300,
  autoFetchOnFocus: true,
  confirmDestructive: true,
  defaultSshKeyPath: '',
  fontScale: 1.0
};

// Apply saved app settings (theme + font) at startup
async function applySavedAppSettings() {
  try {
    const r = await gs.getAppSettings();
    if (r && r.ok) {
      applyTheme(r.data.theme);
      applyFontScale(r.data.fontScale);
      // Mirror a few into state for downstream code
      if (typeof state !== 'undefined') {
        if (r.data.graphLimit) state.graphLimit = r.data.graphLimit;
      }
    }
  } catch (e) { /* harmless */ }
}

// Wire up Settings buttons (toolbar + welcome screen)
(() => {
  const wire = (id) => {
    const el = document.getElementById(id);
    if (el) el.onclick = () => showSettingsDialog();
  };
  wire('btn-settings');
  wire('welcome-settings');
})();

// ============================================
// PANE RESIZERS — drag handles between tab columns
// ============================================
const RESIZER_STORAGE_KEY = 'gitgood:pane-widths:v4';

// Resolve the grid container that a resizer controls.
// data-target can be:
//   - an element id (e.g. "graph-body")
//   - "data-panel:NAME" for a tab panel (e.g. "data-panel:changes" → [data-panel="changes"])
function resolveResizerTarget(targetAttr) {
  if (!targetAttr) return null;
  if (targetAttr.startsWith('data-panel:')) {
    const name = targetAttr.slice('data-panel:'.length);
    return document.querySelector(`[data-panel="${name}"]`);
  }
  return document.getElementById(targetAttr);
}

// Load persisted widths
function loadResizerWidths() {
  try {
    const raw = localStorage.getItem(RESIZER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function saveResizerWidths(map) {
  try { localStorage.setItem(RESIZER_STORAGE_KEY, JSON.stringify(map)); } catch (e) {}
}

// Apply saved widths to a grid container if any are stored under its resizer key.
// Validates the saved value so a corrupt/stale entry can never break the layout.
function applyResizerWidths(resizerEl) {
  const key = resizerEl.dataset.resizer;
  const widths = loadResizerWidths();
  const saved = widths[key];
  if (!saved || typeof saved !== 'string') return;

  const target = resolveResizerTarget(resizerEl.dataset.target);
  if (!target) return;

  // Validate: the saved template must have the same number of tracks as the authored
  // template (content columns + interleaved resizer columns) and must keep one flexible
  // (fr) track. Otherwise we ignore it and fall back to the CSS-defined layout.
  const dataCols = (resizerEl.dataset.cols || '').trim().split(/\s+/).filter(Boolean);
  const expectedContent = dataCols.length;              // e.g. 2 for "1fr 380px"
  const expectedTracks = expectedContent > 0 ? expectedContent * 2 - 1 : 0; // interleaved resizers
  const savedTracks = saved.trim().split(/\s+/).filter(Boolean);

  const looksValid =
    savedTracks.length === expectedTracks &&
    /fr/.test(saved) &&                                  // still has a flexible track
    savedTracks.every(t => /^(\d+(\.\d+)?(px|fr)|0)$/.test(t)) && // only px/fr/0 values
    !savedTracks.some(t => /px$/.test(t) && parseFloat(t) < 0);   // no negative widths

  if (!looksValid) {
    // Discard the bad entry so it can't keep breaking the layout.
    delete widths[key];
    saveResizerWidths(widths);
    return;
  }
  target.style.gridTemplateColumns = saved;
}

// Parse a grid-template-columns string into an array of values
// (preserving 'fr', 'px', etc.). Resolve 'fr' values to current pixel width
// using getComputedStyle so we can edit in pixels and put it all back.
function readGridColumns(target) {
  const tracks = getComputedStyle(target).gridTemplateColumns.split(/\s+/).filter(Boolean);
  // tracks are already in px from getComputedStyle
  return tracks.map(v => parseFloat(v));
}

// Set up a single resizer
function setupResizer(resizerEl) {
  const target = resolveResizerTarget(resizerEl.dataset.target);
  if (!target) return;

  // Determine which grid track should stay flexible (1fr). We read data-cols
  // (the original template authored in HTML, e.g. "280px 1fr 320px") and find the
  // index of the "1fr" entry among the CONTENT columns. In the live grid, resizer
  // columns are interleaved (content, resizer, content, resizer, content), so the
  // live index of the Nth content column is N*2.
  let flexLiveIndex = -1;
  const dataCols = (resizerEl.dataset.cols || '').trim().split(/\s+/).filter(Boolean);
  const flexContentIdx = dataCols.findIndex(c => c === '1fr' || c.endsWith('fr'));
  if (flexContentIdx >= 0) flexLiveIndex = flexContentIdx * 2; // account for interleaved resizers

  // Find this resizer's column index in the parent grid.
  // The resizer's previous and next siblings are the columns being resized.
  // The resizer is always a grid item itself, so its column index = #of preceding grid children.
  // Note: with `display: contents` on a wrapper, the resizer's siblings ARE the grid items.

  resizerEl.addEventListener('mousedown', (downEvt) => {
    downEvt.preventDefault();

    // Find the actual previous and next *grid items* (skip text nodes and the resizer itself)
    const gridChildren = Array.from(target.children).filter(el => {
      // If the layout uses `display: contents` wrapper, get actual rendered grid items
      const cs = getComputedStyle(el);
      return cs.display !== 'none';
    });
    // For `display: contents` wrappers, the real grid items are inside the wrapper.
    // We walk up from the resizer to find which siblings are the immediate columns.
    let prevEl = resizerEl.previousElementSibling;
    let nextEl = resizerEl.nextElementSibling;
    if (!prevEl || !nextEl) return;

    // Read current pixel widths of all columns
    const startCols = readGridColumns(target);
    // Find resizer's column index in the grid
    // We do this by counting how many grid-item ancestors of the resizer come before it
    // within the same grid track flow. Easier: just measure prev/next bounding rects.
    const prevRect = prevEl.getBoundingClientRect();
    const nextRect = nextEl.getBoundingClientRect();
    const startX = downEvt.clientX;
    const startPrevWidth = prevRect.width;
    const startNextWidth = nextRect.width;
    const totalCombined = startPrevWidth + startNextWidth;

    // Minimum widths so neither pane disappears
    const MIN = 120;

    resizerEl.classList.add('resizing');
    document.body.classList.add('resizing-panes');

    const onMove = (mvEvt) => {
      const delta = mvEvt.clientX - startX;
      let newPrev = startPrevWidth + delta;
      let newNext = startNextWidth - delta;
      if (newPrev < MIN) { newPrev = MIN; newNext = totalCombined - MIN; }
      if (newNext < MIN) { newNext = MIN; newPrev = totalCombined - MIN; }

      // Rebuild the grid-template-columns string. We replace the columns at
      // the indices of prevEl and nextEl. The resizer (5px) sits between them.
      // Strategy: read current tracks, find prev/next by their relative position,
      // and patch in the new pixel widths.
      const currentTracks = readGridColumns(target);
      // We need the indices of the prev/next columns. Since the resizer is one of the
      // grid items, scanning from `target.children` works only if the grid wrapper
      // is the target itself (no `display: contents` wrapper). For `display: contents`
      // we need to scan the wrapper's children too.

      // Use a flat walk of "rendered" grid children in the resizer's row
      const tracks = computeTrackList(target, resizerEl);
      const prevIdx = tracks.indexOf(prevEl);
      const nextIdx = tracks.indexOf(nextEl);
      if (prevIdx < 0 || nextIdx < 0) return;

      const newCols = currentTracks.slice();
      // Only assign fixed widths to the NON-flex column(s) of the dragged pair.
      // The flex column (diff) always stays 1fr and absorbs slack, so resizing one
      // side simply takes space from the flexible middle — the right panel stays
      // anchored to the edge with no empty gap.
      if (prevIdx !== flexLiveIndex) newCols[prevIdx] = newPrev;
      if (nextIdx !== flexLiveIndex) newCols[nextIdx] = newNext;
      target.style.gridTemplateColumns = newCols.map((w, i) => {
        // Keep resizer columns at 5px exact
        if (tracks[i] && tracks[i].classList && tracks[i].classList.contains('pane-resizer')) return '5px';
        // Keep the designated flex column flexible
        if (i === flexLiveIndex) return '1fr';
        return w + 'px';
      }).join(' ');
    };

    const onUp = () => {
      resizerEl.classList.remove('resizing');
      document.body.classList.remove('resizing-panes');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist — but only if the produced template is well-formed (right track count,
      // keeps a flexible column, no negatives). Never save a layout that could break.
      const tmpl = target.style.gridTemplateColumns;
      const dataColsArr = (resizerEl.dataset.cols || '').trim().split(/\s+/).filter(Boolean);
      const expectedTracks = dataColsArr.length > 0 ? dataColsArr.length * 2 - 1 : 0;
      const parts = (tmpl || '').trim().split(/\s+/).filter(Boolean);
      const valid = parts.length === expectedTracks &&
        /fr/.test(tmpl) &&
        parts.every(t => /^(\d+(\.\d+)?(px|fr)|0)$/.test(t)) &&
        !parts.some(t => /px$/.test(t) && parseFloat(t) < 0);
      if (valid) {
        const widths = loadResizerWidths();
        widths[resizerEl.dataset.resizer] = tmpl;
        saveResizerWidths(widths);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Compute the flat list of grid items that share the resizer's ROW — i.e. the columns
// the resizer actually sits between. Items that span the full width (e.g. a toolbar on
// another grid row) must be excluded, or the column indices get misaligned and resizing
// produces a corrupt grid-template-columns that collapses the layout.
function computeTrackList(target, resizerEl) {
  const all = [];
  function walk(el) {
    for (const child of el.children) {
      const cs = getComputedStyle(child);
      if (cs.display === 'contents') walk(child);
      else if (cs.display !== 'none') all.push(child);
    }
  }
  walk(target);

  if (!resizerEl) return all;

  // Keep only items whose vertical extent overlaps the resizer's (same grid row),
  // which naturally drops a full-width header/toolbar living on a different row.
  const rRect = resizerEl.getBoundingClientRect();
  const rMid = rRect.top + rRect.height / 2;
  const sameRow = all.filter(el => {
    if (el === resizerEl) return true;
    const b = el.getBoundingClientRect();
    return b.top <= rMid && b.bottom >= rMid;   // row overlaps the resizer's midline
  });
  return sameRow.length ? sameRow : all;
}

// Initialize all resizers on the page
(() => {
  // One-time cleanup: remove obsolete pane-width keys from older versions whose saved
  // values can break the (now restructured) layouts — notably the History panel.
  try {
    ['gitgood:pane-widths', 'gitgood:pane-widths:v1', 'gitgood:pane-widths:v2', 'gitgood:pane-widths:v3',
     'gitsouls:pane-widths', 'gitsouls:pane-widths:v1', 'gitsouls:pane-widths:v2'].forEach(k => {
      localStorage.removeItem(k);
    });
  } catch (e) {}

  // Set up on next tick so all stylesheets are applied first
  setTimeout(() => {
    document.querySelectorAll('.pane-resizer').forEach(el => {
      applyResizerWidths(el);
      setupResizer(el);
    });
  }, 100);

  // Provide a way to reset widths (could expose later via a menu)
  window.__resetPaneWidths = () => {
    try { localStorage.removeItem(RESIZER_STORAGE_KEY); } catch (e) {}
    location.reload();
  };
})();

(async function init() {
  try {
    // Apply saved theme/font before anything else so there's no flash
    await applySavedAppSettings();
    // Check if a repo is already open (e.g. on reload)
    const cur = await gs.currentRepo();
    if (cur && cur.ok && cur.data) {
      state.repo = cur.data;
      $('#welcome-screen').classList.add('hidden');
      $('#app-screen').classList.remove('hidden');
      updateRepoInfo();
      await refreshAll();
    } else {
      await showWelcome();
    }
  } catch (err) {
    console.error('[GitGood init error]', err);
    // Show welcome screen even if init had an issue
    try { await showWelcome(); } catch (e) { console.error(e); }
    showToast('Init warning: ' + (err.message || err), 'error', 6000);
  }
})();
