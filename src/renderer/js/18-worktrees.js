// ============================================
// WORKTREES (renderer)
// ============================================
// A linked worktree is a second checkout of the same repository — its own working tree and
// HEAD, sharing the object store and the refs. Two consequences drive this whole panel:
//
// • Opening one is just openRepoByPath(). Every other feature already works on a worktree
//   without knowing it is one, so there is no "worktree mode" anywhere in the app.
// • A branch can only be checked out in one worktree at a time. The sidebar therefore marks
//   which branch is claimed where, and the Add dialog defaults to making a *new* branch —
//   the alternative is git refusing the add, which is a confusing way to learn the rule.

const worktreeState = {
  list: [],       // last worktree:list result
  loaded: false
};

async function refreshWorktrees() {
  if (!state.repo) { worktreeState.list = []; worktreeState.loaded = false; renderWorktrees(); return; }
  const r = await gs.worktreeList();
  worktreeState.list = (r && r.ok) ? (r.data || []) : [];
  worktreeState.loaded = !!(r && r.ok);
  renderWorktrees();
}

// Which worktree (if any) holds this branch. Used to explain a checkout that git will
// refuse before the user tries it.
function worktreeHoldingBranch(branch) {
  if (!branch) return null;
  return worktreeState.list.find(w => w.branch === branch && !w.current) || null;
}

function renderWorktrees() {
  const list = document.getElementById('worktree-list');
  const count = document.getElementById('worktree-count');
  const section = document.getElementById('section-worktrees');
  if (!list) return;

  const trees = worktreeState.list;
  if (count) count.textContent = trees.length;
  // One worktree means the repository has none of interest — the main checkout is always
  // in the list. Keep the section (its header holds the Add button) but say so plainly.
  if (section) section.classList.toggle('single-worktree', trees.length <= 1);

  list.innerHTML = '';
  if (!trees.length) {
    list.innerHTML = `<li class="sidebar-empty">${worktreeState.loaded ? 'No worktrees' : 'Not loaded'}</li>`;
    return;
  }

  trees.forEach(w => {
    const li = document.createElement('li');
    li.className = 'sidebar-item worktree-item'
      + (w.current ? ' active' : '')
      + (w.prunable || !w.exists ? ' missing' : '');
    const label = w.branch ? w.branch : (w.detached ? `detached @ ${(w.head || '').slice(0, 7)}` : w.name);
    li.innerHTML = `
      <span class="wt-icon">${w.main ? '⌂' : '⑂'}</span>
      <span class="wt-label">${escapeHtml(label)}</span>
      ${w.locked ? '<span class="wt-flag" title="Locked — excluded from prune">⚿</span>' : ''}
      ${(w.prunable || !w.exists) ? '<span class="wt-flag bad" title="The folder is gone; prune to clean up">⚠</span>' : ''}
    `;
    li.title = `${w.path}${w.main ? '\n(main worktree)' : ''}${w.lockReason ? '\nLocked: ' + w.lockReason : ''}`;
    li.onclick = () => { if (!w.current) openWorktree(w); };
    li.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [];
      if (!w.current) items.push({ label: 'Open this worktree', icon: '📜', action: () => openWorktree(w) });
      items.push({ label: 'Open folder', icon: '⛬', action: () => gs.openInExplorer(w.path) });
      items.push({ label: 'Copy path', icon: '⎘', action: () => copyText(w.path, 'Path copied') });
      items.push('sep');
      items.push({
        label: w.locked ? 'Unlock' : 'Lock (exclude from prune)',
        icon: '⚿',
        action: () => toggleWorktreeLock(w)
      });
      if (!w.main) {
        items.push('sep');
        items.push({ label: 'Remove worktree…', icon: '✗', danger: true, action: () => removeWorktree(w) });
      }
      showContextMenu(items, e.pageX, e.pageY);
    };
    list.appendChild(li);
  });
}

// Switching to a worktree is a plain repo open: same objects, same refs, different HEAD and
// working tree. openRepoByPath does the rest (watcher, refresh, tab bookkeeping).
async function openWorktree(w) {
  if (!w || !w.path) return;
  if (!w.exists) {
    showToast(`The folder for this worktree is gone (${w.path}). Prune to clean up the leftover record.`, 'error', 7000);
    return;
  }
  await openRepoByPath(w.path);
}

