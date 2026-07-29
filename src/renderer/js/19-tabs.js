// ============================================
// REPOSITORY TABS
// ============================================
// Several repositories open at once, one visible at a time. This is deliberately a
// renderer-side feature: the main process still holds a single `git` instance and a single
// currentRepoPath, and switching a tab is exactly repo:open on that path. Nothing else in
// the app has to know that more than one repository exists.
//
// What that buys: no change to ~150 IPC handlers, no per-repo watcher fleet, no risk of an
// operation landing in the wrong repository — main only ever knows about one.
// What it costs: a background tab is inert. It shows no live badge and its counts do not
// update, because nobody is running git in it. That is the honest trade, and the reason a
// tab shows only what was true when you last looked at it.

const repoTabs = {
  tabs: [],           // [{ path, name, ui }] — ui is the snapshot below, or null
  activePath: null,
  // Set while switchRepoTab is driving openRepoByPath, so noteRepoOpened knows the open
  // came from a tab click rather than from the user opening a new repository.
  switching: false,
  restoring: false
};

// The slice of view state that belongs to a repository rather than to the app. Anything
// here is remembered per tab and put back when you return to it.
function snapshotTabUi() {
  const graphSearch = document.getElementById('graph-search');
  const historySearch = document.getElementById('history-search');
  const changesSearch = document.getElementById('changes-search');
  return {
    currentTab: state.currentTab,
    graphFilter: state.graphFilter || '',
    graphFilterMode: state.graphFilterMode || 'message',
    historyFilter: state.historyFilter || '',
    historyFilterMode: state.historyFilterMode || 'message',
    searchQuery: state.searchQuery || '',
    graphLimit: state.graphLimit,
    selectedGraphHash: state.selectedGraphHash || null,
    selectedFile: state.selectedFile || null,
    selectedFileStaged: !!state.selectedFileStaged,
    // Input values are snapshotted separately: the state fields above are only written on
    // 'input', and a value typed but not yet committed to state would otherwise be lost.
    graphSearchValue: graphSearch ? graphSearch.value : '',
    historySearchValue: historySearch ? historySearch.value : '',
    changesSearchValue: changesSearch ? changesSearch.value : ''
  };
}

function activeTab() {
  return repoTabs.tabs.find(t => t.path === repoTabs.activePath) || null;
}

// Store the current view state on the active tab. Called before every switch and before
// the window unloads.
function saveActiveTabUi() {
  const t = activeTab();
  if (t && state.repo) t.ui = snapshotTabUi();
}

// Put a remembered view back after the repository has finished loading. Runs after
// refreshAll, so every list it touches already holds the new repo's data.
async function restoreTabUi(repoPath) {
  const t = repoTabs.tabs.find(x => x.path === repoPath);
  const ui = t && t.ui;
  if (!ui) return;

  state.graphFilter = ui.graphFilter;
  state.graphFilterMode = ui.graphFilterMode;
  state.historyFilter = ui.historyFilter;
  state.historyFilterMode = ui.historyFilterMode;
  state.searchQuery = ui.searchQuery;
  if (ui.graphLimit) state.graphLimit = ui.graphLimit;

  const set = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined) el.value = value; };
  set('graph-search', ui.graphSearchValue);
  set('history-search', ui.historySearchValue);
  set('changes-search', ui.changesSearchValue);
  set('graph-search-mode', ui.graphFilterMode);
  set('history-search-mode', ui.historyFilterMode);

  if (ui.currentTab) goToTab(ui.currentTab);

  // A filter only takes effect on a repaint, and the tab we just switched to painted with
  // the filter empty.
  if (ui.graphFilter && typeof relayoutGraph === 'function') relayoutGraph();
  if (ui.historyFilter && typeof renderHistory === 'function') renderHistory();
  if (ui.searchQuery && typeof renderFileList === 'function') renderFileList();

  // Re-select the file only if this repository still has it — the same path in a different
  // repository is a different file, and selecting a stale one shows a confusing empty diff.
  if (ui.selectedFile) {
    const list = ui.selectedFileStaged ? (state.stagedFiles || []) : (state.unstagedFiles || []);
    if (list.some(f => f.path === ui.selectedFile)) {
      await selectFile(ui.selectedFile, ui.selectedFileStaged);
    }
  }
}

// ============================================
// TAB BOOKKEEPING
// ============================================
// Called by openRepoByPath once main has actually switched. Adds the tab if it is new and
// makes it active either way.
function noteRepoOpened(repo) {
  if (!repo || !repo.path) return;
  let tab = repoTabs.tabs.find(t => t.path === repo.path);
  if (!tab) {
    tab = { path: repo.path, name: repo.name || repo.path.split(/[\\/]/).pop(), ui: null };
    // Open next to the tab you came from, the way editors do.
    const idx = repoTabs.tabs.findIndex(t => t.path === repoTabs.activePath);
    if (idx >= 0) repoTabs.tabs.splice(idx + 1, 0, tab);
    else repoTabs.tabs.push(tab);
  }
  repoTabs.activePath = repo.path;
  renderRepoTabs();
  persistRepoTabs();
}

async function switchRepoTab(repoPath) {
  if (!repoPath || repoPath === repoTabs.activePath) return;
  if (repoTabs.switching) return;
  saveActiveTabUi();
  repoTabs.switching = true;
  try {
    // openRepoByPath stops the old watcher, swaps main's repo, reloads everything and
    // calls noteRepoOpened + restoreTabUi. A failure there leaves the tab in place so the
    // user can retry or close it — a repo that has moved on disk is the usual cause.
    await openRepoByPath(repoPath);
  } finally {
    repoTabs.switching = false;
  }
}

