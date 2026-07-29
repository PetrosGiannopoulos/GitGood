// ============================================
// COMMIT & TAG SIGNING (renderer)
// ============================================
// Three jobs: the Signing panel in Settings, the per-commit "sign" tick in the commit box,
// and the signature badge on a selected commit.
//
// Verification is lazy and cached per hash. Every check spawns gpg or ssh-keygen in the
// main process (see repo:verifyCommit), so it happens once per commit the user actually
// looks at — never for a list, and never again for the same commit while the repo is open.

const signingState = {
  status: null,        // last signing:status payload, or null before the first load
  loading: null,       // in-flight signing:status promise, shared by concurrent callers
  verified: new Map()  // hash -> verification result
};

// Load (and cache) the signing configuration. `force` re-reads after a config write.
async function loadSigningStatus(force) {
  if (!force && signingState.status) return signingState.status;
  if (!force && signingState.loading) return signingState.loading;
  signingState.loading = (async () => {
    const r = await gs.signingStatus();
    signingState.status = (r && r.ok) ? r.data : null;
    signingState.loading = null;
    return signingState.status;
  })();
  return signingState.loading;
}

// Signing config is per-repo (local config can override global), and a verification result
// is meaningless once the repo changes. Called from the repo-open path.
function resetSigningState() {
  signingState.status = null;
  signingState.loading = null;
  signingState.verified.clear();
}

// ============================================
// SIGNATURE BADGE
// ============================================
const SIG_ICON = { good: '✓', warn: '⚠', bad: '✗', unknown: '?', none: '' };

function signatureBadgeHtml(v) {
  if (!v || v.level === 'none') return '';
  const who = v.signer ? ` — ${escapeHtml(v.signer)}` : '';
  const key = v.keyId ? ` <span class="sig-key text-mono">${escapeHtml(v.keyId)}</span>` : '';
  return `<div class="sig-badge sig-${v.level}" title="${escapeHtml(v.label + (v.signer ? ' by ' + v.signer : ''))}">
    <span class="sig-icon">${SIG_ICON[v.level] || '?'}</span>
    <span class="sig-label">${escapeHtml(v.label)}${who}</span>${key}
  </div>`;
}

// Fill in the signature line for a commit detail pane. The host element is rendered empty
// by the caller and stays empty for unsigned commits — the overwhelming majority — so an
// unsigned repository shows no signing UI at all rather than a row of "not signed" noise.
async function hydrateSignatureBadge(hostEl, hash) {
  if (!hostEl || !hash) return;
  let v = signingState.verified.get(hash);
  if (!v) {
    const r = await gs.verifyCommit({ hash });
    if (!r || !r.ok) return;
    v = r.data;
    signingState.verified.set(hash, v);
  }
  // The pane may have been re-rendered for another commit while git was working.
  if (!hostEl.isConnected || hostEl.dataset.sigHash !== hash) return;
  hostEl.innerHTML = signatureBadgeHtml(v);
}

// ============================================
// COMMIT BOX — the per-commit signing tick
// ============================================
// The checkbox mirrors commit.gpgsign, and whatever it shows is what gets sent: the commit
// handler turns it into an explicit -S / --no-gpg-sign. That means the box in front of the
// user is always the truth, even when a repo's local config disagrees with the global one.
async function initCommitSignToggle() {
  const row = document.getElementById('commit-sign-row');
  const cb = document.getElementById('commit-sign');
  if (!row || !cb) return;
  const st = await loadSigningStatus();
  if (!st) { row.classList.add('hidden'); return; }
  const configured = !!(st.effective && st.effective.key) || (st.gpg && st.gpg.available && st.gpg.keys.length);
  // Nothing to sign with and signing switched off: don't advertise a feature that cannot
  // work yet. Settings → Signing is where that gets set up.
  row.classList.toggle('hidden', !configured && !st.effective.commitSign);
  cb.checked = !!(st.effective && st.effective.commitSign);
  const note = document.getElementById('commit-sign-note');
  if (note) {
    note.textContent = st.effective.key
      ? `${st.effective.format === 'ssh' ? 'SSH' : st.effective.format === 'x509' ? 'X.509' : 'OpenPGP'} · ${st.effective.key}`
      : 'No signing key configured yet';
  }
}

