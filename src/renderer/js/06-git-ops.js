// GIT OPERATIONS — Wrappers
// ============================================
async function stageFiles(files) {
  const r = await gs.stage(files);
  if (handleResult(r)) {
    state.multiSelected.clear();
    await refreshStatus();
  }
}

async function unstageFiles(files) {
  const r = await gs.unstage(files);
  if (handleResult(r)) {
    state.multiSelected.clear();
    await refreshStatus();
  }
}

async function discardFiles(files) {
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return;

  // Detect if any are untracked — for those, "discard" means delete from disk
  const untrackedPaths = new Set();
  state.unstagedFiles.forEach(f => {
    if (f.status === 'untracked' && list.includes(f.path)) untrackedPaths.add(f.path);
  });
  const hasUntracked = untrackedPaths.size > 0;
  const hasTracked = list.some(p => !untrackedPaths.has(p));

  let title, message;
  if (list.length === 1) {
    title = hasUntracked ? 'Delete Untracked File' : 'Discard Changes';
    message = hasUntracked
      ? `Permanently delete "${list[0]}" from disk? This cannot be undone.`
      : `Permanently discard changes to "${list[0]}"? This cannot be undone.`;
  } else {
    title = `Discard / Delete (${list.length} files)`;
    const preview = list.slice(0, 8).join('\n') + (list.length > 8 ? `\n…and ${list.length - 8} more` : '');
    if (hasUntracked && hasTracked) {
      message = `${untrackedPaths.size} untracked file(s) will be deleted from disk, and changes to ${list.length - untrackedPaths.size} tracked file(s) will be discarded. This cannot be undone.\n\n${preview}`;
    } else if (hasUntracked) {
      message = `${list.length} untracked files will be deleted from disk. This cannot be undone.\n\n${preview}`;
    } else {
      message = `Permanently discard changes to ${list.length} files? This cannot be undone.\n\n${preview}`;
    }
  }

  const confirmed = await modal.confirm({
    title,
    message,
    danger: true,
    confirmText: hasUntracked && !hasTracked ? 'Delete' : 'Discard'
  });
  if (!confirmed) return;
  const r = await gs.discard(list);
  if (handleResult(r, list.length === 1 ? 'Done' : `Done — ${list.length} files`)) {
    state.multiSelected.clear();
    await refreshStatus();
  }
}

async function commitChanges() {
  const summary = $('#commit-summary').value.trim();
  const description = $('#commit-description').value.trim();
  if (!summary) {
    showToast('Summary required', 'error');
    $('#commit-summary').focus();
    return;
  }

  const stagedCount = $$('#staged-files .file-item').length;
  if (stagedCount === 0) {
    showToast('Nothing staged. Stage changes first.', 'error');
    return;
  }

  const r = await withLoading('Committing', () => gs.commit({ message: summary, description }));
  if (handleResult(r, 'Deed inscribed')) {
    $('#commit-summary').value = '';
    $('#commit-description').value = '';
    await refreshAll();
  }
}

// Marker used in stash messages so we can find auto-stashes bound to a branch.
// Format: "[GitGood auto] on <branch-name>"
const AUTO_STASH_MARKER = '[GitGood auto] on ';
// Legacy marker from when the app was named GitSouls — still matched on restore so
// existing auto-stashes aren't orphaned after the rename.
const AUTO_STASH_MARKER_LEGACY = '[GitSouls auto] on ';
function autoStashMarkerFor(branch) { return AUTO_STASH_MARKER + branch; }

