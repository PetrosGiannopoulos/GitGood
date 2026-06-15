// GIT LFS MANAGER
// ============================================
async function showLfsManager() {
  const infoR = await withLoading('Checking LFS', () => gs.lfsInfo());
  const info = (infoR && infoR.ok) ? infoR.data : { available: false };

  const body = document.createElement('div');
  body.className = 'lfs-manager';

  // Case 1: git-lfs not installed on the machine
  if (!info.available) {
    body.innerHTML = `
      <div class="lfs-status-banner not-available">
        <div class="lfs-status-icon">⚠</div>
        <div>
          <div class="lfs-status-title">Git LFS not found</div>
          <div class="lfs-status-text">The <code>git-lfs</code> command isn't installed or isn't on your PATH. Install it from <span class="text-mono">git-lfs.com</span>, then reopen this dialog.</div>
        </div>
      </div>
    `;
    const close = document.createElement('button');
    close.className = 'btn-medieval primary'; close.textContent = 'Close';
    close.onclick = () => modal.hide();
    modal.show({ title: '⛂ Git LFS', body, footer: [close] });
    return;
  }

  // Render the full manager
  function render() {
    const patterns = info.patterns || [];
    body.innerHTML = `
      <div class="lfs-status-banner ${info.initialized ? 'ok' : 'warn'}">
        <div class="lfs-status-icon">${info.initialized ? '✓' : '⚠'}</div>
        <div>
          <div class="lfs-status-title">${info.initialized ? 'Git LFS is active in this repository' : 'Git LFS not initialized here'}</div>
          <div class="lfs-status-text">
            ${escapeHtml(info.version || '')}
            ${info.initialized ? ` · ${info.trackedFiles} tracked file${info.trackedFiles === 1 ? '' : 's'}` : ' · click Initialize to set up hooks & filters'}
          </div>
        </div>
        ${info.initialized ? '' : '<button class="btn-medieval primary" id="lfs-init" type="button">⚜ Initialize</button>'}
      </div>

      <div class="lfs-section">
        <div class="lfs-section-title">⚒ Transfer</div>
        <div class="lfs-btn-row">
          <button class="mini-btn" id="lfs-pull" type="button" title="Download LFS objects for the current checkout">⇣ Pull</button>
          <button class="mini-btn" id="lfs-fetch" type="button" title="Download LFS objects without checking out">⇣ Fetch</button>
          <button class="mini-btn" id="lfs-fetch-all" type="button" title="Fetch ALL LFS objects (every ref)">⇣ Fetch All</button>
          <button class="mini-btn" id="lfs-push" type="button" title="Upload LFS objects for the current branch">⇡ Push</button>
          <button class="mini-btn" id="lfs-push-all" type="button" title="Upload ALL LFS objects">⇡ Push All</button>
          <button class="mini-btn" id="lfs-checkout" type="button" title="Populate working copy from local LFS cache">⌬ Checkout</button>
          <button class="mini-btn" id="lfs-prune2" type="button" title="Prune unreferenced LFS objects">✕ Prune</button>
        </div>
      </div>

      <div class="lfs-section">
        <div class="lfs-section-title">⚜ Tracked Patterns (${patterns.length})</div>
        <div class="lfs-track-add">
          <input type="text" class="modal-input" id="lfs-pattern" placeholder="e.g. *.psd  or  assets/**/*.bin" />
          <button class="mini-btn primary" id="lfs-track-btn" type="button">+ Track</button>
        </div>
        ${patterns.length ? `
          <ul class="lfs-pattern-list">
            ${patterns.map(p => `
              <li class="lfs-pattern-item">
                <span class="lfs-pattern-name text-mono">${escapeHtml(p)}</span>
                <button class="mini-btn" data-untrack="${escapeHtml(p)}" type="button">✕ Untrack</button>
              </li>
            `).join('')}
          </ul>
        ` : '<div class="lfs-empty">No patterns tracked yet. Add one above (e.g. <code>*.psd</code>).</div>'}
      </div>

      <div class="lfs-section">
        <div class="lfs-section-title">⌗ Managed Files</div>
        <button class="mini-btn" id="lfs-list-files" type="button">List LFS files…</button>
        <div id="lfs-files-result"></div>
      </div>

      <div class="lfs-section">
        <div class="lfs-section-title">⚔ Migrate</div>
        <div class="lfs-status-text" style="margin-bottom:8px">Convert existing files already in history into LFS pointers. <strong class="text-red">Rewrites history</strong> — coordinate with collaborators first.</div>
        <div class="lfs-track-add">
          <input type="text" class="modal-input" id="lfs-migrate-pattern" placeholder="e.g. *.zip,*.bin (comma-separated)" />
          <button class="mini-btn" id="lfs-migrate-btn" type="button">⚔ Migrate Import</button>
        </div>
      </div>
    `;

    // Re-fetch info and re-render
    async function reload() {
      const r = await gs.lfsInfo();
      if (r && r.ok) { info.initialized = r.data.initialized; info.patterns = r.data.patterns; info.trackedFiles = r.data.trackedFiles; info.version = r.data.version; }
      render();
    }

    const byId = (id) => body.querySelector('#' + id);

    if (byId('lfs-init')) byId('lfs-init').onclick = async () => {
      const r = await withLoading('Initializing LFS', () => gs.lfsInstall());
      if (handleResult(r, 'Git LFS initialized')) await reload();
    };

    byId('lfs-pull').onclick = async () => {
      const r = await withLoading('LFS pull', () => gs.lfsPull());
      handleResult(r, 'LFS objects pulled');
    };
    byId('lfs-fetch').onclick = async () => {
      const r = await withLoading('LFS fetch', () => gs.lfsFetch({}));
      handleResult(r, 'LFS objects fetched');
    };
    byId('lfs-fetch-all').onclick = async () => {
      const r = await withLoading('LFS fetch --all', () => gs.lfsFetch({ all: true }));
      handleResult(r, 'All LFS objects fetched');
    };
    byId('lfs-push').onclick = async () => {
      const r = await withLoading('LFS push', () => gs.lfsPush({ remote: 'origin' }));
      handleResult(r, 'LFS objects pushed');
    };
    byId('lfs-push-all').onclick = async () => {
      const r = await withLoading('LFS push --all', () => gs.lfsPush({ remote: 'origin', all: true }));
      handleResult(r, 'All LFS objects pushed');
    };
    byId('lfs-checkout').onclick = async () => {
      const r = await withLoading('LFS checkout', () => gs.lfsCheckout());
      handleResult(r, 'LFS checkout complete');
    };
    byId('lfs-prune2').onclick = async () => {
      const ok = await modal.confirm({ title: 'Prune LFS', message: 'Remove unreferenced LFS objects from local cache?', confirmText: 'Prune' });
      if (!ok) return;
      const r = await withLoading('Pruning LFS', () => gs.lfsPrune());
      handleResult(r, 'LFS pruned');
    };

    byId('lfs-track-btn').onclick = async () => {
      const pat = byId('lfs-pattern').value.trim();
      if (!pat) { showToast('Enter a pattern', 'error'); return; }
      const r = await withLoading('Tracking ' + pat, () => gs.lfsTrack(pat));
      if (handleResult(r, 'Now tracking ' + pat)) await reload();
    };
    byId('lfs-pattern').onkeydown = (e) => { if (e.key === 'Enter') byId('lfs-track-btn').click(); };

    body.querySelectorAll('[data-untrack]').forEach(btn => {
      btn.onclick = async () => {
        const pat = btn.dataset.untrack;
        const r = await withLoading('Untracking ' + pat, () => gs.lfsUntrack(pat));
        if (handleResult(r, 'Stopped tracking ' + pat)) await reload();
      };
    });

    byId('lfs-list-files').onclick = async () => {
      const out = byId('lfs-files-result');
      out.innerHTML = '<div class="lfs-empty">Loading…</div>';
      const r = await gs.lfsFiles();
      if (!r.ok) { out.innerHTML = `<div class="lfs-empty">Failed: ${escapeHtml(r.error)}</div>`; return; }
      const files = r.data.files || [];
      if (!files.length) { out.innerHTML = '<div class="lfs-empty">No LFS-managed files.</div>'; return; }
      out.innerHTML = `
        <ul class="lfs-files-list">
          ${files.slice(0, 200).map(f => `
            <li class="lfs-file-item">
              <span class="lfs-file-dl" title="${f.downloaded ? 'Downloaded' : 'Not downloaded'}">${f.downloaded ? '●' : '○'}</span>
              <span class="lfs-file-path text-mono" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
              <span class="lfs-file-size">${escapeHtml(f.size || '')}</span>
            </li>
          `).join('')}
          ${files.length > 200 ? `<li class="lfs-empty">…and ${files.length - 200} more</li>` : ''}
        </ul>
      `;
    };

    byId('lfs-migrate-btn').onclick = async () => {
      const raw = byId('lfs-migrate-pattern').value.trim();
      if (!raw) { showToast('Enter at least one pattern', 'error'); return; }
      const patterns = raw.split(',').map(s => s.trim()).filter(Boolean);
      const ok = await modal.confirm({
        title: 'Migrate to LFS',
        message: `Rewrite history to convert files matching [${patterns.join(', ')}] into LFS pointers? This changes commit hashes and requires a force-push. Make sure you have a backup and coordinate with collaborators.`,
        danger: true, confirmText: 'Migrate'
      });
      if (!ok) return;
      const r = await withLoading('Migrating to LFS', () => gs.lfsMigrateImport({ patterns }));
      if (handleResult(r, 'Migration complete')) await reload();
    };
  }

  render();

  const close = document.createElement('button');
  close.className = 'btn-medieval'; close.textContent = 'Close';
  close.onclick = () => { modal.hide(); refreshDiskUsage().catch(() => {}); };
  modal.show({ title: '⛂ Git LFS Manager', body, footer: [close] });
}

