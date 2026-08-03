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
  view: 'prs',       // 'prs' | 'issues' | 'items' | 'board'
  items: [],
  loading: false,
  loadedFor: null,   // repo path the current list belongs to
  checks: new Map(), // sha -> forge:checks result, so the graph doesn't re-ask per click
  // The request or issue being read in the right-hand pane. Panes are filled lazily and
  // then kept, so flipping between Conversation and Files costs nothing the second time.
  detail: null,      // { kind, number, data, tab, timeline, commits, files, error }
  // Boards. The Work Items and Board views are two drawings of one payload, so they share
  // a single fetch — switching between them costs nothing.
  boards: null,      // [{ id, title, url }] — null until asked for
  boardId: null,
  board: null,       // the loaded board: { columns: [{ id, name, items: [] }], fieldId, … }
  // What the list is currently showing, and how much of it there is. `items` holds every
  // page loaded so far — "Load more" appends rather than replacing, so scroll position and
  // the open reader both survive it.
  filters: { text: '', scope: '', label: '', milestone: '' },
  page: 1,
  total: null,       // null when the forge would not say (GitHub's list endpoints never do)
  totalPages: null,
  hasMore: false,
  degraded: false,   // GitHub search answered, so requests have no head/base to draw
  loadingMore: false,
  // The label and milestone names behind the two filter selects, fetched once per repo.
  catalog: null,
  catalogFor: null
};

// Which views are drawn from the board payload rather than from a list of requests/issues.
function forgeIsBoardView(view) {
  const v = view || forgeState.view;
  return v === 'items' || v === 'board';
}

function forgeReset() {
  forgeState.info = null;
  forgeState.items = [];
  forgeState.loadedFor = null;
  forgeState.detail = null;
  forgeState.boards = null;
  forgeState.boardId = null;
  forgeState.board = null;
  forgeState.checks.clear();
  forgeState.catalog = null;
  forgeState.catalogFor = null;
  forgeClearFilters();
  const badge = document.getElementById('forge-tab-badge');
  if (badge) badge.style.display = 'none';
}

// Entry point from the tab strip.
async function openForgeTab() {
  if (!state.repo) return;
  if (forgeState.loadedFor === state.repo.path &&
      (forgeIsBoardView() ? forgeState.board : forgeState.items.length)) { renderForge(); return; }
  await refreshForge();
}

// Callers fire this and walk away (a click handler cannot await), so a throw inside would
// surface as a bare "unhandled rejection" banner with no idea which tab it came from. It
// belongs in the panel that failed.
async function refreshForge() {
  try {
    await refreshForgeInner();
  } catch (err) {
    forgeState.loading = false;
    const body = document.getElementById('forge-body');
    if (body) {
      body.classList.remove('has-split');
      body.innerHTML = forgeErrorHtml((err && err.message) || String(err));
    }
    console.error('[forge]', err);
  }
}

async function refreshForgeInner() {
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
  updateForgeToolbar();

  if (!forgeState.info.supported) { forgeState.loading = false; renderForgeUnknownHost(); return; }
  if (!forgeState.info.hasToken || forgeState.info.tokenInvalid) { forgeState.loading = false; renderForgeTokenPrompt(); return; }

  if (forgeIsBoardView()) { await refreshForgeBoard(); return; }

  const r = await forgeFetchListPage(1);
  forgeState.loading = false;

  if (!r || !r.ok) { body.innerHTML = forgeErrorHtml(r && r.error); return; }
  const d = r.data || {};
  forgeState.items = d.items || [];
  forgeState.loadedFor = state.repo.path;
  forgeApplyPageInfo(d);
  renderForge();
  forgeLoadFilterCatalog();
}

// One page of the current view, under the current filters. The scope filters are all
// "…me", and only forge:info knows who that is here — main is told rather than asked, so
// filtering does not cost an extra round trip per query.
function forgeFetchListPage(page) {
  const f = forgeState.filters;
  const opts = {
    state: (document.getElementById('forge-state') || {}).value || 'open',
    page,
    me: ((forgeState.info || {}).user || {}).login || '',
    text: f.text, scope: f.scope, label: f.label, milestone: f.milestone
  };
  return forgeState.view === 'issues' ? gs.forgeIssues(opts) : gs.forgePullRequests(opts);
}

function forgeApplyPageInfo(d) {
  forgeState.page = d.page || 1;
  forgeState.total = d.total === undefined ? null : d.total;
  forgeState.totalPages = d.totalPages === undefined ? null : d.totalPages;
  forgeState.hasMore = !!d.hasMore;
  forgeState.degraded = !!d.degraded;
}

// Appends rather than replaces, so the reader stays open and the list does not jump back
// to the top — which is the whole reason this is a button and not a page number.
async function forgeLoadMore() {
  if (forgeState.loadingMore || !forgeState.hasMore) return;
  forgeState.loadingMore = true;
  renderForge();
  try {
    const r = await forgeFetchListPage(forgeState.page + 1);
    if (!r || !r.ok) { showToast((r && r.error) || 'Could not load more.', 'error', 6000); return; }
    const d = r.data || {};
    // A row already on screen must not appear twice: paging by offset over a list ordered
    // by "recently updated" will re-serve an item that was bumped between the two requests.
    const seen = new Set(forgeState.items.map(i => `${i.kind}:${i.number}`));
    forgeState.items = forgeState.items.concat((d.items || []).filter(i => !seen.has(`${i.kind}:${i.number}`)));
    forgeApplyPageInfo(d);
  } finally {
    forgeState.loadingMore = false;
    renderForge();
  }
}

// Switching view is state plus the subtab highlight plus the toolbar, and it happens from
// two places — the subtabs themselves, and landing on a freshly opened issue.
function setForgeView(view) {
  forgeState.view = view;
  const subtabs = document.getElementById('forge-subtabs');
  if (subtabs) {
    subtabs.querySelectorAll('[data-forge-view]')
      .forEach(b => b.classList.toggle('active', b.dataset.forgeView === view));
  }
  updateForgeToolbar();
}

// The open/closed filter belongs to the request and issue lists; the board picker belongs
// to the other two. Showing all of it at once would offer controls that do nothing.
//
// The two "new" buttons follow the list they add to: opening a request from the Issues tab
// (or an issue from the Requests tab) is a button that does not belong to what is on screen.
// Neither shows on the board views — an issue created there would not join the board, and a
// card that never appears reads as a bug.
function updateForgeToolbar() {
  const boardView = forgeIsBoardView();
  const stateSel = document.getElementById('forge-state');
  const boardSel = document.getElementById('forge-board');
  const newPr = document.getElementById('forge-new-pr');
  const newIssue = document.getElementById('forge-new-issue');
  if (stateSel) stateSel.style.display = boardView ? 'none' : '';
  if (newPr) newPr.style.display = forgeState.view === 'prs' ? '' : 'none';
  if (newIssue) newIssue.style.display = forgeState.view === 'issues' ? '' : 'none';
  if (boardSel) boardSel.style.display = boardView ? '' : 'none';

  // The filter bar belongs to the request and issue lists. A board is drawn from one
  // payload the forge composed itself, and filtering it here would hide cards from columns
  // whose counts would then no longer add up.
  const bar = document.getElementById('forge-filterbar');
  const ready = !!(forgeState.info && forgeState.info.supported && forgeState.info.hasToken && !forgeState.info.tokenInvalid);
  if (bar) bar.style.display = boardView || !ready ? 'none' : '';
  // Review is something only a request can be waiting for.
  const scope = document.getElementById('forge-filter-scope');
  const reviewOpt = scope && scope.querySelector('option[value="review"]');
  if (reviewOpt) {
    reviewOpt.hidden = forgeState.view !== 'prs';
    if (reviewOpt.hidden && scope.value === 'review') { scope.value = ''; forgeState.filters.scope = ''; }
  }
  const clear = document.getElementById('forge-filter-clear');
  if (clear) clear.style.display = forgeFiltersActive() ? '' : 'none';
}

function forgeFiltersActive() {
  const f = forgeState.filters;
  return !!(f.text || f.scope || f.label || f.milestone);
}

function forgeClearFilters() {
  forgeState.filters = { text: '', scope: '', label: '', milestone: '' };
  const ids = ['forge-filter-text', 'forge-filter-scope', 'forge-filter-label', 'forge-filter-milestone'];
  for (const id of ids) { const el = document.getElementById(id); if (el) el.value = ''; }
}