async function toggleWorktreeLock(w) {
  const r = await gs.worktreeLock({ path: w.path, unlock: !!w.locked });
  if (!handleResult(r, w.locked ? 'Worktree unlocked' : 'Worktree locked')) return;
  await refreshWorktrees();
}

async function removeWorktree(w, force) {
  if (!force) {
    const ok = await modal.confirm({
      title: 'Remove Worktree',
      message: `Remove the worktree at:\n${w.path}\n\nThe branch and its commits stay in the repository — only this checkout folder goes.`,
      confirmText: 'Remove',
      danger: true
    });
    if (!ok) return;
  }
  const r = await withLoading('Removing worktree', () => gs.worktreeRemove({ path: w.path, force: !!force }));
  if (r && !r.ok && /uncommitted changes or untracked files/i.test(r.error || '')) {
    // git refuses rather than destroying work. Say exactly what would be lost before offering.
    const ok = await modal.confirm({
      title: 'Worktree Has Uncommitted Work',
      message: `${r.error}\n\nRemoving it anyway deletes those changes permanently.`,
      confirmText: 'Delete Anyway',
      danger: true
    });
    if (!ok) return;
    return removeWorktree(w, true);
  }
  if (!handleResult(r, 'Worktree removed')) return;
  await refreshWorktrees();
}

async function pruneWorktrees() {
  const r = await withLoading('Pruning worktrees', () => gs.worktreePrune());
  if (!handleResult(r)) return;
  const n = r.data.pruned || 0;
  showToast(n ? `Pruned ${n} stale worktree record${n === 1 ? '' : 's'}` : 'Nothing to prune', n ? 'success' : 'info');
  await refreshWorktrees();
}

