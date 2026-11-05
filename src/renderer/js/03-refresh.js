// MAIN APP — REFRESH PIPELINE
// ============================================
function updateRepoInfo() {
  // Called on every way a repository becomes current (open, clone, init, tab, reload), which
  // is exactly when the commit panel's forge button has to ask again.
  if (typeof updateCommitIssueButton === 'function') updateCommitIssueButton();
  if (!state.repo) {
    $('#repo-info').innerHTML = '<span class="repo-label">No realm</span>';
    hideRepoPathTip();
    return;
  }
  $('#repo-info').innerHTML = `
    <span class="repo-name">${escapeHtml(state.repo.name)}</span>
    <span class="repo-path">${escapeHtml(state.repo.path)}</span>
  `;
}

// ---- full-path tooltip ----------------------------------------------------------------
// The toolbar shows the path ellipsised to whatever room is left before the Sync button;
// hovering it shows the whole thing. The tooltip is a <body> child, not a child of the
// repo-info block, for two reasons: .toolbar-left clips its overflow (that clip is what
// stops the path running under the buttons), and a tooltip that is itself part of the
// hovered element's layout makes the pointer chase it — restyling the hovered node moves it
// out from under the cursor, hover drops, it snaps back, and the pair oscillates.
let _repoPathTip = null;

function repoPathTipEl() {
  if (_repoPathTip && _repoPathTip.isConnected) return _repoPathTip;
  _repoPathTip = document.createElement('div');
  _repoPathTip.className = 'repo-path-tip';
  document.body.appendChild(_repoPathTip);
  return _repoPathTip;
}

function showRepoPathTip() {
  const info = document.getElementById('repo-info');
  const path = info && info.querySelector('.repo-path');
  if (!path || !state.repo) return;
  const tip = repoPathTipEl();
  tip.textContent = state.repo.path;
  // Anchored to the toolbar's bottom edge rather than to the (clipped) path element, so it
  // sits in the same place whether or not the text is truncated.
  const anchor = info.getBoundingClientRect();
  const bar = document.querySelector('.toolbar');
  tip.style.left = Math.round(anchor.left) + 'px';
  tip.style.top = Math.round((bar ? bar.getBoundingClientRect().bottom : anchor.bottom) + 4) + 'px';
  tip.style.right = 'auto';
  tip.classList.add('visible');
  // Nudge back inside if the path is long enough to run off the right edge.
  const box = tip.getBoundingClientRect();
  if (box.right > window.innerWidth - 8) {
    tip.style.left = Math.max(8, window.innerWidth - 8 - box.width) + 'px';
  }
}

function hideRepoPathTip() {
  if (_repoPathTip) _repoPathTip.classList.remove('visible');
}

(() => {
  const info = document.getElementById('repo-info');
  if (!info) return;
  // enter/leave rather than :hover so the tooltip's own existence can never influence it.
  info.addEventListener('mouseenter', showRepoPathTip);
  info.addEventListener('mouseleave', hideRepoPathTip);
  // mouseenter only fires when the pointer crosses the boundary. If the repository opens
  // (or a tab switch repaints this block) while the cursor is already resting here, there
  // is no crossing and hovering would feel dead until you moved away and back. Showing on
  // move covers that; it can only ever show, so it cannot start a flicker loop.
  info.addEventListener('mousemove', () => {
    if (!_repoPathTip || !_repoPathTip.classList.contains('visible')) showRepoPathTip();
  });
  // A tooltip pinned to a viewport coordinate goes stale the moment anything moves.
  window.addEventListener('resize', hideRepoPathTip);
  window.addEventListener('blur', hideRepoPathTip);
})();