function showBranchCleanupDialog(data) {
  const merged = data.merged || [];
  const current = data.current || '';

  const body = document.createElement('div');
  if (!merged.length) {
    body.innerHTML = `
      <p class="modal-text">No merged branches found to clean up.</p>
      <p class="modal-text text-muted" style="font-size:12px">Current branch: <strong class="text-red">${escapeHtml(current)}</strong></p>
      ${data.unmerged && data.unmerged.length
        ? `<p class="modal-text text-muted" style="font-size:12px">${data.unmerged.length} branch(es) NOT merged (use the Branches tab if you want to force-delete those).</p>`
        : ''}
    `;
    const close = document.createElement('button');
    close.className = 'btn-medieval primary'; close.textContent = 'Close';
    close.onclick = () => modal.hide();
    modal.show({ title: 'Cleanup Merged Branches', body, footer: [close] });
    return;
  }

  // Default all selected
  const selected = new Set(merged.map(b => b.name));

  body.innerHTML = `
    <p class="modal-text">The following local branches are fully merged into <strong class="text-red">${escapeHtml(current)}</strong> and safe to delete:</p>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span class="branches-label" style="margin:0"><span id="cb-count">${selected.size}</span> / ${merged.length} selected</span>
      <div style="display:flex;gap:6px">
        <button class="mini-btn" id="cb-all" type="button">Select All</button>
        <button class="mini-btn" id="cb-none" type="button">Select None</button>
      </div>
    </div>
    <ul class="cleanup-branches-list" id="cb-list">
      ${merged.map(b => `
        <li class="cleanup-branch-item selected" data-name="${escapeHtml(b.name)}">
          <input type="checkbox" checked />
          <span>${escapeHtml(b.name)}</span>
        </li>
      `).join('')}
    </ul>
    ${data.unmerged && data.unmerged.length
      ? `<p class="modal-text text-muted" style="margin-top:12px;font-size:12px">⚔ ${data.unmerged.length} other branch(es) are NOT fully merged and are not listed here. Use the Branches tab to force-delete those if intentional.</p>`
      : ''}
  `;

  body.querySelectorAll('.cleanup-branch-item').forEach(li => {
    const name = li.dataset.name;
    li.onclick = () => {
      if (selected.has(name)) {
        selected.delete(name);
        li.classList.remove('selected');
        li.querySelector('input').checked = false;
      } else {
        selected.add(name);
        li.classList.add('selected');
        li.querySelector('input').checked = true;
      }
      body.querySelector('#cb-count').textContent = selected.size;
    };
  });
  body.querySelector('#cb-all').onclick = () => {
    merged.forEach(b => selected.add(b.name));
    body.querySelectorAll('.cleanup-branch-item').forEach(li => {
      li.classList.add('selected'); li.querySelector('input').checked = true;
    });
    body.querySelector('#cb-count').textContent = selected.size;
  };
  body.querySelector('#cb-none').onclick = () => {
    selected.clear();
    body.querySelectorAll('.cleanup-branch-item').forEach(li => {
      li.classList.remove('selected'); li.querySelector('input').checked = false;
    });
    body.querySelector('#cb-count').textContent = 0;
  };

  const cancel = document.createElement('button');
  cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
  cancel.onclick = () => modal.hide();
  const del = document.createElement('button');
  del.className = 'btn-medieval danger';
  del.innerHTML = '<span class="btn-icon">✕</span> Delete Selected';
  del.onclick = async () => {
    const list = [...selected];
    if (!list.length) { showToast('No branches selected', 'error'); return; }
    modal.hide();
    const r = await withLoading(`Deleting ${list.length} branch(es)`, () => gs.deleteBranches({ branches: list, force: false }));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
    const { deleted, failed } = r.data;
    if (deleted.length) showToast(`Deleted ${deleted.length} branch(es)`, 'success');
    if (failed.length) {
      const msg = failed.map(f => `${f.branch}: ${f.error}`).join('\n');
      showToast(`${failed.length} failed:\n${msg}`, 'error', 8000);
    }
    await refreshAll();
    await refreshDiskUsage();
  };
  modal.show({ title: 'Cleanup Merged Branches', body, footer: [cancel, del] });
}

