// ============================================
// WORKING-TREE WATCHER + BACKGROUND FETCH (renderer side)
// ============================================
// The main process coalesces filesystem events and tells us "the working tree changed" or
// "something in .git changed". This module decides how much to reload for each, and — more
// importantly — when NOT to reload, because a refresh that fires while someone is typing a
// commit message or picking lines to stage is worse than a slightly stale view.

const watchState = {
  enabled: false,
  autoFetchMinutes: 0,
  lastRefresh: 0,
  pending: null,
  suspendedReason: null
};

// A refresh is deferred while any of these is true. Each one represents the user being
// mid-thought in a way a repaint would disrupt.
function refreshWouldDisturbUser() {
  // A modal is open — the graph or file list changing underneath a dialog is jarring, and
  // dialogs like the rebase planner hold a snapshot of state they were built from.
  const modalOpen = !!(document.getElementById('modal-overlay') &&
    !document.getElementById('modal-overlay').classList.contains('hidden'));
  if (modalOpen) return true;

  // The conflict resolver runs inside the shared modal (so the check above already covers
  // it), but it also has its own open flag — use that directly rather than relying on the
  // modal check to stay true forever.
  if (typeof _resolverOpen !== 'undefined' && _resolverOpen) return true;

  // The blame / file-history overlay is a full-screen workflow of its own.
  const blameOpen = !!(document.getElementById('blame-overlay') &&
    !document.getElementById('blame-overlay').classList.contains('hidden'));
  if (blameOpen) return true;

  // Lines are ticked for partial staging. Refreshing re-reads the diff, and a changed diff
  // invalidates the selection (see partialStagingBind) — so hold off while they're mid-pick.
  if (typeof partialStaging !== 'undefined' && partialStaging.selected && partialStaging.selected.size) return true;

  // A commit message is being written.
  const active = document.activeElement;
  if (active && (active.id === 'commit-summary' || active.id === 'commit-description')) return true;

  return false;
}

// Coalesce and rate-limit. The main process already debounces the raw fs events; this adds
// a floor on how often we're willing to re-run git, and retries later if the user is busy.
const WATCH_MIN_INTERVAL_MS = 1500;

function scheduleWatchRefresh(payload) {
  if (!watchState.enabled || !state.repo) return;
  // Remember the strongest signal seen while a refresh is pending.
  watchState.pending = watchState.pending || { worktree: false, gitDir: false };
  watchState.pending.worktree = watchState.pending.worktree || !!payload.worktree;
  watchState.pending.gitDir = watchState.pending.gitDir || !!payload.gitDir;

  if (watchState.timer) return;
  const since = Date.now() - watchState.lastRefresh;
  const delay = Math.max(250, WATCH_MIN_INTERVAL_MS - since);
  watchState.timer = setTimeout(runWatchRefresh, delay);
}

async function runWatchRefresh() {
  watchState.timer = null;
  if (!watchState.enabled || !state.repo) { watchState.pending = null; return; }

  if (refreshWouldDisturbUser()) {
    // Try again shortly rather than dropping the signal — the user will finish eventually.
    watchState.timer = setTimeout(runWatchRefresh, 2500);
    return;
  }

  const payload = watchState.pending || { worktree: true, gitDir: false };
  watchState.pending = null;
  watchState.lastRefresh = Date.now();

  try {
    if (payload.gitDir) {
      // Refs, HEAD or the index moved — branch list, graph and status can all be stale.
      await refreshAll();
    } else {
      // Only working-tree files changed: status is enough, and it's much cheaper than
      // relaying out the graph on every save.
      await refreshStatus();
      await refreshSelectedFileDiff();
    }
  } catch (e) {
    // A refresh failing (e.g. repo deleted underneath us) shouldn't kill the watcher.
    console.error('watch refresh failed', e);
  }
}

// Re-read the diff for the file currently open in the Changes tab, so an external edit is
// visible without clicking away and back. Skipped when a selection is active — that case
// is already held off by refreshWouldDisturbUser, but this keeps the invariant local too.
async function refreshSelectedFileDiff() {
  if (state.currentTab !== 'changes' || !state.selectedFile) return;
  if (typeof partialStaging !== 'undefined' && partialStaging.selected && partialStaging.selected.size) return;
  const el = document.getElementById('diff-content');
  const prevScroll = el ? el.scrollTop : 0;
  // The file may have just been staged away or deleted; selectFile handles both.
  const stillListed =
    (state.stagedFiles || []).some(f => f.path === state.selectedFile) ||
    (state.unstagedFiles || []).some(f => f.path === state.selectedFile);
  if (!stillListed) return;
  await selectFile(state.selectedFile, state.selectedFileStaged);
  if (el) el.scrollTop = prevScroll;
}

// Start watching the currently open repo. Called after a repo opens.
async function startRepoWatch() {
  const r = await gs.startWatching();
  if (!r.ok) { watchState.enabled = false; return; }
  watchState.enabled = !!r.data.watching;
  watchState.autoFetchMinutes = r.data.autoFetchMinutes || 0;
  if (r.data.watcherDisabled) {
    watchState.enabled = false;
    watchState.suspendedReason = 'The filesystem watcher is unavailable on this system — refresh manually or on window focus.';
  }
}

async function stopRepoWatch() {
  watchState.enabled = false;
  clearTimeout(watchState.timer);
  watchState.timer = null;
  watchState.pending = null;
  try { await gs.stopWatching(); } catch (e) { /* best effort */ }
}

// Subscriptions. Registered once at load; they no-op until a repo is open.
(() => {
  if (!window.gs || !gs.onFsChanged) return;

  gs.onFsChanged((payload) => {
    if (!payload) return;
    if (payload.unavailable) {
      watchState.enabled = false;
      // Told once, quietly — this is a platform limitation, not something to nag about.
      if (!watchState.suspendedReason) {
        watchState.suspendedReason = payload.error || 'unavailable';
        showToast('Filesystem watching is unavailable on this system — GitGood will refresh on window focus instead.', 'info', 7000);
      }
      return;
    }
    scheduleWatchRefresh(payload);
  });

  gs.onAutoFetched((payload) => {
    if (!payload) return;
    if (payload.suspended) {
      showToast('Background fetch failed twice and has been paused for this session. Check the remote, then fetch manually.', 'error', 9000);
      watchState.autoFetchMinutes = 0;
      return;
    }
    // A fetch only moves remote-tracking refs, so refresh the parts that read them. Held
    // off — like watcher refreshes — while the user is mid-task.
    if (refreshWouldDisturbUser()) return;
    Promise.resolve()
      .then(() => refreshStatus())
      .then(() => refreshBranches())
      .catch(() => {});
  });
})();