async function refreshAll() {
  // New commits may have appeared — drop the cached commit→files map so a file-based
  // search rebuilds it on next use, and the diff-content (pickaxe) match sets so a
  // content search re-runs against the updated history.
  _commitFilesMap = null;
  clearContentMatchCache();
  clearLocalOnlyCommits();
  // The hidden-info (empty folders / ignored) cache is repo-specific and time-based;
  // drop it on a full refresh so switching repos can't show the previous repo's data.
  hiddenInfoCache = null;
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
    tap(refreshRemotes(), 'Contacting distant realms…'),
    // Cheap (one `git worktree list`) and it feeds the "already checked out elsewhere"
    // warnings, so it rides along with every full refresh.
    typeof refreshWorktrees === 'function' ? tap(refreshWorktrees(), 'Counting the outposts…') : Promise.resolve()
  ]);
  // The stash list is filtered by the current branch, and refreshStashes may have drawn it
  // before refreshStatus learned which branch that now is — draw it again with both known.
  renderStashes();
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
  // refreshAll() cleared the commit→files cache above. If a file-based history filter is
  // active, reload it before rendering — otherwise commitMatchesFilter sees an empty map
  // and filters everything out, leaving the history blank until the user re-types.
  if ((state.historyFilterMode === 'files' || state.historyFilterMode === 'all') && (state.historyFilter || '').trim()) {
    await ensureCommitFilesMap();
  } else if (state.historyFilterMode === 'content' && (state.historyFilter || '').trim()) {
    await ensureContentMatches(state.historyFilter);
  }
  renderHistory();
}

async function refreshGraph() {
  const requestedLimit = state.graphLimit || 300;
  state.graphLoading = true;
  const result = await gs.graphLog({ limit: requestedLimit });
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
  // Fewer commits than asked for ⇒ the whole history fits in the window (#9).
  state.graphAtEnd = commits.length < requestedLimit;
  if (typeof updateLoadMoreButton === 'function') updateLoadMoreButton();
  // refreshAll() cleared the commit→files cache above. If a file-based graph filter is
  // active, reload it before laying out — otherwise commitMatchesFilter sees an empty map
  // and filters every commit out, so the graph renders empty ("No chronicles to display")
  // and the detail pane clears until the user re-triggers the filter.
  if ((state.graphFilterMode === 'files' || state.graphFilterMode === 'all') && (state.graphFilter || '').trim()) {
    await ensureCommitFilesMap();
  } else if (state.graphFilterMode === 'content' && (state.graphFilter || '').trim()) {
    await ensureContentMatches(state.graphFilter);
  }
  // Preload the local-only set too (refreshAll cleared it) so hiding unpushed commits doesn't
  // flash the full graph before the set arrives.
  if (state.graphHideLocalCommits) await ensureLocalOnlyCommits();
  relayoutGraph();
}