// Safe checkout for a local branch. If the working tree has uncommitted changes,
// prompts the user to: Stash & Switch / Discard & Switch / Cancel.
// After successful switch, looks for auto-stashes bound to the new branch and
// offers to restore them.
async function checkoutBranch(name) {
  if (!name) return;
  // Checking out a named branch is a deliberate move onto a branch — forget any
  // remembered detached-HEAD origin so a stale "return to" target doesn't linger.
  state.detachedFrom = null;
  // Don't bother prompting if there are no changes
  const hasChanges = state.status && (state.status.files || []).length > 0;
  if (!hasChanges) {
    const r = await withLoading('Checking out ' + name, () => gs.checkoutSafe({ branch: name }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
    if (r.data && r.data.switched) {
      showToast(`Checked out ${name}`, 'success');
      await refreshAll();
      await maybeOfferAutoStashRestore(name);
    }
    return;
  }
  // Has changes — go through the safe flow
  await promptCheckoutWithDirty(name, /*isRemoteSetup*/ null);
}

// Checkout a specific commit (detached HEAD). Remembers the branch we left so the
// user can return to it with one click via the detached-HEAD banner.
async function checkoutCommit(hash) {
  if (!hash) return;
  const shortHash = hash.slice(0, 7);

  // Remember where we came from. Read a FRESH status so we never rely on a stale
  // state.status. Prefer the branch reported by status; if that's unavailable, fall
  // back to the local branches' current. Only record when we're NOT already detached.
  let originBranch = null;
  let freshHasChanges = false;
  try {
    const freshStatus = await gs.status();
    if (freshStatus.ok) {
      const st = freshStatus.data;
      freshHasChanges = (st.files || []).length > 0;
      const onBranch = st && !st.detached && st.current && st.current !== 'HEAD';
      if (onBranch) originBranch = st.current;
    }
  } catch (e) { /* ignore */ }
  // Secondary source: the local branch list's current marker.
  if (!originBranch) {
    const lc = state.branches && state.branches.local && state.branches.local.current;
    if (lc && lc !== 'HEAD') originBranch = lc;
  }
  if (originBranch) {
    state.detachedFrom = originBranch;
  }

  const hasChanges = freshHasChanges || (state.status && (state.status.files || []).length > 0);
  if (hasChanges) {
    const choice = await modal.confirm({
      title: 'Uncommitted Changes',
      message: `You have uncommitted changes. Checking out ${shortHash} will move HEAD. Auto-stash your changes first?`,
      confirmText: 'Stash & Checkout',
      cancelText: 'Cancel'
    });
    if (!choice) return;
    const r = await withLoading(`Checking out ${shortHash}`, () => gs.checkoutSafe({ branch: hash, autoStashAll: true }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  } else {
    const r = await withLoading(`Checking out ${shortHash}`, () => gs.checkoutSafe({ branch: hash }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  }
  showToast(`Checked out commit ${shortHash} (detached HEAD)`, 'success');
  await refreshAll();
}

// Return from a detached HEAD back to the branch we started on (or a default branch).
async function returnToBranch() {
  const target = state.detachedFrom || guessDefaultBranch();
  if (!target) {
    showToast('No branch to return to', 'error');
    return;
  }
  const hasChanges = state.status && (state.status.files || []).length > 0;
  if (hasChanges) {
    const choice = await modal.confirm({
      title: 'Uncommitted Changes',
      message: `You have uncommitted changes at this commit. Auto-stash them and return to “${target}”?`,
      confirmText: 'Stash & Return',
      cancelText: 'Cancel'
    });
    if (!choice) return;
    const r = await withLoading(`Returning to ${target}`, () => gs.checkoutSafe({ branch: target, autoStashAll: true }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  } else {
    const r = await withLoading(`Returning to ${target}`, () => gs.checkoutSafe({ branch: target }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  }
  state.detachedFrom = null;
  showToast(`Returned to ${target}`, 'success');
  await refreshAll();
  await maybeOfferAutoStashRestore(target);
}

// Same logic but for a remote branch: creates a local tracking branch.
async function checkoutRemoteBranch(remoteBranch, localName) {
  const hasChanges = state.status && (state.status.files || []).length > 0;
  if (!hasChanges) {
    const r = await withLoading('Checking out ' + localName, () => gs.rawCommand(['checkout', '-b', localName, remoteBranch]));
    if (!handleResult(r, `Checked out ${localName}`)) return;
    await refreshAll();
    await maybeOfferAutoStashRestore(localName);
    return;
  }
  // Dirty tree — use the same prompt but route to the remote-checkout flow on confirm
  await promptCheckoutWithDirty(localName, { remoteBranch, localName });
}

// Show the stash-or-discard prompt. Routes to the appropriate checkout backend on confirm.
async function promptCheckoutWithDirty(targetBranch, remoteSetup) {
  const status = state.status;
  const fromBranch = (status && status.current) || 'current branch';
  const fileCount = (status && status.files) ? status.files.length : 0;
  const filesPreview = (status && status.files) ? status.files.slice(0, 10).map(f => f.path) : [];

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Switching from <strong>${escapeHtml(fromBranch)}</strong> to <strong class="text-red">${escapeHtml(targetBranch)}</strong>, but thy working tree hath <strong>${fileCount}</strong> uncommitted change${fileCount === 1 ? '' : 's'}.</p>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);padding:8px;max-height:140px;overflow-y:auto;margin-bottom:14px">
      ${filesPreview.map(p => escapeHtml(p)).join('<br>')}
      ${fileCount > filesPreview.length ? `<br><span class="text-muted">…and ${fileCount - filesPreview.length} more</span>` : ''}
    </div>
    <p class="modal-text">Choose thy course:</p>
    <div class="merge-strategies">
      <label class="merge-strategy selected">
        <input type="radio" name="checkout-mode" value="stash" checked />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">⚿ Stash & Switch (recommended)</div>
          <div class="merge-strategy-desc">Save thy changes to a stash bound to <strong>${escapeHtml(fromBranch)}</strong> (including untracked files). When thou returnest to this banner, the stash shall be offered for restoration.</div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="checkout-mode" value="discard" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">✕ Discard & Switch ⚠</div>
          <div class="merge-strategy-desc">Permanently abandon all uncommitted changes (including untracked files) before switching. <strong>Cannot be undone.</strong></div>
        </div>
      </label>
    </div>
  `;

  body.querySelectorAll('.merge-strategy').forEach(card => {
    card.onclick = () => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
      body.querySelectorAll('.merge-strategy').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    };
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary';
  okBtn.innerHTML = '<span class="btn-icon">⑂</span> Switch';
  okBtn.onclick = async () => {
    const mode = body.querySelector('input[name="checkout-mode"]:checked').value;
    modal.hide();

    if (mode === 'discard') {
      const sure = await modal.confirm({
        title: 'Confirm Discard',
        message: 'All uncommitted changes (including untracked files) will be permanently lost. Continue?',
        danger: true, confirmText: 'Yes, discard'
      });
      if (!sure) return;
    }

    if (remoteSetup) {
      // For remote-branch checkout we need to handle stash/discard manually,
      // then run our remote checkout (-b localName remoteBranch).
      if (mode === 'stash') {
        const stashMsg = autoStashMarkerFor(fromBranch);
        // Drop any existing auto-stash bound to this branch first so repeated
        // checkouts don't accumulate duplicate stashes.
        try { await gs.dropAutoStashFor(fromBranch); } catch (e) { /* non-fatal */ }
        const sr = await withLoading('Stashing', () => gs.stash({ message: stashMsg, includeUntracked: true }));
        if (!sr.ok) { showToast('Stash failed: ' + sr.error, 'error', 6000); return; }
      } else if (mode === 'discard') {
        const dr = await gs.rawCommand(['reset', '--hard', 'HEAD']);
        if (!dr.ok) { showToast('Reset failed: ' + dr.error, 'error', 6000); return; }
        const cr = await gs.rawCommand(['clean', '-fd']);
        if (!cr.ok) { showToast('Clean failed: ' + cr.error, 'error', 6000); return; }
      }
      const r = await withLoading('Checking out ' + remoteSetup.localName, () => gs.rawCommand(['checkout', '-b', remoteSetup.localName, remoteSetup.remoteBranch]));
      if (!handleResult(r, `Checked out ${remoteSetup.localName}`)) return;
      await refreshAll();
      if (mode === 'stash') showToast('Stashed and switched', 'success');
      await maybeOfferAutoStashRestore(remoteSetup.localName);
    } else {
      // Regular local branch — use the safe-checkout backend with the right flag
      const opts = { branch: targetBranch };
      if (mode === 'stash') opts.autoStashAll = true;
      else if (mode === 'discard') opts.discardAll = true;
      const r = await withLoading(`Switching to ${targetBranch}`, () => gs.checkoutSafe(opts));
      if (!r.ok) { showToast(r.error, 'error', 6000); return; }
      if (r.data && r.data.switched) {
        showToast(mode === 'stash' ? 'Stashed and switched' : 'Switched', 'success');
        await refreshAll();
        await maybeOfferAutoStashRestore(targetBranch);
      }
    }
  };

  modal.show({ title: 'Uncommitted Changes', body, footer: [cancelBtn, okBtn] });
}

// After arriving at a branch, look for auto-stashes bound to it and offer restore.
async function maybeOfferAutoStashRestore(branch) {
  if (!branch) return;
  // Search the current marker, then fall back to the legacy GitSouls marker.
  let r = await gs.stashFindByPrefix(autoStashMarkerFor(branch));
  let stashes = (r.ok && r.data) ? r.data : [];
  if (!stashes.length) {
    const legacy = await gs.stashFindByPrefix(AUTO_STASH_MARKER_LEGACY + branch);
    if (legacy.ok && legacy.data && legacy.data.length) stashes = legacy.data;
  }
  if (!stashes.length) return;
  // Show the most recent (lowest index) and offer restore-all
  const body = document.createElement('div');
  const rowsHtml = stashes.map(s => `
    <div class="merge-incoming-row">
      <span class="text-red text-mono">${escapeHtml(s.ref)}</span>
      <span>${escapeHtml(s.message)}</span>
      <span class="text-muted text-mono">${escapeHtml(s.date ? new Date(s.date).toLocaleString() : '')}</span>
    </div>
  `).join('');

  body.innerHTML = `
    <p class="modal-text">${stashes.length} auto-stash${stashes.length === 1 ? '' : 'es'} bound to <strong class="text-red">${escapeHtml(branch)}</strong> ${stashes.length === 1 ? 'was' : 'were'} found. Restore?</p>
    <div class="merge-incoming">${rowsHtml}</div>
    <p class="modal-text text-muted" style="font-size:12px">"Pop" applies the most recent stash and removes it from the stash list. "Apply" keeps the stash entry around.</p>
  `;

  const laterBtn = document.createElement('button');
  laterBtn.className = 'btn-medieval'; laterBtn.textContent = 'Not Now';
  laterBtn.onclick = () => modal.hide();

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-medieval'; applyBtn.innerHTML = '<span class="btn-icon">⌥</span> Apply Latest';
  applyBtn.onclick = async () => {
    modal.hide();
    // Apply the newest auto-stash (lowest index)
    const target = stashes[0];
    const r = await withLoading('Applying auto-stash', () => gs.stashApply(target.index));
    if (handleResult(r, 'Auto-stash applied')) await refreshAll();
  };

  const popBtn = document.createElement('button');
  popBtn.className = 'btn-medieval primary'; popBtn.innerHTML = '<span class="btn-icon">⌃</span> Pop Latest';
  popBtn.onclick = async () => {
    modal.hide();
    const target = stashes[0];
    const r = await withLoading('Popping auto-stash', () => gs.stashPop(target.index));
    if (handleResult(r, 'Auto-stash restored')) await refreshAll();
  };

  modal.show({ title: 'Restore Auto-Stash', body, footer: [laterBtn, applyBtn, popBtn] });
}

async function mergeBranch(name) {
  // Use the smart merge dialog
  await showSmartMergeDialog(name);
}

async function deleteBranch(name, force) {
  const confirmed = await modal.confirm({
    title: force ? 'Force Delete Branch' : 'Delete Branch',
    message: force
      ? `Force delete branch "${name}"? Unmerged commits will be lost.`
      : `Delete branch "${name}"?`,
    danger: true,
    confirmText: force ? 'Force Delete' : 'Delete'
  });
  if (!confirmed) return;
  const r = await gs.deleteBranch({ name, force });
  if (handleResult(r, `Deleted ${name}`)) {
    await refreshBranches();
  }
}

async function removeRemote(name) {
  const confirmed = await modal.confirm({
    title: 'Remove Remote',
    message: `Remove the remote "${name}"?`,
    danger: true,
    confirmText: 'Remove'
  });
  if (!confirmed) return;
  const r = await gs.removeRemote(name);
  if (handleResult(r, `Removed ${name}`)) {
    await refreshRemotes();
  }
}

async function stashApply(i) {
  const r = await gs.stashApply(i);
  if (handleResult(r, 'Stash applied')) {
    await refreshAll();
  }
}

async function stashPop(i) {
  const r = await gs.stashPop(i);
  if (handleResult(r, 'Stash popped')) {
    await refreshAll();
  }
}

async function stashDrop(i) {
  const confirmed = await modal.confirm({
    title: 'Drop Stash',
    message: `Permanently drop stash@{${i}}? This cannot be undone.`,
    danger: true,
    confirmText: 'Drop'
  });
  if (!confirmed) return;
  const r = await gs.stashDrop(i);
  if (handleResult(r, 'Stash dropped')) {
    await refreshStashes();
  }
}

// ============================================
// STASH BROWSER — selective unstash per file
// ============================================
async function showStashBrowser(stashIndex) {
  // Fetch file list of this stash
  const stash = state.stashes.find(s => s.index === stashIndex) || state.stashes[stashIndex];
  const listResult = await withLoading('Reading stash', () => gs.stashFiles(stashIndex));
  if (!listResult.ok) {
    showToast('Failed to read stash: ' + listResult.error, 'error', 6000);
    return;
  }
  const { tracked, untracked } = listResult.data;
  const allFiles = [
    ...tracked.map(f => ({ ...f })),
    ...untracked.map(f => ({ ...f }))
  ];

  if (!allFiles.length) {
    showToast('Stash is empty (no file changes)', 'error');
    return;
  }

  // Track selected file paths in a Set
  const selected = new Set(allFiles.map(f => f.path)); // default: all selected

  // Status letter map
  const letterFor = (status) => ({
    'A': 'A', 'M': 'M', 'D': 'D', 'R': 'R', 'C': 'R', 'T': 'T', '?': 'U'
  })[status] || 'M';
  const statusClass = (status) => ({
    'A': 'added', 'M': 'modified', 'D': 'deleted', 'R': 'renamed',
    'C': 'renamed', 'T': 'modified', '?': 'untracked'
  })[status] || 'modified';

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">
      <strong class="text-red">${escapeHtml(stash ? stash.ref : `stash@{${stashIndex}}`)}</strong>
      &nbsp;·&nbsp; ${escapeHtml(stash ? stash.message : '')}
    </p>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
      <span class="branches-label" style="margin:0">⚜ Files in this stash (<span id="sb-count">${selected.size}</span>/${allFiles.length} selected)</span>
      <div style="display:flex;gap:6px">
        <button class="mini-btn" id="sb-all">Select All</button>
        <button class="mini-btn" id="sb-none">Select None</button>
      </div>
    </div>
    <ul class="file-list" id="sb-files" style="max-height:340px;overflow-y:auto;border:1px solid var(--border)">
      ${allFiles.map(f => `
        <li class="file-item multi-selected" data-path="${escapeHtml(f.path)}">
          <div class="file-checkbox" title="Select"></div>
          <div class="file-status ${statusClass(f.status)}">${letterFor(f.status)}</div>
          <div class="file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
          <div class="file-actions">
            ${f.kind === 'untracked' ? '<span style="font-size:10px;color:var(--muted-text);font-family:var(--font-mono)">untracked</span>' : ''}
          </div>
        </li>
      `).join('')}
    </ul>
    <label class="modal-checkbox" style="margin-top:14px">
      <input type="checkbox" id="sb-drop-after" />
      Drop the stash after restoring (only if restoring all files)
    </label>
  `;

  // Wire up row selection (click = toggle)
  body.querySelectorAll('#sb-files .file-item').forEach(li => {
    const path = li.dataset.path;
    li.onclick = () => {
      if (selected.has(path)) {
        selected.delete(path);
        li.classList.remove('multi-selected');
      } else {
        selected.add(path);
        li.classList.add('multi-selected');
      }
      body.querySelector('#sb-count').textContent = selected.size;
      syncDropCheckbox();
    };
  });

  // Select all / none
  body.querySelector('#sb-all').onclick = () => {
    allFiles.forEach(f => selected.add(f.path));
    body.querySelectorAll('#sb-files .file-item').forEach(li => li.classList.add('multi-selected'));
    body.querySelector('#sb-count').textContent = selected.size;
    syncDropCheckbox();
  };
  body.querySelector('#sb-none').onclick = () => {
    selected.clear();
    body.querySelectorAll('#sb-files .file-item').forEach(li => li.classList.remove('multi-selected'));
    body.querySelector('#sb-count').textContent = selected.size;
    syncDropCheckbox();
  };

  function syncDropCheckbox() {
    const cb = body.querySelector('#sb-drop-after');
    if (selected.size < allFiles.length) {
      cb.checked = false;
      cb.disabled = true;
      cb.parentElement.style.opacity = '0.4';
    } else {
      cb.disabled = false;
      cb.parentElement.style.opacity = '1';
    }
  }
  syncDropCheckbox();

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Close';
  cancelBtn.onclick = () => modal.hide();

  const popAllBtn = document.createElement('button');
  popAllBtn.className = 'btn-medieval';
  popAllBtn.innerHTML = '<span class="btn-icon">⌃</span> Pop All';
  popAllBtn.title = 'Apply all files and remove the stash';
  popAllBtn.onclick = async () => {
    modal.hide();
    const r = await withLoading('Popping stash', () => gs.stashPop(stashIndex));
    if (handleResult(r, 'Stash popped')) await refreshAll();
  };

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-medieval primary';
  applyBtn.innerHTML = '<span class="btn-icon">⌥</span> Restore Selected';
  applyBtn.onclick = async () => {
    const paths = [...selected];
    if (!paths.length) { showToast('No files selected', 'error'); return; }
    const drop = body.querySelector('#sb-drop-after').checked && paths.length === allFiles.length;
    modal.hide();
    const r = await withLoading(`Restoring ${paths.length} file${paths.length === 1 ? '' : 's'}`,
      () => gs.stashApplyFiles({ index: stashIndex, paths, drop }));
    if (handleResult(r, drop ? 'Restored and dropped stash' : `Restored ${paths.length} file${paths.length === 1 ? '' : 's'}`)) {
      await refreshAll();
    }
  };

  modal.show({
    title: 'Stash Browser',
    body,
    footer: [cancelBtn, popAllBtn, applyBtn]
  });
}

// ============================================
// TOOLBAR ACTIONS
// ============================================
// Sync split-button: the dropdown reveals Fetch / Pull / Push.
const syncDropdown = $('#sync-dropdown');
const syncMenu = $('#sync-menu');
function closeSyncMenu() { if (syncMenu) syncMenu.classList.add('hidden'); }
function toggleSyncMenu() { if (syncMenu) syncMenu.classList.toggle('hidden'); }
if ($('#btn-sync')) $('#btn-sync').onclick = (e) => { e.stopPropagation(); toggleSyncMenu(); };
// Close the menu when clicking elsewhere or pressing Esc
document.addEventListener('click', (e) => {
  if (syncDropdown && !syncDropdown.contains(e.target)) closeSyncMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSyncMenu(); });

$('#btn-fetch').onclick = async () => {
  closeSyncMenu();
  const r = await withLoading('Fetching', () => gs.fetch());
  if (handleResult(r, 'Fetched from remote')) {
    await refreshAll();
  }
};

$('#btn-pull').onclick = async () => {
  closeSyncMenu();
  const r = await withLoading('Pulling', () => gs.pull());
  if (handleResult(r, 'Pulled from remote')) {
    await refreshAll();
  }
};

$('#btn-push').onclick = async () => {
  closeSyncMenu();
  const r = await withLoading('Pushing', () => gs.push());
  if (!r.ok && /no upstream|has no upstream branch|set-upstream/i.test(r.error || '')) {
    // Offer set-upstream
    const branch = state.status && state.status.current;
    const confirmed = await modal.confirm({
      title: 'No Upstream Branch',
      message: `Branch "${branch}" has no upstream. Push and set upstream to "origin/${branch}"?`,
      confirmText: 'Push & Set Upstream'
    });
    if (!confirmed) return;
    const r2 = await withLoading('Pushing', () => gs.push({ setUpstream: true, remote: 'origin', branch }));
    if (handleResult(r2, 'Pushed and upstream set')) {
      await refreshAll();
    }
    return;
  }
  if (handleResult(r, 'Pushed to remote')) {
    await refreshAll();
  }
};

$('#btn-refresh').onclick = async () => {
  await refreshAll();
  showToast('Refreshed', 'success', 1500);
};

$('#btn-terminal').onclick = () => openTerminal();

$('#btn-branch').onclick = () => {
  // Switch to the Branches tab
  const tab = document.querySelector('.tab[data-tab="branches"]');
  if (tab) tab.click();
};
$('#btn-stash').onclick = () => showStashMenu();

$('#btn-open-folder').onclick = () => {
  if (state.repo) gs.openInExplorer(state.repo.path);
};

$('#btn-close-repo').onclick = async () => {
  await gs.closeRepo();
  state.repo = null;
  state.status = null;
  state.selectedCommit = null;
  state.selectedFile = null;
  clearCommitCache();
  state.collapsedCommits = null;
  state.graphCollapsed = false;
  state.graphFilter = "";
  state.historyFilter = "";
  state.detachedFrom = null;
  _diskState.loaded = false;
  _diskState.lastData = null;
  showWelcome();
};

// ============================================
// BRANCH & STASH MENUS (modals)
// ============================================
function showBranchMenu() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="modal-field">
      <label>New Branch Name</label>
      <input class="modal-input" id="new-branch-name" placeholder="feature/holy-grail" />
    </div>
    <div class="modal-checkbox">
      <input type="checkbox" id="checkout-after" checked />
      <label for="checkout-after">Checkout after creation</label>
    </div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const createBtn = document.createElement('button');
  createBtn.className = 'btn-medieval primary';
  createBtn.innerHTML = '<span class="btn-icon">⑂</span> Create';
  createBtn.onclick = async () => {
    const name = $('#new-branch-name').value.trim();
    const checkout = $('#checkout-after').checked;
    if (!name) { showToast('Name required', 'error'); return; }
    modal.hide();
    const r = await gs.createBranch({ name, checkout });
    if (handleResult(r, `Branch ${name} forged`)) {
      await refreshAll();
    }
  };
  modal.show({ title: 'New Branch', body, footer: [cancelBtn, createBtn] });
}

function showCreateBranchDialog(fromHash) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Create a new branch from commit <code class="text-mono text-red">${escapeHtml(fromHash.slice(0,7))}</code></p>
    <div class="modal-field">
      <label>Branch Name</label>
      <input class="modal-input" id="new-branch-name" placeholder="branch-name" />
    </div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const createBtn = document.createElement('button');
  createBtn.className = 'btn-medieval primary';
  createBtn.textContent = 'Create';
  createBtn.onclick = async () => {
    const name = $('#new-branch-name').value.trim();
    if (!name) { showToast('Name required', 'error'); return; }
    modal.hide();
    const r = await gs.rawCommand(['branch', name, fromHash]);
    if (handleResult(r, `Branch ${name} created`)) {
      await refreshBranches();
    }
  };
  modal.show({ title: 'Create Branch', body, footer: [cancelBtn, createBtn] });
}

// Show the stash creation dialog. opts.paths = optional array of paths to stash (else: all).
function showStashMenu(opts) {
  opts = opts || {};
  const paths = Array.isArray(opts.paths) ? opts.paths : null;
  const scope = paths
    ? (paths.length === 1 ? `1 file (${paths[0]})` : `${paths.length} files`)
    : 'all changes (staged + unstaged + untracked)';

  // Detect whether untracked files exist among the targeted paths
  const willStashUntracked = (() => {
    if (paths) {
      const untrackedSet = new Set(state.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path));
      return paths.some(p => untrackedSet.has(p));
    }
    return state.unstagedFiles.some(f => f.status === 'untracked');
  })();

  const pathsPreview = paths
    ? `<div class="modal-field"><label>Files</label><div style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);padding:8px;max-height:120px;overflow-y:auto">${paths.slice(0, 30).map(p => escapeHtml(p)).join('<br>')}${paths.length > 30 ? `<br><span class="text-muted">…and ${paths.length - 30} more</span>` : ''}</div></div>`
    : '';

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Stash <strong class="text-red">${escapeHtml(scope)}</strong> for safekeeping.</p>
    ${pathsPreview}
    <div class="modal-field">
      <label>Stash Message (optional)</label>
      <input class="modal-input" id="stash-msg" placeholder="WIP on feature" />
    </div>
    <label class="modal-checkbox">
      <input type="checkbox" id="stash-untracked" ${willStashUntracked ? 'checked' : ''} />
      Include untracked files
    </label>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const stashBtn = document.createElement('button');
  stashBtn.className = 'btn-medieval primary';
  stashBtn.innerHTML = '<span class="btn-icon">⚿</span> Stash';
  stashBtn.onclick = async () => {
    const msg = $('#stash-msg').value.trim();
    const includeUntracked = $('#stash-untracked').checked;
    modal.hide();
    const r = await withLoading('Stashing', () => gs.stash({
      message: msg || undefined,
      paths: paths || undefined,
      includeUntracked
    }));
    if (handleResult(r, paths ? `Stashed ${paths.length} file${paths.length === 1 ? '' : 's'}` : 'Stashed')) {
      state.multiSelected.clear();
      await refreshAll();
    }
  };
  modal.show({ title: paths ? 'Stash Selected Files' : 'Stash All Changes', body, footer: [cancelBtn, stashBtn] });
}

// ============================================
// COMMIT BUTTON & STAGE/UNSTAGE ALL
// ============================================
$('#commit-btn').onclick = () => commitChanges();
$('#commit-summary').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitChanges();
});

$('#stage-all-btn').onclick = async () => {
  const r = await gs.stageAll();
  if (handleResult(r)) await refreshStatus();
};

$('#unstage-all-btn').onclick = async () => {
  const r = await gs.unstageAll();
  if (handleResult(r)) await refreshStatus();
};

// ============================================
// CHANGES SEARCH
// ============================================
(() => {
  const input = $('#changes-search');
  const clearBtn = $('#changes-search-clear');
  if (!input) return;
  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearBtn.classList.toggle('visible', !!input.value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = input.value;
      renderChanges();
    }, 100);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.searchQuery = '';
      clearBtn.classList.remove('visible');
      renderChanges();
    }
  });
  clearBtn.onclick = () => {
    input.value = '';
    state.searchQuery = '';
    clearBtn.classList.remove('visible');
    renderChanges();
    input.focus();
  };
})();

