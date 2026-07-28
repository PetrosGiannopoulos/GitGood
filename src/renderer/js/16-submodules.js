// ============================================
// SUBMODULES
// ============================================
// A submodule appears in the outer repo as a single index entry holding one commit hash.
// Rendered as an ordinary file that produces a diff of two raw SHAs, which says nothing
// about what actually changed — and line-level staging on it is meaningless (see
// isSubmodulePath's use in selectFile). This module replaces that with a panel describing
// the pointer move, and gives uninitialised submodules somewhere to be seen at all.

// Paths come from repo:status on every refresh, so this is just a lookup.
function isSubmodulePath(p) {
  const list = (state.status && state.status.submodulePaths) || [];
  return list.indexOf(p) !== -1;
}

function repoHasSubmodules() {
  return (((state.status && state.status.submodulePaths) || []).length > 0);
}

const SUBMODULE_STATE_TEXT = {
  'uninitialized': { label: 'Not initialized', cls: 'warn' },
  'pointer-moved': { label: 'Pointer moved',   cls: 'moved' },
  'conflicted':    { label: 'Conflicted',      cls: 'bad' },
  'in-sync':       { label: 'In sync',         cls: 'ok' },
  'unknown':       { label: 'Unknown',         cls: '' }
};

// ---- the diff-pane panel -------------------------------------------------------------

// Write `html` into the diff pane only if it isn't already exactly what's there. The
// working-tree watcher re-selects the open file on every filesystem event, and a submodule
// with its own churning working tree produces a steady stream of them — so this panel gets
// re-rendered constantly with identical content. Assigning innerHTML anyway would tear down
// and rebuild the buttons under the pointer each time, which is visible as a flicker (and
// loses a click that lands mid-swap). The previous HTML is stashed on the element itself, so
// it goes away with the panel: after any other file has been shown, the marker is gone and
// this repaints unconditionally.
function paintSubmodulePanel(host, subPath, html) {
  const cur = host.firstElementChild;
  if (cur && cur.__submodPath === subPath && cur.__submodHtml === html) return;
  host.innerHTML = html;
  const el = host.firstElementChild;
  if (el) { el.__submodPath = subPath; el.__submodHtml = html; }
}

