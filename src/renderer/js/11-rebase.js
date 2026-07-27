// ============================================
// REBASE
// ============================================
// Two entry points, both from the branch context menus:
//   • "Rebase onto <branch>"            → a plain replay, with a preview of what moves
//   • "Interactive rebase onto <branch>" → the same, plus a plan the user can edit
//
// Conflicts are not treated as failures. A rebase that stops mid-way leaves git in an
// in-progress state that the existing conflict banner already understands (it detects
// .git/rebase-merge and offers Resolve / Continue / Skip / Abort), so we just refresh
// and let that take over.

// Shared preflight: load the plan and refuse the obvious no-ops before showing any UI.
async function loadRebasePlan(onto) {
  const r = await withLoading('Reading history', () => gs.rebaseTodo({ onto }));
  if (!r.ok) { showToast(r.error || 'Could not read history', 'error', 7000); return null; }
  const plan = r.data;

  if (plan.alreadyUpToDate) {
    showToast(
      plan.upToDateReason === 'behind'
        ? `Nothing to rebase — “${plan.current}” has no commits that “${onto}” doesn't already have. Pull or merge instead.`
        : `Nothing to rebase — “${plan.current}” is already based on “${onto}”.`,
      'info', 6000);
    return null;
  }
  if (!plan.commits.length) {
    showToast('Nothing to rebase — no commits would move.', 'info', 5000);
    return null;
  }
  return plan;
}

// Does the working tree have uncommitted changes? A rebase refuses to start on a dirty
// tree unless --autostash is used, so both dialogs offer it.
function workingTreeIsDirty() {
  return !!(state.status && (state.status.files || []).length > 0);
}

function dirtyTreeCheckboxHtml() {
  if (!workingTreeIsDirty()) return '';
  const n = (state.status.files || []).length;
  return `<label class="modal-checkbox">
    <input type="checkbox" id="rb-autostash" checked />
    Stash the ${n} uncommitted change${n === 1 ? '' : 's'} automatically, and restore ${n === 1 ? 'it' : 'them'} afterwards
  </label>`;
}

// Warn when the commits being replayed are already published: a rebase rewrites them, so
// the remote diverges and the next push has to be forced.
async function warnIfPublished(plan, onto) {
  const tracking = state.status && state.status.tracking;
  const ahead = (state.status && state.status.ahead) || 0;
  if (!tracking || plan.commits.length <= ahead) return true;
  const rewritten = plan.commits.length - ahead;
  return await modal.confirm({
    title: 'Rebasing Published Commits',
    message:
      `${rewritten} of the ${plan.commits.length} commit${plan.commits.length === 1 ? '' : 's'} being replayed ` +
      `${rewritten === 1 ? 'is' : 'are'} already on ${tracking}. Rebasing rewrites ${rewritten === 1 ? 'it' : 'them'}, ` +
      `so the remote will diverge and your next push must be a force-push ` +
      `(GitGood uses the safe --force-with-lease).\n\n` +
      `Anyone who already pulled these commits will need to reconcile their history.\n\nContinue?`,
    danger: true,
    confirmText: 'Rebase Anyway'
  });
}

// After a rebase completes, offer to update the remote if the branch tracks one.
async function offerPushAfterRebase() {
  const tracking = state.status && state.status.tracking;
  if (!tracking) return;
  const behind = (state.status && state.status.behind) || 0;
  const needForce = behind > 0;
  const ok = await modal.confirm({
    title: 'Push the Rebased Branch',
    message: needForce
      ? `The rebase rewrote commits that are already on ${tracking}, so the remote has diverged.\n\n` +
        `Push with --force-with-lease (the safe force — it refuses if a teammate pushed in the meantime)?`
      : `Push the rebased branch to ${tracking}?`,
    confirmText: needForce ? 'Force-Push (lease)' : 'Push'
  });
  if (!ok) return;
  const r = await withLoading(needForce ? 'Force-pushing' : 'Pushing',
    () => gs.push(needForce ? { force: true } : undefined));
  if (handleResult(r, 'Pushed')) await refreshAll();
}

// Shared tail for both flows: run it, then interpret the outcome.
async function runRebase(opts, label) {
  const r = await withLoading(label, () => gs.rebase(opts));
  if (!r.ok) { showToast(r.error || 'Rebase failed', 'error', 9000); await refreshAll(); return false; }
  await refreshAll();

  if (r.data && r.data.conflicted) {
    showToast('Rebase paused on a conflict — resolve it, then Continue.', 'info', 7000);
    // The conflict banner is already showing after refreshAll; take the user straight to
    // the resolver rather than making them hunt for it.
    if (typeof openConflictResolver === 'function') openConflictResolver();
    return false;
  }

  showToast('Rebase complete', 'success');
  await offerPushAfterRebase();
  return true;
}