// The two name-based selects. Fetched once per repository and reused for both lists —
// labels and milestones belong to the project, not to what is being listed. Failures are
// silent on purpose: a filter that cannot be populated should leave the list working, and
// both catalogues are the same ones the pickers use, cached in main for ten minutes.
async function forgeLoadFilterCatalog() {
  if (!state.repo || forgeState.catalogFor === state.repo.path) return;
  forgeState.catalogFor = state.repo.path;
  const [lr, mr] = await Promise.all([gs.forgeLabels({}), gs.forgeIssueMeta({ kind: 'issue' })]);
  if (!state.repo || forgeState.catalogFor !== state.repo.path) return;   // repo changed meanwhile
  forgeState.catalog = {
    labels: (lr && lr.ok && lr.data) || [],
    milestones: (mr && mr.ok && mr.data && mr.data.milestones) || []
  };
  forgeFillFilterSelect('forge-filter-label', forgeState.catalog.labels.map(l => l.name), forgeState.filters.label);
  forgeFillFilterSelect('forge-filter-milestone', forgeState.catalog.milestones.map(m => m.title), forgeState.filters.milestone);
}

// Keeps the first option (the "Any …" one) and replaces the rest. A value that is currently
// filtered on is re-added even if the catalogue no longer lists it, or repopulating would
// silently drop the filter the list is actually showing.
function forgeFillFilterSelect(id, names, current) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const all = names.slice();
  if (current && !all.includes(current)) all.unshift(current);
  while (sel.options.length > 1) sel.remove(1);
  for (const n of all) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }
  sel.value = current || '';
}

// A changed filter is a new query, so it goes back to page one and drops the reader: the
// item being read may not be in the new list at all, and leaving it open beside a list that
// no longer contains it reads as a bug.
async function forgeApplyFilters() {
  forgeState.detail = null;
  updateForgeToolbar();
  await refreshForge();
}

function wireForgeFilterBar() {
  const text = document.getElementById('forge-filter-text');
  if (text) {
    let timer = null;
    text.addEventListener('input', () => {
      clearTimeout(timer);
      // Typing is not a query. GitHub's search endpoint allows roughly thirty calls a
      // minute, separately from the rest of the API, so a request per keystroke would
      // exhaust it inside one sentence.
      timer = setTimeout(() => {
        const v = text.value.trim();
        if (v === forgeState.filters.text) return;
        forgeState.filters.text = v;
        forgeApplyFilters();
      }, 450);
    });
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      clearTimeout(timer);                 // Enter means now, not in another 450ms
      forgeState.filters.text = text.value.trim();
      forgeApplyFilters();
    });
  }
  for (const [id, key] of [['forge-filter-scope', 'scope'], ['forge-filter-label', 'label'], ['forge-filter-milestone', 'milestone']]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { forgeState.filters[key] = el.value; forgeApplyFilters(); });
  }
  const clear = document.getElementById('forge-filter-clear');
  if (clear) clear.addEventListener('click', () => { forgeClearFilters(); forgeApplyFilters(); });
}

// Load the board list once per repository, then the selected board. Both views land here.
async function refreshForgeBoard() {
  const body = document.getElementById('forge-body');
  if (!body) return;

  if (!forgeState.boards) {
    const r = await gs.forgeBoards({});
    forgeState.loading = false;
    if (!r || !r.ok) { body.classList.remove('has-split'); body.innerHTML = forgeErrorHtml(r && r.error); return; }
    forgeState.boards = r.data || [];
  }

  // Checked on every pass, not only on the one that fetched: an empty list is cached like
  // any other, and an empty array is truthy, so the block above is skipped from the second
  // call onwards. Reading boards[0] out of it was how this used to throw.
  if (!forgeState.boards.length) {
    forgeState.loading = false;
    forgeState.board = null;
    body.classList.remove('has-split');
    body.innerHTML = forgeNoBoardsHtml();
    updateForgeBoardPicker();
    return;
  }

  if (!forgeState.boardId || !forgeState.boards.some(b => b.id === forgeState.boardId)) {
    forgeState.boardId = forgeState.boards[0].id;
  }
  updateForgeBoardPicker();

  const r = await gs.forgeBoard({ id: forgeState.boardId });
  forgeState.loading = false;
  if (!r || !r.ok) { body.classList.remove('has-split'); body.innerHTML = forgeErrorHtml(r && r.error); return; }
  forgeState.board = r.data;
  forgeState.loadedFor = state.repo.path;
  renderForge();
}

function forgeNoBoardsHtml() {
  const gh = (forgeState.info || {}).provider === 'github';
  return `<div class="empty-state">
    <div class="empty-icon">▦</div>
    <p>No ${gh ? 'project' : 'board'} is attached to this repository.</p>
    <p class="text-muted" style="max-width:520px">
      ${gh
        ? 'GitGood reads GitHub Projects that are linked to this repository. Link one from the repository’s Projects tab and it will appear here.'
        : 'GitLab creates a default board per project. If none is listed, the token may not be allowed to see it.'}
    </p>
  </div>`;
}

function updateForgeBoardPicker() {
  const sel = document.getElementById('forge-board');
  if (!sel) return;
  const boards = forgeState.boards || [];
  sel.innerHTML = boards.map(b =>
    `<option value="${forgeAttr(b.id)}"${b.id === forgeState.boardId ? ' selected' : ''}>${escapeHtml(b.title)}</option>`).join('');
  sel.disabled = boards.length < 2;
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
  updateForgeToolbar();   // also covers the cached path, which never goes through refreshForge
  const items = forgeState.items || [];

  // The badge counts open requests only — an issue count on a tab that also lists requests
  // would be ambiguous, and open requests are the thing people act on.
  const badge = document.getElementById('forge-tab-badge');
  if (badge && forgeState.view === 'prs') {
    const open = items.filter(i => i.state === 'open' || i.state === 'draft').length;
    badge.textContent = open;
    badge.style.display = open ? 'inline-block' : 'none';
  }

  if (forgeIsBoardView()) { renderForgeBoardView(body); return; }

  const current = (state.branches.local && state.branches.local.current) || '';
  const listHtml = items.length
    ? `<ul class="forge-list">${items.map(it => forgeState.view === 'issues'
        ? forgeIssueRowHtml(it)
        : forgeRequestRowHtml(it, current)).join('')}</ul>${forgeListFootHtml()}`
    : forgeEmptyListHtml();

  // The pane is rebuilt wholesale on every render — including the one that follows "Load
  // more" — so without this the list would jump back to the top at the exact moment it grew.
  // Switching view or repository is a different list and legitimately starts at the top.
  const key = `${forgeState.view}:${forgeState.loadedFor || ''}`;
  const oldPane = body.querySelector('.forge-list-pane');
  const keepScroll = oldPane && key === _forgeListScrollKey ? oldPane.scrollTop : 0;

  body.innerHTML = forgeSplitHtml(`<div class="forge-list-pane">${listHtml}</div>`);
  body.classList.add('has-split');
  _forgeListScrollKey = key;
  if (keepScroll) {
    const pane = body.querySelector('.forge-list-pane');
    if (pane) pane.scrollTop = keepScroll;
  }
  renderForgeDetail();
  forgeSetupSplitResizer();
}

let _forgeListScrollKey = '';

// The list pane, a drag handle, and the reader. A grid rather than a flex row because the
// shared resizer in 08-lfs-settings drives grid-template-columns — the board keeps the flex
// `.forge-split` because it has a variable number of children and no handle.
function forgeSplitHtml(paneHtml) {
  return `
    <div class="forge-split forge-split-cols" id="forge-split">
      ${paneHtml}
      <div class="pane-resizer" data-resizer="forge-list" data-target="forge-split" data-cols="340px 1fr" title="Drag to resize"></div>
      <div class="forge-detail" id="forge-detail"></div>
    </div>`;
}

// The resizers in 08-lfs-settings are wired once at startup, over the DOM as it stood then.
// This split is rebuilt by innerHTML on every render, so its handle is a different element
// each time and has to be wired again — which is safe precisely *because* it is new: there
// is no previous listener left on it to double up.
function forgeSetupSplitResizer() {
  const el = document.querySelector('#forge-split > .pane-resizer');
  if (!el || typeof setupResizer !== 'function') return;
  applyResizerWidths(el);
  setupResizer(el);
}