// Rendered in place of a gitlink's two-SHA diff. Shows which way the pointer moved and the
// commits it crossed, read from inside the submodule.
async function renderSubmodulePanel(subPath, staged) {
  const host = $('#diff-content');
  // Same reasoning as the spinner in selectFile: only blank the pane when what's on it now
  // isn't this submodule's panel. submoduleSummary runs several git commands inside the
  // submodule, so this is a long time to show a spinner over content that rarely changes.
  const showingThis = !!(host.firstElementChild && host.firstElementChild.__submodPath === subPath);
  if (!showingThis) host.innerHTML = '<div class="empty-state"><span class="loading"></span></div>';

  const r = await gs.submoduleSummary({ path: subPath });

  // The selection can move while the git calls above are running (a click, or the watcher
  // dropping a file that was staged away). Don't paint over whatever replaced us.
  if (state.selectedFile !== subPath) return;

  if (!r.ok) {
    host.innerHTML = `<div class="empty-state"><p class="text-red">${escapeHtml(r.error)}</p></div>`;
    return;
  }
  const s = r.data;

  if (!s.initialized) {
    paintSubmodulePanel(host, subPath, `
      <div class="submod-panel">
        <div class="submod-head">
          <span class="submod-icon">⛨</span>
          <span class="submod-path">${escapeHtml(subPath)}</span>
          <span class="submod-state warn">Not initialized</span>
        </div>
        <p class="submod-note">This submodule has never been checked out, so the folder is empty.
        Its contents are not part of this repository — they are fetched from the submodule's own remote.</p>
        <div class="submod-actions">
          <button class="btn-medieval primary" data-submod-action="update" data-submod-path="${escapeHtml(subPath)}">
            <span class="btn-icon">⤓</span> Initialize &amp; Update</button>
        </div>
      </div>`);
    return;
  }

  const short = h => (h || '').slice(0, 8);
  const n = (c) => `${c} commit${c === 1 ? '' : 's'}`;
  const DIRECTION = {
    ahead:    { verb: `moved forward by ${n(s.ahead)}`, cls: 'moved' },
    behind:   { verb: `moved back by ${n(s.behind)}`,   cls: 'moved' },
    diverged: { verb: `diverged — ${n(s.ahead)} gained, ${n(s.behind)} dropped`, cls: 'bad' },
    unchanged:{ verb: 'is unchanged',                   cls: 'ok' },
    // The pointers can't be compared when the submodule hasn't fetched one of the commits.
    unknown:  { verb: 'changed, but the commits involved are not in this clone', cls: 'warn' }
  };
  const dir = DIRECTION[s.direction] || DIRECTION.unknown;

  // "behind" lists the commits that would be LOST by keeping this pointer, so label the
  // list for what it is rather than implying they are being added.
  const listLabel = s.direction === 'behind'
    ? `${s.commits.length} commit${s.commits.length === 1 ? '' : 's'} dropped by this move`
    : `${s.commits.length} commit${s.commits.length === 1 ? '' : 's'} brought in by this move`;

  let commitsHtml = '';
  if (s.commitsUnavailable) {
    commitsHtml = `<p class="submod-note">The commits between these two pointers aren't available
      locally — fetch inside the submodule to see them.</p>`;
  } else if (s.commits.length) {
    commitsHtml = `
      <div class="submod-commits-label">${escapeHtml(listLabel)}${s.truncated ? ' (first 50)' : ''}</div>
      <div class="submod-commits">
        ${s.commits.map(c => `
          <div class="submod-commit">
            <code class="submod-hash">${escapeHtml(c.short)}</code>
            <span class="submod-subject">${escapeHtml(c.subject)}</span>
            <span class="submod-author">${escapeHtml(c.author)}</span>
          </div>`).join('')}
      </div>`;
  }

  const dirtyHtml = s.dirtyFiles.length ? `
    <div class="submod-dirty">
      <div class="submod-commits-label">⚠ ${s.dirtyFiles.length} uncommitted change${s.dirtyFiles.length === 1 ? '' : 's'} inside the submodule</div>
      <p class="submod-note">These live in the submodule's own working tree. Committing here records
      only the pointer — commit them inside the submodule first, or they stay on this machine.</p>
      <div class="submod-commits">
        ${s.dirtyFiles.slice(0, 20).map(f => `
          <div class="submod-commit"><code class="submod-hash">${escapeHtml(f.code || '??')}</code>
          <span class="submod-subject">${escapeHtml(f.path)}</span></div>`).join('')}
      </div>
    </div>` : '';

  paintSubmodulePanel(host, subPath, `
    <div class="submod-panel">
      <div class="submod-head">
        <span class="submod-icon">⛨</span>
        <span class="submod-path">${escapeHtml(subPath)}</span>
        <span class="submod-state ${dir.cls}">Submodule</span>
      </div>
      <p class="submod-note">This is a submodule: the outer repository records only which commit
      of it to use. The pointer ${escapeHtml(dir.verb)}.</p>
      <div class="submod-move">
        <code class="submod-hash old">${escapeHtml(short(s.indexHash))}</code>
        <span class="submod-arrow">→</span>
        <code class="submod-hash new">${escapeHtml(short(s.workHash))}</code>
      </div>
      ${commitsHtml}
      ${dirtyHtml}
      <div class="submod-actions">
        ${staged
          ? `<button class="btn-medieval" data-submod-action="unstage" data-submod-path="${escapeHtml(subPath)}">
               <span class="btn-icon">⇣</span> Unstage pointer</button>`
          : `<button class="btn-medieval primary" data-submod-action="stage" data-submod-path="${escapeHtml(subPath)}">
               <span class="btn-icon">⇡</span> Stage pointer</button>`}
        <button class="btn-medieval" data-submod-action="restore" data-submod-path="${escapeHtml(subPath)}">
          <span class="btn-icon">↺</span> Restore recorded commit</button>
        <button class="btn-medieval" data-submod-action="open" data-submod-path="${escapeHtml(subPath)}">
          <span class="btn-icon">⛨</span> Open submodule</button>
      </div>
    </div>`);
}