function showLargestObjectsDialog(objects) {
  const body = document.createElement('div');
  if (!objects || !objects.length) {
    body.innerHTML = '<p class="modal-text">No objects found.</p>';
  } else {
    body.innerHTML = `
      <p class="modal-text">The largest objects in the repository (across all history). Useful for identifying bloat — usually committed binaries or large files that should be in LFS or <code>.gitignore</code>.</p>
      <ul class="objects-list">
        ${objects.map(o => `
          <li class="object-row" title="${escapeHtml(o.path || '(no path)')}">
            <span class="obj-hash">${escapeHtml((o.hash || '').slice(0, 10))}</span>
            <span class="obj-type">${escapeHtml(o.type || '')}</span>
            <span class="obj-path">${escapeHtml(o.path || '—')}</span>
            <span class="obj-size">${fmtBytes(o.size)}</span>
          </li>
        `).join('')}
      </ul>
      <p class="modal-text text-muted" style="font-size:11px;margin-top:10px">
        ⚜ To physically remove a large object from history (advanced, rewrites history):<br/>
        <code class="text-mono">git filter-repo --path &lt;path&gt; --invert-paths</code>
      </p>
    `;
  }
  const close = document.createElement('button');
  close.className = 'btn-medieval primary'; close.textContent = 'Close';
  close.onclick = () => modal.hide();
  modal.show({ title: 'Largest Objects', body, footer: [close] });
}

// ============================================
// SETTINGS DIALOG
// ============================================

const BUILTIN_THEMES = [
  { id: 'crusader',  name: 'Crusader',        swatches: ['#0a0606', '#b22222', '#c8a04a', '#efe6d4'] },
  { id: 'molecular', name: 'Molecular Tech',  swatches: ['#eaf3fd', '#006ade', '#00d4e8', '#04182e'] },
  { id: 'biohazard', name: 'Biohazard',       swatches: ['#030803', '#39ff14', '#d8ff00', '#e8ffd6'] },
  { id: 'sweet',     name: 'Sweet Factory',   swatches: ['#0f040b', '#ff2d96', '#ffdf3d', '#ffeaf6'] },
  { id: 'monastery', name: 'Blood Monastery', swatches: ['#faf7f0', '#c41212', '#c89400', '#1c0500'] },
  { id: 'racing',    name: 'Racing Punk',     swatches: ['#0a0a08', '#ffe600', '#ff6a00', '#fffbe0'] }
];
// Alacritty palettes (from github.com/alacritty/alacritty-theme), generated into
// 00-alacritty-themes.js as window.ALACRITTY_THEMES. They carry a `vars` map that is
// injected at runtime instead of relying on a predefined CSS class.
const ALACRITTY_THEMES = (typeof window !== 'undefined' && window.ALACRITTY_THEMES) || [];
const ALACRITTY_BY_ID = Object.create(null);
for (const t of ALACRITTY_THEMES) ALACRITTY_BY_ID[t.id] = t;

// The picker shows built-ins plus all Alacritty themes.
const AVAILABLE_THEMES = BUILTIN_THEMES.concat(
  ALACRITTY_THEMES.map(t => ({ id: t.id, name: t.name, swatches: t.swatches, alacritty: true, dark: t.dark }))
);

// Style element used to inject an Alacritty theme's CSS variables onto :root.
let _alacrittyStyleEl = null;
function injectAlacrittyVars(theme) {
  if (!_alacrittyStyleEl) {
    _alacrittyStyleEl = document.createElement('style');
    _alacrittyStyleEl.id = 'alacritty-theme-vars';
    document.head.appendChild(_alacrittyStyleEl);
  }
  if (!theme) { _alacrittyStyleEl.textContent = ''; return; }
  const decls = Object.entries(theme.vars).map(([k, v]) => `${k}:${v};`).join('');
  // Scoped to the html.theme-alacritty class so it overrides :root cleanly.
  _alacrittyStyleEl.textContent = `html.theme-alacritty{${decls}}`;
}