// An empty list has two quite different causes, and saying which is the difference between
// "there is nothing to do" and "your filter is too narrow".
function forgeEmptyListHtml() {
  const issues = forgeState.view === 'issues';
  if (forgeFiltersActive()) {
    return `<div class="empty-state">
      <div class="empty-icon">⌕</div>
      <p>Nothing matches these filters.</p>
      <button class="mini-btn" data-forge-act="clear-filters">✕ Clear filters</button>
    </div>`;
  }
  const openOnly = (document.getElementById('forge-state') || {}).value === 'open';
  return `<div class="empty-state">
    <div class="empty-icon">${issues ? '☰' : '⇄'}</div>
    <p>Nothing here${openOnly ? ' that is still open' : ''}.</p>
    ${issues ? '<button class="mini-btn" data-forge-act="new-issue">+ New Issue</button>' : ''}
  </div>`;
}

// What the list is and is not showing. Without this a first page of fifty out of two
// hundred looks exactly like the whole list — the same trap the label chips avoid with
// their "+N", and the reason the count is stated even when there is no more to load.
function forgeListFootHtml() {
  const loaded = (forgeState.items || []).length;
  if (!loaded) return '';
  const total = forgeState.total;
  const summary = (total !== null && total !== undefined)
    ? `Showing ${loaded} of ${total}`
    : forgeState.totalPages
      ? `${loaded} loaded · page ${forgeState.page} of ${forgeState.totalPages}`
      : `${loaded} loaded`;

  return `<div class="forge-list-foot">
    <span class="text-muted">${escapeHtml(summary)}</span>
    ${forgeState.hasMore
      ? `<button class="mini-btn" data-forge-act="load-more"${forgeState.loadingMore ? ' disabled' : ''}>${
          forgeState.loadingMore ? '<span class="loading"></span> Loading' : '↓ Load more'}</button>`
      : ''}
    ${forgeState.degraded
      ? '<span class="text-muted forge-foot-note" title="GitHub&#39;s search index does not carry a request&#39;s branches, so the source → target line is left out while a filter is on">Filtered through search — branch names unavailable</span>'
      : ''}
  </div>`;
}

// ============================================
// WORK ITEMS & BOARD
// ============================================
// Both are the same payload. Work Items is the flat reading of it — every card in one list,
// with the column it sits in shown as a badge — and Board is the columnar one. The reader
// on the right is the same reader the request and issue lists use.

function forgeBoardCards() {
  const b = forgeState.board;
  if (!b) return [];
  const out = [];
  for (const col of b.columns || []) {
    for (const card of col.items || []) out.push(Object.assign({ columnName: col.name }, card));
  }
  return out;
}

function renderForgeBoardView(body) {
  const b = forgeState.board;
  if (!b) {
    body.classList.remove('has-split');
    body.innerHTML = forgeNoBoardsHtml();
    return;
  }
  // The board is wide, so the reader only takes its width once something is open. The Work
  // Items list is narrow and keeps the reader alongside it permanently, like the other lists.
  const isBoard = forgeState.view === 'board';
  const showReader = !isBoard || !!forgeState.detail;
  // Work Items is a list beside the reader like the other two, so it gets the same drag
  // handle and shares its remembered width. The board is a different shape — a wide pane
  // whose reader comes and goes — and keeps the plain flex split.
  body.innerHTML = isBoard
    ? `<div class="forge-split">
         ${forgeBoardHtml(b)}
         ${showReader ? '<div class="forge-detail" id="forge-detail"></div>' : ''}
       </div>`
    : forgeSplitHtml(`<div class="forge-list-pane forge-items-pane">${forgeWorkItemsHtml(b)}</div>`);
  body.classList.add('has-split');
  if (showReader) renderForgeDetail();
  if (!isBoard) forgeSetupSplitResizer();
}

function forgeWorkItemsHtml(b) {
  const cards = forgeBoardCards();
  if (!cards.length) {
    return `<div class="empty-state"><div class="empty-icon">⛯</div><p>This ${escapeHtml(b.title)} has no items.</p></div>`;
  }
  // Newest activity first: a work-item list read top-down should start with what moved.
  const sorted = cards.slice().sort((x, y) => new Date(y.updatedAt || 0) - new Date(x.updatedAt || 0));
  return `<ul class="forge-list">${sorted.map(c => `
    <li class="forge-item${forgeCardActiveClass(c)}" ${forgeCardOpenAttr(c)}>
      <div class="forge-item-head">
        <span class="forge-state forge-state-${escapeHtml(c.state)}">${escapeHtml(c.state)}</span>
        ${c.number ? `<span class="forge-num">#${c.number}</span>` : ''}
        <span class="forge-title">${escapeHtml(c.title)}</span>
        ${c.url ? forgeOpenExternalBtnHtml(c.url) : ''}
      </div>
      <div class="forge-item-meta">
        <span class="forge-col-badge">${escapeHtml(c.columnName)}</span>
        <span class="forge-type">${escapeHtml(c.type)}</span>
        ${c.author ? ' · ' + escapeHtml(c.author) : ''}
        ${c.updatedAt ? ' · updated ' + escapeHtml(relativeTime(c.updatedAt)) : ''}
        ${forgeMetaLabelsHtml(c.labels, 4)}
      </div>
    </li>`).join('')}</ul>`;
}

function forgeBoardHtml(b) {
  const cols = b.columns || [];
  return `<div class="forge-board-pane">
    ${b.moveHint ? `<div class="forge-board-hint">${escapeHtml(b.moveHint)}</div>` : ''}
    <div class="forge-board">
      ${cols.map(col => `
        <section class="forge-col" data-col-id="${forgeAttr(col.id)}">
          <header class="forge-col-head">
            <span class="forge-col-name">${escapeHtml(col.name)}</span>
            <span class="forge-num">${(col.items || []).length}</span>
          </header>
          <div class="forge-col-body" data-drop-col="${forgeAttr(col.id)}">
            ${(col.items || []).map(c => forgeCardHtml(c, b)).join('')}
          </div>
        </section>`).join('')}
    </div>
  </div>`;
}