// ============================================
// ADD DIALOG
// ============================================
function showAddWorktreeDialog() {
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }

  const branches = (state.branches.local && state.branches.local.all) || [];
  const claimed = new Set(worktreeState.list.filter(w => w.branch).map(w => w.branch));
  const suggestion = `${(state.repo.path || '').replace(/[\\/]+$/, '')}-wt`;

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">A worktree is a second folder checked out from this same repository —
      handy for building one branch while you keep editing another. It shares the history; only the files differ.</p>

    <div class="modal-field">
      <label>Folder for the new worktree</label>
      <div style="display:flex;gap:6px">
        <input class="modal-input" id="wt-path" value="${escapeHtml(suggestion)}" placeholder="C:\\code\\myrepo-feature" />
        <button class="mini-btn" id="wt-browse" type="button">…</button>
      </div>
    </div>

    <div class="modal-field">
      <label>What to check out there</label>
      <div class="merge-strategies">
        <label class="merge-strategy selected">
          <input type="radio" name="wt-mode" value="new" checked />
          <div class="merge-strategy-body">
            <div class="merge-strategy-title">A new branch</div>
            <div class="merge-strategy-desc">Create a branch for this worktree, based on the ref below. <strong>Usually what you want</strong> — an existing branch can only be checked out in one worktree at a time.</div>
          </div>
        </label>
        <label class="merge-strategy">
          <input type="radio" name="wt-mode" value="existing" />
          <div class="merge-strategy-body">
            <div class="merge-strategy-title">An existing branch</div>
            <div class="merge-strategy-desc">Only branches not already checked out somewhere are listed.</div>
          </div>
        </label>
        <label class="merge-strategy">
          <input type="radio" name="wt-mode" value="detach" />
          <div class="merge-strategy-body">
            <div class="merge-strategy-title">A commit, detached</div>
            <div class="merge-strategy-desc">No branch. Good for inspecting or building an old revision.</div>
          </div>
        </label>
      </div>
    </div>

    <div class="modal-field" id="wt-newbranch-field">
      <label>New branch name</label>
      <input class="modal-input" id="wt-newbranch" placeholder="feature/second-front" />
    </div>

    <div class="modal-field" id="wt-existing-field" style="display:none">
      <label>Branch</label>
      <select class="modal-input" id="wt-existing">
        ${branches.filter(b => !claimed.has(b)).map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')
          || '<option value="" disabled selected>Every branch is already checked out somewhere</option>'}
      </select>
    </div>

    <div class="modal-field" id="wt-ref-field">
      <label id="wt-ref-label">Base it on (branch, tag or commit — blank for HEAD)</label>
      <input class="modal-input" id="wt-ref" placeholder="${escapeHtml((state.branches.local && state.branches.local.current) || 'HEAD')}" />
    </div>
  `;

  body.querySelectorAll('.merge-strategy').forEach(card => {
    card.onclick = () => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
      body.querySelectorAll('.merge-strategy').forEach(c => c.classList.toggle('selected', c === card));
      const mode = radio ? radio.value : 'new';
      body.querySelector('#wt-newbranch-field').style.display = mode === 'new' ? '' : 'none';
      body.querySelector('#wt-existing-field').style.display = mode === 'existing' ? '' : 'none';
      // An existing branch already says where to start; a ref would be ignored.
      body.querySelector('#wt-ref-field').style.display = mode === 'existing' ? 'none' : '';
      body.querySelector('#wt-ref-label').textContent = mode === 'detach'
        ? 'Commit to check out (hash, tag or branch)'
        : 'Base it on (branch, tag or commit — blank for HEAD)';
    };
  });

  body.querySelector('#wt-browse').onclick = async () => {
    const r = await gs.selectFolder('Choose a folder for the new worktree');
    if (r && r.ok) body.querySelector('#wt-path').value = r.data;
  };

  // Typing a branch name suggests a matching folder, which is nearly always what people
  // want and saves a trip to the browse dialog.
  const pathInput = body.querySelector('#wt-path');
  body.querySelector('#wt-newbranch').oninput = (e) => {
    if (pathInput.dataset.touched) return;
    const slug = e.target.value.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
    pathInput.value = slug ? `${(state.repo.path || '').replace(/[\\/]+$/, '')}-${slug}` : suggestion;
  };
  pathInput.oninput = () => { pathInput.dataset.touched = '1'; };

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-medieval primary';
  addBtn.innerHTML = '<span class="btn-icon">+</span> Create Worktree';
  addBtn.onclick = async () => {
    const mode = (body.querySelector('input[name="wt-mode"]:checked') || {}).value || 'new';
    const target = body.querySelector('#wt-path').value.trim();
    if (!target) { showToast('Choose a folder for the worktree', 'error'); return; }

    const opts = { path: target };
    if (mode === 'new') {
      const name = body.querySelector('#wt-newbranch').value.trim();
      if (!name) { showToast('Name the new branch', 'error'); return; }
      opts.newBranch = name;
      const ref = body.querySelector('#wt-ref').value.trim();
      if (ref) opts.ref = ref;
    } else if (mode === 'existing') {
      const b = body.querySelector('#wt-existing').value;
      if (!b) { showToast('No branch available — every one is already checked out somewhere.', 'error', 6000); return; }
      opts.ref = b;
    } else {
      opts.detach = true;
      const ref = body.querySelector('#wt-ref').value.trim();
      if (!ref) { showToast('Which commit should the detached worktree point at?', 'error'); return; }
      opts.ref = ref;
    }

    modal.hide();
    const r = await withLoading('Creating worktree', () => gs.worktreeAdd(opts));
    if (!handleResult(r, 'Worktree created')) return;
    await refreshWorktrees();
    // Offer to jump straight there — creating one and staying put is the rarer intent.
    const go = await modal.confirm({
      title: 'Worktree Created',
      message: `Created at:\n${r.data.path}\n\nOpen it now? The current worktree stays exactly as it is.`,
      confirmText: 'Open It',
      cancelText: 'Stay Here'
    });
    if (go) await openRepoByPath(r.data.path);
  };

  modal.show({ title: '⌂ New Worktree', body, footer: [cancelBtn, addBtn] });
}

// Header buttons
(() => {
  const add = document.getElementById('worktree-add-btn');
  if (add) add.onclick = (e) => { e.stopPropagation(); showAddWorktreeDialog(); };
  const prune = document.getElementById('worktree-prune-btn');
  if (prune) prune.onclick = (e) => { e.stopPropagation(); pruneWorktrees(); };
})();
