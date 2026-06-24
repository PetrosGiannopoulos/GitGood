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
  // New commits may have appeared — drop the cached commit→files map so a file-based
  // search rebuilds it on next use, and the diff-content (pickaxe) match sets so a
  // content search re-runs against the updated history.
  _commitFilesMap = null;
  clearContentMatchCache();
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

// Number of newest commits to keep visible when the graph is collapsed.
const GRAPH_COLLAPSE_VISIBLE = 5;

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
    commits = commits.filter(c => commitMatchesFilter(c, query, state.graphFilterMode));
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
          { label: 'Checkout as local', icon: '⑂', action: () => checkoutRemoteBranch(b, localName) },
          'sep',
          { label: 'Delete remote branch', icon: '✗', danger: true, action: () => deleteRemoteBranch(b) }
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
  const commits = query ? allCommits.filter(c => commitMatchesFilter(c, query, state.historyFilterMode)) : allCommits;

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
      diffBytes: details.diffBytes,
      // While a diff-content filter is active, seed the per-commit file filter with the
      // same query so the files that actually changed it surface immediately.
      fileFilter: (state.historyFilterMode === 'content' && (state.historyFilter || '').trim()) || ''
    });
  });
}

// ============================================