// Build the layout from the current commit list, applying the folds (computeGraphFolds):
// a commit's linear run below it — the commits that only continue its own branch line — can
// be folded behind it, by hand (state.collapsedCommits) or everywhere at once
// (state.graphCompressed, minus the folds opened by hand in state.expandedFolds).
function relayoutGraph() {
  const all = state.graphAllCommits || [];
  const head = state.graphHead || '';
  let commits = all;
  const hiddenCount = 0;

  // 0. Text filter (search bar): keep only commits matching the query. This narrows
  //    the graph to matches; structural lines to filtered-out parents simply fade off.
  const query = (state.graphFilter || '').trim();
  if (query) {
    commits = commits.filter(c => commitMatchesFilter(c, query, state.graphFilterMode));
  }

  // 0.5 Hide local-only (unpushed) commits when the option is on. These are only branch tips,
  //     so removing them leaves every remaining (remote-reachable) commit's parents intact —
  //     no structural gaps, hence no `filtered` stub treatment needed here. If the set hasn't
  //     loaded yet, kick off the load and repaint when it arrives (this pass shows everything).
  if (state.graphHideLocalCommits) {
    const localOnly = localOnlyCommitSet();
    if (localOnly) {
      if (localOnly.size) commits = commits.filter(c => !localOnly.has(c.hash));
    } else {
      ensureLocalOnlyCommits().then(() => relayoutGraph());
    }
  }

  // Folds. Not while filtering: a filtered list is already a subset, and a run of matches
  // is not a run of history.
  let folds = new Map();
  let parentsOverride = null;
  let foldedTotal = 0;
  if (!query) {
    const f = computeGraphFolds(commits, {
      head,
      collapsed: state.collapsedCommits,
      compressed: !!state.graphCompressed,
      expanded: state.expandedFolds
    });
    folds = f.folds;
    if (f.hidden.size) {
      commits = commits.filter(c => !f.hidden.has(c.hash));
      parentsOverride = f.parents;
      foldedTotal = f.hidden.size;
    }
  }
  const collapsedSet = new Set([...folds].filter(([, v]) => v.collapsed).map(([h]) => h));

  const layout = layoutGraph(commits, { filtered: !!query, parentsOverride, foldedAnchors: collapsedSet });
  state.graph = {
    commits, head, hiddenCount,
    perCommitHidden: foldedTotal,
    filtered: !!query,
    folds,               // Map<hash, { count, collapsed }>: every commit with a run to fold
    parentsOverride,     // Map<hash, parents>: a folded commit's first parent skips its run
    collapsedSet,        // the anchors currently folded
    ...layout
  };
  renderGraph();
  if (typeof updateGraphFoldButtons === 'function') updateGraphFoldButtons();

  // Reflect "no matches" on the graph search box — but not while a diff-content search is
  // still streaming (`searching`), where 0 matches so far just means "not found yet".
  const searchBox = document.getElementById('graph-search');
  if (searchBox) searchBox.classList.toggle('has-no-matches',
    !!query && commits.length === 0 && !searchBox.classList.contains('searching'));
}