// Apply a theme: built-ins set an html class (vars live in CSS); Alacritty themes get a
// shared "theme-alacritty" class plus injected CSS variables. Called on load and picker.
function applyTheme(themeId) {
  const html = document.documentElement;
  // Clear every possible theme class (built-ins + the alacritty marker)
  for (const t of BUILTIN_THEMES) html.classList.remove('theme-' + t.id);
  html.classList.remove('theme-alacritty');

  const alac = ALACRITTY_BY_ID[themeId];
  if (alac) {
    injectAlacrittyVars(alac);
    html.classList.add('theme-alacritty');
    html.classList.toggle('theme-light', !alac.dark);
  } else {
    injectAlacrittyVars(null);            // remove any injected vars
    html.classList.remove('theme-light');
    if (themeId && themeId !== 'crusader') html.classList.add('theme-' + themeId);
  }

  // Recolor the commit graph to match the new theme, then redraw if it's loaded.
  if (typeof refreshThemeLaneColors === 'function') {
    refreshThemeLaneColors();
    try { if (state && state.graph && state.graph.commits && state.graph.commits.length) relayoutGraph(); } catch (e) {}
  }
}

// Apply font scale by genuinely resizing fonts (not zooming layout). The UI uses
// many hardcoded px font sizes, so we walk every CSS rule once, record each rule's
// base font-size in px, and on scale change rewrite them to base*scale. This affects
// ONLY text size — paddings, widths, and layout stay put.
let _fontScaleBases = null; // [{ rule, basePx }]

function collectFontScaleBases() {
  const bases = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; } // skip cross-origin
    if (!rules) continue;
    for (const rule of rules) {
      // Only style rules with an explicit px font-size
      if (rule.style && rule.style.fontSize && rule.style.fontSize.endsWith('px')) {
        const basePx = parseFloat(rule.style.fontSize);
        if (!isNaN(basePx)) bases.push({ rule, basePx });
      }
    }
  }
  // Only cache once we actually found rules (avoids caching an empty list if the
  // stylesheet hasn't finished parsing yet).
  if (bases.length) _fontScaleBases = bases;
  return bases;
}

function applyFontScale(scale) {
  const v = Math.max(0.75, Math.min(1.5, parseFloat(scale) || 1.0));
  // Clear any leftover zoom from a previous build
  const welcome = document.getElementById('welcome-screen');
  const app = document.getElementById('app-screen');
  if (welcome) welcome.style.zoom = '';
  if (app) app.style.zoom = '';

  const bases = _fontScaleBases || collectFontScaleBases();
  if (!bases || !bases.length) return;

  for (const { rule, basePx } of bases) {
    try {
      rule.style.setProperty('font-size', (basePx * v).toFixed(2) + 'px', rule.style.getPropertyPriority('font-size'));
    } catch (e) { /* some rules are read-only; skip */ }
  }
}