// A card is only draggable when the board can actually take the move — a GitHub project
// with no single-select field has nothing to write, and saying so beats a drag that fails.
function forgeCardHtml(c, b) {
  return `<article class="forge-card${forgeCardActiveClass(c)}"
      ${b.canMove ? 'draggable="true"' : ''}
      data-item-id="${forgeAttr(c.itemId)}"
      data-card-col="${forgeAttr(c.columnId)}"
      ${forgeCardOpenAttr(c)}>
    <div class="forge-card-head">
      <span class="forge-state forge-state-${escapeHtml(c.state)}">${escapeHtml(c.state)}</span>
      ${c.number ? `<span class="forge-num">#${c.number}</span>` : ''}
      ${c.url ? forgeOpenExternalBtnHtml(c.url) : ''}
    </div>
    <div class="forge-card-title">${escapeHtml(c.title)}</div>
    ${(c.labels || []).length ? `<div class="forge-card-labels">${forgeLabelsHtml(c.labels, 4)}</div>` : ''}
    <div class="forge-card-foot">
      <span class="forge-type">${escapeHtml(c.type)}</span>
      ${(c.assignees || []).length ? '<span>' + escapeHtml(c.assignees.join(', ')) + '</span>' : ''}
      ${c.updatedAt ? `<span>${escapeHtml(relativeTime(c.updatedAt))}</span>` : ''}
    </div>
  </article>`;
}

// A draft item exists only inside the project — there is no issue behind it and no page to
// open — so it is read from the payload already in hand rather than fetched.
function forgeCardOpenAttr(c) {
  return c.kind === 'draft'
    ? `data-forge-draft="${forgeAttr(c.itemId)}"`
    : `data-forge-open="${c.kind === 'request' ? 'request' : 'issue'}:${c.number}"`;
}

function forgeCardActiveClass(c) {
  const d = forgeState.detail;
  if (!d) return '';
  if (d.draftId) return d.draftId === c.itemId ? ' active' : '';
  return d.number === c.number && d.kind === (c.kind === 'request' ? 'request' : 'issue') ? ' active' : '';
}

function openForgeDraft(itemId) {
  const card = forgeBoardCards().find(c => c.itemId === itemId);
  if (!card) return;
  // Shaped like a loaded detail so the reader needs no special case beyond the draft flag.
  forgeState.detail = {
    kind: 'issue', number: 0, draftId: itemId, tab: 'conversation',
    loading: false, error: '', timeline: [], commits: null, files: null,
    data: {
      kind: 'issue', number: 0, title: card.title, body: card.body || '',
      state: 'draft', author: card.author, url: '', createdAt: card.updatedAt,
      updatedAt: card.updatedAt, comments: 0, labels: card.labels || [],
      assignees: card.assignees || [], milestone: ''
    }
  };
  renderForge();
}

// ---- drag and drop -------------------------------------------------------------------
// The card moves in the UI first and the forge is told after. A rejected move puts it back
// and says why — the alternative, a card that sits still for a second after being dropped,
// reads as a broken board.
let _forgeDrag = null;

document.addEventListener('dragstart', (e) => {
  const card = e.target.closest && e.target.closest('.forge-card[draggable="true"]');
  if (!card) return;
  _forgeDrag = { itemId: card.dataset.itemId, fromCol: card.dataset.cardCol || '' };
  card.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // Firefox and Chromium both refuse to start a drag without payload on the transfer.
    e.dataTransfer.setData('text/plain', card.dataset.itemId);
  }
});

document.addEventListener('dragend', () => {
  _forgeDrag = null;
  document.querySelectorAll('.forge-card.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.forge-col-body.drop-target').forEach(el => el.classList.remove('drop-target'));
});

document.addEventListener('dragover', (e) => {
  if (!_forgeDrag) return;
  const col = e.target.closest && e.target.closest('[data-drop-col]');
  if (!col) return;
  e.preventDefault();                       // without this the drop event never fires
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (!col.classList.contains('drop-target')) {
    document.querySelectorAll('.forge-col-body.drop-target').forEach(el => el.classList.remove('drop-target'));
    col.classList.add('drop-target');
  }
});

document.addEventListener('drop', (e) => {
  if (!_forgeDrag) return;
  const col = e.target.closest && e.target.closest('[data-drop-col]');
  if (!col) return;
  e.preventDefault();
  const to = col.dataset.dropCol || '';
  const drag = _forgeDrag;
  _forgeDrag = null;
  if (to !== drag.fromCol) forgeMoveCard(drag.itemId, drag.fromCol, to);
});

async function forgeMoveCard(itemId, fromCol, toCol) {
  const b = forgeState.board;
  if (!b) return;
  const from = (b.columns || []).find(c => c.id === fromCol);
  const to = (b.columns || []).find(c => c.id === toCol);
  if (!from || !to) return;
  const idx = from.items.findIndex(c => c.itemId === itemId);
  if (idx === -1) return;

  const [card] = from.items.splice(idx, 1);
  card.columnId = toCol;
  to.items.unshift(card);
  renderForge();

  const r = await gs.forgeMoveBoardItem({
    boardId: b.id, fieldId: b.fieldId, itemId,
    number: card.number, kind: card.kind,
    fromColumn: fromCol, toColumn: toCol
  });
  if (r && r.ok) { showToast(`#${card.number || '—'} → ${to.name}`, 'success'); return; }

  // Put it back exactly where it was.
  const back = to.items.findIndex(c => c.itemId === itemId);
  if (back !== -1) to.items.splice(back, 1);
  card.columnId = fromCol;
  from.items.splice(idx, 0, card);
  renderForge();
  showToast((r && r.error) || 'The forge refused the move.', 'error', 6000);
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
      ${pr.source && pr.target
        ? `<span class="text-mono">${escapeHtml(pr.source)}</span> → <span class="text-mono">${escapeHtml(pr.target)}</span> · `
        : ''}${escapeHtml(pr.author)}
      ${pr.updatedAt ? ' · updated ' + escapeHtml(relativeTime(pr.updatedAt)) : ''}
      ${pr.comments ? ` · ${pr.comments} comment${pr.comments === 1 ? '' : 's'}` : ''}
      ${(pr.assignees || []).length ? ' · ' + forgePeopleHtml(pr.assignees) : ''}
      ${forgeMetaLabelsHtml(pr.labels, 4)}
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
      ${(it.assignees || []).length ? ' · ' + forgePeopleHtml(it.assignees) : ''}
      ${it.milestone ? ' · <span class="forge-flag">' + escapeHtml(it.milestone) + '</span>' : ''}
      ${forgeMetaLabelsHtml(it.labels, 4)}
    </div>
  </li>`;
}

// Labels wear the forge's own colours. Both providers let a project pick them, and they are
// the fastest thing to read in a list — "bug" red and "docs" blue are recognised before the
// title is — so they are drawn filled rather than outlined, which is how both sites draw them.
//
// A truncated set says so with a +N rather than quietly showing three of seven: a label the
// reader cannot see is worse than no labels, because the ones on screen look complete.
function forgeLabelsHtml(labels, limit) {
  const all = (labels || []).filter(l => (typeof l === 'string' ? l : l && l.name));
  if (!all.length) return '';
  const cap = limit || 99;
  const shown = all.slice(0, cap);
  const rest = all.length - shown.length;

  const chips = shown.map(l => forgeLabelChipHtml(l));
  if (rest > 0) {
    chips.push(`<span class="forge-label forge-label-more" title="${forgeAttr(all.map(l => (typeof l === 'string' ? l : l.name)).join(', '))}">+${rest}</span>`);
  }
  return `<span class="forge-labels">${chips.join('')}</span>`;
}

// One chip, wearing the forge's colours. Shared with the picker so a label looks the same
// where it is chosen as it does where it is read.
function forgeLabelChipHtml(l, extraClass) {
  const name = typeof l === 'string' ? l : l.name;
  const color = typeof l === 'string' ? '' : forgeHex(l.color);
  // GitLab publishes the foreground it uses; GitHub publishes only the background and
  // leaves the reader to find an ink that stays legible on it. Prefer the stated answer.
  const ink = typeof l === 'string' ? '' : forgeHex(l.ink);
  const style = color
    ? ` style="background:#${color};border-color:#${color};color:${ink ? '#' + ink : forgeReadableInk(color)}"`
    : '';
  return `<span class="forge-label${extraClass ? ' ' + extraClass : ''}"${style} title="${forgeAttr(name)}">${escapeHtml(name)}</span>`;
}

// The same chips on a meta line, where they follow other facts and need the separator.
function forgeMetaLabelsHtml(labels, limit) {
  const html = forgeLabelsHtml(labels, limit);
  return html ? ' · ' + html : '';
}

// Accepts what either forge sends: with or without the #, three digits or six.
function forgeHex(v) {
  const s = String(v || '').replace(/^#/, '').trim();
  if (/^[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^[0-9a-f]{3}$/i.test(s)) return s.toLowerCase().split('').map(c => c + c).join('');
  return '';
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
  const draft = e.target.closest('[data-forge-draft]');
  if (draft) { openForgeDraft(draft.dataset.forgeDraft); return; }

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
  // A project draft has no issue behind it: nothing to close, comment on, or open in a
  // browser. It is a note on a board, and the reader shows it as one.
  const draft = !!d.draftId;
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
        ${draft ? '' : `<span class="forge-num">#${x.number}</span>`}
        <span class="forge-detail-name">${escapeHtml(x.title)}</span>
        <button class="forge-ext" title="Close this panel and go back to the list — nothing happens to the ${draft ? 'item' : isReq ? 'request' : 'issue'} itself" data-forge-act="close-detail">✕</button>
      </div>
      <div class="forge-detail-meta">
        ${escapeHtml(x.author || '')}
        ${x.createdAt ? ' opened ' + escapeHtml(relativeTime(x.createdAt)) : ''}
        ${isReq ? ` · <span class="text-mono">${escapeHtml(x.source)}</span> → <span class="text-mono">${escapeHtml(x.target)}</span>` : ''}
        ${isReq && x.isFork ? ' <span class="forge-flag">fork</span>' : ''}
        ${counts}
        ${forgeDetailLabelsHtml(x, draft)}
      </div>
      ${forgeDetailPropsHtml(x, isReq, draft)}
      ${isReq ? forgeMergeStateHtml(x) : ''}
      ${isReq ? '<div class="forge-detail-checks"></div>' : ''}
      ${draft ? '<div class="forge-detail-meta">A draft item on the board — it has no issue behind it yet.</div>' : `
      <div class="forge-detail-actions">
        ${isReq && open ? '<button class="mini-btn" data-forge-act="checkout" title="Fetch this request’s head and check it out locally">⤓ Checkout</button>' : ''}
        ${isReq && open ? '<button class="mini-btn" data-forge-act="merge" title="Merge on the forge">⑃ Merge</button>' : ''}
        <button class="mini-btn" data-forge-act="edit" title="Edit the title and description">✎ Edit</button>
        <button class="mini-btn" data-forge-act="props" title="Assignees, milestone and the rest of what this carries">⚙ Properties</button>
        ${forgeMoreMenuItems().length ? '<button class="mini-btn" data-forge-act="more" title="Close, reopen or delete — the actions that change the item itself">⋯ More</button>' : ''}
        <span class="graph-spacer"></span>
        <button class="mini-btn" data-forge-act="refresh" title="Reload from the forge">⟳</button>
        <button class="mini-btn" data-forge-url="${forgeAttr(x.url)}" title="Open on the forge in a browser">↗ Browser</button>
      </div>
      <div class="forge-detail-tabs">
        ${tabs.map(([id, label, n]) => `<button class="mini-btn${d.tab === id ? ' active' : ''}" data-forge-tab="${id}">${label}${n ? ` <span class="forge-num">${n}</span>` : ''}</button>`).join('')}
      </div>`}
    </div>`;
}

// Closing an issue and closing the panel it is being read in are different things, and a
// "✕ Close" button sitting a few pixels from the panel's own ✕ made them look like the same
// one. So the actions that change the item on the forge — close, reopen, delete — live
// behind ⋯ instead: reaching them is a deliberate second click, and nothing in the action
// row is one slip away from closing somebody's issue.
//
// Built as data rather than markup because the same list decides two things: whether the ⋯
// button is drawn at all (a merged request has nothing here) and what the menu contains.
function forgeMoreMenuItems() {
  const d = forgeState.detail;
  if (!d || !d.data || d.draftId) return [];
  const x = d.data;
  const isReq = d.kind === 'request';
  const st = x.state === 'opened' ? 'open' : x.state;
  const open = st === 'open' || st === 'draft';
  const noun = isReq ? ((forgeState.info || {}).provider === 'gitlab' ? 'merge request' : 'pull request') : 'issue';

  const items = [];
  if (!x.merged) {
    items.push(open
      ? { label: `Close this ${noun}`, icon: '✕', action: () => forgeSetItemState(false) }
      : { label: `Reopen this ${noun}`, icon: '↺', action: () => forgeSetItemState(true) });
  }
  // Deleting is issues-only, and permanent on both forges — so it is last, behind a
  // separator, and never adjacent to anything that merely closes.
  if (!isReq) {
    if (items.length) items.push('sep');
    items.push({ label: 'Delete this issue…', icon: '✗', danger: true, action: () => forgeDeleteIssue() });
  }
  return items;
}

// Anchored under the button rather than at the pointer: this is a menu belonging to a
// control, not a right-click on whatever happened to be under the cursor. .context-menu is
// position:fixed, so the viewport coordinates from the rect are the ones it wants.
function forgeShowMoreMenu(btn) {
  const items = forgeMoreMenuItems();
  if (!items.length) return;
  const r = btn.getBoundingClientRect();
  showContextMenu(items, r.left, r.bottom + 4);
}

// Labels in the reader are the editable copy, so they carry the pencil. A draft board item
// has no issue behind it on the forge and nothing to write labels to, so it gets the plain
// chips — the same reason it has no actions and no comment box.
//
// The row is drawn even when there are no labels: "no labels ✎" is how the first one gets
// added, and a pencil that only appears once a label exists cannot be found.
function forgeDetailLabelsHtml(x, draft) {
  if (draft) return forgeMetaLabelsHtml(x.labels);
  const chips = forgeLabelsHtml(x.labels);
  return ` · ${chips || '<span class="text-muted">no labels</span>'}` +
    ` <button class="forge-label-edit" data-forge-act="labels" title="Change the labels on this item">✎</button>`;
}

// Everything the item carries that is not its text: who is on it, what it is planned
// against, and the provider's own extras. One row and one pencil rather than a control per
// property — the two forges disagree about which of these exist at all, so the row shows
// what this one has and the dialog behind it offers exactly those fields.
//
// Drawn even when every value is empty, for the same reason the labels row is: "unassigned ✎"
// is how the first assignee gets added, and a pencil that only appears once a value exists
// cannot be found.
function forgeDetailPropsHtml(x, isReq, draft) {
  if (draft) return '';
  const gitlab = (forgeState.info || {}).provider === 'gitlab';
  const bits = [forgePropHtml('Assignees', forgePeopleHtml(x.assignees), 'unassigned')];
  if (isReq) bits.push(forgePropHtml('Reviewers', forgePeopleHtml(x.reviewers), 'none requested'));
  bits.push(forgePropHtml('Milestone', x.milestone ? escapeHtml(x.milestone) : '', 'none'));
  if (gitlab && !isReq) {
    bits.push(forgePropHtml('Due', x.dueDate ? escapeHtml(x.dueDate) : '', 'no date'));
    // Only where the plan has weights at all: an empty field nobody can fill is noise.
    if (x.weightSupported) {
      bits.push(forgePropHtml('Weight', x.weight === null || x.weight === undefined ? '' : String(x.weight), '—'));
    }
  }

  // The flags are the properties that are only worth a word when they are true.
  const flags = [];
  if (x.confidential) flags.push('<span class="forge-flag" title="Visible only to project members">confidential</span>');
  if (x.locked) {
    flags.push(`<span class="forge-flag" title="No new comments except from people with write access">🔒 locked${x.lockReason ? ' · ' + escapeHtml(x.lockReason) : ''}</span>`);
  }
  if (x.issueType && x.issueType !== 'issue') flags.push(`<span class="forge-flag">${escapeHtml(x.issueType.replace(/_/g, ' '))}</span>`);
  // GitHub's two ways of being closed. "Completed" is the default and says nothing worth
  // repeating; "not planned" is the one that changes what the closure meant.
  if (x.stateReason === 'not_planned') flags.push('<span class="forge-flag" title="Closed as not planned">not planned</span>');

  return `<div class="forge-detail-props">
    ${bits.join('')}
    ${flags.join('')}
    <button class="forge-label-edit" data-forge-act="props" title="Change assignees, milestone and the rest">✎</button>
  </div>`;
}

function forgePropHtml(key, valueHtml, empty) {
  return `<span class="forge-prop"><span class="forge-prop-k">${escapeHtml(key)}</span>` +
    `<span class="forge-prop-v">${valueHtml || `<span class="text-muted">${escapeHtml(empty)}</span>`}</span></span>`;
}

// People are drawn as a monogram and a login, never as a remote avatar: the renderer has no
// business fetching images from the forge, which is the same rule that keeps every other
// network call in main.
function forgePeopleHtml(logins) {
  const all = (logins || []).filter(Boolean);
  if (!all.length) return '';
  return all.map(l =>
    `<span class="forge-person"><span class="forge-monogram">${escapeHtml(String(l).slice(0, 1).toUpperCase())}</span>${escapeHtml(l)}</span>`
  ).join('');
}

// ---- the properties editor -------------------------------------------------------------

// One dialog over forge:issueMeta's answer, which says which fields this provider has. The
// payload sent back carries only the keys that actually changed, so a field the dialog never
// showed is never written — that is what lets one handler serve an issue and a request, on
// two providers, without the renderer knowing which is which.
async function forgeEditProperties() {
  const d = forgeState.detail;
  if (!d || !d.data || d.draftId) return;
  const x = d.data;
  const isReq = d.kind === 'request';

  const r = await withLoading('Reading the project', () => gs.forgeIssueMeta({ kind: d.kind }));
  if (!r || !r.ok) { showToast((r && r.error) || 'Could not read the project.', 'error', 6000); return; }
  const meta = r.data || {};
  const f = meta.features || {};

  const assignees = (x.assignees || []).slice();
  const reviewers = (x.reviewers || []).slice();
  const milestoneId = x.milestoneId === null || x.milestoneId === undefined ? '' : String(x.milestoneId);
  const closed = x.state === 'closed';

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Properties of <strong>#${x.number}</strong> — ${escapeHtml(x.title)}</p>
    <div class="modal-field">
      <label>Assignees</label>
      ${forgeUserPickerHtml('prop-assignee', forgeUserRows(meta.assignees, assignees), assignees, meta.assigneesError)}
    </div>
    ${f.reviewers ? `
    <div class="modal-field">
      <label>Reviewers</label>
      ${forgeUserPickerHtml('prop-reviewer', forgeUserRows(meta.assignees, reviewers), reviewers, meta.assigneesError)}
    </div>` : ''}
    <div class="modal-field">
      <label>Milestone</label>
      ${forgeMilestoneSelectHtml('prop-milestone', meta.milestones, milestoneId, x.milestone, meta.milestonesError)}
    </div>
    ${f.dueDate ? `
    <div class="modal-field">
      <label>Due date</label>
      <input class="modal-input" type="date" id="prop-due" value="${forgeAttr(x.dueDate || '')}" />
    </div>` : ''}
    ${f.weight && x.weightSupported ? `
    <div class="modal-field">
      <label>Weight (blank for none)</label>
      <input class="modal-input" type="number" min="0" id="prop-weight" value="${forgeAttr(x.weight === null || x.weight === undefined ? '' : String(x.weight))}" />
    </div>` : ''}
    ${f.issueType ? `
    <div class="modal-field">
      <label>Type</label>
      <select class="modal-input" id="prop-type">
        ${['issue', 'incident', 'test_case', 'task'].map(t =>
          `<option value="${t}"${(x.issueType || 'issue') === t ? ' selected' : ''}>${t.replace(/_/g, ' ')}</option>`).join('')}
      </select>
    </div>` : ''}
    ${f.confidential ? `
    <label class="modal-checkbox"><input type="checkbox" id="prop-confidential"${x.confidential ? ' checked' : ''} /> Confidential — visible only to project members</label>` : ''}
    ${f.lock ? `
    <label class="modal-checkbox"><input type="checkbox" id="prop-locked"${x.locked ? ' checked' : ''} /> Lock the discussion — only people with write access can comment</label>
    ${f.lockReason ? `
    <div class="modal-field">
      <label>Lock reason (optional)</label>
      <select class="modal-input" id="prop-lock-reason">
        ${[['', '—'], ['off-topic', 'off-topic'], ['too heated', 'too heated'], ['resolved', 'resolved'], ['spam', 'spam']].map(([v, t]) =>
          `<option value="${v}"${(x.lockReason || '') === v ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
    </div>` : ''}` : ''}
    ${f.stateReason && closed ? `
    <div class="modal-field">
      <label>Closed as</label>
      <select class="modal-input" id="prop-state-reason">
        <option value="completed"${x.stateReason !== 'not_planned' ? ' selected' : ''}>completed</option>
        <option value="not_planned"${x.stateReason === 'not_planned' ? ' selected' : ''}>not planned</option>
      </select>
    </div>` : ''}
    ${f.assigneesDropSilently ? `<p class="modal-text text-muted">${escapeHtml(
      meta.provider === 'gitlab'
        ? 'GitLab keeps more than one assignee only on Premium and above — on other plans the first is kept and the rest are dropped.'
        : 'GitHub silently ignores an assignee without access to the repository, so what is shown afterwards is what actually stuck.')}</p>` : ''}`;

  forgeWirePicker(body, 'prop-assignee-filter', '#prop-assignee-list .forge-user-row');
  forgeWirePicker(body, 'prop-reviewer-filter', '#prop-reviewer-list .forge-user-row');

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-medieval primary';
  saveBtn.innerHTML = '<span class="btn-icon">⚙</span> Save';
  saveBtn.onclick = async () => {
    const payload = { kind: d.kind, number: d.number };
    const val = id => { const el = body.querySelector('#' + id); return el ? el.value : null; };
    const on = id => { const el = body.querySelector('#' + id); return el ? el.checked : null; };

    // Only read a picker that actually drew. A project whose member list this token cannot
    // see has no boxes to tick, and treating that as "nobody is ticked" would unassign
    // everyone the moment anything else on this form was saved.
    const drew = id => !!body.querySelector('#' + id + '-list');

    if (drew('prop-assignee')) {
      const want = forgePickedUsers(body, 'prop-assignee');
      if (!forgeSameSet(want, assignees)) payload.assignees = want;
    }
    if (f.reviewers && drew('prop-reviewer')) {
      const want = forgePickedUsers(body, 'prop-reviewer');
      if (!forgeSameSet(want, reviewers)) payload.reviewers = want;
    }

    const ms = val('prop-milestone');
    // "" is a real choice here — it means "take the milestone off" — so it is sent as null
    // rather than skipped, which is the distinction the handler reads.
    if (ms !== null && ms !== milestoneId) payload.milestone = ms === '' ? null : ms;

    if (f.dueDate) { const v = val('prop-due'); if (v !== null && v !== (x.dueDate || '')) payload.dueDate = v; }
    if (f.weight && x.weightSupported) {
      const v = val('prop-weight');
      const cur = x.weight === null || x.weight === undefined ? '' : String(x.weight);
      if (v !== null && v !== cur) payload.weight = v === '' ? null : v;
    }
    if (f.issueType) { const v = val('prop-type'); if (v !== null && v !== (x.issueType || 'issue')) payload.issueType = v; }
    if (f.confidential) { const v = on('prop-confidential'); if (v !== null && v !== !!x.confidential) payload.confidential = v; }
    if (f.lock) {
      const locked = on('prop-locked');
      const reason = f.lockReason ? (val('prop-lock-reason') || '') : '';
      // A reason change on an already-locked item still has to be written, and the only way
      // to write one is to lock again — the lock endpoint takes no PATCH.
      if (locked !== null && (locked !== !!x.locked || (locked && reason !== (x.lockReason || '')))) {
        payload.locked = locked;
        if (locked && reason) payload.lockReason = reason;
      }
    }
    if (f.stateReason && closed) {
      const v = val('prop-state-reason');
      if (v !== null && v !== (x.stateReason || 'completed')) payload.stateReason = v;
    }

    modal.hide();
    // Only kind and number left means nothing was touched, and a no-op write still costs a
    // request against a rate-limited API.
    if (Object.keys(payload).length <= 2) return;

    const res = await withLoading('Saving', () => gs.forgeSetProperties(payload));
    if (!handleResult(res, 'Saved')) return;
    const now = forgeState.detail;
    if (now && now.number === d.number) now.data = res.data;
    renderForgeDetail();
    await refreshForge();
  };

  modal.show({ title: '⚙ Properties', body, footer: [cancelBtn, saveBtn] });
}

// A person already on the item but no longer in the project's list still has to be tickable,
// or saving the dialog would silently unassign them — the same rule as a label the project
// has since deleted.
function forgeUserRows(all, chosen) {
  const known = new Set((all || []).map(u => u.login));
  return (all || []).concat((chosen || [])
    .filter(l => !known.has(l))
    .map(l => ({ login: l, name: '', outside: true })));
}

function forgeUserPickerHtml(id, rows, chosen, error) {
  const picked = new Set(chosen || []);
  if (!rows.length) {
    return `<p class="modal-text text-muted">${escapeHtml(error ||
      'Nobody to choose from — this token cannot read the list of people with access to the project.')}</p>`;
  }
  return `
    <input class="modal-input" id="${id}-filter" placeholder="Filter people…" autocomplete="off" />
    <div class="forge-label-picker forge-picker-short" id="${id}-list">
      ${rows.map(u => `
        <label class="forge-user-row" data-pick-text="${forgeAttr((u.login + ' ' + (u.name || '')).toLowerCase())}">
          <input type="checkbox" data-pick="${id}" value="${forgeAttr(u.login)}"${picked.has(u.login) ? ' checked' : ''} />
          <span class="forge-monogram">${escapeHtml(u.login.slice(0, 1).toUpperCase())}</span>
          <span class="forge-person-login">${escapeHtml(u.login)}</span>
          ${u.name ? `<span class="forge-label-desc">${escapeHtml(u.name)}</span>` : ''}
          ${u.outside ? '<span class="forge-label-desc">no longer has access</span>' : ''}
        </label>`).join('')}
    </div>
    ${error ? `<p class="modal-text text-muted">${escapeHtml(error)}</p>
      <p class="modal-text text-muted">Only the people already on this item are listed, so someone can be taken off but nobody new can be added.</p>` : ''}`;
}

function forgePickedUsers(body, id) {
  return [...body.querySelectorAll(`input[data-pick="${id}"]:checked`)].map(i => i.value);
}

// A milestone the item is on but the project no longer lists (closed and filtered out, or
// belonging to a group this token cannot see) is kept as an option, so opening the dialog
// and saving something else does not quietly clear it.
function forgeMilestoneSelectHtml(id, all, currentId, currentTitle, error) {
  const rows = (all || []).slice();
  if (currentId && !rows.some(m => String(m.id) === String(currentId))) {
    rows.unshift({ id: currentId, title: currentTitle || `#${currentId}`, state: 'open', dueOn: '' });
  }
  if (!rows.length) {
    return `<p class="modal-text text-muted">${escapeHtml(error ||
      'This project has no milestones yet. They are created on the forge, not here.')}</p>`;
  }
  return `<select class="modal-input" id="${id}">
    <option value=""${currentId ? '' : ' selected'}>— none —</option>
    ${rows.map(m => `<option value="${forgeAttr(String(m.id))}"${String(m.id) === String(currentId) ? ' selected' : ''}>${
      escapeHtml(m.title)}${m.state === 'closed' ? ' (closed)' : ''}${m.dueOn ? ' · due ' + escapeHtml(m.dueOn) : ''}</option>`).join('')}
  </select>`;
}