// ============================================
// SELECTION BAR ACTIONS
// ============================================
function getSelectedPaths(filterPrefix) {
  return [...state.multiSelected]
    .filter(k => !filterPrefix || k.startsWith(filterPrefix))
    .map(k => k.split(':').slice(1).join(':'));
}

$('#sel-stage').onclick = () => {
  const paths = getSelectedPaths('unstaged:');
  if (paths.length) stageFiles(paths);
};
$('#sel-unstage').onclick = () => {
  const paths = getSelectedPaths('staged:');
  if (paths.length) unstageFiles(paths);
};
const _selStashBtn = $('#sel-stash');
if (_selStashBtn) _selStashBtn.onclick = () => {
  const paths = getSelectedPaths('unstaged:');
  if (paths.length) showStashMenu({ paths });
};
$('#sel-discard').onclick = () => {
  const paths = getSelectedPaths('unstaged:');
  if (paths.length) discardFiles(paths);
};
$('#sel-clear').onclick = () => {
  state.multiSelected.clear();
  renderChanges();
};

// Section header "Stash All Unstaged" button
const _stashUnstagedBtn = $('#stash-unstaged-btn');
if (_stashUnstagedBtn) _stashUnstagedBtn.onclick = () => {
  // Stash all unstaged file paths
  const paths = state.unstagedFiles.map(f => f.path);
  if (!paths.length) { showToast('No unstaged changes', 'error'); return; }
  showStashMenu({ paths });
};