// Which commits a fold hides. A commit's *run* is the chain of first parents below it that
// only continue its line: each has no ref (branch tip, tag), is not HEAD, is not a merge, is
// not a root, and has exactly one child in view — the commit above it. The run therefore
// ends at the fork point where this branch left another one (that commit has two children),
// so folding a feature branch never swallows the history of the branch it came from.
// What stays visible is exactly the structure: tips, merges, forks, roots.
//
// A folded commit's first parent is rewritten (`parents`) to the commit under its run, so
// the layout draws one line straight across the fold instead of a line that runs off the
// bottom as if history ended there. A run that reaches past the loaded window keeps the
// hidden parent, which the layout already draws as "continues below".
//
// opts: head, collapsed (Set, folded by hand), compressed (fold every run), expanded (Set,
// opened by hand while compressed). In compressed mode the members of an opened run are
// not folded again on their own — otherwise opening a fold would just fold one row lower.
function computeGraphFolds(commits, opts) {
  const { head = '', collapsed = null, compressed = false, expanded = null } = opts || {};
  const byHash = new Map();
  const childCount = new Map();
  for (const c of commits) {
    byHash.set(c.hash, c);
    for (const p of (c.parents || [])) childCount.set(p, (childCount.get(p) || 0) + 1);
  }
  const plain = (c) => c.hash !== head
    && !(c.refs && c.refs.length)
    && (c.parents || []).length === 1
    && childCount.get(c.hash) === 1;
  // The next commit of c's run, or null.
  const runNext = (c) => {
    const fp = (c.parents || [])[0];
    const p = fp ? byHash.get(fp) : null;
    return p && plain(p) ? p : null;
  };

  // Run lengths, memoised: run(c) = 1 + run(next) — so long linear history costs O(n).
  const runLen = new Map();
  const lenOf = (start) => {
    const stack = [];
    let c = start;
    while (c && !runLen.has(c.hash)) { stack.push(c); c = runNext(c); }
    // Walked off the end: the last commit has no next, run 0. Hit a memo: one more than it.
    let n = c ? runLen.get(c.hash) : -1;
    for (let i = stack.length - 1; i >= 0; i--) runLen.set(stack[i].hash, ++n);
    return runLen.get(start.hash);
  };

  const hidden = new Set();
  const covered = new Set();   // inside a run opened by hand while compressed
  const folds = new Map();
  const parents = new Map();
  for (const c of commits) {    // newest first, so an anchor is seen before its run
    if (hidden.has(c.hash)) continue;
    const count = lenOf(c);
    if (!count) continue;
    const byHand = !!(collapsed && collapsed.has(c.hash));
    const isCollapsed = byHand
      || (compressed && !covered.has(c.hash) && !(expanded && expanded.has(c.hash)));
    folds.set(c.hash, { count, collapsed: isCollapsed });
    let cur = c;
    for (let i = 0; i < count; i++) {
      cur = byHash.get(cur.parents[0]);
      (isCollapsed ? hidden : covered).add(cur.hash);
    }
    if (isCollapsed) parents.set(c.hash, [cur.parents[0], ...c.parents.slice(1)]);
  }
  return { hidden, folds, parents };
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
        const items = [
          { label: 'Checkout', icon: '⑂', action: () => checkoutBranch(b) },
          { label: 'Merge into current', icon: '⚒', action: () => mergeBranch(b) }
        ];
        // Rebasing onto yourself is meaningless, so only offer it for other branches.
        if (b !== current) {
          items.push(
            { label: `Rebase ${current || 'HEAD'} onto ${b}`, icon: '⚔', action: () => showRebaseDialog(b) },
            { label: `Interactive rebase onto ${b}…`, icon: '☰', action: () => showInteractiveRebaseDialog(b) }
          );
        }
        items.push(
          { label: 'Rename branch…', icon: '✎', action: () => showRenameBranchDialog(b) },
          'sep',
          { label: 'Delete branch', icon: '✗', danger: true, action: () => deleteBranch(b, false) },
          { label: 'Force delete', icon: '⚔', danger: true, action: () => deleteBranch(b, true) }
        );
        showContextMenu(items, e.pageX, e.pageY);
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
          { label: 'Checkout as local', icon: '⑂', action: () => checkoutRemoteBranch(b, localName) },
          { label: `Rebase current branch onto ${b}`, icon: '⚔', action: () => showRebaseDialog(b) },
          { label: `Interactive rebase onto ${b}…`, icon: '☰', action: () => showInteractiveRebaseDialog(b) },
          'sep',
          { label: 'Delete remote branch', icon: '✗', danger: true, action: () => deleteRemoteBranch(b) }
        ], e.pageX, e.pageY);
      };
      remoteList.appendChild(li);
    });
  }

  renderRecentBranches(current);
}

// Local branches, newest push first. Main reads the push times from the remote-tracking
// reflogs (lib/recent-pushes.js), so a branch only appears once it has been pushed from
// this clone — and a branch pushed elsewhere, or before the reflog was expired, does not.
function renderRecentBranches(current) {
  const list = $('#recent-branches');
  if (!list) return;
  list.innerHTML = '';
  const recent = (state.branches && state.branches.recent) || [];
  $('#recent-count').textContent = recent.length;
  if (!recent.length) {
    list.innerHTML = '<li class="sidebar-empty">No branches pushed from here yet</li>';
    return;
  }
  recent.forEach(r => {
    const li = document.createElement('li');
    li.className = 'sidebar-item recent-branch-item' + (r.branch === current ? ' active' : '');
    li.title = `Pushed to ${r.remoteRef} ${new Date(r.time).toLocaleString()} (${r.hash.slice(0, 7)})`;
    li.innerHTML = `<span class="recent-branch-name">${escapeHtml(r.branch)}</span><span class="recent-branch-when">${escapeHtml(relativeTime(r.time))}</span>`;
    li.dataset.context = 'branch';
    li.onclick = () => { if (r.branch !== current) checkoutBranch(r.branch); };
    li.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [{ label: 'Checkout', icon: '⑂', action: () => checkoutBranch(r.branch) }];
      if (r.branch !== current) items.push({ label: 'Merge into current', icon: '⚒', action: () => mergeBranch(r.branch) });
      showContextMenu(items, e.pageX, e.pageY);
    };
    list.appendChild(li);
  });
}