function forgeSameSet(a, b) {
  return a.length === b.length && a.every(v => b.includes(v));
}

// Tick what it should have. The set is replaced wholesale, which is what the dialog shows,
// so there is no add/remove vocabulary to get backwards.
async function forgeEditLabels() {
  const d = forgeState.detail;
  if (!d || !d.data || d.draftId) return;
  const x = d.data;

  const r = await withLoading('Reading labels', () => gs.forgeLabels({}));
  if (!r || !r.ok) { showToast((r && r.error) || 'Could not read the labels.', 'error', 6000); return; }
  const all = r.data || [];

  const chosen = new Set((x.labels || []).map(l => (typeof l === 'string' ? l : l.name)));
  const rows = forgeLabelRows(all, chosen);

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Labels on <strong>#${x.number}</strong> — ${escapeHtml(x.title)}</p>
    ${forgeLabelPickerHtml(rows, chosen)}`;
  forgeWireLabelPicker(body);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-medieval primary';
  applyBtn.innerHTML = '<span class="btn-icon">✎</span> Apply';
  applyBtn.disabled = !rows.length;
  applyBtn.onclick = async () => {
    const want = forgeChosenLabels(body);
    modal.hide();
    // Nothing ticked or unticked is not worth a write, and a no-op PUT still costs a request
    // against a rate-limited API.
    if (want.length === chosen.size && want.every(n => chosen.has(n))) return;

    const res = await withLoading('Applying labels', () => gs.forgeSetLabels({ kind: d.kind, number: d.number, labels: want }));
    if (!handleResult(res, 'Labels updated')) return;
    // The forge's answer, not what was ticked: it is the one that knows what actually stuck.
    const now = forgeState.detail;
    if (now && now.number === d.number && now.data) now.data.labels = (res.data && res.data.labels) || [];
    renderForgeDetail();
    await refreshForge();
  };

  modal.show({ title: '✎ Labels', body, footer: [cancelBtn, applyBtn] });
  const filter = body.querySelector('#forge-label-filter');
  if (filter) setTimeout(() => filter.focus(), 0);
}

// The title and body, as they are. Both forges accept the same edit on a request as on an
// issue, so this is offered for either — what differs is only what can be deleted.
async function forgeEditItem() {
  const d = forgeState.detail;
  if (!d || !d.data || d.draftId) return;
  const x = d.data;
  const noun = d.kind === 'issue' ? 'Issue' : (forgeState.info || {}).provider === 'gitlab' ? 'Merge Request' : 'Pull Request';

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="modal-field">
      <label>Title</label>
      <input class="modal-input" id="forge-edit-title" value="${forgeAttr(x.title || '')}" />
    </div>
    <div class="modal-field">
      <label>Description</label>
      <textarea class="modal-input" id="forge-edit-body" rows="10"></textarea>
    </div>`;
  // Set through .value rather than in the markup: a body containing "</textarea>" would
  // otherwise close the field early and spill the rest of it into the dialog as HTML.
  body.querySelector('#forge-edit-body').value = x.body || '';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-medieval primary';
  saveBtn.innerHTML = '<span class="btn-icon">✎</span> Save';
  saveBtn.onclick = async () => {
    const title = body.querySelector('#forge-edit-title').value.trim();
    const text = body.querySelector('#forge-edit-body').value;
    if (!title) { showToast('A title is required', 'error'); return; }
    modal.hide();
    if (title === (x.title || '') && text === (x.body || '')) return;   // nothing to write

    const r = await withLoading('Saving', () => gs.forgeUpdateItem({ kind: d.kind, number: d.number, title, body: text }));
    if (!handleResult(r, 'Saved')) return;
    const now = forgeState.detail;
    if (now && now.number === d.number) now.data = r.data;
    renderForgeDetail();
    await refreshForge();
  };

  modal.show({ title: `✎ Edit ${noun} #${x.number}`, body, footer: [cancelBtn, saveBtn] });
  setTimeout(() => { const t = body.querySelector('#forge-edit-title'); if (t) t.focus(); }, 0);
}