// ============================================
// AUTO-REFRESH ON WINDOW FOCUS
// ============================================
(() => {
  let focusRefreshTimer = null;
  let lastRefresh = 0;
  function scheduleFocusRefresh() {
    // Only refresh if a repo is open
    if (!state.repo) return;
    // Don't refresh if a modal is open (could disrupt user input)
    if (!$('#modal-overlay').classList.contains('hidden')) return;
    // Don't yank focus or interrupt active typing in the commit fields or search
    const active = document.activeElement;
    if (active && (active.id === 'commit-summary' || active.id === 'commit-description' || active.id === 'changes-search')) {
      // Still refresh, but only the lists/log — we skip nothing, since renderChanges preserves the input
      // The render functions don't touch input values, so this is actually fine.
    }
    // Throttle: at most one auto-refresh every 1.5 seconds
    const now = Date.now();
    if (now - lastRefresh < 1500) return;
    lastRefresh = now;
    // Debounce slightly so we coalesce rapid focus/blur cycles
    clearTimeout(focusRefreshTimer);
    focusRefreshTimer = setTimeout(() => {
      refreshAll().catch(err => console.error('Auto-refresh failed:', err));
    }, 150);
  }
  // Listen to main-process event (window focused)
  if (gs.onWindowFocus) gs.onWindowFocus(scheduleFocusRefresh);
  // Fallback DOM event for in-window focus return
  window.addEventListener('focus', scheduleFocusRefresh);
  // Also when the tab/document becomes visible (e.g., after being hidden)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleFocusRefresh();
  });
})();