// What repo:commit should be told. undefined means "no opinion, follow the config", which
// is what a hidden (unconfigured) row means.
function commitSignChoice() {
  const row = document.getElementById('commit-sign-row');
  const cb = document.getElementById('commit-sign');
  if (!row || !cb || row.classList.contains('hidden')) return undefined;
  return !!cb.checked;
}

// ============================================
// SETTINGS PANEL
// ============================================
// Rendered into the Settings dialog by 08-lfs-settings.js. Unlike the other panels this one
// applies on its own buttons rather than the dialog's Save: writing signing config runs git
// config immediately, and the Test button below has to run against what was actually saved.
// `override` re-renders from an already-loaded status with some fields edited — the format
// dropdown uses it so switching OpenPGP↔SSH swaps the key list without re-probing gpg.
async function renderSigningSettings(panel, override) {
  if (!override) {
    panel.innerHTML = `<div class="settings-panel-title">Signing</div>
      <div class="settings-group"><p class="modal-text text-muted">Reading your signing configuration…</p></div>`;
  }

  const st = override || await loadSigningStatus(true);
  if (!st) {
    panel.innerHTML = `<div class="settings-panel-title">Signing</div>
      <div class="settings-group"><p class="modal-text text-red">Could not read the signing configuration.</p></div>`;
    return;
  }

  const hasRepo = !!st.hasRepo;
  const eff = st.effective;
  const fmt = eff.format || 'openpgp';

  const gpgOptions = st.gpg.keys.map(k => {
    const label = `${k.keyId}${k.uid ? ' — ' + k.uid : ''}${k.expired ? ' (expired)' : ''}`;
    return `<option value="${escapeHtml(k.keyId)}"${eff.key === k.keyId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  const sshOptions = st.ssh.keys.map(k => {
    const label = `${k.path.split(/[\\/]/).pop()} — ${k.type}${k.comment ? ' ' + k.comment : ''}${k.hasPrivate ? '' : ' (public half only)'}`;
    return `<option value="${escapeHtml(k.path)}"${eff.key === k.path ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');

  // A key set in config that isn't in the detected list (an agent-only SSH key, a key on a
  // smartcard) is still valid — keep it selectable rather than silently dropping it.
  const known = fmt === 'ssh' ? st.ssh.keys.some(k => k.path === eff.key) : st.gpg.keys.some(k => k.keyId === eff.key);
  const customOption = (eff.key && !known)
    ? `<option value="${escapeHtml(eff.key)}" selected>${escapeHtml(eff.key)} (from config)</option>` : '';

  panel.innerHTML = `
    <div class="settings-panel-title">Signing</div>
    <p class="modal-text text-muted" style="font-size:12px;margin-bottom:12px">
      A signature proves a commit came from you. GitGood never touches your key — it configures
      <span class="text-mono">git</span>, which signs with gpg or ssh exactly as it would on the command line.
    </p>

    <div class="settings-group">
      <div class="settings-group-title">Where to save</div>
      <div class="settings-row">
        <div class="label">Scope<small>Global applies everywhere. Local applies only to the open repository and overrides global.</small></div>
        <div class="control">
          <div class="scope-toggle" id="sign-scope" data-scope="global">
            <button type="button" data-set-scope="global" class="active">Global</button>
            <button type="button" data-set-scope="local" ${hasRepo ? '' : 'disabled title="Open a repository first"'}>Local</button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Signature format</div>
      <div class="settings-row">
        <div class="label">Format<small>OpenPGP is the classic. SSH signing reuses the key you already push with (git 2.34+).</small></div>
        <div class="control">
          <select id="sign-format">
            <option value="openpgp"${fmt === 'openpgp' ? ' selected' : ''}>OpenPGP (gpg)${st.gpg.available ? '' : ' — gpg not found'}</option>
            <option value="ssh"${fmt === 'ssh' ? ' selected' : ''}>SSH${st.ssh.available ? '' : ' — ssh-keygen has no signing support'}</option>
            <option value="x509"${fmt === 'x509' ? ' selected' : ''}>X.509 (smimesign)</option>
          </select>
        </div>
      </div>
      <div class="settings-row">
        <div class="label">Signing key<small id="sign-key-hint">${fmt === 'ssh' ? 'The public key file; the private half must be beside it or loaded in your agent.' : 'The long key id of a secret key you hold.'}</small></div>
        <div class="control">
          <select id="sign-key" style="min-width:260px">
            <option value="">(none)</option>
            ${customOption}
            ${fmt === 'ssh' ? sshOptions : gpgOptions}
          </select>
          ${fmt === 'ssh' ? '<button class="mini-btn" id="sign-key-browse" type="button">…</button>' : ''}
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">What to sign</div>
      <div class="settings-row">
        <div class="label">Sign every commit<small>Sets <span class="text-mono">commit.gpgsign</span>. You can still override it per commit in the Changes tab.</small></div>
        <div class="control">
          <label class="medieval-toggle"><input type="checkbox" id="sign-commits" ${eff.commitSign ? 'checked' : ''} /><span class="toggle-track"></span></label>
        </div>
      </div>
      <div class="settings-row">
        <div class="label">Sign every tag<small>Sets <span class="text-mono">tag.gpgsign</span>. Signed tags are always annotated.</small></div>
        <div class="control">
          <label class="medieval-toggle"><input type="checkbox" id="sign-tags" ${eff.tagSign ? 'checked' : ''} /><span class="toggle-track"></span></label>
        </div>
      </div>
    </div>

    <div class="settings-group" id="sign-allowed-group" style="${fmt === 'ssh' ? '' : 'display:none'}">
      <div class="settings-group-title">SSH trust store</div>
      <p class="modal-text text-muted" style="font-size:12px;margin-bottom:10px">
        SSH signatures can only be verified against an <span class="text-mono">allowed_signers</span> file listing which key belongs to whom.
        Without it your own commits show as “cannot be checked”.
      </p>
      <div class="settings-row">
        <div class="label">allowed_signers<small id="sign-allowed-status">${st.ssh.allowedSignersExists
          ? escapeHtml(st.ssh.allowedSignersFile) + ` · ${st.ssh.allowedSignersEntries} entr${st.ssh.allowedSignersEntries === 1 ? 'y' : 'ies'}`
          : 'Not configured'}</small></div>
        <div class="control">
          <button class="mini-btn" id="sign-add-allowed" type="button">+ Trust my key</button>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Check it works</div>
      <p class="modal-text text-muted" style="font-size:12px;margin-bottom:10px">
        Signs a throwaway object with your current settings. Nothing is committed and no branch moves —
        it only proves that git, your key and your passphrase prompt can reach each other.
      </p>
      <div class="settings-row">
        <div class="label">Test signature<small id="sign-test-status">${hasRepo ? 'Not run yet' : 'Open a repository to run the test'}</small></div>
        <div class="control">
          <button class="mini-btn primary" id="sign-test" type="button" ${hasRepo ? '' : 'disabled'}>⚔ Test</button>
        </div>
      </div>
      <pre class="sign-test-output hidden" id="sign-test-output"></pre>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Detected</div>
      <div class="settings-row"><div class="label">gpg</div><div class="control"><span class="text-muted" style="font-size:12px">${st.gpg.available ? escapeHtml(st.gpg.version) + ` · ${st.gpg.keys.length} secret key${st.gpg.keys.length === 1 ? '' : 's'}` : 'not installed'}</span></div></div>
      <div class="settings-row"><div class="label">ssh-keygen signing</div><div class="control"><span class="text-muted" style="font-size:12px">${st.ssh.available ? `available · ${st.ssh.keys.length} public key${st.ssh.keys.length === 1 ? '' : 's'} in ~/.ssh` : 'unavailable'}</span></div></div>
      <div class="settings-row"><div class="label">git</div><div class="control"><span class="text-muted" style="font-size:12px">${escapeHtml(st.gitVersion || '')}</span></div></div>
    </div>

    <div class="settings-actions-row">
      <button class="btn-medieval primary" id="sign-apply" type="button"><span class="btn-icon">✓</span> Apply signing settings</button>
    </div>
  `;

  const scopeBox = panel.querySelector('#sign-scope');
  scopeBox.querySelectorAll('button[data-set-scope]').forEach(btn => {
    btn.onclick = () => {
      if (btn.disabled) return;
      scopeBox.dataset.scope = btn.dataset.setScope;
      scopeBox.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    };
  });

  // Changing the format changes which keys are even meaningful, so re-render rather than
  // trying to swap the options in place.
  panel.querySelector('#sign-format').onchange = async (e) => {
    const chosen = e.target.value;
    await renderSigningSettings(panel, { ...st, effective: { ...eff, format: chosen, key: '' } });
  };

  const browse = panel.querySelector('#sign-key-browse');
  if (browse) browse.onclick = async () => {
    const r = await gs.selectFile('Select your SSH public key (.pub)');
    if (!r || !r.ok) return;
    const sel = panel.querySelector('#sign-key');
    const opt = document.createElement('option');
    opt.value = r.data; opt.textContent = r.data; opt.selected = true;
    sel.appendChild(opt);
  };

  panel.querySelector('#sign-apply').onclick = async () => {
    const scope = scopeBox.dataset.scope;
    const payload = {
      scope,
      format: panel.querySelector('#sign-format').value,
      key: panel.querySelector('#sign-key').value,
      commitSign: panel.querySelector('#sign-commits').checked,
      tagSign: panel.querySelector('#sign-tags').checked
    };
    if (payload.commitSign && !payload.key) {
      showToast('Choose a signing key first — git cannot sign without one.', 'error', 6000);
      return;
    }
    const r = await withLoading('Saving signing settings', () => gs.signingConfigure(payload));
    if (!handleResult(r, `Signing settings saved (${scope})`)) return;
    await loadSigningStatus(true);
    await initCommitSignToggle();
    await renderSigningSettings(panel);
  };

  const addAllowed = panel.querySelector('#sign-add-allowed');
  if (addAllowed) addAllowed.onclick = async () => {
    const keyPath = panel.querySelector('#sign-key').value;
    if (!keyPath) { showToast('Choose your SSH signing key first', 'error'); return; }
    const identity = (eff.email || '').trim();
    if (!identity) { showToast('Set user.email in Settings → Git Identity first — it is the name your key is trusted under.', 'error', 7000); return; }
    const r = await gs.signingAddAllowedSigner({ identity, publicKeyPath: keyPath });
    if (!handleResult(r)) return;
    showToast(r.data.added ? `Trusted ${identity} in ${r.data.file}` : (r.data.reason || 'Already trusted'), 'success', 5000);
    await renderSigningSettings(panel);
  };

  panel.querySelector('#sign-test').onclick = async () => {
    const statusEl = panel.querySelector('#sign-test-status');
    const outEl = panel.querySelector('#sign-test-output');
    statusEl.textContent = 'Signing a test object…';
    outEl.classList.add('hidden');
    const r = await gs.signingTest();
    if (!r || !r.ok) {
      statusEl.textContent = 'Test failed';
      outEl.textContent = (r && r.error) || 'Unknown error';
      outEl.classList.remove('hidden');
      return;
    }
    const d = r.data;
    if (d.ok) {
      const verdict = (SIG_STATUS_LABEL[d.status] || d.status);
      statusEl.textContent = `Signed successfully — git reads it back as: ${verdict}`;
      if (d.status === 'E' || d.status === 'U') {
        outEl.textContent = d.status === 'E'
          ? 'The signature was created but cannot be verified locally. For SSH signing that means your key is missing from allowed_signers (see above). For OpenPGP it means the public key is not in your keyring.'
          : 'The signature is good but the key is not marked trusted in your keyring. Commits will still be signed; `gpg --edit-key <id> trust` silences it.';
        outEl.classList.remove('hidden');
      }
    } else {
      statusEl.textContent = 'Signing failed';
      outEl.textContent = (d.help ? d.help + '\n\n' : '') + d.error;
      outEl.classList.remove('hidden');
    }
  };
}

const SIG_STATUS_LABEL = {
  G: 'good signature', U: 'good, untrusted key', X: 'good, expired',
  Y: 'good, expired key', R: 'good, REVOKED key', B: 'BAD signature',
  E: 'cannot be checked here', N: 'not signed'
};