// The branch a stash was made on, as parsed from its subject by repo:stashList.
function stashBranchOf(stash) {
  return stash.branch || '(unknown)';
}

// The branch name stashes made right now would record — "(no branch)" is git's own wording
// for a detached HEAD, so those stashes match it too.
function currentStashBranch() {
  const st = state.status;
  if (!st) return null;
  return st.detached ? '(no branch)' : (st.current || null);
}

// GitHub Desktop names the stashes it makes "!!GitHub_Desktop<branch>" — a marker for its own
// lookup, not something to read. Returns the branch inside the marker, or null.
function githubDesktopStashBranch(stash) {
  const m = (stash.text || '').match(/^!!GitHub_Desktop<(.*)>$/);
  return m ? (m[1] || stashBranchOf(stash)) : null;
}

// What to call a stash in a list: a GitHub Desktop stash is called by its branch.
function stashDisplayText(stash) {
  const ghd = githubDesktopStashBranch(stash);
  if (ghd) return ghd;
  return stash.text || stash.message || stash.hash || 'stash';
}

// Hover text for a stash row. Built from the parsed fields rather than the raw subject, which
// for GitHub Desktop reads "On x: !!GitHub_Desktop<x>".
function stashTooltip(stash, i, hint) {
  const ghd = githubDesktopStashBranch(stash);
  const lines = [ghd ? `${ghd} (GitHub Desktop stash)` : stashDisplayText(stash)];
  lines.push(`Branch: ${stashBranchOf(stash)}`);
  const meta = [`stash@{${i}}`];
  if (stash.date) meta.push(new Date(stash.date).toLocaleString());
  if (stash.hash) meta.push(stash.hash.slice(0, 7));
  lines.push(meta.join(' · '));
  if (hint) lines.push(hint);
  return lines.join('\n');
}

function stashIndexOf(stash, fallback) {
  return (typeof stash.index === 'number') ? stash.index : fallback;
}

// `onDrop` replaces the plain drop — the branch picker passes one so it can reopen itself
// after the confirmation dialog (there is only one modal) has taken its place.
function stashContextMenu(e, i, onDrop) {
  e.preventDefault();
  e.stopPropagation();
  showContextMenu([
    { label: 'Browse files…', icon: '⚜', action: () => showStashBrowser(i) },
    'sep',
    { label: 'Apply (keep stash)', icon: '⌥', action: () => stashApply(i) },
    { label: 'Pop (apply & remove)', icon: '⌃', action: () => stashPop(i) },
    'sep',
    { label: 'Drop', icon: '✗', danger: true, action: () => (onDrop ? onDrop(i) : stashDrop(i)) }
  ], e.pageX, e.pageY);
}

// The sidebar lists only the current branch's stashes; the rest are one click away in
// showStashBranchPicker. state.stashes always holds every stash — indices are global.
function renderStashes() {
  const list = $('#stash-list');
  if (!list) return;
  list.innerHTML = '';
  const all = state.stashes || [];
  const current = currentStashBranch();
  const mine = all.filter(s => stashBranchOf(s) === current);
  const others = all.length - mine.length;
  const countEl = $('#stash-count');
  countEl.textContent = mine.length;
  countEl.title = `${mine.length} on this branch · ${all.length} in total`;
  if (!mine.length) {
    list.innerHTML = `<li class="sidebar-empty">${all.length ? 'No stashes on this branch' : 'No stashes'}</li>`;
  }
  mine.forEach((stash) => {
    const i = stashIndexOf(stash, all.indexOf(stash));
    const li = document.createElement('li');
    li.className = 'sidebar-item stash-item';
    li.textContent = `[${i}] ${stashDisplayText(stash)}`;
    li.title = stashTooltip(stash, i, 'Click to browse files in this stash');
    li.onclick = () => showStashBrowser(i);
    li.oncontextmenu = (e) => stashContextMenu(e, i);
    list.appendChild(li);
  });
  if (others > 0) {
    const li = document.createElement('li');
    li.className = 'sidebar-item stash-item';
    li.style.color = 'var(--text-dim)';
    li.textContent = `☰ ${others} on other branch${others === 1 ? '' : 'es'}…`;
    li.title = 'Browse stashes on every branch';
    li.onclick = () => showStashBranchPicker();
    list.appendChild(li);
  }
}

