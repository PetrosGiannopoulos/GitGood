// ============================================
// FORGE (renderer) — GitHub & GitLab
// ============================================
// The one tab that talks to a server other than git. Everything it shows is normalised in
// main (see the forge section there), so "pull request" and "merge request" are one thing
// here, called a request.
//
// Nothing loads until the tab is opened, and nothing reloads on a git refresh: this is the
// network, and a background fetch storm against an API with a rate limit is a good way to
// get a repository throttled. Refresh is a button.

const forgeState = {
  info: null,        // last forge:info payload
  view: 'prs',       // 'prs' | 'issues'
  items: [],
  loading: false,
  loadedFor: null,   // repo path the current list belongs to
  checks: new Map(), // sha -> forge:checks result, so the graph doesn't re-ask per click
  // The request or issue being read in the right-hand pane. Panes are filled lazily and
  // then kept, so flipping between Conversation and Files costs nothing the second time.
  detail: null       // { kind, number, data, tab, timeline, commits, files, error }
};

function forgeReset() {
  forgeState.info = null;
  forgeState.items = [];
  forgeState.loadedFor = null;
  forgeState.detail = null;
  forgeState.checks.clear();
  const badge = document.getElementById('forge-tab-badge');
  if (badge) badge.style.display = 'none';
}

// Entry point from the tab strip.
async function openForgeTab() {
  if (!state.repo) return;
  if (forgeState.loadedFor === state.repo.path && forgeState.items.length) { renderForge(); return; }
  await refreshForge();
}

async function refreshForge() {
  const body = document.getElementById('forge-body');
  if (!body || !state.repo) return;
  forgeState.loading = true;
  // Everything below this point that is not the list+reader (spinner, error, token setup)
  // owns the whole body and scrolls itself.
  body.classList.remove('has-split');
  body.innerHTML = '<div class="empty-state"><span class="loading"></span></div>';

  const info = await gs.forgeInfo({});
  if (!info || !info.ok) {
    forgeState.loading = false;
    body.innerHTML = forgeErrorHtml(info && info.error);
    return;
  }
  forgeState.info = info.data;
  updateForgeLabel();

  if (!forgeState.info.supported) { forgeState.loading = false; renderForgeUnknownHost(); return; }
  if (!forgeState.info.hasToken || forgeState.info.tokenInvalid) { forgeState.loading = false; renderForgeTokenPrompt(); return; }

  const stateFilter = (document.getElementById('forge-state') || {}).value || 'open';
  const r = forgeState.view === 'issues'
    ? await gs.forgeIssues({ state: stateFilter })
    : await gs.forgePullRequests({ state: stateFilter });
  forgeState.loading = false;

  if (!r || !r.ok) { body.innerHTML = forgeErrorHtml(r && r.error); return; }
  forgeState.items = r.data || [];
  forgeState.loadedFor = state.repo.path;
  renderForge();
}

function updateForgeLabel() {
  const el = document.getElementById('forge-repo-label');
  if (!el) return;
  const i = forgeState.info;
  if (!i) { el.textContent = ''; return; }
  const who = i.user && i.user.login ? ` · ${i.user.login}` : '';
  el.textContent = `${i.provider === 'gitlab' ? 'GitLab' : i.provider === 'github' ? 'GitHub' : i.host} · ${i.projectPath}${who}`;
  el.title = i.webUrl || '';
}

function forgeErrorHtml(msg) {
  return `<div class="empty-state">
    <div class="empty-icon">⚑</div>
    <p class="text-red" style="max-width:560px;white-space:pre-line">${escapeHtml(msg || 'The forge could not be reached.')}</p>
  </div>`;
}

// The list is the left half of the tab and the reader is the right half. Rendering them
// together (rather than swapping one for the other) is what makes walking a queue of
// requests cheap: the list never reloads, and the selected row stays visible.
function renderForge() {
  const body = document.getElementById('forge-body');
  if (!body) return;
  const items = forgeState.items || [];

  // The badge counts open requests only — an issue count on a tab that also lists requests
  // would be ambiguous, and open requests are the thing people act on.
  const badge = document.getElementById('forge-tab-badge');
  if (badge && forgeState.view === 'prs') {
    const open = items.filter(i => i.state === 'open' || i.state === 'draft').length;
    badge.textContent = open;
    badge.style.display = open ? 'inline-block' : 'none';
  }

  const current = (state.branches.local && state.branches.local.current) || '';
  const listHtml = items.length
    ? `<ul class="forge-list">${items.map(it => forgeState.view === 'issues'
        ? forgeIssueRowHtml(it)
        : forgeRequestRowHtml(it, current)).join('')}</ul>`
    : `<div class="empty-state">
        <div class="empty-icon">${forgeState.view === 'issues' ? '☰' : '⇄'}</div>
        <p>Nothing here${(document.getElementById('forge-state') || {}).value === 'open' ? ' that is still open' : ''}.</p>
      </div>`;

  body.innerHTML = `
    <div class="forge-split">
      <div class="forge-list-pane">${listHtml}</div>
      <div class="forge-detail" id="forge-detail"></div>
    </div>`;
  body.classList.add('has-split');
  renderForgeDetail();
}

// Rows carry what it takes to open them here (kind + number); the ↗ button is the only
// thing left that leaves the app, and it is deliberately a separate target.
function forgeRowAttrs(it) {
  return `data-forge-open="${it.kind === 'issue' ? 'issue' : 'request'}:${it.number}"`;
}

function forgeRowClass(it) {
  const d = forgeState.detail;
  const kind = it.kind === 'issue' ? 'issue' : 'request';
  return d && d.number === it.number && d.kind === kind ? ' active' : '';
}

function forgeOpenExternalBtnHtml(url) {
  return `<button class="forge-ext" title="Open on the forge in a browser" data-forge-url="${forgeAttr(url)}">↗</button>`;
}