// Deleting an issue on a forge is permanent and takes its comments with it — there is no
// trash to recover it from, on either provider. So this asks for the number to be typed
// rather than for one more click: the confirmation should cost as much as the mistake does.
async function forgeDeleteIssue() {
  const d = forgeState.detail;
  if (!d || !d.data || d.draftId || d.kind !== 'issue') return;
  const x = d.data;
  const host = (forgeState.info || {}).host || 'the forge';

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Permanently delete issue <strong>#${x.number}</strong> — ${escapeHtml(x.title)}?</p>
    <p class="modal-text text-red">This cannot be undone. The issue and all of its comments are removed from ${escapeHtml(host)}. Closing it instead keeps the record and can be reversed.</p>
    <div class="modal-field">
      <label>Type <span class="text-mono">${x.number}</span> to confirm</label>
      <input class="modal-input" id="forge-del-confirm" autocomplete="off" placeholder="${x.number}" />
    </div>`;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const delBtn = document.createElement('button');
  delBtn.className = 'btn-medieval danger';
  delBtn.innerHTML = '<span class="btn-icon">✗</span> Delete Permanently';
  delBtn.disabled = true;
  delBtn.onclick = async () => {
    modal.hide();
    const r = await withLoading('Deleting', () => gs.forgeDeleteIssue({ kind: 'issue', number: d.number }));
    if (!handleResult(r, `Issue #${d.number} deleted`)) return;
    // Nothing left to read, so the pane goes back to the list rather than showing a 404.
    closeForgeDetail();
    await refreshForge();
  };

  const input = body.querySelector('#forge-del-confirm');
  input.addEventListener('input', () => { delBtn.disabled = input.value.trim() !== String(x.number); });

  modal.show({ title: '✗ Delete Issue', body, footer: [cancelBtn, delBtn] });
  setTimeout(() => input.focus(), 0);
}