// Popup: pick a branch (or narrow with the filter) to see the stashes made on it.
// `restore` ({ selected, filter, scroll }) reopens it as it was — used after a drop, whose
// confirmation dialog replaces this one in the single modal.
function showStashBranchPicker(restore) {
  const all = state.stashes || [];
  const current = currentStashBranch();
  const localBranches = new Set((state.branches && state.branches.local && state.branches.local.all) || []);

  const counts = new Map();
  for (const s of all) counts.set(stashBranchOf(s), (counts.get(stashBranchOf(s)) || 0) + 1);
  // Current branch first, then alphabetical.
  const names = [...counts.keys()].sort((a, b) =>
    (b === current) - (a === current) || a.localeCompare(b));
  let selected = counts.has(current) ? current : null;   // null = every branch
  // A restored branch whose last stash was just dropped falls back to every branch.
  if (restore && 'selected' in restore) selected = counts.has(restore.selected) ? restore.selected : null;

  const body = document.createElement('div');
  body.innerHTML = `
    <input class="modal-input" id="sp-filter" placeholder="Filter branches and stash messages…" style="margin-bottom:10px" />
    <div style="display:grid;grid-template-columns:minmax(120px,220px) minmax(0,1fr);gap:10px">
      <div>
        <span class="branches-label" style="margin:0 0 6px;display:block">⑂ Branches</span>
        <ul class="file-list" id="sp-branches" style="max-height:360px;overflow-y:auto;border:1px solid var(--border)"></ul>
      </div>
      <div>
        <span class="branches-label" style="margin:0 0 6px;display:block" id="sp-stash-label">⚿ Stashes</span>
        <ul class="file-list" id="sp-stashes" style="max-height:360px;overflow-y:auto;border:1px solid var(--border)"></ul>
      </div>
    </div>
  `;
  const filterInput = body.querySelector('#sp-filter');
  const branchUl = body.querySelector('#sp-branches');
  const stashUl = body.querySelector('#sp-stashes');
  const stashLabel = body.querySelector('#sp-stash-label');

  const row = (text, extraText, columns = 'minmax(0,1fr) auto') => {
    const li = document.createElement('li');
    li.className = 'file-item';
    // .file-item is a 4-column grid (checkbox, status, path, actions); these rows have
    // only the last two (stash rows add a third, the drop button).
    li.style.gridTemplateColumns = columns;
    const path = document.createElement('div');
    path.className = 'file-path';
    // .file-path is direction:rtl so long file paths elide at the start; for this text that
    // would reorder punctuation ("[0] !!x<y>" draws as "<x<y!! [0]").
    path.style.direction = 'ltr';
    path.textContent = text;
    li.appendChild(path);
    if (extraText) {
      const extra = document.createElement('div');
      extra.className = 'file-actions';
      extra.style.cssText = 'font-size:11px;color:var(--text-dim);font-family:var(--font-mono);white-space:nowrap';
      extra.textContent = extraText;
      li.appendChild(extra);
    }
    return li;
  };
  const empty = (text) => {
    const li = document.createElement('li');
    li.className = 'sidebar-empty';
    li.textContent = text;
    return li;
  };

  function render() {
    // Every space-separated term must appear — the same idiom as the branch and path filters.
    const terms = filterInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (str) => terms.every(t => str.toLowerCase().includes(t));
    const stashHit = (s) => hit(`${stashBranchOf(s)} ${s.message}`);
    const matching = all.filter(stashHit);

    branchUl.innerHTML = '';
    const addBranch = (name, label, n, tag) => {
      const li = row(label, tag ? `${tag} · ${n}` : String(n));
      if (name === selected) li.classList.add('selected');
      li.onclick = () => { selected = name; render(); };
      branchUl.appendChild(li);
    };
    addBranch(null, 'All branches', matching.length);
    names
      .filter(n => hit(n) || matching.some(s => stashBranchOf(s) === n))
      .forEach(n => {
        const n2 = matching.filter(s => stashBranchOf(s) === n).length;
        const tag = n === current ? 'current'
          : (!localBranches.has(n) && !n.startsWith('(')) ? 'deleted' : '';
        // A branch that matched by name shows all its stashes' count even if none match.
        addBranch(n, n, hit(n) && !n2 ? counts.get(n) : n2, tag);
      });

    const onBranch = (s) => selected === null || stashBranchOf(s) === selected;
    // Picking a branch by name shows all its stashes; the filter narrows only when it
    // isn't simply the branch name that matched.
    const shown = all.filter(s => onBranch(s) && (stashHit(s) || (selected !== null && hit(selected))));
    stashLabel.textContent = `⚿ Stashes${selected === null ? '' : ` on ${selected}`} (${shown.length})`;
    stashUl.innerHTML = '';
    if (!all.length) stashUl.appendChild(empty('No stashes in this repository'));
    else if (!shown.length) stashUl.appendChild(empty('No matching stashes'));
    shown.forEach(s => {
      const i = stashIndexOf(s, all.indexOf(s));
      const when = s.date ? new Date(s.date).toLocaleDateString() : '';
      const li = row(`[${i}] ${stashDisplayText(s)}`,
        selected === null ? `${stashBranchOf(s)}${when ? ' · ' + when : ''}` : when,
        'minmax(0,1fr) auto auto');
      li.title = stashTooltip(s, i, 'Click to browse files · right-click for actions');
      li.onclick = () => showStashBrowser(i);
      li.oncontextmenu = (e) => stashContextMenu(e, i, dropAndReopen);
      // Always a third cell, even when there is no date, so the button stays in its column.
      if (!li.querySelector('.file-actions')) li.appendChild(document.createElement('div'));
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      const dropBtn = document.createElement('button');
      dropBtn.className = 'file-action-btn';
      dropBtn.textContent = '✕';
      dropBtn.title = `Drop stash@{${i}}`;
      dropBtn.onclick = (e) => { e.stopPropagation(); dropAndReopen(i); };
      actions.appendChild(dropBtn);
      li.appendChild(actions);
      stashUl.appendChild(li);
    });
  }

  // The confirmation takes over the modal; whatever the answer, come back to this view
  // with the same branch, filter and scroll position, built from the refreshed list.
  async function dropAndReopen(i) {
    const snapshot = { selected, filter: filterInput.value, scroll: stashUl.scrollTop };
    await stashDrop(i);
    showStashBranchPicker(snapshot);
  }

  if (restore && restore.filter) filterInput.value = restore.filter;
  filterInput.oninput = render;
  render();

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-medieval';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => modal.hide();
  modal.show({ title: 'Stashes by Branch', body, footer: [closeBtn] });
  if (restore && restore.scroll) stashUl.scrollTop = restore.scroll;
}

