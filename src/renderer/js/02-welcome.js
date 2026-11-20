// WELCOME SCREEN
// ============================================
async function showWelcome() {
  $('#welcome-screen').classList.remove('hidden');
  $('#app-screen').classList.add('hidden');
  await loadRecentRepos();
}

// The left panel holds two lists — tabs still open (19-tabs.js) and recent repositories —
// and is hidden only when both are empty.
function updateWelcomePanelEmpty() {
  const panel = $('#welcome-recent');
  if (!panel) return;
  const hasRecent = !!$('#recent-list .recent-item');
  const hasTabs = !!$('#open-tabs-list .recent-item');
  panel.classList.toggle('is-empty', !hasRecent && !hasTabs);
  const recentTitle = $('#welcome-recent-title');
  if (recentTitle) recentTitle.classList.toggle('hidden', !hasRecent);
}

async function loadRecentRepos() {
  const result = await gs.getRecentRepos();
  const list = $('#recent-list');
  list.innerHTML = '';
  if (typeof renderWelcomeTabs === 'function') renderWelcomeTabs();
  if (!result.ok || !result.data || !result.data.length) {
    updateWelcomePanelEmpty();
    return;
  }
  result.data.forEach(p => {
    const item = document.createElement('button');
    item.className = 'recent-item';
    const parts = p.replace(/\\/g, '/').split('/');
    const name = parts[parts.length - 1];
    item.innerHTML = `
      <div class="recent-name">${escapeHtml(name)}</div>
      <div class="recent-path">${escapeHtml(p)}</div>
    `;
    item.onclick = () => openRepoByPath(p);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        { label: 'Open', icon: '📜', action: () => openRepoByPath(p) },
        { label: 'Copy path', icon: '⎘', action: () => copyText(p, 'Path copied') },
        'sep',
        { label: 'Remove from list', icon: '✗', danger: true, action: () => removeRecentRepo(p) },
        { label: 'Clear all recent', icon: '⌫', danger: true, action: () => clearRecentRepos() }
      ], e.pageX, e.pageY);
    };
    list.appendChild(item);
  });
  updateWelcomePanelEmpty();
}

// Remove a single repo from the recent list, then refresh the welcome list.
async function removeRecentRepo(p) {
  const r = await gs.removeRecentRepo(p);
  if (r && r.ok) {
    showToast('Removed from recent', 'success');
    await loadRecentRepos();
  } else {
    showToast((r && r.error) || 'Could not remove', 'error');
  }
}

// Clear the entire recent list (with confirmation).
async function clearRecentRepos() {
  const ok = await modal.confirm({
    title: 'Clear Recent Chronicles',
    message: 'Remove all repositories from the recent list? This does not delete anything on disk.',
    confirmText: 'Clear All',
    cancelText: 'Cancel'
  });
  if (!ok) return;
  const r = await gs.clearRecentRepos();
  if (r && r.ok) {
    showToast('Recent list cleared', 'success');
    await loadRecentRepos();
  }
}

$('#welcome-open').onclick = () => openRepoDialog();
$('#welcome-clone').onclick = () => showCloneDialog();
$('#welcome-init').onclick = () => showInitDialog();
const _sshBtn = $('#welcome-sshkey');
if (_sshBtn) _sshBtn.onclick = () => showSshKeyGenerator();

async function openRepoDialog() {
  const sel = await gs.selectDirectory();
  if (!sel.ok) return;
  await openRepoByPath(sel.data);
}