// ---- the label picker, shared by the reader's pencil and the new-issue dialog ----------

// A label the item already carries but the project no longer defines still has to be
// tickable, or applying the dialog would silently strip it.
function forgeLabelRows(all, chosen) {
  const known = new Set((all || []).map(l => l.name));
  return (all || []).concat([...chosen]
    .filter(n => !known.has(n))
    .map(n => ({ name: n, color: '', ink: '', description: 'not defined on the project' })));
}

function forgeLabelPickerHtml(rows, chosen) {
  const host = (forgeState.info || {}).host || 'the forge';
  if (!rows.length) {
    return `<p class="modal-text text-muted">This project defines no labels yet. Create them on ${escapeHtml(host)} and they will show up here.</p>`;
  }
  return `
    <input class="modal-input" id="forge-label-filter" placeholder="Filter labels…" autocomplete="off" />
    <div class="forge-label-picker">
      ${rows.map(l => `
        <label class="forge-label-row" data-pick-text="${forgeAttr(l.name.toLowerCase())}">
          <input type="checkbox" value="${forgeAttr(l.name)}"${chosen.has(l.name) ? ' checked' : ''} />
          ${forgeLabelChipHtml(l)}
          ${l.description ? `<span class="forge-label-desc">${escapeHtml(l.description)}</span>` : ''}
        </label>`).join('')}
    </div>
    <p class="modal-text text-muted">New labels are created on ${escapeHtml(host)}, not here.</p>`;
}