function forgeRequestRowHtml(pr, currentBranch) {
  const mine = pr.source && pr.source === currentBranch;
  return `<li class="forge-item${mine ? ' current-branch-pr' : ''}${forgeRowClass(pr)}" ${forgeRowAttrs(pr)}>
    <div class="forge-item-head">
      <span class="forge-state forge-state-${escapeHtml(pr.state)}">${escapeHtml(pr.state)}</span>
      <span class="forge-num">#${pr.number}</span>
      <span class="forge-title">${escapeHtml(pr.title)}</span>
      ${mine ? '<span class="forge-flag" title="Opened from the branch you are on">current branch</span>' : ''}
      ${forgeOpenExternalBtnHtml(pr.url)}
    </div>
    <div class="forge-item-meta">
      <span class="text-mono">${escapeHtml(pr.source)}</span> → <span class="text-mono">${escapeHtml(pr.target)}</span>
      · ${escapeHtml(pr.author)}
      ${pr.updatedAt ? ' · updated ' + escapeHtml(relativeTime(pr.updatedAt)) : ''}
      ${pr.comments ? ` · ${pr.comments} comment${pr.comments === 1 ? '' : 's'}` : ''}
    </div>
  </li>`;
}

function forgeIssueRowHtml(it) {
  const st = it.state === 'opened' ? 'open' : it.state;
  return `<li class="forge-item${forgeRowClass(it)}" ${forgeRowAttrs(it)}>
    <div class="forge-item-head">
      <span class="forge-state forge-state-${escapeHtml(st)}">${escapeHtml(st)}</span>
      <span class="forge-num">#${it.number}</span>
      <span class="forge-title">${escapeHtml(it.title)}</span>
      ${forgeOpenExternalBtnHtml(it.url)}
    </div>
    <div class="forge-item-meta">
      ${escapeHtml(it.author)}
      ${it.updatedAt ? ' · updated ' + escapeHtml(relativeTime(it.updatedAt)) : ''}
      ${forgeLabelsHtml(it.labels, 4)}
    </div>
  </li>`;
}

function forgeLabelsHtml(labels, limit) {
  const list = (labels || []).slice(0, limit || 99);
  if (!list.length) return '';
  return ' · ' + list.map(l => {
    const name = typeof l === 'string' ? l : l.name;
    const color = typeof l === 'string' ? '' : l.color;
    // GitHub gives a background colour and expects the reader to pick a legible foreground;
    // luminance decides, the same way the forge does it.
    const style = /^[0-9a-f]{6}$/i.test(color || '')
      ? ` style="background:#${color};border-color:#${color};color:${forgeReadableInk(color)}"`
      : '';
    return `<span class="forge-label"${style}>${escapeHtml(name)}</span>`;
  }).join(' ');
}

function forgeReadableInk(hex) {
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111' : '#fff';
}