// ============================================
// PLAIN REBASE
// ============================================
async function showRebaseDialog(onto) {
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }
  const plan = await loadRebasePlan(onto);
  if (!plan) return;

  const n = plan.commits.length;
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Replay the <strong class="text-red">${n}</strong> commit${n === 1 ? '' : 's'} on
      <strong>${escapeHtml(plan.current || 'HEAD')}</strong> on top of
      <strong class="text-red">${escapeHtml(onto)}</strong>.</p>
    <p class="modal-text text-muted" style="font-size:12px">
      This rewrites those commits — they get new hashes. The result is a straight line of history
      with no merge commit.</p>
    <div class="branches-label" style="margin:14px 0 6px">⚜ Commits to replay (oldest first)</div>
    <div class="rb-preview">${plan.commits.map(c => `
      <div class="rb-preview-row">
        <span class="text-red text-mono">${escapeHtml(c.short)}</span>
        <span>${escapeHtml(c.subject)}</span>
      </div>`).join('')}</div>
    ${plan.mergeCount ? `<p class="modal-text text-muted" style="font-size:12px;margin-top:10px">
      ⚠ ${plan.mergeCount} merge commit${plan.mergeCount === 1 ? '' : 's'} in this range will be flattened —
      a default rebase does not preserve merges.</p>` : ''}
    ${dirtyTreeCheckboxHtml()}
  `;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const editBtn = document.createElement('button');
  editBtn.className = 'btn-medieval';
  editBtn.innerHTML = '<span class="btn-icon">☰</span> Edit Plan…';
  editBtn.title = 'Reorder, squash, reword or drop commits before replaying them';
  editBtn.onclick = () => { modal.hide(); showInteractiveRebaseDialog(onto, plan); };

  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary';
  okBtn.innerHTML = '<span class="btn-icon">⚔</span> Rebase';
  okBtn.onclick = async () => {
    const autostashEl = body.querySelector('#rb-autostash');
    const autostash = !!(autostashEl && autostashEl.checked);
    if (workingTreeIsDirty() && !autostash) {
      showToast('Commit or stash your changes first, or tick the auto-stash option.', 'error', 6000);
      return;
    }
    modal.hide();
    if (!await warnIfPublished(plan, onto)) return;
    await runRebase({ onto, autostash }, `Rebasing onto ${onto}`);
  };

  modal.show({ title: 'Rebase', body, footer: [cancelBtn, editBtn, okBtn] });
}

// ============================================
// INTERACTIVE REBASE
// ============================================
const REBASE_ACTIONS = [
  { value: 'pick',   label: 'pick',   hint: 'Keep the commit as it is' },
  { value: 'reword', label: 'reword', hint: 'Keep the changes, edit the message' },
  { value: 'squash', label: 'squash', hint: 'Fold into the commit above, combining messages' },
  { value: 'fixup',  label: 'fixup',  hint: 'Fold into the commit above, discarding this message' },
  { value: 'drop',   label: 'drop',   hint: 'Remove the commit entirely' }
];

async function showInteractiveRebaseDialog(onto, preloadedPlan) {
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }
  const plan = preloadedPlan || await loadRebasePlan(onto);
  if (!plan) return;

  // Working copy of the plan, in the order it will be written to the todo file.
  let rows = plan.commits.map(c => ({
    hash: c.hash, short: c.short, subject: c.subject, author: c.author,
    action: 'pick',
    message: null            // set by reword, and by squash on the group leader
  }));

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Plan how the <strong class="text-red">${rows.length}</strong>
      commit${rows.length === 1 ? '' : 's'} on <strong>${escapeHtml(plan.current || 'HEAD')}</strong>
      are replayed onto <strong class="text-red">${escapeHtml(onto)}</strong>.
      Oldest is at the top — the same order git uses.</p>
    <div class="rb-legend">${REBASE_ACTIONS.map(a =>
      `<span><code>${a.label}</code> ${escapeHtml(a.hint)}</span>`).join('')}</div>
    <div class="rb-list" id="rb-list"></div>
    <div class="rb-summary" id="rb-summary"></div>
    ${plan.mergeCount ? `<p class="modal-text text-muted" style="font-size:12px;margin-top:10px">
      ⚠ ${plan.mergeCount} merge commit${plan.mergeCount === 1 ? '' : 's'} in this range will be flattened.</p>` : ''}
    ${dirtyTreeCheckboxHtml()}
  `;

  const listEl = body.querySelector('#rb-list');
  const summaryEl = body.querySelector('#rb-summary');

  function renderRows() {
    listEl.innerHTML = rows.map((r, i) => {
      const isSquashish = r.action === 'squash' || r.action === 'fixup';
      // A squash/fixup at the very top has nothing to fold into — flag it inline rather
      // than only failing when git is invoked.
      const orphan = isSquashish && !rows.slice(0, i).some(p => p.action !== 'drop');
      return `
      <div class="rb-row action-${r.action}${orphan ? ' invalid' : ''}" data-idx="${i}">
        <div class="rb-move">
          <button class="rb-move-btn" data-move="up" data-idx="${i}" ${i === 0 ? 'disabled' : ''} title="Move earlier">▲</button>
          <button class="rb-move-btn" data-move="down" data-idx="${i}" ${i === rows.length - 1 ? 'disabled' : ''} title="Move later">▼</button>
        </div>
        <select class="rb-action" data-idx="${i}" title="What to do with this commit">
          ${REBASE_ACTIONS.map(a => `<option value="${a.value}"${a.value === r.action ? ' selected' : ''}>${a.label}</option>`).join('')}
        </select>
        <span class="rb-hash text-mono text-red">${escapeHtml(r.short)}</span>
        <span class="rb-subject" title="${escapeHtml(r.subject)}">${escapeHtml(r.message ? r.message.split('\n')[0] : r.subject)}</span>
        <button class="rb-edit-btn" data-edit="${i}" title="Edit the message for this commit"
          ${r.action === 'reword' || r.action === 'squash' ? '' : 'disabled'}>✎</button>
      </div>`;
    }).join('');
    renderSummary();
  }

  function renderSummary() {
    const kept = rows.filter(r => r.action !== 'drop');
    const folded = rows.filter(r => r.action === 'squash' || r.action === 'fixup').length;
    const dropped = rows.filter(r => r.action === 'drop').length;
    const resulting = kept.length - folded;
    const bits = [`${resulting} commit${resulting === 1 ? '' : 's'} after rebase`];
    if (folded) bits.push(`${folded} folded in`);
    if (dropped) bits.push(`${dropped} dropped`);
    summaryEl.textContent = '⚜ ' + bits.join(' · ');
  }

  listEl.addEventListener('change', (e) => {
    const sel = e.target.closest('.rb-action');
    if (!sel) return;
    const i = parseInt(sel.dataset.idx, 10);
    rows[i].action = sel.value;
    // A message only belongs to reword/squash; drop it otherwise so it can't leak into
    // the todo for an action that never opens an editor.
    if (rows[i].action !== 'reword' && rows[i].action !== 'squash') rows[i].message = null;
    renderRows();
  });

  listEl.addEventListener('click', (e) => {
    const move = e.target.closest('[data-move]');
    if (move) {
      const i = parseInt(move.dataset.idx, 10);
      const j = move.dataset.move === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= rows.length) return;
      const tmp = rows[i]; rows[i] = rows[j]; rows[j] = tmp;
      renderRows();
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit && !edit.disabled) {
      const i = parseInt(edit.dataset.edit, 10);
      promptRebaseMessage(rows[i], () => renderRows());
    }
  });

  renderRows();

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn-medieval';
  resetBtn.textContent = 'Reset Plan';
  resetBtn.onclick = () => {
    rows = plan.commits.map(c => ({
      hash: c.hash, short: c.short, subject: c.subject, author: c.author, action: 'pick', message: null
    }));
    renderRows();
  };

  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary';
  okBtn.innerHTML = '<span class="btn-icon">⚔</span> Run Rebase';
  okBtn.onclick = async () => {
    const firstKept = rows.find(r => r.action !== 'drop');
    if (!firstKept) { showToast('The plan drops every commit — nothing would be left.', 'error', 6000); return; }
    if (firstKept.action === 'squash' || firstKept.action === 'fixup') {
      showToast('The first kept commit cannot be a squash or fixup — there is nothing before it to fold into.', 'error', 7000);
      return;
    }
    const autostashEl = body.querySelector('#rb-autostash');
    const autostash = !!(autostashEl && autostashEl.checked);
    if (workingTreeIsDirty() && !autostash) {
      showToast('Commit or stash your changes first, or tick the auto-stash option.', 'error', 6000);
      return;
    }

    modal.hide();
    if (!await warnIfPublished(plan, onto)) return;

    const todo = rows.map(r => ({
      hash: r.hash, subject: r.subject, action: r.action,
      message: r.message || undefined
    }));
    await runRebase({ onto, todo, autostash }, 'Running interactive rebase');
  };

  modal.show({ title: 'Interactive Rebase', body, footer: [cancelBtn, resetBtn, okBtn] });
}