async function openRepoByPath(p) {
  // Switching away from a repository parks its view state on its tab first; opening a new
  // one has nothing to park. Both go through here (see 19-tabs.js).
  if (typeof saveActiveTabUi === 'function' && state.repo && state.repo.path !== p) saveActiveTabUi();
  const result = await withLoading('Opening repository', () => gs.openRepo(p));
  if (!result.ok) {
    showToast(result.error || 'Failed to open repository', 'error', 5000);
    return;
  }
  state.repo = result.data;
  if (typeof noteRepoOpened === 'function') noteRepoOpened(result.data);
  clearCommitCache();
  state.collapsedCommits = null;
  state.graphCompressed = false;
  state.expandedFolds = null;
  state.graphFilter = "";
  state.historyFilter = "";
  state.detachedFrom = null;
  state.remoteTags = null;          // the previous repo's remote tags mean nothing here
  state.remoteTagsRemote = null;
  { const gs1 = document.getElementById('graph-search'); if (gs1) gs1.value = '';
    const hs1 = document.getElementById('history-search'); if (hs1) hs1.value = ''; }
  _diskState.loaded = false;
  _diskState.lastData = null;
  clearDiskStale();
  $('#welcome-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  updateRepoInfo();
  // Block interaction behind the overlay until the full initial load completes, so the
  // user can't click into a half-rendered graph or changes list.
  // Signing config is per-repo (local config can override global) and cached verification
  // results belong to the repo they were read from.
  if (typeof resetSigningState === 'function') resetSigningState();
  // Forge data (host, token status, PR list, CI results) belongs to the repo we are leaving.
  if (typeof forgeReset === 'function') forgeReset();
  await withRepoOpen(`Opening “${result.data.name}”`, () => refreshAll());
  if (typeof initCommitSignToggle === 'function') initCommitSignToggle();
  // Put back whatever this tab was showing last time (filters, selected commit/file, which
  // centre tab). Runs after the load so every list it touches already holds real data.
  if (typeof restoreTabUi === 'function') await restoreTabUi(result.data.path);
  setStatus('Ready');
  showToast(`Opened "${result.data.name}"`, 'success');
  // Start watching the working tree and the background fetch for THIS repo. Done after
  // the initial load so the watcher can't fire a refresh into a half-built UI.
  if (typeof startRepoWatch === 'function') startRepoWatch();
}

// Initialize: branch name, whether to start on a real branch (an initial commit — git has
// no branches before one), and a .gitignore built from templates (lib/gitignore-templates.js
// in main; the renderer only ever sees ids, labels and the preview text).
async function showInitDialog() {
  const sel = await gs.selectFolder('Choose a folder for the new repository');
  if (!sel.ok) return;
  const folder = sel.data;
  const [inspR, prefR] = await Promise.all([gs.initInspect(folder), gs.getAppSettings()]);
  const info = (inspR && inspR.ok) ? inspR.data : { isRepo: false, hasGitignore: false, unityRoots: [], templates: [] };
  const prefs = (prefR && prefR.ok) ? prefR.data : {};

  if (info.isRepo) {
    const open = await modal.confirm({
      title: 'Already a Repository',
      message: `${folder}\nis already a git repository. Initializing would not change its branches. Open it instead?`,
      confirmText: 'Open'
    });
    if (open) await openRepoByPath(folder);
    return;
  }

  const bases = info.templates.filter(t => t.kind === 'base');
  const addons = info.templates.filter(t => t.kind === 'addon');
  const known = new Set(info.templates.map(t => t.id));
  // A Unity project in the folder makes Unity the obvious template, unless one was chosen last time.
  let base = known.has(prefs.initGitignoreBase) ? prefs.initGitignoreBase : 'none';
  if (base === 'none' && info.unityRoots.length) base = 'unity';
  const pickedAddons = new Set((prefs.initGitignoreAddons || []).filter(id => known.has(id)));

  const body = document.createElement('div');
  body.className = 'init-dialog';
  body.innerHTML = `
    <p class="modal-text">Create a new git repository at<br><strong class="text-mono">${escapeHtml(folder)}</strong></p>
    <div class="modal-field">
      <label>Branch name</label>
      <input class="modal-input" id="init-branch" value="${escapeHtml(prefs.defaultBranchName || 'main')}" placeholder="main" spellcheck="false" />
    </div>
    <label class="merge-smart-toggle">
      <input type="checkbox" id="init-commit" ${prefs.initWithBranch !== false ? 'checked' : ''} />
      <div class="merge-strategy-body">
        <div class="merge-strategy-title">Start on <span id="init-branch-echo"></span></div>
        <div class="merge-strategy-desc">Git has no branches until the first commit. This makes an initial commit holding only the .gitignore (or nothing), so the branch exists right away. Your other files stay uncommitted. The default is in Settings → Defaults.</div>
      </div>
    </label>
    <div class="modal-field">
      <label>.gitignore template</label>
      <select class="modal-input" id="init-gi-base">
        <option value="none">None</option>
        ${bases.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join('')}
      </select>
      <div class="init-gi-desc" id="init-gi-desc"></div>
    </div>
    <div class="modal-field">
      <label>Also ignore</label>
      <div class="init-gi-addons">
        ${addons.map(t => `
          <label class="init-gi-addon" title="${escapeHtml(t.description)}">
            <input type="checkbox" value="${escapeHtml(t.id)}" ${pickedAddons.has(t.id) ? 'checked' : ''} />
            <span>${escapeHtml(t.label)}</span>
          </label>`).join('')}
      </div>
    </div>
    <div class="init-gi-note" id="init-gi-note"></div>
    <details class="init-gi-preview">
      <summary>Preview .gitignore <span class="text-muted" id="init-gi-count"></span></summary>
      <pre id="init-gi-text"></pre>
    </details>
  `;

  const baseSel = body.querySelector('#init-gi-base');
  baseSel.value = base;
  const branchInput = body.querySelector('#init-branch');
  const echo = body.querySelector('#init-branch-echo');
  const syncEcho = () => { echo.textContent = branchInput.value.trim() || 'the default branch'; };
  branchInput.oninput = syncEcho;
  syncEcho();

  const chosenAddons = () => [...body.querySelectorAll('.init-gi-addon input:checked')].map(i => i.value);
  const describe = () => {
    const t = bases.find(b => b.id === baseSel.value);
    body.querySelector('#init-gi-desc').textContent = t ? t.description : '';
    const notes = [];
    if (baseSel.value === 'unity') {
      const roots = info.unityRoots;
      if (!roots.length) notes.push('No Unity project found here yet, so Library/, Temp/… are anchored at the repository root. Create the project directly in this folder.');
      else if (roots.length === 1 && roots[0] === '') notes.push('Unity project found at the folder root.');
      else notes.push(`Unity project${roots.length > 1 ? 's' : ''} found in ${roots.map(r => r + '/').join(', ')}. Library/, Temp/… are anchored there, not at the root.`);
    }
    if (info.hasGitignore) notes.push('This folder already has a .gitignore. It is kept, and only the patterns it lacks are appended.');
    const noteEl = body.querySelector('#init-gi-note');
    noteEl.textContent = notes.join(' ');
    noteEl.style.display = notes.length ? '' : 'none';
  };

  // Preview: newest request wins, so fast clicking never shows an older answer.
  let previewSeq = 0;
  const refreshPreview = async () => {
    const seq = ++previewSeq;
    const r = await gs.gitignorePreview({ folder, base: baseSel.value, addons: chosenAddons() });
    if (seq !== previewSeq) return;
    const pre = body.querySelector('#init-gi-text');
    const count = body.querySelector('#init-gi-count');
    if (!r || !r.ok) { pre.textContent = (r && r.error) || 'Preview failed'; count.textContent = ''; return; }
    pre.textContent = r.data.added ? r.data.text : (info.hasGitignore ? '(nothing to add: the existing .gitignore already has these patterns)' : '(no .gitignore will be written)');
    count.textContent = r.data.added ? `· ${r.data.added} pattern${r.data.added === 1 ? '' : 's'}` : '';
  };
  const onChange = () => { describe(); refreshPreview(); };
  baseSel.onchange = onChange;
  body.querySelectorAll('.init-gi-addon input').forEach(i => { i.onchange = onChange; });
  onChange();

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary'; okBtn.innerHTML = '<span class="btn-icon">⚒</span> Initialize';
  okBtn.onclick = async () => {
    const branch = branchInput.value.trim();
    const gitignore = { base: baseSel.value, addons: chosenAddons() };
    const initialCommit = body.querySelector('#init-commit').checked;
    modal.hide();
    // Remember the template choice: a Unity developer picks Unity every time.
    try { gs.setAppSettings({ initGitignoreBase: gitignore.base, initGitignoreAddons: gitignore.addons }); } catch (e) {}
    const result = await withLoading('Initializing repository',
      () => gs.initRepo({ path: folder, branch, initialCommit, gitignore }));
    if (!result.ok) {
      showToast(result.error, 'error', 6000);
      return;
    }
    // Same path as opening any repository: tab, state reset, watcher.
    await openRepoByPath(result.data.path);
    const d = result.data;
    const gi = d.gitignoreAdded ? ` with a .gitignore (${d.gitignoreAdded} patterns)` : '';
    if (d.commitError) {
      showToast(`Repository forged${gi}, but the initial commit failed: ${d.commitError}`, 'error', 10000);
    } else {
      showToast(d.committed ? `Repository forged on ${branch || 'the default branch'}${gi}` : `Repository forged${gi}`, 'success', 6000);
    }
  };
  modal.show({ title: 'Initialize Repository', body, footer: [cancelBtn, okBtn] });
}

// ============================================
// SSH KEY GENERATOR
// ============================================
async function showSshKeyGenerator() {
  // Fetch defaults (username, hostname, ~/.ssh path)
  const idR = await gs.sshDefaultIdentity();
  const ident = (idR && idR.ok) ? idR.data : { username: 'user', hostname: 'host', sshDir: '~/.ssh' };
  const defaultComment = `${ident.username}@${ident.hostname}`;

  // Track latest generated key in closure
  let lastKey = null;
  let showingPrivate = false;

  const body = document.createElement('div');
  body.className = 'ssh-key-gen';
  body.innerHTML = `
    <div class="skg-grid">
      <div class="skg-field">
        <label>Key Type</label>
        <div class="skg-segmented" id="skg-type">
          <button type="button" class="skg-seg active" data-value="ed25519">Ed25519</button>
          <button type="button" class="skg-seg" data-value="rsa">RSA</button>
          <button type="button" class="skg-seg" data-value="ecdsa">ECDSA</button>
        </div>
        <div class="skg-hint" id="skg-type-hint">Modern, fast, recommended default.</div>
      </div>

      <div class="skg-field" id="skg-bits-field" style="display:none">
        <label>RSA Bits</label>
        <div class="skg-segmented" id="skg-bits">
          <button type="button" class="skg-seg" data-value="2048">2048</button>
          <button type="button" class="skg-seg active" data-value="3072">3072</button>
          <button type="button" class="skg-seg" data-value="4096">4096</button>
        </div>
      </div>

      <div class="skg-field" id="skg-curve-field" style="display:none">
        <label>ECDSA Curve</label>
        <div class="skg-segmented" id="skg-curve">
          <button type="button" class="skg-seg active" data-value="P-256">P-256</button>
          <button type="button" class="skg-seg" data-value="P-384">P-384</button>
          <button type="button" class="skg-seg" data-value="P-521">P-521</button>
        </div>
      </div>

      <div class="skg-field">
        <label>Comment (label for the key)</label>
        <input class="modal-input" id="skg-comment" value="${escapeHtml(defaultComment)}" placeholder="user@host" />
      </div>

      <div class="skg-field">
        <label>Passphrase (optional, encrypts the private key)</label>
        <input class="modal-input" type="password" id="skg-pass" placeholder="Leave empty for no passphrase" />
      </div>
      <div class="skg-field" id="skg-pass2-field" style="display:none">
        <label>Confirm Passphrase</label>
        <input class="modal-input" type="password" id="skg-pass2" />
      </div>
    </div>

    <div class="skg-entropy">
      <div class="skg-entropy-label">⚜ Entropy of the Realm</div>
      <div class="skg-entropy-bar"><div class="skg-entropy-fill" id="skg-entropy-fill"></div></div>
      <div class="skg-entropy-hint" id="skg-entropy-hint">Move thy mouse to gather entropy (optional flair — the keys use OS cryptographic randomness regardless).</div>
    </div>

    <div class="skg-actions-row">
      <button class="btn-medieval primary" id="skg-roll" type="button">
        <span class="btn-icon">⚷</span> <span id="skg-roll-text">Forge Key</span>
      </button>
      <button class="btn-medieval" id="skg-reroll" type="button" style="display:none">
        <span class="btn-icon">⟳</span> Re-roll
      </button>
    </div>

    <div class="skg-output" id="skg-output" style="display:none">
      <div class="skg-out-section">
        <div class="skg-out-header">
          <span>⚜ Public Key</span>
          <span class="skg-fp" id="skg-fp"></span>
        </div>
        <textarea class="skg-textarea" id="skg-public" readonly></textarea>
        <div class="skg-out-actions">
          <button class="mini-btn" id="skg-copy-pub" type="button">⎘ Copy</button>
          <button class="mini-btn" id="skg-save-pub" type="button">⌬ Save .pub File</button>
        </div>
      </div>

      <div class="skg-out-section">
        <div class="skg-out-header">
          <span>⚷ Private Key</span>
          <button class="mini-btn" id="skg-toggle-priv" type="button">👁 Show</button>
        </div>
        <textarea class="skg-textarea private" id="skg-private" readonly></textarea>
        <div class="skg-out-actions">
          <button class="mini-btn" id="skg-copy-priv" type="button">⎘ Copy</button>
          <button class="mini-btn" id="skg-save-priv" type="button">⌬ Save Private Key</button>
        </div>
        <div class="skg-warn">
          <strong>⚠ Keep the private key secret.</strong> Never share it, never commit it to a repository. Save it to <code>${escapeHtml(ident.sshDir)}</code> with restricted permissions.
        </div>
      </div>
    </div>
  `;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-medieval';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => modal.hide();

  modal.show({ title: '⚷ SSH Key Generator', body, footer: [closeBtn] });

  // ------------------- Wiring -------------------

  // Segmented control: type
  let selectedType = 'ed25519';
  let selectedBits = 3072;
  let selectedCurve = 'P-256';

  const typeHints = {
    'ed25519': 'Modern, fast, recommended default.',
    'rsa': 'Classic, widely compatible. Use 3072 bits or higher.',
    'ecdsa': 'Elliptic curve. Smaller and faster than RSA at equivalent security.'
  };

  body.querySelectorAll('#skg-type .skg-seg').forEach(btn => {
    btn.onclick = () => {
      selectedType = btn.dataset.value;
      body.querySelectorAll('#skg-type .skg-seg').forEach(b => b.classList.toggle('active', b === btn));
      $('#skg-bits-field').style.display = selectedType === 'rsa' ? '' : 'none';
      $('#skg-curve-field').style.display = selectedType === 'ecdsa' ? '' : 'none';
      $('#skg-type-hint').textContent = typeHints[selectedType] || '';
    };
  });
  body.querySelectorAll('#skg-bits .skg-seg').forEach(btn => {
    btn.onclick = () => {
      selectedBits = parseInt(btn.dataset.value, 10);
      body.querySelectorAll('#skg-bits .skg-seg').forEach(b => b.classList.toggle('active', b === btn));
    };
  });
  body.querySelectorAll('#skg-curve .skg-seg').forEach(btn => {
    btn.onclick = () => {
      selectedCurve = btn.dataset.value;
      body.querySelectorAll('#skg-curve .skg-seg').forEach(b => b.classList.toggle('active', b === btn));
    };
  });

  // Passphrase: show confirm field when first field has content
  const passInput = $('#skg-pass');
  passInput.addEventListener('input', () => {
    $('#skg-pass2-field').style.display = passInput.value ? '' : 'none';
  });

  // Entropy bar: mouse movement adds to it. Caps at 100%.
  // (Purely visual — generation uses OS RNG.)
  const fill = $('#skg-entropy-fill');
  const hint = $('#skg-entropy-hint');
  let entropy = 0;
  let lastEnt = { x: 0, y: 0, t: 0 };
  const onMouseMove = (e) => {
    const now = Date.now();
    if (now - lastEnt.t < 30) return;
    const dx = Math.abs(e.clientX - lastEnt.x);
    const dy = Math.abs(e.clientY - lastEnt.y);
    const delta = Math.min(2, Math.sqrt(dx * dx + dy * dy) / 50);
    entropy = Math.min(100, entropy + delta);
    fill.style.width = entropy.toFixed(1) + '%';
    if (entropy >= 100) hint.textContent = '⚔ Entropy full — go forth and forge.';
    lastEnt = { x: e.clientX, y: e.clientY, t: now };
  };
  body.addEventListener('mousemove', onMouseMove);

  // -------- Generation --------
  async function generate() {
    const pass = passInput.value;
    const pass2 = $('#skg-pass2').value;
    if (pass && pass !== pass2) {
      showToast('Passphrases do not match', 'error');
      return;
    }

    const opts = {
      type: selectedType,
      comment: $('#skg-comment').value.trim(),
      passphrase: pass || undefined
    };
    if (selectedType === 'rsa') opts.bits = selectedBits;
    if (selectedType === 'ecdsa') opts.curve = selectedCurve;

    const rollBtn = $('#skg-roll');
    const rerollBtn = $('#skg-reroll');
    rollBtn.disabled = true;
    rerollBtn.disabled = true;
    $('#skg-roll-text').textContent = 'Forging…';

    try {
      const r = await gs.sshGenerateKey(opts);
      if (!r.ok) {
        showToast('Forging failed: ' + r.error, 'error', 6000);
        return;
      }
      lastKey = r.data;
      // Populate output
      $('#skg-output').style.display = 'block';
      $('#skg-public').value = lastKey.publicLine;
      // Always start with private key masked
      showingPrivate = false;
      const privEl = $('#skg-private');
      privEl.value = '••••• Private key generated. Click "Show" to reveal. •••••';
      privEl.classList.add('masked');
      $('#skg-toggle-priv').textContent = '👁 Show';
      $('#skg-fp').textContent = lastKey.fingerprint;
      // Update reroll visibility
      rerollBtn.style.display = '';
      $('#skg-roll-text').textContent = 'Forge Key';
      // Scroll the output into view
      $('#skg-output').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      showToast(`Forged ${selectedType} key`, 'success');
    } catch (err) {
      showToast('Forging failed: ' + (err.message || err), 'error', 6000);
    } finally {
      rollBtn.disabled = false;
      rerollBtn.disabled = false;
    }
  }

  $('#skg-roll').onclick = generate;
  $('#skg-reroll').onclick = generate;

  // Show / hide private key
  $('#skg-toggle-priv').onclick = () => {
    if (!lastKey) return;
    showingPrivate = !showingPrivate;
    const privEl = $('#skg-private');
    if (showingPrivate) {
      privEl.value = lastKey.privatePem;
      privEl.classList.remove('masked');
      $('#skg-toggle-priv').textContent = '👁 Hide';
    } else {
      privEl.value = '••••• Private key hidden. Click "Show" to reveal. •••••';
      privEl.classList.add('masked');
      $('#skg-toggle-priv').textContent = '👁 Show';
    }
  };

  // Copy buttons
  $('#skg-copy-pub').onclick = async () => {
    if (!lastKey) return;
    await copyText(lastKey.publicLine, 'Public key copied');
  };
  $('#skg-copy-priv').onclick = async () => {
    if (!lastKey) return;
    await copyText(lastKey.privatePem, 'Private key copied — handle with care');
  };

  // Save buttons
  $('#skg-save-pub').onclick = async () => {
    if (!lastKey) return;
    const r = await gs.sshSaveKey({
      content: lastKey.publicLine + '\n',
      defaultName: lastKey.suggestedName + '.pub',
      kind: 'public'
    });
    if (!r.ok) { showToast('Save failed: ' + r.error, 'error', 6000); return; }
    if (r.data.saved) showToast('Saved to ' + r.data.filePath, 'success', 5000);
  };
  $('#skg-save-priv').onclick = async () => {
    if (!lastKey) return;
    const r = await gs.sshSaveKey({
      content: lastKey.privatePem.endsWith('\n') ? lastKey.privatePem : lastKey.privatePem + '\n',
      defaultName: lastKey.suggestedName,
      kind: 'private'
    });
    if (!r.ok) { showToast('Save failed: ' + r.error, 'error', 6000); return; }
    if (r.data.saved) showToast('Saved to ' + r.data.filePath, 'success', 5000);
  };
}


function showCloneDialog() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="modal-field">
      <label>Repository URL</label>
      <input class="modal-input" id="clone-url" placeholder="https://github.com/user/repo.git  or  git@github.com:user/repo.git" />
      <div id="clone-url-hint" style="margin-top:6px;font-size:11px;color:var(--muted-text);font-family:var(--font-mono)"></div>
    </div>
    <div class="modal-field">
      <label>Destination Folder (parent)</label>
      <div class="modal-row">
        <input class="modal-input" id="clone-dest" placeholder="Choose parent folder" readonly />
        <button class="btn-medieval" id="clone-browse" style="padding:8px 14px">Browse</button>
      </div>
    </div>
    <div class="modal-field" id="clone-ssh-field" style="display:none">
      <label>SSH Private Key (optional)</label>
      <div class="modal-row">
        <input class="modal-input" id="clone-ssh-key" placeholder="Leave blank to use default key / ssh-agent" />
        <button class="btn-medieval" id="clone-ssh-browse" style="padding:8px 14px">Browse</button>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted-text)">
        Tip: leave empty if you use ssh-agent or have <code>~/.ssh/id_rsa</code> (or <code>id_ed25519</code>) set up.
      </div>
    </div>
    <p class="modal-text text-muted" style="font-size:12px">The repository will be cloned into a sub-folder of the chosen destination.</p>
  `;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const cloneBtn = document.createElement('button');
  cloneBtn.className = 'btn-medieval primary';
  cloneBtn.innerHTML = '<span class="btn-icon">⚔</span> Clone';
  cloneBtn.onclick = async () => {
    const url = $('#clone-url').value.trim();
    const dest = $('#clone-dest').value.trim();
    const sshKeyPath = ($('#clone-ssh-key') && $('#clone-ssh-key').value.trim()) || undefined;
    if (!url) { showToast('URL required', 'error'); return; }
    if (!dest) { showToast('Destination required', 'error'); return; }
    modal.hide();
    const result = await withLoading('Cloning repository', () => gs.cloneRepo({ url, destination: dest, sshKeyPath }));
    if (!result.ok) {
      // Long auth/SSH errors get a modal instead of a toast — much more readable
      const errText = result.error || 'Clone failed';
      if (errText.length > 100 || /SSH|HTTPS|publickey|Authentication/i.test(errText)) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-medieval primary';
        closeBtn.textContent = 'Close';
        closeBtn.onclick = () => modal.hide();
        modal.show({
          title: 'Clone Failed',
          body: `<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;color:var(--text-dim);line-height:1.5;max-height:50vh;overflow:auto">${escapeHtml(errText)}</pre>`,
          footer: closeBtn
        });
      } else {
        showToast(errText, 'error', 8000);
      }
      return;
    }
    if (typeof saveActiveTabUi === 'function' && state.repo) saveActiveTabUi();
    state.repo = result.data;
    // A clone opens in its own tab, like any other repository opened from here.
    if (typeof noteRepoOpened === 'function') noteRepoOpened(result.data);
    $('#welcome-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    updateRepoInfo();
    await withRepoOpen(`Opening “${result.data.name}”`, () => refreshAll());
    showToast(`Cloned "${result.data.name}"`, 'success');
  };

  modal.show({ title: 'Clone Repository', body, footer: [cancelBtn, cloneBtn] });

  // Detect URL type as user types, show SSH key field if relevant
  const urlInput = $('#clone-url');
  const sshField = $('#clone-ssh-field');
  const hint = $('#clone-url-hint');
  urlInput.addEventListener('input', () => {
    const v = urlInput.value.trim();
    if (/^(git@|ssh:\/\/)/i.test(v)) {
      sshField.style.display = '';
      hint.textContent = '⚔ SSH URL detected — uses your SSH key';
      hint.style.color = 'var(--crusader-red-bright)';
    } else if (/^https?:\/\//i.test(v)) {
      sshField.style.display = 'none';
      hint.textContent = '⌬ HTTPS URL — for private repos use a Personal Access Token as password';
      hint.style.color = 'var(--muted-text)';
    } else {
      sshField.style.display = 'none';
      hint.textContent = '';
    }
  });

  $('#clone-browse').onclick = async () => {
    const sel = await gs.selectFolder('Choose destination folder');
    if (sel.ok) $('#clone-dest').value = sel.data;
  };

  $('#clone-ssh-browse').onclick = async () => {
    const sel = await gs.selectFile('Select SSH private key');
    if (sel.ok) $('#clone-ssh-key').value = sel.data;
  };
}

// ============================================