// escapeHtml() leaves quotes alone, which is fine for a file path and not fine for text
// written by a stranger on the internet and dropped into an attribute.
function forgeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Clicking a row opens it in the detail pane; the ↗ affordances (and links inside a
// rendered comment) are the only things that hand the user to a browser.
document.addEventListener('click', (e) => {
  const ext = e.target.closest('[data-forge-url]');
  if (ext) {
    e.preventDefault();
    e.stopPropagation();
    const url = ext.dataset.forgeUrl;
    if (url) gs.openExternal(url);
    return;
  }
  const row = e.target.closest('[data-forge-open]');
  if (row) {
    const [kind, number] = String(row.dataset.forgeOpen).split(':');
    openForgeItem(kind, parseInt(number, 10));
  }
});

// ============================================
// THE READER — a request or issue, in the app
// ============================================
// Four panes' worth of data, each fetched the first time it is looked at and then kept on
// forgeState.detail. Re-rendering is cheap and happens on every change; re-fetching is not
// and happens only when asked (the ⟳ in the detail header, or a successful action).

async function openForgeItem(kind, number) {
  if (!number || !state.repo) return;
  const want = kind === 'issue' ? 'issue' : kind === 'auto' ? 'auto' : 'request';
  forgeState.detail = {
    kind: want === 'auto' ? 'request' : want, number,
    tab: 'conversation', data: null, timeline: null, commits: null, files: null,
    loading: true, error: ''
  };
  renderForge();   // repaint at once so the clicked row highlights before the network answers

  let r = await gs.forgeDetail({ kind: want === 'auto' ? 'request' : want, number });
  // A bare "#123" in a description does not say which kind it is. GitHub numbers requests
  // and issues from one sequence, so the wrong guess is a 404 and the other kind is right.
  if (want === 'auto' && (!r || !r.ok)) r = await gs.forgeDetail({ kind: 'issue', number });

  const d = forgeState.detail;
  if (!d || d.number !== number) return;      // the user clicked something else meanwhile
  d.loading = false;
  if (!r || !r.ok) { d.error = (r && r.error) || 'Could not load it.'; renderForgeDetail(); return; }
  d.data = r.data;
  d.kind = r.data.kind === 'issue' ? 'issue' : 'request';
  renderForge();                              // the row may now need a different highlight
  loadForgePane('conversation');
}

function closeForgeDetail() {
  forgeState.detail = null;
  renderForge();
}

// Fetch whatever the named tab needs, once. `force` is the ⟳ button.
async function loadForgePane(tab, force) {
  const d = forgeState.detail;
  if (!d || !d.data) return;
  const key = tab === 'commits' ? 'commits' : tab === 'files' ? 'files' : 'timeline';
  if (d[key] && !force) return;
  d[key + 'Loading'] = true;
  renderForgeDetail();

  const call = key === 'commits' ? gs.forgeRequestCommits({ number: d.number })
    : key === 'files' ? gs.forgeRequestFiles({ number: d.number })
    : gs.forgeTimeline({ kind: d.kind, number: d.number });
  const r = await call;

  const now = forgeState.detail;
  if (!now || now.number !== d.number || now.kind !== d.kind) return;
  now[key + 'Loading'] = false;
  if (!r || !r.ok) { now[key + 'Error'] = r && r.error; renderForgeDetail(); return; }
  now[key + 'Error'] = '';
  now[key] = r.data;
  renderForgeDetail();
}

async function refreshForgeDetail() {
  const d = forgeState.detail;
  if (!d) return;
  const r = await gs.forgeDetail({ kind: d.kind, number: d.number });
  if (!handleResult(r)) return;
  const now = forgeState.detail;
  if (!now || now.number !== d.number) return;
  now.data = r.data;
  now.timeline = null; now.commits = null; now.files = null;
  renderForgeDetail();
  loadForgePane(now.tab, true);
}

// Keeping the scroll position across a re-render is what stops the pane jumping when a
// comment posts or a pane finishes loading. A tab change is a new view and starts at the top.
let _forgeDetailScrollKey = '';

function renderForgeDetail() {
  const host = document.getElementById('forge-detail');
  if (!host) return;
  const d = forgeState.detail;

  if (!d) {
    host.innerHTML = `<div class="empty-state forge-detail-hint">
      <div class="empty-icon">⚑</div>
      <p>Pick one on the left to read it here.</p>
    </div>`;
    _forgeDetailScrollKey = '';
    return;
  }
  if (d.loading) { host.innerHTML = '<div class="empty-state"><span class="loading"></span></div>'; return; }
  if (d.error) { host.innerHTML = forgeErrorHtml(d.error); return; }

  const key = `${d.kind}:${d.number}:${d.tab}`;
  const keepScroll = key === _forgeDetailScrollKey ? host.scrollTop : 0;
  // A half-written comment must survive a re-render — a pane finishing its load while the
  // user types would otherwise throw the draft away.
  const box = document.getElementById('forge-comment-box');
  const draft = key === _forgeDetailScrollKey && box ? box.value : '';

  const x = d.data;
  const isReq = d.kind === 'request';
  host.innerHTML = forgeDetailHeadHtml(d, x, isReq) +
    `<div class="forge-detail-body">${
      d.tab === 'commits' ? forgeCommitsPaneHtml(d)
      : d.tab === 'files' ? forgeFilesPaneHtml(d)
      : forgeConversationPaneHtml(d, x)
    }</div>`;

  _forgeDetailScrollKey = key;
  host.scrollTop = keepScroll;
  if (draft) {
    const fresh = document.getElementById('forge-comment-box');
    if (fresh) fresh.value = draft;
  }

  // CI for the head commit, filled in by the same helper the commit panes use.
  const checksHost = host.querySelector('.forge-detail-checks');
  if (checksHost && x.sha) {
    checksHost.dataset.checksSha = x.sha;
    hydrateChecksBadge(checksHost, x.sha);
  }
}

function forgeDetailHeadHtml(d, x, isReq) {
  const st = x.state === 'opened' ? 'open' : x.state;
  const open = st === 'open' || st === 'draft';
  const counts = isReq && (x.additions || x.deletions)
    ? `<span class="forge-plusminus"><span class="text-add">+${x.additions}</span> <span class="text-del">−${x.deletions}</span></span>` : '';

  const tabs = isReq ? [
    ['conversation', '☰ Conversation', x.comments || 0],
    ['commits', '✠ Commits', x.commitsCount || 0],
    ['files', '⚔ Files', x.changedFiles || 0]
  ] : [['conversation', '☰ Conversation', x.comments || 0]];

  return `
    <div class="forge-detail-head">
      <div class="forge-detail-title">
        <span class="forge-state forge-state-${escapeHtml(st)}">${escapeHtml(st)}</span>
        <span class="forge-num">#${x.number}</span>
        <span class="forge-detail-name">${escapeHtml(x.title)}</span>
        <button class="forge-ext" title="Close this and go back to the list" data-forge-act="close-detail">✕</button>
      </div>
      <div class="forge-detail-meta">
        ${escapeHtml(x.author || '')}
        ${x.createdAt ? ' opened ' + escapeHtml(relativeTime(x.createdAt)) : ''}
        ${isReq ? ` · <span class="text-mono">${escapeHtml(x.source)}</span> → <span class="text-mono">${escapeHtml(x.target)}</span>` : ''}
        ${isReq && x.isFork ? ' <span class="forge-flag">fork</span>' : ''}
        ${counts}
        ${forgeLabelsHtml(x.labels)}
        ${(x.assignees || []).length ? ' · assigned ' + x.assignees.map(a => escapeHtml(a)).join(', ') : ''}
        ${isReq && (x.reviewers || []).length ? ' · review ' + x.reviewers.map(a => escapeHtml(a)).join(', ') : ''}
      </div>
      ${isReq ? forgeMergeStateHtml(x) : ''}
      ${isReq ? '<div class="forge-detail-checks"></div>' : ''}
      <div class="forge-detail-actions">
        ${isReq && open ? '<button class="mini-btn" data-forge-act="checkout" title="Fetch this request’s head and check it out locally">⤓ Checkout</button>' : ''}
        ${isReq && open ? '<button class="mini-btn" data-forge-act="merge" title="Merge on the forge">⑃ Merge</button>' : ''}
        ${x.merged ? '' : `<button class="mini-btn" data-forge-act="${open ? 'close' : 'reopen'}">${open ? '✕ Close' : '↺ Reopen'}</button>`}
        <span class="graph-spacer"></span>
        <button class="mini-btn" data-forge-act="refresh" title="Reload from the forge">⟳</button>
        <button class="mini-btn" data-forge-url="${forgeAttr(x.url)}" title="Open on the forge in a browser">↗ Browser</button>
      </div>
      <div class="forge-detail-tabs">
        ${tabs.map(([id, label, n]) => `<button class="mini-btn${d.tab === id ? ' active' : ''}" data-forge-tab="${id}">${label}${n ? ` <span class="forge-num">${n}</span>` : ''}</button>`).join('')}
      </div>
    </div>`;
}

// What the forge thinks of merging this, in one line. "unknown" is a real answer — both
// providers compute mergeability asynchronously — and must not read as a conflict.
function forgeMergeStateHtml(x) {
  if (x.merged) return `<div class="forge-mergestate ok">⑃ Merged${x.mergedAt ? ' ' + escapeHtml(relativeTime(x.mergedAt)) : ''}</div>`;
  if (x.state === 'closed') return `<div class="forge-mergestate">✕ Closed without merging</div>`;
  if (x.conflicts || x.mergeable === false) {
    return `<div class="forge-mergestate bad">⚠ Cannot merge cleanly${x.mergeableState ? ` (${escapeHtml(x.mergeableState)})` : ''}</div>`;
  }
  if (x.mergeable === true) return `<div class="forge-mergestate ok">✓ No conflicts with ${escapeHtml(x.target)}</div>`;
  return `<div class="forge-mergestate">◌ The forge has not finished checking for conflicts</div>`;
}

// ---- conversation --------------------------------------------------------------------

function forgeConversationPaneHtml(d, x) {
  const entries = d.timeline || [];
  const body = `
    <article class="forge-comment forge-comment-body">
      <header class="forge-comment-head">
        <span class="forge-comment-author">${escapeHtml(x.author || '')}</span>
        <span class="forge-comment-when">${x.createdAt ? escapeHtml(relativeTime(x.createdAt)) : ''}</span>
      </header>
      <div class="forge-md">${forgeMarkdown(x.body)}</div>
    </article>`;

  const list = d.timelineLoading && !d.timeline
    ? '<div class="empty-state"><span class="loading"></span></div>'
    : d.timelineError
      ? forgeErrorHtml(d.timelineError)
      : entries.map(forgeCommentHtml).join('');

  return body + list + `
    <div class="forge-composer">
      <textarea class="modal-input" id="forge-comment-box" rows="3" placeholder="Leave a comment (Ctrl+Enter to send)"></textarea>
      <div class="forge-composer-foot">
        <span class="text-muted">Markdown is rendered here and sent as written.</span>
        <button class="btn-medieval primary" data-forge-act="comment">✎ Comment</button>
      </div>
    </div>`;
}

function forgeCommentHtml(c) {
  if (c.kind === 'system') {
    return `<div class="forge-sysnote">${escapeHtml(c.author)} ${forgeMarkdownInlineOnly(c.body)} · ${escapeHtml(relativeTime(c.createdAt))}</div>`;
  }
  const verdict = c.kind === 'review' && c.state
    ? `<span class="forge-verdict forge-verdict-${escapeHtml(c.state)}">${escapeHtml(c.state.replace(/_/g, ' '))}</span>` : '';
  const where = c.kind === 'inline' && c.path
    ? `<span class="forge-comment-where text-mono">${escapeHtml(c.path)}${c.line ? ':' + c.line : ''}</span>` : '';
  return `<article class="forge-comment${c.kind === 'inline' ? ' is-inline' : ''}">
    <header class="forge-comment-head">
      <span class="forge-comment-author">${escapeHtml(c.author)}</span>
      ${verdict}${where}
      <span class="forge-comment-when">${c.createdAt ? escapeHtml(relativeTime(c.createdAt)) : ''}</span>
      ${c.url ? forgeOpenExternalBtnHtml(c.url) : ''}
    </header>
    ${c.diffHunk ? `<pre class="forge-hunk">${escapeHtml(c.diffHunk.split('\n').slice(-6).join('\n'))}</pre>` : ''}
    <div class="forge-md">${forgeMarkdown(c.body)}</div>
  </article>`;
}

// ---- commits -------------------------------------------------------------------------

function forgeCommitsPaneHtml(d) {
  if (d.commitsLoading && !d.commits) return '<div class="empty-state"><span class="loading"></span></div>';
  if (d.commitsError) return forgeErrorHtml(d.commitsError);
  const list = d.commits || [];
  if (!list.length) return '<div class="empty-state"><p>No commits.</p></div>';
  return `<ul class="forge-commits">${list.map(c => `
    <li class="forge-commit">
      <span class="text-mono forge-commit-hash" title="Copy" data-forge-hash="${forgeAttr(c.hash)}">${escapeHtml((c.hash || '').slice(0, 7))}</span>
      <span class="forge-commit-msg">${escapeHtml(c.message)}</span>
      <span class="forge-commit-meta">${escapeHtml(c.author)}${c.date ? ' · ' + escapeHtml(relativeTime(c.date)) : ''}</span>
    </li>`).join('')}</ul>`;
}

// ---- files ---------------------------------------------------------------------------

function forgeFilesPaneHtml(d) {
  if (d.filesLoading && !d.files) return '<div class="empty-state"><span class="loading"></span></div>';
  if (d.filesError) return forgeErrorHtml(d.filesError);
  const payload = d.files || { files: [] };
  const files = payload.files || [];
  if (!files.length) return '<div class="empty-state"><p>No file changes.</p></div>';

  // One combined diff through the app's own renderer: the request's changes read exactly
  // like a commit's, including the line cap that keeps a 40k-line diff from freezing the
  // window, and the unified/split preference set anywhere else in the app.
  const combined = files.map(f => f.diff).join('\n');
  const summary = `<ul class="forge-filelist">${files.map(f => `
    <li class="forge-fileline">
      <span class="file-status ${escapeHtml(f.status)}">${({ added: 'A', deleted: 'D', renamed: 'R', modified: 'M' })[f.status] || 'M'}</span>
      <span class="forge-filepath text-mono">${escapeHtml(f.path)}</span>
      <span class="forge-plusminus"><span class="text-add">+${f.additions}</span> <span class="text-del">−${f.deletions}</span></span>
    </li>`).join('')}</ul>`;

  return `<div class="forge-files-head">
      <span>${files.length} file${files.length === 1 ? '' : 's'} changed</span>
      ${payload.truncated ? '<span class="text-red">· the forge returned only the first page</span>' : ''}
      <span class="graph-spacer"></span>
      <span class="diff-view-toggle">
        <button class="diff-view-btn${state.diffMode === 'split' ? '' : ' active'}" data-diffmode="unified">☰ Unified</button>
        <button class="diff-view-btn${state.diffMode === 'split' ? ' active' : ''}" data-diffmode="split">◫ Split</button>
      </span>
    </div>
    ${summary}
    <div class="forge-diff diff-content">${renderDiff(combined, {})}</div>`;
}

// Called by setDiffMode so the Files pane follows the unified/split toggle like every
// other diff in the app. Cheap: the patches are already in hand.
function rerenderForgeFiles() {
  const d = forgeState.detail;
  if (!d || d.tab !== 'files' || !d.files) return;
  renderForgeDetail();
}

// ---- actions -------------------------------------------------------------------------

async function forgePostComment() {
  const d = forgeState.detail;
  const box = document.getElementById('forge-comment-box');
  if (!d || !box) return;
  const text = box.value.trim();
  if (!text) { showToast('Write something first', 'error'); return; }
  const r = await withLoading('Posting the comment', () => gs.forgeComment({ kind: d.kind, number: d.number, body: text }));
  if (!handleResult(r, 'Comment posted')) return;
  box.value = '';   // before the re-render, which otherwise restores it as an unsent draft
  const now = forgeState.detail;
  if (!now || now.number !== d.number) return;
  now.timeline = (now.timeline || []).concat([r.data]);
  if (now.data) now.data.comments = (now.data.comments || 0) + 1;
  renderForgeDetail();
  const host = document.getElementById('forge-detail');
  if (host) host.scrollTop = host.scrollHeight;
}

async function forgeSetItemState(open) {
  const d = forgeState.detail;
  if (!d) return;
  const noun = d.kind === 'issue' ? 'issue' : 'request';
  const ok = await modal.confirm({
    title: open ? 'Reopen' : 'Close',
    message: `${open ? 'Reopen' : 'Close'} ${noun} #${d.number} — ${d.data.title}?`,
    confirmText: open ? 'Reopen' : 'Close it',
    danger: !open
  });
  if (!ok) return;
  const r = await withLoading(open ? 'Reopening' : 'Closing', () => gs.forgeSetState({ kind: d.kind, number: d.number, state: open ? 'open' : 'closed' }));
  if (!handleResult(r, open ? 'Reopened' : 'Closed')) return;
  const now = forgeState.detail;
  if (now && now.number === d.number) now.data = r.data;
  await refreshForge();
}

async function forgeCheckoutRequest() {
  const d = forgeState.detail;
  if (!d || d.kind !== 'request') return;
  const gitlab = (forgeState.info || {}).provider === 'gitlab';
  const local = `${gitlab ? 'mr' : 'pr'}-${d.number}`;
  const ok = await modal.confirm({
    title: '⤓ Check Out Request',
    message: `Fetch #${d.number} from the remote and check it out as "${local}".\n\n` +
      `If "${local}" already exists it is moved to the request's current head — it is a branch GitGood maintains for reading requests, not one to commit on.`,
    confirmText: 'Check It Out'
  });
  if (!ok) return;
  const r = await withLoading('Fetching the request', () => gs.forgeCheckoutRequest({ number: d.number }));
  if (!handleResult(r, `On ${local}`)) return;
  await refreshAll();
}

async function forgeMergeRequest() {
  const d = forgeState.detail;
  if (!d || d.kind !== 'request' || !d.data) return;
  const x = d.data;
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Merge <strong>#${x.number}</strong> — ${escapeHtml(x.title)}<br>
      <span class="text-muted text-mono">${escapeHtml(x.source)} → ${escapeHtml(x.target)}</span></p>
    ${x.mergeable === false || x.conflicts ? '<p class="modal-text text-red">The forge reports this cannot merge cleanly. It will refuse.</p>' : ''}
    <div class="modal-field">
      <label>How</label>
      <select class="modal-input" id="forge-merge-method">
        <option value="merge">Merge commit</option>
        <option value="squash">Squash and merge</option>
        <option value="rebase">Rebase and merge</option>
      </select>
    </div>
    <label class="modal-checkbox"><input type="checkbox" id="forge-merge-del" /> Delete <span class="text-mono">${escapeHtml(x.source)}</span> on the remote afterwards</label>`;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const goBtn = document.createElement('button');
  goBtn.className = 'btn-medieval primary';
  goBtn.innerHTML = '<span class="btn-icon">⑃</span> Merge';
  goBtn.onclick = async () => {
    const method = body.querySelector('#forge-merge-method').value;
    const deleteBranch = body.querySelector('#forge-merge-del').checked;
    modal.hide();
    const r = await withLoading('Merging', () => gs.forgeMerge({ number: x.number, method, deleteBranch, branch: x.source }));
    if (!handleResult(r, 'Merged')) return;
    await refreshForgeDetail();
    await refreshForge();
  };

  modal.show({ title: '⑃ Merge Request', body, footer: [cancelBtn, goBtn] });
}

// One delegated listener for everything inside the detail pane, because the pane is
// rebuilt from scratch on every render.
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-forge-tab]');
  if (tabBtn) {
    const d = forgeState.detail;
    if (!d) return;
    d.tab = tabBtn.dataset.forgeTab;
    renderForgeDetail();
    loadForgePane(d.tab);
    return;
  }
  const hash = e.target.closest('[data-forge-hash]');
  if (hash) { copyText(hash.dataset.forgeHash, 'Hash copied'); return; }

  const act = e.target.closest('[data-forge-act]');
  if (!act) return;
  switch (act.dataset.forgeAct) {
    case 'close-detail': closeForgeDetail(); break;
    case 'refresh': refreshForgeDetail(); break;
    case 'comment': forgePostComment(); break;
    case 'checkout': forgeCheckoutRequest(); break;
    case 'merge': forgeMergeRequest(); break;
    case 'close': forgeSetItemState(false); break;
    case 'reopen': forgeSetItemState(true); break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
  if (e.target && e.target.id === 'forge-comment-box') { e.preventDefault(); forgePostComment(); }
});

// ============================================
// MARKDOWN
// ============================================
// Enough of it to read a request: the bodies here are written by other people and go
// straight into the app's own window, so the text is escaped *first* and the only tags
// that come back are the ones written below. No HTML from the forge is ever passed through.

function forgeMdInline(s) {
  let out = s;
  // Inline code first, so nothing below rewrites what is inside it.
  const code = [];
  out = out.replace(/`([^`]+)`/g, (m, c) => { code.push(c); return `\u0000C${code.length - 1}\u0000`; });

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, url) => forgeMdLink(url, alt || url, m, true))
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, text, url) => forgeMdLink(url, text, m))
    .replace(/(^|[\s(])((?:https?:)\/\/[^\s<>()]+)/g, (m, pre, url) => pre + forgeMdLink(url, url, url))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // A "#123" is a request or issue on this same forge, so it opens here rather than away.
    .replace(/(^|[\s(])#(\d+)\b/g, (m, pre, n) => `${pre}<a class="forge-ref" data-forge-open="auto:${n}">#${n}</a>`)
    .replace(/(^|[\s(])!(\d+)\b/g, (m, pre, n) => `${pre}<a class="forge-ref" data-forge-open="request:${n}">!${n}</a>`)
    .replace(/(^|[\s(])@([A-Za-z0-9][A-Za-z0-9-_.]{0,38})\b/g, (m, pre, who) => {
      const host = (forgeState.info || {}).host;
      return host ? `${pre}<a class="forge-ref" data-forge-url="https://${forgeAttr(host)}/${forgeAttr(who)}">@${who}</a>` : m;
    });

  return out.replace(/\u0000C(\d+)\u0000/g, (m, i) => `<code>${code[+i]}</code>`);
}

// Only what a one-line system note needs — no links, no lists.
function forgeMarkdownInlineOnly(s) {
  return forgeMdInline(escapeHtml(String(s || '')).replace(/\n+/g, ' '));
}

function forgeMdLink(url, text, original, isImage) {
  // The text arrived escaped, so "&amp;" in a URL has to be put back before it is used.
  const raw = String(url).replace(/&amp;/g, '&');
  // Only http(s) becomes a link. Anything else (javascript:, file:, data:) is left exactly
  // as it was written — already-escaped text, so it reads as source and does nothing.
  if (!/^https?:\/\//i.test(raw)) return original;
  return `<a class="forge-link" data-forge-url="${forgeAttr(raw)}">${isImage ? '🖼 ' : ''}${text}</a>`;
}

function forgeMarkdown(src) {
  const text = String(src == null ? '' : src);
  if (!text.trim()) return '<p class="text-muted">No description.</p>';

  // Escape everything up front. From here on the input is inert text and every tag added
  // below is one of ours.
  let s = escapeHtml(text).replace(/\r\n/g, '\n');

  // Fenced code blocks are lifted out whole so no inline rule touches their contents.
  const fences = [];
  s = s.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    fences.push(`<pre class="forge-code"><code>${code.replace(/\n+$/, '')}</code></pre>`);
    return `\u0000F${fences.length - 1}\u0000`;
  });

  const out = [];
  const lines = s.split('\n');
  let para = [];
  let list = null;          // 'ul' | 'ol'

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${forgeMdInline(para.join('<br>'))}</p>`);
    para = [];
  };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushAll = () => { flushPara(); flushList(); };

  for (const line of lines) {
    const t = line.trim();

    if (!t) { flushAll(); continue; }
    const fence = /^\u0000F(\d+)\u0000$/.exec(t);
    if (fence) { flushAll(); out.push(fences[+fence[1]]); continue; }
    if (/^(---+|\*\*\*+|___+)$/.test(t)) { flushAll(); out.push('<hr class="forge-hr">'); continue; }

    const head = /^(#{1,6})\s+(.*)$/.exec(t);
    if (head) {
      flushAll();
      const level = Math.min(6, head[1].length) + 2;   // an h1 in a comment is not an h1 here
      out.push(`<div class="forge-h forge-h${level}">${forgeMdInline(head[2])}</div>`);
      continue;
    }

    const quote = /^&gt;\s?(.*)$/.exec(t);
    if (quote) { flushAll(); out.push(`<blockquote class="forge-quote">${forgeMdInline(quote[1])}</blockquote>`); continue; }

    const item = /^([-*+]|\d+\.)\s+(.*)$/.exec(t);
    if (item) {
      flushPara();
      const want = /^\d/.test(item[1]) ? 'ol' : 'ul';
      if (list !== want) { flushList(); list = want; out.push(`<${want} class="forge-ul">`); }
      // Task list items keep their box, drawn rather than made interactive: ticking it
      // here would not write anything back to the forge.
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[2]);
      out.push(task
        ? `<li class="forge-task">${task[1] === ' ' ? '☐' : '☑'} ${forgeMdInline(task[2])}</li>`
        : `<li>${forgeMdInline(item[2])}</li>`);
      continue;
    }

    flushList();
    para.push(t);
  }
  flushAll();
  // A fence that opened mid-line leaves its marker inside a paragraph rather than on a
  // line of its own; put those back too so no marker can ever reach the screen.
  return out.join('').replace(/\u0000F(\d+)\u0000/g, (m, i) => fences[+i] || '');
}

function renderForgeUnknownHost() {
  const i = forgeState.info || {};
  const body = document.getElementById('forge-body');
  body.innerHTML = `
    <div class="forge-setup">
      <h3>Which forge is ${escapeHtml(i.host || 'this host')}?</h3>
      <p class="modal-text text-muted">GitGood recognises github.com and gitlab.com on sight. For a self-hosted install it needs to be told,
      because the two APIs have nothing in common.</p>
      <div class="modal-field">
        <label>Forge type</label>
        <select class="modal-input" id="forge-kind">
          <option value="github">GitHub / GitHub Enterprise</option>
          <option value="gitlab">GitLab (self-hosted)</option>
        </select>
      </div>
      <div class="modal-field">
        <label>Personal access token for ${escapeHtml(i.host || '')}</label>
        <input class="modal-input" type="password" id="forge-token" placeholder="paste token" autocomplete="off" />
      </div>
      <button class="btn-medieval primary" id="forge-save-token">✓ Connect</button>
    </div>`;
  wireForgeTokenForm();
}

function renderForgeTokenPrompt() {
  const i = forgeState.info || {};
  const body = document.getElementById('forge-body');
  const gh = i.provider === 'github';
  const tokenUrl = gh
    ? (i.host === 'github.com' ? 'https://github.com/settings/tokens' : `https://${i.host}/settings/tokens`)
    : `https://${i.host}/-/user_settings/personal_access_tokens`;
  body.innerHTML = `
    <div class="forge-setup">
      <h3>${i.tokenInvalid ? 'That token no longer works' : `Connect to ${escapeHtml(i.host)}`}</h3>
      <p class="modal-text text-muted">
        ${gh ? 'A classic token with the <strong>repo</strong> scope (or a fine-grained token with Pull requests, Issues and Contents access) lets GitGood list and open pull requests.'
             : 'A personal access token with the <strong>api</strong> scope lets GitGood list and open merge requests.'}
        The token is encrypted by your operating system's credential store and never leaves this machine except as a request header.
      </p>
      ${i.storageAvailable ? '' : `<p class="modal-text text-red">This system has no secure credential store available, so GitGood will not save a token here.</p>`}
      <div class="modal-field">
        <label>Personal access token</label>
        <input class="modal-input" type="password" id="forge-token" placeholder="paste token" autocomplete="off" ${i.storageAvailable ? '' : 'disabled'} />
      </div>
      <input type="hidden" id="forge-kind" value="${escapeHtml(i.provider)}" />
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn-medieval primary" id="forge-save-token" ${i.storageAvailable ? '' : 'disabled'}>✓ Connect</button>
        <a href="#" id="forge-token-help" style="color:var(--accent-bright);font-size:12px">Create one on ${escapeHtml(i.host)} ↗</a>
      </div>
    </div>`;
  const help = document.getElementById('forge-token-help');
  if (help) help.onclick = (e) => { e.preventDefault(); gs.openExternal(tokenUrl); };
  wireForgeTokenForm();
}

function wireForgeTokenForm() {
  const btn = document.getElementById('forge-save-token');
  if (!btn) return;
  btn.onclick = async () => {
    const kindEl = document.getElementById('forge-kind');
    const tokenEl = document.getElementById('forge-token');
    const token = (tokenEl && tokenEl.value || '').trim();
    if (!token) { showToast('Paste a token first', 'error'); return; }
    btn.disabled = true;
    const r = await withLoading('Checking the token', () => gs.forgeSetToken({
      host: forgeState.info.host,
      provider: kindEl ? kindEl.value : forgeState.info.provider,
      token
    }));
    btn.disabled = false;
    if (!handleResult(r)) return;
    showToast(`Connected to ${forgeState.info.host} as ${r.data.user.login || 'you'}`, 'success');
    await refreshForge();
  };
  const input = document.getElementById('forge-token');
  if (input) input.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
}

// ============================================
// CREATE A REQUEST
// ============================================
async function showCreatePrDialog() {
  if (!state.repo) return;
  const info = forgeState.info || ((await gs.forgeInfo({})).data);
  if (!info || !info.supported) { showToast('This repository has no recognised forge remote.', 'error', 6000); return; }
  if (!info.hasToken) { goToTab('forge'); await refreshForge(); showToast('Connect a token first', 'error'); return; }
  forgeState.info = info;

  const current = (state.branches.local && state.branches.local.current) || '';
  const branches = (state.branches.local && state.branches.local.all) || [];
  const base = info.defaultBranch || branches.find(b => b === 'main' || b === 'master') || '';
  const gitlab = info.provider === 'gitlab';

  // The last commit's subject is nearly always the right title for a single-commit branch.
  const lastSubject = ((state.log.all || [])[0] || {}).message || '';

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="modal-field">
      <label>Source branch (the work)</label>
      <select class="modal-input" id="pr-head">
        ${branches.map(b => `<option value="${escapeHtml(b)}"${b === current ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}
      </select>
    </div>
    <div class="modal-field">
      <label>Target branch (where it should land)</label>
      <select class="modal-input" id="pr-base">
        ${branches.map(b => `<option value="${escapeHtml(b)}"${b === base ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}
      </select>
    </div>
    <div class="modal-field">
      <label>Title</label>
      <input class="modal-input" id="pr-title" value="${escapeHtml(lastSubject)}" placeholder="What this changes" />
    </div>
    <div class="modal-field">
      <label>Description (optional)</label>
      <textarea class="modal-input" id="pr-body" rows="6" placeholder="Why, and anything a reviewer needs to know"></textarea>
    </div>
    <label class="modal-checkbox"><input type="checkbox" id="pr-draft" /> Open as a draft${gitlab ? ' (GitLab marks this with a “Draft:” title)' : ''}</label>
    <label class="modal-checkbox"><input type="checkbox" id="pr-push" checked /> Push the source branch first if the remote does not have it</label>
  `;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const createBtn = document.createElement('button');
  createBtn.className = 'btn-medieval primary';
  createBtn.innerHTML = '<span class="btn-icon">⇄</span> Create';
  createBtn.onclick = async () => {
    const head = body.querySelector('#pr-head').value;
    const target = body.querySelector('#pr-base').value;
    const title = body.querySelector('#pr-title').value.trim();
    const desc = body.querySelector('#pr-body').value;
    const draft = body.querySelector('#pr-draft').checked;
    const push = body.querySelector('#pr-push').checked;
    if (!title) { showToast('A title is required', 'error'); return; }
    if (head === target) { showToast('Source and target are the same branch', 'error'); return; }
    modal.hide();

    // The forge can only see branches it has. Pushing first turns "no commits between
    // these branches" — the most common and least helpful API error — into a working PR.
    if (push) {
      const remoteHas = ((state.branches.remotes && state.branches.remotes.all) || [])
        .some(b => b.endsWith('/' + head));
      if (!remoteHas || head === current) {
        const pr = await withLoading('Pushing ' + head, () => gs.push({ setUpstream: true, remote: info.remote, branch: head }));
        if (!pr || !pr.ok) { showToast('Push failed: ' + ((pr && pr.error) || ''), 'error', 7000); return; }
      }
    }

    const r = await withLoading('Opening the request', () => gs.forgeCreatePullRequest({
      title, body: desc, head, base: target, draft
    }));
    if (!handleResult(r)) return;
    showToast(`Opened #${r.data.number}`, 'success');
    // Straight into the reader rather than a "open it in a browser?" prompt — the request
    // now has a home in the app.
    goToTab('forge');
    await refreshForge();
    await openForgeItem('request', r.data.number);
  };

  modal.show({ title: forgeState.info.provider === 'gitlab' ? '⇄ New Merge Request' : '⇄ New Pull Request', body, footer: [cancelBtn, createBtn] });
}

// ============================================
// CI CHECKS ON A COMMIT
// ============================================
// Filled into the slot rendered by the commit detail panes. Only asks the forge for commits
// that are actually on a remote — a local-only commit has nothing to have been built.
async function hydrateChecksBadge(hostEl, sha) {
  if (!hostEl || !sha) return;
  if (!forgeState.info) {
    const i = await gs.forgeInfo({});
    if (!i || !i.ok) return;
    forgeState.info = i.data;
  }
  if (!forgeState.info.supported || !forgeState.info.hasToken) return;

  let data = forgeState.checks.get(sha);
  if (!data) {
    const r = await gs.forgeChecks({ sha });
    if (!r || !r.ok) return;
    data = r.data;
    forgeState.checks.set(sha, data);
  }
  if (!data || data.state === 'none') return;
  if (!hostEl.isConnected || hostEl.dataset.checksSha !== sha) return;

  const icon = { success: '✓', failure: '✗', running: '◌', neutral: '–' }[data.state] || '–';
  const summary = data.state === 'running'
    ? `${data.counts.running} of ${data.counts.total} still running`
    : `${data.counts.success}/${data.counts.total} passed${data.counts.failure ? `, ${data.counts.failure} failed` : ''}`;
  hostEl.innerHTML = `
    <div class="checks-badge checks-${data.state}">
      <span class="checks-icon">${icon}</span>
      <span class="checks-label">${escapeHtml(summary)}</span>
      <button class="checks-toggle" type="button">details</button>
    </div>
    <ul class="checks-runs hidden">
      ${data.runs.map(run => `<li class="checks-run checks-${run.state}">
        <span class="checks-icon">${({ success: '✓', failure: '✗', running: '◌', neutral: '–' })[run.state] || '–'}</span>
        <span class="checks-run-name"${run.url ? ` data-forge-url="${escapeHtml(run.url)}"` : ''}>${escapeHtml(run.name)}</span>
        <span class="checks-run-detail">${escapeHtml(run.detail || '')}</span>
      </li>`).join('')}
    </ul>`;
  const toggle = hostEl.querySelector('.checks-toggle');
  if (toggle) toggle.onclick = () => hostEl.querySelector('.checks-runs').classList.toggle('hidden');
}

// ============================================
// WIRING
// ============================================
(() => {
  const refresh = document.getElementById('forge-refresh');
  if (refresh) refresh.onclick = () => refreshForge();

  const newPr = document.getElementById('forge-new-pr');
  if (newPr) newPr.onclick = () => showCreatePrDialog();

  const stateSel = document.getElementById('forge-state');
  if (stateSel) stateSel.onchange = () => refreshForge();

  const settings = document.getElementById('forge-settings');
  if (settings) settings.onclick = () => showForgeSettings();

  const subtabs = document.getElementById('forge-subtabs');
  if (subtabs) subtabs.onclick = (e) => {
    const btn = e.target.closest('[data-forge-view]');
    if (!btn) return;
    forgeState.view = btn.dataset.forgeView;
    // A request left open in the reader while the list switches to issues reads as though
    // it belonged to that list. Switching the list closes it.
    forgeState.detail = null;
    subtabs.querySelectorAll('[data-forge-view]').forEach(b => b.classList.toggle('active', b === btn));
    refreshForge();
  };
})();

// Token management for the host this repository points at.
async function showForgeSettings() {
  const info = forgeState.info || ((await gs.forgeInfo({})).data);
  if (!info) { showToast('No forge remote on this repository', 'error'); return; }
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Remote <code class="text-mono">${escapeHtml(info.remote)}</code> →
      <code class="text-mono">${escapeHtml(info.host)}</code>
      ${info.provider ? `(${escapeHtml(info.provider)})` : '<span class="text-red">(unknown forge)</span>'}</p>
    <p class="modal-text text-muted">${info.hasToken
      ? `A token is stored for this host${info.user && info.user.login ? `, authenticating as <strong>${escapeHtml(info.user.login)}</strong>` : ''}.`
      : 'No token is stored for this host.'}</p>
    <div class="modal-field">
      <label>Replace the token</label>
      <input class="modal-input" type="password" id="forge-token" placeholder="paste a new token" autocomplete="off" />
      <input type="hidden" id="forge-kind" value="${escapeHtml(info.provider || 'github')}" />
    </div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Close';
  cancelBtn.onclick = () => modal.hide();

  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn-medieval danger';
  clearBtn.textContent = 'Forget Token';
  clearBtn.onclick = async () => {
    const r = await gs.forgeClearToken({ host: info.host });
    if (!handleResult(r, 'Token forgotten')) return;
    modal.hide();
    await refreshForge();
  };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-medieval primary';
  saveBtn.textContent = 'Save Token';
  saveBtn.id = 'forge-save-token';
  saveBtn.onclick = async () => {
    const token = (document.getElementById('forge-token').value || '').trim();
    if (!token) { showToast('Paste a token first', 'error'); return; }
    const r = await withLoading('Checking the token', () => gs.forgeSetToken({
      host: info.host, provider: document.getElementById('forge-kind').value, token
    }));
    if (!handleResult(r, 'Token saved')) return;
    modal.hide();
    await refreshForge();
  };

  modal.show({ title: '⚑ Forge Connection', body, footer: [cancelBtn, clearBtn, saveBtn] });
}