function forgeWireLabelPicker(body) {
  forgeWirePicker(body, 'forge-label-filter', '.forge-label-row');
}

// Filtering hides rows rather than redrawing the list, so a tick survives typing in the box.
// Shared by the label and people pickers: the matched text is put on the row up front
// (data-pick-text) so this never has to know what kind of thing it is filtering.
function forgeWirePicker(body, filterId, rowSelector) {
  const filter = body.querySelector('#' + filterId);
  if (!filter) return;
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const row of body.querySelectorAll(rowSelector)) {
      row.style.display = !q || (row.dataset.pickText || '').includes(q) ? '' : 'none';
    }
  });
}

// Every ticked box, including the ones the filter is currently hiding.
function forgeChosenLabels(body) {
  return [...body.querySelectorAll('.forge-label-row input:checked')].map(i => i.value);
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

  // Nowhere to post a comment to on a project draft.
  if (d.draftId) return body;

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
    // Close, reopen and delete are reached from the ⋯ menu, which calls them directly.
    // The global "click closes any open menu" listener lives in 01-core and so runs before
    // this one — it hides the menu, then this reopens it. That order is what makes a
    // left-click trigger work here at all.
    case 'more': forgeShowMoreMenu(act); break;
    // These three belong to the list rather than the reader, but the listener is on
    // document either way and the switch is the one place forge buttons are read.
    case 'load-more': forgeLoadMore(); break;
    case 'clear-filters': forgeClearFilters(); forgeApplyFilters(); break;
    case 'new-issue': showCreateIssueDialog(); break;
    case 'labels': forgeEditLabels(); break;
    case 'props': forgeEditProperties(); break;
    case 'edit': forgeEditItem(); break;
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
        ${gh ? 'A classic token with the <strong>repo</strong> scope (or a fine-grained token with Pull requests, Issues and Contents access) lets GitGood list and open pull requests. ' +
               'Add the <strong>project</strong> scope as well if you want the Board and Work Items tabs — a Project belongs to the account or organisation that owns it, so repository access alone does not reach it.'
             : 'A personal access token with the <strong>api</strong> scope lets GitGood list and open merge requests, and read the issue boards.'}
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

// An issue has no git side at all — no branch, no push, nothing to check against the working
// tree — so this is the whole of it: a title, a description, and the labels to open it with.
async function showCreateIssueDialog() {
  if (!state.repo) return;
  const info = forgeState.info || ((await gs.forgeInfo({})).data);
  if (!info || !info.supported) { showToast('This repository has no recognised forge remote.', 'error', 6000); return; }
  if (!info.hasToken) { goToTab('forge'); await refreshForge(); showToast('Connect a token first', 'error'); return; }
  forgeState.info = info;

  // None of this is a requirement: a project whose labels or members cannot be read still
  // gets a dialog that opens an issue, just with fewer pickers in it. Both are fetched
  // together because they are two reads of the same project and the dialog waits for both.
  const [lr, mr] = await withLoading('Reading the project',
    () => Promise.all([gs.forgeLabels({}), gs.forgeIssueMeta({ kind: 'issue' })]));
  const rows = (lr && lr.ok && lr.data) || [];
  const meta = (mr && mr.ok && mr.data) || {};
  const f = meta.features || {};
  const chosen = new Set();

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="modal-field">
      <label>Title</label>
      <input class="modal-input" id="issue-title" placeholder="What is wrong, or what should exist" />
    </div>
    <div class="modal-field">
      <label>Description (optional)</label>
      <textarea class="modal-input" id="issue-body" rows="7" placeholder="Steps, context, anything the next person needs"></textarea>
    </div>
    <div class="modal-field">
      <label>Labels (optional)</label>
      ${forgeLabelPickerHtml(rows, chosen)}
    </div>
    <div class="modal-field">
      <label>Assignees (optional)</label>
      ${forgeUserPickerHtml('issue-assignee', forgeUserRows(meta.assignees, []), [], meta.assigneesError)}
    </div>
    <div class="modal-field">
      <label>Milestone (optional)</label>
      ${forgeMilestoneSelectHtml('issue-milestone', meta.milestones, '', '', meta.milestonesError)}
    </div>
    ${f.dueDate ? `
    <div class="modal-field">
      <label>Due date (optional)</label>
      <input class="modal-input" type="date" id="issue-due" />
    </div>` : ''}
    ${f.issueType ? `
    <div class="modal-field">
      <label>Type</label>
      <select class="modal-input" id="issue-type">
        ${['issue', 'incident', 'test_case', 'task'].map(t => `<option value="${t}">${t.replace(/_/g, ' ')}</option>`).join('')}
      </select>
    </div>` : ''}
    ${f.confidential ? `
    <label class="modal-checkbox"><input type="checkbox" id="issue-confidential" /> Confidential — visible only to project members</label>` : ''}`;
  forgeWireLabelPicker(body);
  forgeWirePicker(body, 'issue-assignee-filter', '#issue-assignee-list .forge-user-row');

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const createBtn = document.createElement('button');
  createBtn.className = 'btn-medieval primary';
  createBtn.innerHTML = '<span class="btn-icon">☰</span> Open Issue';
  createBtn.onclick = async () => {
    const title = body.querySelector('#issue-title').value.trim();
    if (!title) { showToast('A title is required', 'error'); return; }
    const desc = body.querySelector('#issue-body').value;
    const labels = forgeChosenLabels(body);
    const pick = id => { const el = body.querySelector('#' + id); return el ? el.value : ''; };
    const opts = {
      title, body: desc, labels,
      assignees: forgePickedUsers(body, 'issue-assignee'),
      milestone: pick('issue-milestone') || null
    };
    if (f.dueDate) opts.dueDate = pick('issue-due');
    if (f.issueType) opts.issueType = pick('issue-type');
    if (f.confidential) {
      const c = body.querySelector('#issue-confidential');
      opts.confidential = !!(c && c.checked);
    }
    modal.hide();

    const r = await withLoading('Opening the issue', () => gs.forgeCreateIssue(opts));
    if (!handleResult(r)) return;
    showToast(`Opened #${r.data.number}`, 'success');
    // Into the reader, the same as a new request: the issue has a home in the app now.
    goToTab('forge');
    setForgeView('issues');
    await refreshForge();
    await openForgeItem('issue', r.data.number);
  };

  modal.show({ title: '☰ New Issue', body, footer: [cancelBtn, createBtn] });
  setTimeout(() => { const t = body.querySelector('#issue-title'); if (t) t.focus(); }, 0);
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
  if (refresh) refresh.onclick = () => {
    // The board list is cached for the life of the repository, so the explicit refresh is
    // the only thing that will notice a project or board created since it was read.
    if (forgeIsBoardView()) { forgeState.boards = null; forgeState.board = null; }
    refreshForge();
  };

  const newPr = document.getElementById('forge-new-pr');
  if (newPr) newPr.onclick = () => showCreatePrDialog();

  const newIssue = document.getElementById('forge-new-issue');
  if (newIssue) newIssue.onclick = () => showCreateIssueDialog();

  const stateSel = document.getElementById('forge-state');
  if (stateSel) stateSel.onchange = () => refreshForge();

  wireForgeFilterBar();

  const settings = document.getElementById('forge-settings');
  if (settings) settings.onclick = () => showForgeSettings();

  const subtabs = document.getElementById('forge-subtabs');
  if (subtabs) subtabs.onclick = (e) => {
    const btn = e.target.closest('[data-forge-view]');
    if (!btn) return;
    const was = forgeState.view;
    setForgeView(btn.dataset.forgeView);

    // Work Items and Board are two drawings of one payload: flipping between them is a
    // re-render, never another round trip.
    if (forgeIsBoardView() && forgeIsBoardView(was) && forgeState.board) { renderForge(); return; }

    // Otherwise the reader is showing something that belongs to the list being left behind.
    forgeState.detail = null;
    refreshForge();
  };

  const boardSel = document.getElementById('forge-board');
  if (boardSel) boardSel.onchange = () => {
    forgeState.boardId = boardSel.value;
    forgeState.board = null;
    forgeState.detail = null;
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