async function showSettingsDialog() {
  // Load both app settings and git config in parallel
  const [appR, gitR] = await Promise.all([gs.getAppSettings(), gs.getGitConfig()]);
  const appSettings = (appR && appR.ok) ? appR.data : { ...DEFAULT_APP_SETTINGS_LOCAL };
  const gitConfig = (gitR && gitR.ok) ? gitR.data : { global: {}, local: {}, effective: {} };

  // Track pending changes so Save can submit them at once
  // appChanges: { key: value } for app-level prefs
  // gitChanges: [{ scope, key, value }]
  const appChanges = {};
  const gitChanges = [];

  const hasRepo = !!(state.repo && state.repo.path);
  const repoLabel = hasRepo ? (state.repo.name || state.repo.path) : '(no repository open)';

  // Helper to record a git config change
  function setGitChange(scope, key, value) {
    // Remove any previous pending change for this scope+key
    for (let i = gitChanges.length - 1; i >= 0; i--) {
      if (gitChanges[i].scope === scope && gitChanges[i].key === key) gitChanges.splice(i, 1);
    }
    gitChanges.push({ scope, key, value });
  }

  // Determine the current effective value for a git config key for the
  // currently-selected scope per row. Initially we show local if a repo is
  // open AND local has a value; otherwise show global.
  function currentScopeFor(key) {
    if (hasRepo && gitConfig.local && gitConfig.local[key] !== undefined) return 'local';
    return 'global';
  }
  function currentValueFor(key, scope) {
    const map = scope === 'local' ? gitConfig.local : gitConfig.global;
    return (map && map[key] !== undefined) ? map[key] : '';
  }

  // Build the dialog
  const body = document.createElement('div');
  body.className = 'settings-dialog';
  body.innerHTML = `
    <nav class="settings-nav">
      <button class="settings-nav-item active" data-tab="general"><span class="nav-icon">⚙</span> General</button>
      <button class="settings-nav-item" data-tab="appearance"><span class="nav-icon">⚜</span> Appearance</button>
      <button class="settings-nav-item" data-tab="git"><span class="nav-icon">⚔</span> Git Identity</button>
      <button class="settings-nav-item" data-tab="defaults"><span class="nav-icon">✠</span> Defaults</button>
      <button class="settings-nav-item" data-tab="about"><span class="nav-icon">⚜</span> About</button>
    </nav>
    <div class="settings-panel" id="settings-panel-content"></div>
  `;

  const panel = body.querySelector('#settings-panel-content');

  // -------------------- Panel renderers --------------------
  function renderGeneral() {
    panel.innerHTML = `
      <div class="settings-panel-title">General</div>
      <div class="settings-group">
        <div class="settings-group-title">Behavior</div>
        <div class="settings-row">
          <div class="label">Auto-refresh on window focus<small>Refresh the repo state when the window regains focus</small></div>
          <div class="control">
            <label class="medieval-toggle">
              <input type="checkbox" id="set-auto-focus" ${appSettings.autoFetchOnFocus ? 'checked' : ''} />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>
        <div class="settings-row">
          <div class="label">Confirm destructive actions<small>Extra confirmation before discard, force-push, hard reset, etc.</small></div>
          <div class="control">
            <label class="medieval-toggle">
              <input type="checkbox" id="set-confirm-destructive" ${appSettings.confirmDestructive ? 'checked' : ''} />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>
      </div>
    `;
    panel.querySelector('#set-auto-focus').onchange = (e) => { appChanges.autoFetchOnFocus = e.target.checked; };
    panel.querySelector('#set-confirm-destructive').onchange = (e) => { appChanges.confirmDestructive = e.target.checked; };
  }

  function renderAppearance() {
    const builtinCards = BUILTIN_THEMES.map(t => themeCardHtml(t, appSettings.theme)).join('');
    panel.innerHTML = `
      <div class="settings-panel-title">Appearance</div>
      <div class="settings-group">
        <div class="settings-group-title">Theme</div>
        <p class="modal-text text-muted" style="font-size:12px;margin-bottom:10px">Pick a theme. Changes apply immediately as a preview; Save to keep.</p>
        <div class="theme-picker" id="theme-picker">${builtinCards}</div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Alacritty themes <span class="text-muted" style="font-weight:400">(${ALACRITTY_THEMES.length} imported)</span></div>
        <p class="modal-text text-muted" style="font-size:12px;margin-bottom:8px">Terminal color schemes from the Alacritty theme collection, mapped to the UI.</p>
        <input type="search" id="alac-search" class="commit-search" style="margin:0 0 10px;width:100%" placeholder="Search ${ALACRITTY_THEMES.length} themes (e.g. dracula, gruvbox, nord)…" />
        <div class="theme-picker theme-picker-scroll" id="alac-picker">
          ${ALACRITTY_THEMES.map(t => themeCardHtml(t, appSettings.theme)).join('')}
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Typography</div>
        <div class="settings-row">
          <div class="label">Font size<small>Multiplier for the UI text size</small></div>
          <div class="control">
            <input type="number" id="set-font-scale" min="0.75" max="1.5" step="0.05" value="${appSettings.fontScale}" />
            <span style="color:var(--muted-text);font-size:11px">× (0.75–1.5)</span>
          </div>
        </div>
      </div>
    `;
    // Theme cards: live preview on click (both built-in and Alacritty grids)
    const wireCards = () => panel.querySelectorAll('.theme-card').forEach(card => {
      card.onclick = () => {
        const id = card.dataset.theme;
        appChanges.theme = id;
        applyTheme(id);
        panel.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c === card));
      };
    });
    wireCards();

    // Alacritty search filter
    const search = panel.querySelector('#alac-search');
    if (search) {
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        panel.querySelectorAll('#alac-picker .theme-card').forEach(card => {
          const name = (card.dataset.name || '').toLowerCase();
          card.style.display = (!q || name.includes(q)) ? '' : 'none';
        });
      };
      search.onkeydown = (e) => { if (e.key === 'Escape') { search.value = ''; search.oninput(); } };
    }

    // Font scale
    const fs = panel.querySelector('#set-font-scale');
    fs.onchange = () => {
      const v = parseFloat(fs.value);
      if (!isNaN(v)) {
        appChanges.fontScale = v;
        applyFontScale(v);
      }
    };
  }

  // One theme card. `dark` flag (Alacritty) tunes the name text via CSS if needed.
  function themeCardHtml(t, currentId) {
    return `<button class="theme-card ${currentId === t.id ? 'active' : ''}" type="button" data-theme="${t.id}" data-name="${escapeHtml(t.name)}">
      <div class="theme-swatches">${t.swatches.map(c => `<span style="background:${c}"></span>`).join('')}</div>
      <div class="theme-card-name">${escapeHtml(t.name)}</div>
    </button>`;
  }

  function renderGitIdentity() {
    // Each row has: label, scope toggle (Global/Local), value input
    const rows = [
      { key: 'user.name',         label: 'User name',          hint: 'Your name as it appears in commits.' },
      { key: 'user.email',        label: 'Email',              hint: 'Email shown on commits.' },
      { key: 'init.defaultBranch', label: 'Default branch',    hint: 'Branch name used when initializing a new repo (e.g. "main").' },
      { key: 'core.editor',       label: 'Editor command',     hint: 'External editor for commit messages, rebases, etc.' },
      { key: 'pull.rebase',       label: 'Pull strategy',      hint: 'true = rebase on pull, false = merge, interactive = interactive rebase.' }
    ];

    panel.innerHTML = `
      <div class="settings-panel-title">Git Identity & Behavior</div>
      <p class="modal-text text-muted" style="font-size:12px;margin-bottom:12px">
        ${hasRepo
          ? `<strong style="color:var(--bone-white)">Local</strong> applies only to <strong class="text-red">${escapeHtml(repoLabel)}</strong>. <strong style="color:var(--bone-white)">Global</strong> is your default across all repos. Local overrides global where set.`
          : `<strong style="color:var(--bone-white)">Global</strong> applies to all repos. Open a repo to set per-repo overrides.`}
      </p>
      <div class="settings-group">
        ${rows.map(r => {
          const scope = currentScopeFor(r.key);
          const val = currentValueFor(r.key, scope);
          return `
            <div class="settings-row" data-key="${r.key}">
              <div class="label">${escapeHtml(r.label)}<small>${escapeHtml(r.hint)}</small></div>
              <div class="control">
                <div class="scope-toggle" data-scope="${scope}">
                  <button type="button" data-set-scope="global" class="${scope === 'global' ? 'active' : ''}">Global</button>
                  <button type="button" data-set-scope="local" class="${scope === 'local' ? 'active' : ''}" ${hasRepo ? '' : 'disabled title="Open a repo to set local config"'}>Local</button>
                </div>
                <input type="text" data-value-for="${r.key}" value="${escapeHtml(val)}" placeholder="(unset)" />
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Wire up scope toggles & input changes
    panel.querySelectorAll('.settings-row[data-key]').forEach(row => {
      const key = row.dataset.key;
      const input = row.querySelector('input[data-value-for]');
      const scopeBox = row.querySelector('.scope-toggle');

      scopeBox.querySelectorAll('button[data-set-scope]').forEach(btn => {
        btn.onclick = () => {
          if (btn.disabled) return;
          const newScope = btn.dataset.setScope;
          scopeBox.dataset.scope = newScope;
          scopeBox.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
          // Repopulate the input to reflect the value at the newly-selected scope
          input.value = currentValueFor(key, newScope);
          // Remove any pending change for this key (user is switching scope mid-edit)
          for (let i = gitChanges.length - 1; i >= 0; i--) {
            if (gitChanges[i].key === key) gitChanges.splice(i, 1);
          }
        };
      });

      input.oninput = () => {
        const scope = scopeBox.dataset.scope;
        setGitChange(scope, key, input.value);
      };
    });
  }

  function renderDefaults() {
    panel.innerHTML = `
      <div class="settings-panel-title">App Defaults</div>
      <div class="settings-group">
        <div class="settings-group-title">Graph view</div>
        <div class="settings-row">
          <div class="label">Default commit limit<small>How many commits to load when opening a repo</small></div>
          <div class="control">
            <input type="number" id="set-graph-limit" min="50" max="5000" step="50" value="${appSettings.graphLimit}" />
            <span style="color:var(--muted-text);font-size:11px">commits</span>
          </div>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">SSH</div>
        <div class="settings-row">
          <div class="label">Default SSH key path<small>Pre-fills the SSH key picker in Clone dialogs</small></div>
          <div class="control">
            <input type="text" id="set-ssh-key" value="${escapeHtml(appSettings.defaultSshKeyPath || '')}" placeholder="~/.ssh/id_ed25519" />
            <button class="mini-btn" id="set-ssh-key-browse" type="button">…</button>
          </div>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Repository initialization</div>
        <div class="settings-row">
          <div class="label">Default branch name<small>Used when initializing a new repository</small></div>
          <div class="control">
            <input type="text" id="set-default-branch" value="${escapeHtml(appSettings.defaultBranchName || 'main')}" placeholder="main" />
          </div>
        </div>
      </div>
    `;
    panel.querySelector('#set-graph-limit').onchange = (e) => {
      const v = parseInt(e.target.value, 10);
      if (!isNaN(v) && v >= 50) appChanges.graphLimit = v;
    };
    panel.querySelector('#set-ssh-key').oninput = (e) => { appChanges.defaultSshKeyPath = e.target.value; };
    panel.querySelector('#set-ssh-key-browse').onclick = async () => {
      const r = await gs.selectFile('Select default SSH private key');
      if (r && r.ok) {
        panel.querySelector('#set-ssh-key').value = r.data;
        appChanges.defaultSshKeyPath = r.data;
      }
    };
    panel.querySelector('#set-default-branch').oninput = (e) => { appChanges.defaultBranchName = e.target.value; };
  }

  async function renderAbout() {
    const pathR = await gs.appSettingsPath();
    const settingsFile = (pathR && pathR.ok) ? pathR.data : '(unknown)';
    panel.innerHTML = `
      <div class="settings-panel-title">About GitGood</div>
      <div class="settings-group">
        <p class="modal-text">A medieval-themed Git client. All operations use real <code>git</code> via <code>simple-git</code> — no proprietary repository format.</p>
        <div class="settings-row">
          <div class="label">Settings file</div>
          <div class="control"><div class="settings-path">${escapeHtml(settingsFile)}</div></div>
        </div>
        <div class="settings-row">
          <div class="label">Reset preferences</div>
          <div class="control">
            <button class="btn-medieval danger" id="set-reset-app" type="button">⟲ Reset App Preferences</button>
          </div>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Tips</div>
        <p class="modal-text text-muted" style="font-size:12px">
          • Right-click commits in the Graph for checkout, cherry-pick, revert, and reset.<br/>
          • Drag a branch pill in the Graph to move it to another commit.<br/>
          • Hold <kbd>Shift</kbd> or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> while clicking files in Changes for multi-select.<br/>
          • Open developer tools with <kbd>Ctrl+Shift+I</kbd> if something goes sideways.
        </p>
      </div>
    `;
    panel.querySelector('#set-reset-app').onclick = async () => {
      const ok = await modal.confirm({
        title: 'Reset App Preferences',
        message: 'Restore all app preferences to defaults? This does NOT touch git config or your repositories.',
        danger: true, confirmText: 'Reset'
      });
      if (!ok) return;
      const r = await gs.resetAppSettings();
      if (r && r.ok) {
        Object.assign(appSettings, r.data);
        Object.keys(appChanges).forEach(k => delete appChanges[k]);
        applyTheme(appSettings.theme);
        applyFontScale(appSettings.fontScale);
        showToast('Preferences reset', 'success');
      }
    };
  }

  // Tab switching
  const renderers = { general: renderGeneral, appearance: renderAppearance, git: renderGitIdentity, defaults: renderDefaults, about: renderAbout };
  body.querySelectorAll('.settings-nav-item').forEach(item => {
    item.onclick = () => {
      body.querySelectorAll('.settings-nav-item').forEach(i => i.classList.toggle('active', i === item));
      renderers[item.dataset.tab]();
    };
  });

  // Render initial tab
  renderGeneral();

  // Footer buttons
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => {
    // Roll back any live theme/font preview changes
    applyTheme(appSettings.theme);
    applyFontScale(appSettings.fontScale);
    modal.hide();
  };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-medieval primary';
  saveBtn.innerHTML = '<span class="btn-icon">✓</span> Save';
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    let appOk = true;
    let gitFailed = [];

    // Save app preferences first
    if (Object.keys(appChanges).length) {
      const r = await gs.setAppSettings(appChanges);
      if (!r || !r.ok) {
        appOk = false;
        showToast('Failed to save app preferences: ' + (r && r.error), 'error', 6000);
      } else {
        Object.assign(appSettings, appChanges);
        Object.keys(appChanges).forEach(k => delete appChanges[k]);
        // Re-apply in case Save changed anything
        applyTheme(appSettings.theme);
        applyFontScale(appSettings.fontScale);
      }
    }

    // Save git config changes
    if (gitChanges.length) {
      const r = await gs.setGitConfigBatch(gitChanges);
      if (!r || !r.ok) {
        showToast('Failed to save git config: ' + (r && r.error), 'error', 6000);
      } else {
        gitFailed = r.data.filter(x => !x.ok);
        if (gitFailed.length) {
          showToast(`${gitFailed.length} git config update(s) failed`, 'error', 6000);
        }
      }
    }

    saveBtn.disabled = false;
    if (appOk && !gitFailed.length) {
      showToast('Settings saved', 'success');
      modal.hide();
    }
  };

  modal.show({ title: '⚙ Settings', body, footer: [cancelBtn, saveBtn] });
}