// Small editor for a reword/squash message. Writes back onto the row and re-renders.
function promptRebaseMessage(row, onDone) {
  const current = row.message !== null && row.message !== undefined ? row.message : row.subject;
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Message for <code class="text-mono text-red">${escapeHtml(row.short)}</code>
      ${row.action === 'squash' ? '(this becomes the combined message for the squash group)' : ''}</p>
    <div class="modal-field">
      <textarea class="modal-input" id="rb-msg" rows="6" style="resize:vertical;font-family:var(--font-mono)"></textarea>
    </div>
  `;
  const ta = body.querySelector('#rb-msg');
  ta.value = current;

  const cancel = document.createElement('button');
  cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
  cancel.onclick = () => modal.hide();

  const save = document.createElement('button');
  save.className = 'btn-medieval primary'; save.textContent = 'Save';
  save.onclick = () => {
    const v = ta.value.trim();
    if (!v) { showToast('A message is required', 'error'); return; }
    row.message = v;
    modal.hide();
    if (onDone) onDone();
  };

  modal.show({ title: 'Edit Commit Message', body, footer: [cancel, save] });
}

// ============================================
// TARGET PICKER
// ============================================
// Entry point for "Interactive rebase…" when the user hasn't already named a target
// (e.g. right-clicking the branch they're already on). Offers the upstream first,
// then the usual integration branches, then everything else.
function promptInteractiveRebaseTarget() {
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }
  const current = (state.branches.local && state.branches.local.current) || '';
  const locals = ((state.branches.local && state.branches.local.all) || []).filter(b => b !== current);
  const remotes = (state.branches.remotes && state.branches.remotes.all) || [];
  const tracking = (state.status && state.status.tracking) || '';

  const candidates = [];
  const seen = new Set();
  const add = (name, note) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    candidates.push({ name, note });
  };
  if (tracking) add(tracking, 'upstream');
  ['main', 'master', 'develop', 'devel'].forEach(n => { if (locals.includes(n)) add(n, 'integration branch'); });
  locals.forEach(n => add(n, 'local'));
  remotes.forEach(n => add(n, 'remote'));

  if (!candidates.length) {
    showToast('There is no other branch to rebase onto.', 'error', 5000);
    return;
  }

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Replay the commits on <strong class="text-red">${escapeHtml(current || 'HEAD')}</strong>
      on top of which branch?</p>
    <div class="modal-field">
      <label>Rebase onto</label>
      <select class="modal-input" id="rb-target">
        ${candidates.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.note ? ` — ${c.note}` : ''}</option>`).join('')}
      </select>
    </div>`;

  const cancel = document.createElement('button');
  cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
  cancel.onclick = () => modal.hide();

  const next = document.createElement('button');
  next.className = 'btn-medieval primary';
  next.innerHTML = '<span class="btn-icon">☰</span> Plan Rebase';
  next.onclick = () => {
    const target = body.querySelector('#rb-target').value;
    modal.hide();
    showInteractiveRebaseDialog(target);
  };

  modal.show({ title: 'Interactive Rebase', body, footer: [cancel, next] });
}

// ============================================
// PULL WITH REBASE
// ============================================
// `git pull --rebase` as an explicit action, so the linear-history workflow doesn't
// require editing pull.rebase in config first.
async function pullRebase() {
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }
  const tracking = state.status && state.status.tracking;
  if (!tracking) { showToast('This branch has no upstream to pull from.', 'error', 6000); return; }

  if (workingTreeIsDirty()) {
    const ok = await modal.confirm({
      title: 'Pull with Rebase',
      message: 'You have uncommitted changes. They will be stashed automatically and restored after the rebase.\n\nContinue?',
      confirmText: 'Stash & Pull'
    });
    if (!ok) return;
  }

  // `git pull --rebase` is fetch-then-rebase; do the fetch explicitly so the rebase
  // replays onto the remote's *current* tip rather than a stale tracking ref.
  const f = await withLoading('Fetching', () => gs.fetch());
  if (!f.ok) { showToast(f.error || 'Fetch failed', 'error', 8000); return; }

  const r = await withLoading('Rebasing onto ' + tracking, () => gs.rebase({ onto: tracking, autostash: true }));
  if (!r.ok) { showToast(r.error || 'Pull failed', 'error', 9000); await refreshAll(); return; }
  await refreshAll();
  if (r.data && r.data.conflicted) {
    showToast('Rebase paused on a conflict — resolve it, then Continue.', 'info', 7000);
    if (typeof openConflictResolver === 'function') openConflictResolver();
    return;
  }
  showToast(`Rebased onto ${tracking}`, 'success');
}