// ============================================
// TABS
// ============================================
$$('.tab').forEach(tab => {
  tab.onclick = () => {
    const target = tab.dataset.tab;
    state.currentTab = target;
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === target));
    // Lazy-load tab data on first visit and on switch
    if (target === 'graph') refreshGraph();
    else if (target === 'branches') renderBranchesTab();
    else if (target === 'history') renderHistory();
  };
});

// ============================================
// DIFF VIEW MODE TOGGLE (unified / split) — applies everywhere the diff is shown
// ============================================
// Restore saved mode before any diff renders.
try {
  const saved = localStorage.getItem('gitgood:diff-mode');
  if (saved === 'split' || saved === 'unified') state.diffMode = saved;
} catch (err) {}

function setDiffMode(mode) {
  if (mode !== 'unified' && mode !== 'split') return;
  if (mode === state.diffMode) return;
  state.diffMode = mode;
  try { localStorage.setItem('gitgood:diff-mode', mode); } catch (err) {}
  // Reflect on every toggle currently on screen.
  document.querySelectorAll('.diff-view-toggle .diff-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.diffmode === mode));

  // Re-render the Changes-tab diff (from memory) in the new mode.
  if (_lastDiff) {
    const el = document.getElementById('diff-content');
    if (el) {
      const prev = el.scrollTop;
      el.innerHTML = renderDiff(_lastDiff.text, _lastDiff.opts);
      el.scrollTop = prev;
    }
  }

  // For the Graph/History commit previews, re-render ONLY the currently-selected file's
  // diff in place — this preserves the selected file and the scroll positions instead of
  // rebuilding the whole detail pane (which reset to the first file).
  const graphDiff = document.getElementById('graph-diff-content');
  if (graphDiff && !rerenderActiveCommitFile(graphDiff) && state.selectedGraphHash) {
    const c = ((state.graph && state.graph.commits) || []).find(x => x.hash === state.selectedGraphHash);
    if (c) renderGraphDetail(c);
  }
  const histDiff = document.getElementById('hist-diff-content');
  if (histDiff && !rerenderActiveCommitFile(histDiff) && state.selectedCommit) {
    const d = (_historyDetailDiff && _historyDetailDiff.hash === state.selectedCommit.hash)
      ? _historyDetailDiff.details : null;
    renderHistoryDetail(state.selectedCommit, d);
  }
}

// One delegated listener handles every diff-view toggle (Changes pane + Graph/History
// detail headers), since those headers are re-created dynamically.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.diff-view-btn');
  if (!btn) return;
  setDiffMode(btn.dataset.diffmode);
});

// Reflect the restored mode on any static toggle present at load (the Changes header).
(() => {
  document.querySelectorAll('.diff-view-toggle .diff-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.diffmode === state.diffMode));
})();


// ============================================
// SIDEBAR TOGGLE (whole panel, horizontal) — frees width for the main content
// ============================================
const SIDEBAR_COLLAPSE_KEY = 'gitgood:sidebar-collapsed';
function setSidebarCollapsed(collapsed) {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  workspace.classList.toggle('sidebar-collapsed', collapsed);
  document.body.classList.toggle('sidebar-is-collapsed', collapsed);
  const btn = document.getElementById('sidebar-toggle');
  if (btn) btn.title = collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)';
  try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) {}
}
function toggleSidebar() {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  setSidebarCollapsed(!workspace.classList.contains('sidebar-collapsed'));
}
(() => {
  const btn = document.getElementById('sidebar-toggle');
  if (btn) btn.onclick = toggleSidebar;
  // Restore persisted state
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1'; } catch (e) {}
  if (collapsed) setSidebarCollapsed(true);
  // Keyboard shortcut: Ctrl/Cmd + B
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggleSidebar();
    }
  });
})();