// Default values mirrored on the renderer side (for reset fallback if backend
// is unreachable, which shouldn't happen but is harmless to keep).
const DEFAULT_APP_SETTINGS_LOCAL = {
  theme: 'crusader',
  defaultBranchName: 'main',
  graphLimit: 300,
  autoFetchOnFocus: true,
  confirmDestructive: true,
  defaultSshKeyPath: '',
  fontScale: 1.0
};

// Apply saved app settings (theme + font) at startup
async function applySavedAppSettings() {
  try {
    const r = await gs.getAppSettings();
    if (r && r.ok) {
      applyTheme(r.data.theme);
      applyFontScale(r.data.fontScale);
      // Mirror a few into state for downstream code
      if (typeof state !== 'undefined') {
        if (r.data.graphLimit) state.graphLimit = r.data.graphLimit;
      }
    }
  } catch (e) { /* harmless */ }
}

// Wire up Settings buttons (toolbar + welcome screen)
(() => {
  const wire = (id) => {
    const el = document.getElementById(id);
    if (el) el.onclick = () => showSettingsDialog();
  };
  wire('btn-settings');
  wire('welcome-settings');
})();

// ============================================
// PANE RESIZERS — drag handles between tab columns
// ============================================
const RESIZER_STORAGE_KEY = 'gitgood:pane-widths:v4';