async function closeRepoTab(repoPath) {
  const idx = repoTabs.tabs.findIndex(t => t.path === repoPath);
  if (idx < 0) return;
  const wasActive = repoTabs.activePath === repoPath;
  repoTabs.tabs.splice(idx, 1);

  if (!repoTabs.tabs.length) {
    repoTabs.activePath = null;
    renderRepoTabs();
    persistRepoTabs();
    await closeCurrentRepo();
    return;
  }
  if (wasActive) {
    // Prefer the tab that took its place, else the one before it.
    const next = repoTabs.tabs[Math.min(idx, repoTabs.tabs.length - 1)];
    repoTabs.activePath = null;   // force switchRepoTab to act
    await switchRepoTab(next.path);
  } else {
    renderRepoTabs();
    persistRepoTabs();
  }
}

// Tear down the current repository and go back to the welcome screen. Shared by the
// toolbar's ✕ and by closing the last tab.
async function closeCurrentRepo() {
  if (typeof stopRepoWatch === 'function') await stopRepoWatch();
  await gs.closeRepo();
  state.repo = null;
  state.status = null;
  state.selectedCommit = null;
  state.selectedFile = null;
  state.diffRenderedKey = null;
  state.remoteTags = null;
  state.remoteTagsRemote = null;
  clearCommitCache();
  state.collapsedCommits = null;
  state.graphCollapsed = false;
  state.graphFilter = '';
  state.historyFilter = '';
  state.detachedFrom = null;
  if (typeof resetSigningState === 'function') resetSigningState();
  if (typeof forgeReset === 'function') forgeReset();
  _diskState.loaded = false;
  _diskState.lastData = null;
  renderRepoTabs();
  showWelcome();
}

// ============================================
// RENDER
// ============================================
function renderRepoTabs() {
  const bar = document.getElementById('repo-tabs');
  if (!bar) return;
  // Shown whenever a repository is open, including the single-tab case. Hiding the strip
  // until a *second* repository is open also hides the + that opens one, which is the only
  // obvious way to get there.
  const show = repoTabs.tabs.length > 0;
  bar.classList.toggle('hidden', !show);
  if (!show) { bar.innerHTML = ''; return; }

  bar.innerHTML = repoTabs.tabs.map(t => `
    <button class="repo-tab${t.path === repoTabs.activePath ? ' active' : ''}"
            data-repo-tab="${escapeHtml(t.path)}" title="${escapeHtml(t.path)}">
      <span class="repo-tab-name">${escapeHtml(t.name)}</span>
      <span class="repo-tab-close" data-close-tab="${escapeHtml(t.path)}" title="Close (Ctrl+W)">✕</span>
    </button>
  `).join('') + `<button class="repo-tab-add" id="repo-tab-add" title="Open another repository in a new tab (Ctrl+O)">+</button>`;
}

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close-tab]');
  if (close) {
    e.preventDefault();
    e.stopPropagation();
    closeRepoTab(close.dataset.closeTab);
    return;
  }
  const tab = e.target.closest('[data-repo-tab]');
  if (tab) {
    e.preventDefault();
    switchRepoTab(tab.dataset.repoTab);
    return;
  }
  if (e.target.closest('#repo-tab-add')) {
    e.preventDefault();
    openRepoDialog();
  }
});

// Middle-click closes, as everywhere else that has tabs.
document.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const tab = e.target.closest('[data-repo-tab]');
  if (!tab) return;
  e.preventDefault();
  closeRepoTab(tab.dataset.repoTab);
});

// Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+W closes. Held back while a modal or the palette
// is up so they don't fire underneath a dialog.
document.addEventListener('keydown', (e) => {
  if (!state.repo) return;
  const overlayUp = document.querySelector('#modal-overlay:not(.hidden), #palette-overlay:not(.hidden), #terminal-overlay:not(.hidden)');
  if (overlayUp) return;
  if (e.ctrlKey && e.key === 'Tab' && repoTabs.tabs.length > 1) {
    e.preventDefault();
    const i = repoTabs.tabs.findIndex(t => t.path === repoTabs.activePath);
    const n = repoTabs.tabs.length;
    const next = repoTabs.tabs[((e.shiftKey ? i - 1 : i + 1) + n) % n];
    switchRepoTab(next.path);
    return;
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
    // Not when typing — Ctrl+W deletes a word in every text field.
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    if (repoTabs.activePath) closeRepoTab(repoTabs.activePath);
  }
});

// ============================================
// PERSISTENCE
// ============================================
function persistRepoTabs() {
  gs.setAppSettings({
    openRepos: repoTabs.tabs.map(t => t.path),
    activeRepo: repoTabs.activePath || ''
  }).catch(() => { /* a failed write only costs the session's tab list */ });
}

// Reopen last session's repositories. Only the active one is actually opened — the others
// are tabs waiting to be clicked, which is the whole point of not running git in them.
async function restoreRepoTabs(settings) {
  const paths = (settings && settings.openRepos) || [];
  if (!paths.length) return false;
  if (settings.restoreTabsOnStart === false) return false;

  repoTabs.tabs = paths.map(p => ({ path: p, name: p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), ui: null }));
  const wanted = (settings.activeRepo && paths.includes(settings.activeRepo)) ? settings.activeRepo : paths[0];
  repoTabs.restoring = true;
  try {
    await openRepoByPath(wanted);
  } catch (e) {
    // The repository may have been moved or deleted since last time; fall back to the
    // welcome screen rather than starting up broken.
    repoTabs.tabs = [];
    repoTabs.activePath = null;
    renderRepoTabs();
    return false;
  } finally {
    repoTabs.restoring = false;
  }
  return true;
}

// Losing the tab list because the window closed mid-session is avoidable.
window.addEventListener('beforeunload', () => {
  saveActiveTabUi();
});