// ---- actions --------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-submod-action]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const subPath = btn.dataset.submodPath;
  const action = btn.dataset.submodAction;

  if (action === 'stage') {
    const r = await gs.stage([subPath]);
    if (handleResult(r, 'Submodule pointer staged')) await refreshStatus();
    return;
  }
  if (action === 'unstage') {
    const r = await gs.unstage([subPath]);
    if (handleResult(r, 'Submodule pointer unstaged')) await refreshStatus();
    return;
  }
  if (action === 'update') {
    const r = await withLoading('Updating submodule', () => gs.submoduleUpdate({ path: subPath, init: true }));
    if (handleResult(r, 'Submodule updated')) {
      await refreshAll();
      if (state.selectedFile === subPath) await selectFile(subPath, state.selectedFileStaged);
    }
    return;
  }
  if (action === 'restore') {
    // `git checkout -- <submodule>` does NOT do this: it only touches the outer index. The
    // submodule has to be checked out from inside, which is what submodule update does.
    const ok = await modal.confirm({
      title: 'Restore Recorded Commit',
      message: `Check "${subPath}" back out at the commit this repository records?\n\n`
             + `Any commits you made inside the submodule stay in its own history, but the `
             + `pointer change will be gone.`,
      confirmText: 'Restore'
    });
    if (!ok) return;
    const r = await withLoading('Restoring submodule', () => gs.submoduleUpdate({ path: subPath, init: true }));
    if (handleResult(r, 'Submodule restored')) {
      await refreshAll();
      if (state.selectedFile === subPath) await selectFile(subPath, state.selectedFileStaged);
    }
    return;
  }
  if (action === 'open') {
    // One repo at a time (main.js keeps a single simple-git instance), so this swaps rather
    // than opening a second window.
    const full = (state.repo && state.repo.path ? state.repo.path : '').replace(/\\/g, '/') + '/' + subPath;
    await openRepoByPath(full);
    return;
  }
});

// ---- the submodule list ------------------------------------------------------------------

// Uninitialised submodules never appear in the Changes list — there is nothing modified
// about them — so without this dialog there is no way to discover or initialise one.
async function showSubmodulesDialog() {
  const body = document.createElement('div');
  body.innerHTML = '<div class="empty-state"><span class="loading"></span></div>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-medieval'; closeBtn.textContent = 'Close';
  closeBtn.onclick = () => modal.hide();
  const updateAllBtn = document.createElement('button');
  updateAllBtn.className = 'btn-medieval primary';
  updateAllBtn.innerHTML = '<span class="btn-icon">⤓</span> Update All';
  updateAllBtn.onclick = async () => {
    modal.hide();
    const r = await withLoading('Updating submodules',
      () => gs.submoduleUpdate({ init: true, recursive: true }));
    if (handleResult(r, 'Submodules updated')) await refreshAll();
  };
  modal.show({ title: 'Submodules', body, footer: [closeBtn, updateAllBtn] });

  const r = await gs.submodules();
  if (!r.ok) {
    body.innerHTML = `<p class="modal-text text-red">${escapeHtml(r.error)}</p>`;
    return;
  }
  if (!r.data.length) {
    body.innerHTML = '<p class="modal-text">This repository has no submodules.</p>';
    return;
  }

  body.innerHTML = `
    <p class="modal-text">Each submodule is a separate repository pinned to one commit.</p>
    <div class="submod-list">
      ${r.data.map(s => {
        const st = SUBMODULE_STATE_TEXT[s.state] || SUBMODULE_STATE_TEXT.unknown;
        // `git submodule status` falls back to the abbreviated hash when the submodule has
        // no tags to describe against, which would just repeat the hash next to it.
        const describe = (s.describe && !(s.hash || '').startsWith(s.describe)) ? s.describe : null;
        return `
        <div class="submod-row">
          <div class="submod-row-main">
            <span class="submod-icon">⛨</span>
            <span class="submod-path">${escapeHtml(s.path)}</span>
            <span class="submod-state ${st.cls}">${escapeHtml(st.label)}</span>
            ${s.contentDirty ? '<span class="submod-state warn">Uncommitted inside</span>' : ''}
          </div>
          <div class="submod-row-meta">
            <code class="submod-hash">${escapeHtml((s.hash || '').slice(0, 8))}</code>
            ${describe ? `<span class="submod-describe">${escapeHtml(describe)}</span>` : ''}
            ${s.url ? `<span class="submod-url" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</span>` : ''}
          </div>
          <div class="submod-row-actions">
            <button class="mini-btn" data-submod-action="update" data-submod-path="${escapeHtml(s.path)}">⤓ Update</button>
            ${s.initialized
              ? `<button class="mini-btn" data-submod-action="open" data-submod-path="${escapeHtml(s.path)}">⛨ Open</button>`
              : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}