// Resolve the grid container that a resizer controls.
// data-target can be:
//   - an element id (e.g. "graph-body")
//   - "data-panel:NAME" for a tab panel (e.g. "data-panel:changes" → [data-panel="changes"])
function resolveResizerTarget(targetAttr) {
  if (!targetAttr) return null;
  if (targetAttr.startsWith('data-panel:')) {
    const name = targetAttr.slice('data-panel:'.length);
    return document.querySelector(`[data-panel="${name}"]`);
  }
  return document.getElementById(targetAttr);
}

// Load persisted widths
function loadResizerWidths() {
  try {
    const raw = localStorage.getItem(RESIZER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function saveResizerWidths(map) {
  try { localStorage.setItem(RESIZER_STORAGE_KEY, JSON.stringify(map)); } catch (e) {}
}

// Apply saved widths to a grid container if any are stored under its resizer key.
// Validates the saved value so a corrupt/stale entry can never break the layout.
function applyResizerWidths(resizerEl) {
  const key = resizerEl.dataset.resizer;
  const widths = loadResizerWidths();
  const saved = widths[key];
  if (!saved || typeof saved !== 'string') return;

  const target = resolveResizerTarget(resizerEl.dataset.target);
  if (!target) return;

  // Validate: the saved template must have the same number of tracks as the authored
  // template (content columns + interleaved resizer columns) and must keep one flexible
  // (fr) track. Otherwise we ignore it and fall back to the CSS-defined layout.
  const dataCols = (resizerEl.dataset.cols || '').trim().split(/\s+/).filter(Boolean);
  const expectedContent = dataCols.length;              // e.g. 2 for "1fr 380px"
  const expectedTracks = expectedContent > 0 ? expectedContent * 2 - 1 : 0; // interleaved resizers
  const savedTracks = saved.trim().split(/\s+/).filter(Boolean);

  const looksValid =
    savedTracks.length === expectedTracks &&
    /fr/.test(saved) &&                                  // still has a flexible track
    savedTracks.every(t => /^(\d+(\.\d+)?(px|fr)|0)$/.test(t)) && // only px/fr/0 values
    !savedTracks.some(t => /px$/.test(t) && parseFloat(t) < 0);   // no negative widths

  if (!looksValid) {
    // Discard the bad entry so it can't keep breaking the layout.
    delete widths[key];
    saveResizerWidths(widths);
    return;
  }
  target.style.gridTemplateColumns = saved;
}

// Parse a grid-template-columns string into an array of values
// (preserving 'fr', 'px', etc.). Resolve 'fr' values to current pixel width
// using getComputedStyle so we can edit in pixels and put it all back.
function readGridColumns(target) {
  const tracks = getComputedStyle(target).gridTemplateColumns.split(/\s+/).filter(Boolean);
  // tracks are already in px from getComputedStyle
  return tracks.map(v => parseFloat(v));
}

// Set up a single resizer
function setupResizer(resizerEl) {
  const target = resolveResizerTarget(resizerEl.dataset.target);
  if (!target) return;

  // Determine which grid track should stay flexible (1fr). We read data-cols
  // (the original template authored in HTML, e.g. "280px 1fr 320px") and find the
  // index of the "1fr" entry among the CONTENT columns. In the live grid, resizer
  // columns are interleaved (content, resizer, content, resizer, content), so the
  // live index of the Nth content column is N*2.
  let flexLiveIndex = -1;
  const dataCols = (resizerEl.dataset.cols || '').trim().split(/\s+/).filter(Boolean);
  const flexContentIdx = dataCols.findIndex(c => c === '1fr' || c.endsWith('fr'));
  if (flexContentIdx >= 0) flexLiveIndex = flexContentIdx * 2; // account for interleaved resizers

  // Find this resizer's column index in the parent grid.
  // The resizer's previous and next siblings are the columns being resized.
  // The resizer is always a grid item itself, so its column index = #of preceding grid children.
  // Note: with `display: contents` on a wrapper, the resizer's siblings ARE the grid items.

  resizerEl.addEventListener('mousedown', (downEvt) => {
    downEvt.preventDefault();

    // Find the actual previous and next *grid items* (skip text nodes and the resizer itself)
    const gridChildren = Array.from(target.children).filter(el => {
      // If the layout uses `display: contents` wrapper, get actual rendered grid items
      const cs = getComputedStyle(el);
      return cs.display !== 'none';
    });
    // For `display: contents` wrappers, the real grid items are inside the wrapper.
    // We walk up from the resizer to find which siblings are the immediate columns.
    let prevEl = resizerEl.previousElementSibling;
    let nextEl = resizerEl.nextElementSibling;
    if (!prevEl || !nextEl) return;

    // Read current pixel widths of all columns
    const startCols = readGridColumns(target);
    // Find resizer's column index in the grid
    // We do this by counting how many grid-item ancestors of the resizer come before it
    // within the same grid track flow. Easier: just measure prev/next bounding rects.
    const prevRect = prevEl.getBoundingClientRect();
    const nextRect = nextEl.getBoundingClientRect();
    const startX = downEvt.clientX;
    const startPrevWidth = prevRect.width;
    const startNextWidth = nextRect.width;
    const totalCombined = startPrevWidth + startNextWidth;

    // Minimum widths so neither pane disappears
    const MIN = 120;

    resizerEl.classList.add('resizing');
    document.body.classList.add('resizing-panes');

    const onMove = (mvEvt) => {
      const delta = mvEvt.clientX - startX;
      let newPrev = startPrevWidth + delta;
      let newNext = startNextWidth - delta;
      if (newPrev < MIN) { newPrev = MIN; newNext = totalCombined - MIN; }
      if (newNext < MIN) { newNext = MIN; newPrev = totalCombined - MIN; }

      // Rebuild the grid-template-columns string. We replace the columns at
      // the indices of prevEl and nextEl. The resizer (5px) sits between them.
      // Strategy: read current tracks, find prev/next by their relative position,
      // and patch in the new pixel widths.
      const currentTracks = readGridColumns(target);
      // We need the indices of the prev/next columns. Since the resizer is one of the
      // grid items, scanning from `target.children` works only if the grid wrapper
      // is the target itself (no `display: contents` wrapper). For `display: contents`
      // we need to scan the wrapper's children too.

      // Use a flat walk of "rendered" grid children in the resizer's row
      const tracks = computeTrackList(target, resizerEl);
      const prevIdx = tracks.indexOf(prevEl);
      const nextIdx = tracks.indexOf(nextEl);
      if (prevIdx < 0 || nextIdx < 0) return;

      const newCols = currentTracks.slice();
      // Only assign fixed widths to the NON-flex column(s) of the dragged pair.
      // The flex column (diff) always stays 1fr and absorbs slack, so resizing one
      // side simply takes space from the flexible middle — the right panel stays
      // anchored to the edge with no empty gap.
      if (prevIdx !== flexLiveIndex) newCols[prevIdx] = newPrev;
      if (nextIdx !== flexLiveIndex) newCols[nextIdx] = newNext;
      target.style.gridTemplateColumns = newCols.map((w, i) => {
        // Keep resizer columns at 5px exact
        if (tracks[i] && tracks[i].classList && tracks[i].classList.contains('pane-resizer')) return '5px';
        // Keep the designated flex column flexible
        if (i === flexLiveIndex) return '1fr';
        return w + 'px';
      }).join(' ');
    };

    const onUp = () => {
      resizerEl.classList.remove('resizing');
      document.body.classList.remove('resizing-panes');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist — but only if the produced template is well-formed (right track count,
      // keeps a flexible column, no negatives). Never save a layout that could break.
      const tmpl = target.style.gridTemplateColumns;
      const dataColsArr = (resizerEl.dataset.cols || '').trim().split(/\s+/).filter(Boolean);
      const expectedTracks = dataColsArr.length > 0 ? dataColsArr.length * 2 - 1 : 0;
      const parts = (tmpl || '').trim().split(/\s+/).filter(Boolean);
      const valid = parts.length === expectedTracks &&
        /fr/.test(tmpl) &&
        parts.every(t => /^(\d+(\.\d+)?(px|fr)|0)$/.test(t)) &&
        !parts.some(t => /px$/.test(t) && parseFloat(t) < 0);
      if (valid) {
        const widths = loadResizerWidths();
        widths[resizerEl.dataset.resizer] = tmpl;
        saveResizerWidths(widths);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Compute the flat list of grid items that share the resizer's ROW — i.e. the columns
// the resizer actually sits between. Items that span the full width (e.g. a toolbar on
// another grid row) must be excluded, or the column indices get misaligned and resizing
// produces a corrupt grid-template-columns that collapses the layout.
function computeTrackList(target, resizerEl) {
  const all = [];
  function walk(el) {
    for (const child of el.children) {
      const cs = getComputedStyle(child);
      if (cs.display === 'contents') walk(child);
      else if (cs.display !== 'none') all.push(child);
    }
  }
  walk(target);

  if (!resizerEl) return all;

  // Keep only items whose vertical extent overlaps the resizer's (same grid row),
  // which naturally drops a full-width header/toolbar living on a different row.
  const rRect = resizerEl.getBoundingClientRect();
  const rMid = rRect.top + rRect.height / 2;
  const sameRow = all.filter(el => {
    if (el === resizerEl) return true;
    const b = el.getBoundingClientRect();
    return b.top <= rMid && b.bottom >= rMid;   // row overlaps the resizer's midline
  });
  return sameRow.length ? sameRow : all;
}

// Initialize all resizers on the page
(() => {
  // One-time cleanup: remove obsolete pane-width keys from older versions whose saved
  // values can break the (now restructured) layouts — notably the History panel.
  try {
    ['gitgood:pane-widths', 'gitgood:pane-widths:v1', 'gitgood:pane-widths:v2', 'gitgood:pane-widths:v3',
     'gitsouls:pane-widths', 'gitsouls:pane-widths:v1', 'gitsouls:pane-widths:v2'].forEach(k => {
      localStorage.removeItem(k);
    });
  } catch (e) {}

  // Set up on next tick so all stylesheets are applied first
  setTimeout(() => {
    document.querySelectorAll('.pane-resizer').forEach(el => {
      applyResizerWidths(el);
      setupResizer(el);
    });
  }, 100);

  // Provide a way to reset widths (could expose later via a menu)
  window.__resetPaneWidths = () => {
    try { localStorage.removeItem(RESIZER_STORAGE_KEY); } catch (e) {}
    location.reload();
  };
})();

