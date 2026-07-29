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
  checks: new Map()  // sha -> forge:checks result, so the graph doesn't re-ask per click
};

function forgeReset() {
  forgeState.info = null;
  forgeState.items = [];
  forgeState.loadedFor = null;
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

  if (!items.length) {
    body.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${forgeState.view === 'issues' ? '☰' : '⇄'}</div>
      <p>Nothing here${(document.getElementById('forge-state') || {}).value === 'open' ? ' that is still open' : ''}.</p>
    </div>`;
    return;
  }

  const current = (state.branches.local && state.branches.local.current) || '';
  body.innerHTML = `<ul class="forge-list">${items.map(it => forgeState.view === 'issues'
    ? forgeIssueRowHtml(it)
    : forgeRequestRowHtml(it, current)).join('')}</ul>`;
}

function forgeRequestRowHtml(pr, currentBranch) {
  const mine = pr.source && pr.source === currentBranch;
  return `<li class="forge-item${mine ? ' current-branch-pr' : ''}" data-forge-url="${escapeHtml(pr.url)}">
    <div class="forge-item-head">
      <span class="forge-state forge-state-${escapeHtml(pr.state)}">${escapeHtml(pr.state)}</span>
      <span class="forge-num">#${pr.number}</span>
      <span class="forge-title">${escapeHtml(pr.title)}</span>
      ${mine ? '<span class="forge-flag" title="Opened from the branch you are on">current branch</span>' : ''}
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
  return `<li class="forge-item" data-forge-url="${escapeHtml(it.url)}">
    <div class="forge-item-head">
      <span class="forge-state forge-state-${escapeHtml(it.state === 'opened' ? 'open' : it.state)}">${escapeHtml(it.state === 'opened' ? 'open' : it.state)}</span>
      <span class="forge-num">#${it.number}</span>
      <span class="forge-title">${escapeHtml(it.title)}</span>
    </div>
    <div class="forge-item-meta">
      ${escapeHtml(it.author)}
      ${it.updatedAt ? ' · updated ' + escapeHtml(relativeTime(it.updatedAt)) : ''}
      ${(it.labels || []).length ? ' · ' + it.labels.slice(0, 4).map(l => `<span class="forge-label">${escapeHtml(l)}</span>`).join(' ') : ''}
    </div>
  </li>`;
}

// Clicking a row opens it in the browser — the forge's own page is a better place to read
// a discussion than anything this app could render.
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-forge-url]');
  if (!row) return;
  const url = row.dataset.forgeUrl;
  if (url) gs.openExternal(url);
});

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
    await refreshForge();
    const go = await modal.confirm({
      title: 'Request Opened',
      message: `#${r.data.number} — ${r.data.title}\n\n${r.data.url}`,
      confirmText: 'Open in Browser',
      cancelText: 'Stay Here'
    });
    if (go) gs.openExternal(r.data.url);
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