{
  const btn = $('#stash-browse-btn');
  if (btn) btn.onclick = (e) => { e.stopPropagation(); showStashBranchPicker(); };
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
        { label: 'Copy URL', icon: '⎘', action: () => copyText(url, 'URL copied') },
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
  const commits = query ? allCommits.filter(c => commitMatchesFilter(c, query, state.historyFilterMode)) : allCommits;

  // Reflect "no matches" on the search box — but not while a diff-content search is still
  // streaming (`searching`), where 0 matches so far just means "not found yet".
  const searchBox = $('#history-search');
  if (searchBox) searchBox.classList.toggle('has-no-matches',
    !!query && commits.length === 0 && !searchBox.classList.contains('searching'));

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
        { label: 'Copy hash', icon: '⎘', action: () => copyText(c.hash, 'Hash copied') },
        { label: 'Copy short hash', icon: '⎘', action: () => copyText(c.hash.slice(0, 7), 'Short hash copied') },
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
  // The cache key carries the whitespace mode: the same commit yields a different diff
  // with -w, so keying by hash alone would serve the wrong variant after a toggle.
  const key = hash + (state.diffIgnoreWhitespace ? '#w' : '');
  const cached = _commitCacheGet(key);
  if (cached) return cached;
  const result = await gs.showCommit({ hash, ignoreWhitespace: !!state.diffIgnoreWhitespace });
  if (result && result.ok) {
    _commitCacheSet(key, result.data);
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

// GitHub's private-email address is "<id>+<login>@users.noreply.github.com"; the numeric
// id means nothing to a reader, so show "<login>@users.noreply.github.com" instead.
function displayAuthorEmail(email) {
  return (email || '').replace(/^\d+\+(?=[^@]+@users\.noreply\.github\.com$)/i, '');
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
      <div class="detail-meta">${escapeHtml(commit.author_name || 'unknown')}</div>
      ${commit.author_email ? `<div class="detail-meta"><span>${escapeHtml(displayAuthorEmail(commit.author_email))}</span></div>` : ''}
      <div class="detail-meta"><span>${new Date(commit.date).toLocaleString()}</span></div>
    </div>
    <div class="detail-section">
      <div class="detail-header">⚜ Hash</div>
      <div class="detail-meta text-mono" style="word-break:break-all">${escapeHtml(commit.hash)}</div>
      <div class="sig-slot" data-sig-hash="${escapeHtml(commit.hash)}"></div>
      <div class="checks-slot" data-checks-sha="${escapeHtml(commit.hash)}"></div>
    </div>
    <div class="detail-section">
      <div class="detail-header detail-header-row">
        <span>⚒ Changes</span>
        ${diffModeToggleHtml()}
      </div>
      <div class="diff-content" id="hist-diff-content" style="border:1px solid var(--border);max-height:50vh"><div class="empty-state"><span class="loading"></span></div></div>
    </div>
  `;

  // Verify on demand — one commit, once (17-signing.js caches by hash). Unsigned commits
  // leave the slot empty, so an unsigned repo shows no signing chrome at all.
  if (typeof hydrateSignatureBadge === 'function') {
    hydrateSignatureBadge(panel.querySelector('.sig-slot'), commit.hash);
  }
  if (typeof hydrateChecksBadge === 'function') {
    hydrateChecksBadge(panel.querySelector('.checks-slot'), commit.hash);
  }

  if (!details) return;

  // Defer the diff render to a separate animation frame so the metadata paints first,
  // and so a huge diff doesn't freeze the UI before any feedback appears.
  requestAnimationFrame(() => {
    const diffEl = panel.querySelector('#hist-diff-content');
    if (!diffEl) return;
    renderCommitFileBrowser(diffEl, details.diff, {
      hash: commit.hash,
      diffTruncated: details.diffTruncated,
      diffBytes: details.diffBytes,
      // Seed the per-commit file filter with the same query whenever the filter is about
      // file contents or file names — in both modes the commit is on screen *because* of
      // particular files, so those are the ones to surface in its file list. Message mode
      // is deliberately excluded: its query says nothing about which file to look at.
      fileFilter: ((state.historyFilterMode === 'content' || state.historyFilterMode === 'files' || state.historyFilterMode === 'all')
        && (state.historyFilter || '').trim()) || ''
    });
  });
}

// ============================================
