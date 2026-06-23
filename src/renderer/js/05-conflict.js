// CONFLICT BANNER & SECTION RENDERING
// ============================================

// Operation label mapping
const OP_LABELS = {
  merge: 'Merge in Progress',
  rebase: 'Rebase in Progress',
  'cherry-pick': 'Cherry-pick in Progress',
  revert: 'Revert in Progress'
};

function renderConflictBanner() {
  const banner = $('#conflict-banner');
  if (!banner) return;
  const op = state.conflicts && state.conflicts.operation;
  const files = (state.conflicts && state.conflicts.files) || [];

  if (!op && !files.length) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  $('#conflict-banner-title').textContent = op ? (OP_LABELS[op] || `${op} in Progress`) : 'Conflicts';

  const unresolved = files.filter(f => f.hasMarkers || !f.looksResolved);
  // Also count files still appearing as conflicted in status (UU, UD, DU, AA)
  const stillConflicted = files.filter(f => /^[UAD]$/.test(f.indexStatus) || /^[UAD]$/.test(f.workingDir));
  const remaining = stillConflicted.length;

  const subtitle = remaining > 0
    ? `${remaining} file${remaining === 1 ? '' : 's'} still needing resolution`
    : files.length > 0
      ? 'All conflicts resolved — ready to continue'
      : 'No conflicts';

  $('#conflict-banner-subtitle').textContent = subtitle;

  // Continue button is only enabled if no conflicts remain
  const continueBtn = $('#conflict-banner-continue');
  continueBtn.disabled = remaining > 0;
  continueBtn.title = remaining > 0 ? 'Resolve all conflicts first' : 'Continue the ' + op;
}

// Wire up the banner buttons once
(() => {
  const viewBtn = $('#conflict-banner-view');
  if (viewBtn) viewBtn.onclick = () => {
    // Always open the resolver — it now hosts ALL conflict kinds (text, binary, modify/
    // delete) with the file list on the left, so the click never silently no-ops.
    openConflictResolver();
  };

  const continueBtn = $('#conflict-banner-continue');
  if (continueBtn) continueBtn.onclick = async () => {
    const op = state.conflicts.operation || 'operation';
    const sure = await modal.confirm({
      title: 'Continue ' + (OP_LABELS[op] || op),
      message: `Continue the ${op}? All marked-resolved files will be used. A new commit will be created (where applicable).`,
      confirmText: 'Continue'
    });
    if (!sure) return;
    const r = await withLoading('Continuing ' + op, () => gs.operationContinue());
    if (handleResult(r, `Continued ${op}`)) await refreshAll();
  };

  const abortBtn = $('#conflict-banner-abort');
  if (abortBtn) abortBtn.onclick = async () => {
    const op = state.conflicts.operation || 'operation';
    const sure = await modal.confirm({
      title: 'Abort ' + (OP_LABELS[op] || op),
      message: `Abort the ${op} and return to the previous state? Any conflict resolution work will be lost.`,
      danger: true,
      confirmText: 'Abort'
    });
    if (!sure) return;
    const r = await withLoading('Aborting ' + op, () => gs.operationAbort());
    if (handleResult(r, `Aborted ${op}`)) await refreshAll();
  };
})();

// ============================================
// CONFLICT FILES SECTION (rendered inside Changes tab)
// ============================================
function renderConflictsSection() {
  try {
    _renderConflictsSection();
  } catch (err) {
    console.error('[GitGood renderConflictsSection ERROR]', err);
    const banner = document.getElementById('error-banner');
    const text = document.getElementById('error-text');
    if (banner && text) {
      text.textContent = 'Conflicts section error: ' + (err.message || err);
      banner.classList.add('show');
    }
  }
}

function _renderConflictsSection() {
  const files = (state.conflicts && state.conflicts.files) || [];
  // Remove any existing section first
  const existing = document.querySelector('.conflicts-section');
  if (existing) existing.remove();
  if (!files.length) return;

  const conflictedFiles = files.filter(f =>
    /^[UAD]$/.test(f.indexStatus || '') ||
    /^[UAD]$/.test(f.workingDir || '') ||
    !f.indexStatus || !f.workingDir
  );
  if (!conflictedFiles.length) return;

  const stagedList = document.querySelector('#staged-files');
  if (!stagedList) return;
  const filesCol = stagedList.closest('.changes-files');
  if (!filesCol) return;

  // The full conflict list now lives inside the resolver modal. Here in the Changes tab
  // we only show a compact entry-point so the user can jump into the resolver.
  const section = document.createElement('div');
  section.className = 'conflicts-section';
  section.innerHTML = `
    <div class="conflicts-banner">
      <span class="conflicts-banner-text">⚔ ${conflictedFiles.length} conflict${conflictedFiles.length === 1 ? '' : 's'} need resolution</span>
      <button class="conflict-mini-btn" id="conflicts-open-resolver">⚜ Open Resolver</button>
    </div>
  `;
  const firstChangesSec = filesCol.querySelector('.changes-section');
  if (firstChangesSec) filesCol.insertBefore(section, firstChangesSec);
  else filesCol.appendChild(section);

  const openBtn = section.querySelector('#conflicts-open-resolver');
  if (openBtn) openBtn.onclick = () => openConflictResolver();
}

// ============================================
// CONFLICT RESOLVER MODAL
// ============================================
// =============================================================================
// CONFLICT RESOLVER — persistent file list (left) + per-file editor (right).
// Open with a file path (or omit to auto-pick the first). The dialog stays open across
// resolutions: resolving a file removes it from the list and auto-loads the next.
// =============================================================================

// Helpers used by the editor (declared at module scope so they don't get rebuilt on each
// file load).
function _conflictResolutionLines(hunk, type) {
  if (type === 'ours') return hunk.ours || [];
  if (type === 'theirs') return hunk.theirs || [];
  if (type === 'ours-theirs') return [...(hunk.ours || []), ...(hunk.theirs || [])];
  if (type === 'theirs-ours') return [...(hunk.theirs || []), ...(hunk.ours || [])];
  return [];
}

// Refresh the resolver's left-side file list from current state, keeping the modal open.
function _refreshResolverFileList(container, currentPath, onPick) {
  const files = ((state.conflicts && state.conflicts.files) || []).filter(f =>
    /^[UAD]$/.test(f.indexStatus || '') ||
    /^[UAD]$/.test(f.workingDir || '') ||
    !f.indexStatus || !f.workingDir
  );
  container.innerHTML = '';
  if (!files.length) {
    container.innerHTML = '<li class="cr-files-empty">✓ All conflicts resolved</li>';
    return files;
  }
  files.forEach(f => {
    let kindLabel = 'both modified';
    let kindClass = 'both';
    if (f.deletedInOurs && !f.deletedInTheirs) { kindLabel = 'del by us · mod by them'; kindClass = 'del-ours'; }
    else if (f.deletedInTheirs && !f.deletedInOurs) { kindLabel = 'mod by us · del by them'; kindClass = 'del-theirs'; }
    else if (!f.base && f.ours && f.theirs) { kindLabel = 'both added'; kindClass = 'both-added'; }
    else if (f.isBinary) { kindLabel = 'binary'; kindClass = 'binary'; }
    const li = document.createElement('li');
    li.className = 'cr-file-item' + (f.path === currentPath ? ' active' : '');
    li.innerHTML = `
      <div class="cr-file-icon">⚔</div>
      <div class="cr-file-body">
        <div class="cr-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
        <div class="cr-file-kind cr-kind-${kindClass}">${kindLabel}</div>
      </div>`;
    li.onclick = () => onPick(f);
    container.appendChild(li);
  });
  return files;
}

// The resolver is a single modal that stays open across files. We track the currently-
// loaded file's path so post-resolution we can advance to the next.
let _resolverOpen = false;
let _resolverCurrentPath = null;

async function openConflictResolver(initialPath) {
  // If already open, just switch to the requested file in the same dialog.
  if (_resolverOpen) {
    if (initialPath && initialPath !== _resolverCurrentPath) await _resolverLoadFile(initialPath);
    return;
  }

  // Pick the first conflict if no path was given.
  const allConflicts = ((state.conflicts && state.conflicts.files) || []).filter(f =>
    /^[UAD]$/.test(f.indexStatus || '') || /^[UAD]$/.test(f.workingDir || '') || !f.indexStatus || !f.workingDir
  );
  if (!allConflicts.length) { showToast('No conflicts to resolve', 'info'); return; }
  let startPath = initialPath || allConflicts[0].path;

  // Build the shell: title + two-pane body (file list | editor) + footer (Done).
  const body = document.createElement('div');
  body.className = 'conflict-resolver-shell';
  body.innerHTML = `
    <div class="cr-files-pane">
      <div class="cr-files-header">Conflicting files</div>
      <ul class="cr-files-list" id="cr-files-list"></ul>
    </div>
    <div class="cr-editor-pane" id="cr-editor-pane">
      <div class="cr-editor-loading">Loading…</div>
    </div>
  `;

  const filesListEl = body.querySelector('#cr-files-list');
  const editorPaneEl = body.querySelector('#cr-editor-pane');

  // Footer button — closes the resolver. Continuing/aborting the operation stays on the
  // top banner (deliberate: those are operation-level, not per-file).
  const doneBtn = document.createElement('button');
  doneBtn.className = 'btn-medieval primary';
  doneBtn.textContent = 'Done';
  doneBtn.onclick = () => { _resolverOpen = false; _resolverCurrentPath = null; modal.hide(); };

  // Refresh the file list, with click → load that file.
  const onPick = (f) => _resolverLoadFile(f.path);
  _refreshResolverFileList(filesListEl, startPath, onPick);

  // Loader for a single file's editor (replaces the right pane content).
  async function _resolverLoadFile(filePath) {
    _resolverCurrentPath = filePath;
    // Re-highlight selected file
    _refreshResolverFileList(filesListEl, filePath, onPick);

    const conflictEntry = ((state.conflicts && state.conflicts.files) || []).find(f => f.path === filePath);
    const isBinary = !!(conflictEntry && conflictEntry.isBinary);
    const isModDel = !!(conflictEntry && (conflictEntry.deletedInOurs || conflictEntry.deletedInTheirs));

    editorPaneEl.innerHTML = `<div class="cr-editor-loading">Loading ${escapeHtml(filePath)}…</div>`;

    // Non-text conflicts (binary, modify/delete) → action panel instead of hunk editor.
    if (isBinary || isModDel) {
      editorPaneEl.innerHTML = '';
      const panel = document.createElement('div');
      panel.className = 'cr-nontext-panel';
      let blurb;
      if (conflictEntry.deletedInOurs && !conflictEntry.deletedInTheirs) {
        blurb = `<strong>${escapeHtml(filePath)}</strong> was deleted on your side but modified on the incoming side. Keep the incoming version, or confirm the deletion.`;
      } else if (conflictEntry.deletedInTheirs && !conflictEntry.deletedInOurs) {
        blurb = `<strong>${escapeHtml(filePath)}</strong> was modified on your side but deleted on the incoming side. Keep your modified version, or delete it as the incoming side did.`;
      } else if (isBinary) {
        blurb = `<strong>${escapeHtml(filePath)}</strong> is a binary file with conflicting versions. Pick one side — it can't be merged line-by-line.`;
      }
      panel.innerHTML = `
        <div class="cr-nontext-header">${escapeHtml(filePath)}</div>
        <p class="cr-nontext-text">${blurb}</p>
        <div class="cr-nontext-actions"></div>`;
      editorPaneEl.appendChild(panel);
      const actions = panel.querySelector('.cr-nontext-actions');

      const mkBtn = (label, cls, action) => {
        const b = document.createElement('button');
        b.className = 'btn-medieval ' + (cls || '');
        b.textContent = label;
        b.onclick = async () => { await action(); await _afterFileResolved(filePath); };
        actions.appendChild(b);
      };

      if (conflictEntry.deletedInOurs && !conflictEntry.deletedInTheirs) {
        mkBtn('⚿ Keep incoming version', 'primary', async () => {
          const r = await withLoading('Keeping file', () => gs.conflictKeepFile(filePath));
          if (!r.ok) showToast('Failed: ' + r.error, 'error', 6000);
        });
        mkBtn('✗ Confirm deletion', 'danger', async () => {
          const r = await withLoading('Deleting', () => gs.conflictDeleteFile(filePath));
          if (!r.ok) showToast('Failed: ' + r.error, 'error', 6000);
        });
      } else if (conflictEntry.deletedInTheirs && !conflictEntry.deletedInOurs) {
        mkBtn('⚿ Keep my version', 'primary', async () => {
          const r = await withLoading('Keeping file', () => gs.conflictKeepFile(filePath));
          if (!r.ok) showToast('Failed: ' + r.error, 'error', 6000);
        });
        mkBtn('✗ Delete (as incoming)', 'danger', async () => {
          const r = await withLoading('Deleting', () => gs.conflictDeleteFile(filePath));
          if (!r.ok) showToast('Failed: ' + r.error, 'error', 6000);
        });
      } else if (isBinary) {
        mkBtn('⚔ Use Ours', 'primary', async () => {
          const r = await withLoading('Using ours', () => gs.conflictUseOurs(filePath));
          if (!r.ok) showToast('Failed: ' + r.error, 'error', 6000);
        });
        mkBtn('⚔ Use Theirs', '', async () => {
          const r = await withLoading('Using theirs', () => gs.conflictUseTheirs(filePath));
          if (!r.ok) showToast('Failed: ' + r.error, 'error', 6000);
        });
      }
      return;
    }

    // Text conflict — parse and render the hunk editor.
    const parsedR = await gs.parseConflictFile(filePath);
    if (!parsedR.ok) {
      editorPaneEl.innerHTML = `<div class="cr-editor-error">Could not parse ${escapeHtml(filePath)}: ${escapeHtml(parsedR.error)}</div>`;
      return;
    }
    const { hunks, eol } = parsedR.data;
    const fileEol = eol || '\n';

    const resolutions = new Map();

    editorPaneEl.innerHTML = `
      <div class="conflict-resolver-toolbar">
        <span class="text-red">⚔</span>
        <span class="text-mono cr-current-path">${escapeHtml(filePath)}</span>
        <span class="conflict-resolver-progress" id="cr-progress"></span>
        <span class="cr-toolbar-spacer"></span>
        <button class="mini-btn" id="cr-all-ours" title="Take ours for every hunk">All Ours</button>
        <button class="mini-btn" id="cr-all-theirs" title="Take theirs for every hunk">All Theirs</button>
        <button class="mini-btn primary" id="cr-save" disabled>✓ Save &amp; Mark Resolved</button>
      </div>
      <div class="conflict-resolver-body" id="cr-body"></div>
    `;
    const bodyEl = editorPaneEl.querySelector('#cr-body');
    const progressEl = editorPaneEl.querySelector('#cr-progress');
    const saveBtn = editorPaneEl.querySelector('#cr-save');
    const allOursBtn = editorPaneEl.querySelector('#cr-all-ours');
    const allTheirsBtn = editorPaneEl.querySelector('#cr-all-theirs');

    const conflictHunkIndices = [];

    hunks.forEach((h, idx) => {
      if (h.type === 'common') {
        const div = document.createElement('div');
        div.className = 'cr-hunk-common';
        div.innerHTML = h.lines.map(l => `<div class="cr-hunk-common-line"><span class="cr-ln"></span><span>${escapeHtml(l) || '&nbsp;'}</span></div>`).join('');
        bodyEl.appendChild(div);
      } else {
        conflictHunkIndices.push(idx);
        const div = document.createElement('div');
        div.className = 'cr-hunk-conflict';
        div.dataset.hunkIdx = idx;
        div.innerHTML = `
          <div class="cr-hunk-actions">
            <span class="cr-label">Conflict #${conflictHunkIndices.length}</span>
            <button class="cr-action" data-pick="ours">Take Ours</button>
            <button class="cr-action" data-pick="theirs">Take Theirs</button>
            <button class="cr-action" data-pick="ours-theirs">Both (Ours, Theirs)</button>
            <button class="cr-action" data-pick="theirs-ours">Both (Theirs, Ours)</button>
            <button class="cr-action" data-pick="custom">✎ Edit</button>
          </div>
          <div class="cr-sides">
            <div class="cr-side ours">
              <div class="cr-side-header">⚔ Ours · ${escapeHtml(h.oursLabel || 'HEAD')}</div>
              ${(h.ours || []).map(l => `<div class="cr-side-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('')}
            </div>
            <div class="cr-side theirs">
              <div class="cr-side-header">⚔ Theirs · ${escapeHtml(h.theirsLabel || 'incoming')}</div>
              ${(h.theirs || []).map(l => `<div class="cr-side-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('')}
            </div>
          </div>
          <div class="cr-resolution" data-resolution style="display:none">
            <div class="cr-resolution-header">✓ Resolution</div>
            <div class="cr-resolution-content"></div>
          </div>
        `;

        div.querySelectorAll('button[data-pick]').forEach(btn => {
          btn.onclick = () => {
            const pick = btn.dataset.pick;
            if (pick === 'custom') {
              const existing = resolutions.get(idx);
              const initial = existing && existing.custom
                ? existing.custom.join('\n')
                : _conflictResolutionLines(h, existing ? existing.type : 'ours').join('\n');
              const resArea = div.querySelector('[data-resolution]');
              resArea.style.display = 'block';
              const contentDiv = resArea.querySelector('.cr-resolution-content');
              contentDiv.innerHTML = `<textarea class="cr-editor">${escapeHtml(initial)}</textarea>`;
              const ta = contentDiv.querySelector('textarea');
              ta.focus();
              ta.oninput = () => {
                resolutions.set(idx, { type: 'custom', custom: ta.value.split('\n') });
                renderProgress();
              };
              resolutions.set(idx, { type: 'custom', custom: ta.value.split('\n') });
              div.classList.add('resolved');
              div.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === btn));
            } else {
              resolutions.set(idx, { type: pick });
              div.classList.add('resolved');
              div.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === btn));
              const resArea = div.querySelector('[data-resolution]');
              resArea.style.display = 'block';
              const contentDiv = resArea.querySelector('.cr-resolution-content');
              const lines = _conflictResolutionLines(h, pick);
              contentDiv.innerHTML = lines.map(l => `<div class="cr-resolution-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
            }
            renderProgress();
          };
        });
        bodyEl.appendChild(div);
      }
    });

    function renderProgress() {
      const total = conflictHunkIndices.length;
      const done = conflictHunkIndices.filter(i => resolutions.has(i)).length;
      progressEl.innerHTML = `Resolved <strong>${done}</strong> / ${total} hunks`;
      saveBtn.disabled = done < total;
      saveBtn.title = done < total ? `${total - done} hunk(s) remain` : 'Save and mark as resolved';
    }
    renderProgress();

    const applyAll = (type) => {
      conflictHunkIndices.forEach(i => {
        if (!resolutions.has(i)) {
          resolutions.set(i, { type });
          const hunkDiv = bodyEl.querySelector(`[data-hunk-idx="${i}"]`);
          if (hunkDiv) {
            hunkDiv.classList.add('resolved');
            const pickBtn = hunkDiv.querySelector(`button[data-pick="${type}"]`);
            if (pickBtn) hunkDiv.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === pickBtn));
            const resArea = hunkDiv.querySelector('[data-resolution]');
            if (resArea) {
              resArea.style.display = 'block';
              const lines = type === 'ours' ? (hunks[i].ours || []) : (hunks[i].theirs || []);
              resArea.querySelector('.cr-resolution-content').innerHTML = lines.map(l => `<div class="cr-resolution-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
            }
          }
        }
      });
      renderProgress();
    };
    allOursBtn.onclick = () => applyAll('ours');
    allTheirsBtn.onclick = () => applyAll('theirs');

    saveBtn.onclick = async () => {
      const out = [];
      hunks.forEach((h, idx) => {
        if (h.type === 'common') { out.push(...h.lines); return; }
        const r = resolutions.get(idx);
        if (!r) { // shouldn't reach (save disabled), but be safe
          out.push(`<<<<<<< ${h.oursLabel || 'HEAD'}`);
          out.push(...(h.ours || []));
          out.push('=======');
          out.push(...(h.theirs || []));
          out.push(`>>>>>>> ${h.theirsLabel || 'incoming'}`);
        } else if (r.type === 'custom') {
          out.push(...(r.custom || []));
        } else {
          out.push(..._conflictResolutionLines(h, r.type));
        }
      });
      const content = out.join(fileEol);
      const writeR = await gs.writeFile({ path: filePath, content });
      if (!writeR.ok) { showToast('Write failed: ' + writeR.error, 'error', 6000); return; }
      const markR = await gs.conflictMarkResolved(filePath);
      if (!markR.ok) { showToast('Mark failed: ' + markR.error, 'error', 6000); return; }
      await _afterFileResolved(filePath);
    };
  }

  // Called after any file is resolved: refresh global conflict state, update the file
  // list (removing the just-resolved entry), and auto-advance to the next file or show a
  // success state if none remain.
  async function _afterFileResolved(filePath) {
    showToast(`Resolved: ${filePath}`, 'success', 2500);
    await refreshAll();
    const remaining = _refreshResolverFileList(filesListEl, null, onPick);
    if (!remaining.length) {
      editorPaneEl.innerHTML = `
        <div class="cr-all-done">
          <div class="cr-all-done-icon">✓</div>
          <h3>All conflicts resolved</h3>
          <p class="text-muted">You can now <strong>Continue</strong> the operation from the top banner to commit the merge result, or <strong>Done</strong> to close this dialog.</p>
        </div>`;
      _resolverCurrentPath = null;
    } else {
      await _resolverLoadFile(remaining[0].path);
    }
  }

  // Start
  _resolverOpen = true;
  modal.show({ title: 'Resolve Conflicts', body, footer: [doneBtn] });
  await _resolverLoadFile(startPath);
}

// When the modal closes externally, clear our open-state flag.
(() => {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  const obs = new MutationObserver(() => {
    if (overlay.classList.contains('hidden')) { _resolverOpen = false; _resolverCurrentPath = null; }
  });
  obs.observe(overlay, { attributes: true, attributeFilter: ['class'] });
})();


// ============================================
// HIDDEN INFO PANEL (empty folders, gitignored files)
// ============================================
// Shown only when there are no actual changes, to explain why "I created a folder
// but nothing showed up" — git can't track empty folders, and .gitignore'd content
// is intentionally hidden.
let hiddenInfoCache = null;
let hiddenInfoCacheTime = 0;
// Per-section collapsed state for the Changes-tab hidden-info panels. Both start
// collapsed; the user can expand by clicking a header. State persists for the session.
const hiddenInfoCollapsed = { empty: true, ignored: true };

async function renderHiddenInfo() {
  const el = $('#hidden-info');
  if (!el) return;

  // Cache for 4 seconds so we don't re-walk the filesystem on every status refresh
  const now = Date.now();
  if (!hiddenInfoCache || now - hiddenInfoCacheTime > 4000) {
    try {
      const r = await gs.inspectHidden();
      hiddenInfoCache = r.ok ? r.data : { emptyFolders: [], ignored: [] };
    } catch (e) {
      hiddenInfoCache = { emptyFolders: [], ignored: [] };
    }
    hiddenInfoCacheTime = now;
  }
  const { emptyFolders = [], ignored = [] } = hiddenInfoCache;

  if (!emptyFolders.length && !ignored.length) {
    el.innerHTML = '';
    return;
  }

  const sections = [];

  if (emptyFolders.length) {
    const rows = emptyFolders.slice(0, 20).map(p => `
      <li class="hidden-info-row" data-path="${escapeHtml(p)}">
        <span class="info-icon">⌬</span>
        <span class="info-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
        <button class="conflict-mini-btn" data-action="gitkeep">+ .gitkeep</button>
      </li>
    `).join('');
    const collapsed = hiddenInfoCollapsed.empty;
    sections.push(`
      <div class="hidden-info-section${collapsed ? ' collapsed' : ''}" data-section="empty">
        <div class="hidden-info-header clickable" data-toggle="empty" role="button" tabindex="0" aria-expanded="${!collapsed}">
          <span class="hidden-info-caret">▸</span>
          <span>⌬ Empty Folders (${emptyFolders.length})</span>
        </div>
        <div class="hidden-info-body">
          <div class="hidden-info-note">
            Git tracks files, not folders. Empty folders are invisible to git. Add a placeholder file (commonly <code>.gitkeep</code>) inside a folder to make git track it.
          </div>
          <ul class="hidden-info-list">${rows}</ul>
          ${emptyFolders.length > 20 ? `<div class="hidden-info-note">…and ${emptyFolders.length - 20} more</div>` : ''}
        </div>
      </div>
    `);
  }

  if (ignored.length) {
    const rows = ignored.slice(0, 20).map(p => `
      <li class="hidden-info-row">
        <span class="info-icon">⌽</span>
        <span class="info-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
      </li>
    `).join('');
    const collapsed = hiddenInfoCollapsed.ignored;
    sections.push(`
      <div class="hidden-info-section${collapsed ? ' collapsed' : ''}" data-section="ignored">
        <div class="hidden-info-header clickable" data-toggle="ignored" role="button" tabindex="0" aria-expanded="${!collapsed}">
          <span class="hidden-info-caret">▸</span>
          <span>⌽ Ignored by .gitignore (${ignored.length})</span>
        </div>
        <div class="hidden-info-body">
          <div class="hidden-info-note">
            These paths match rules in a <code>.gitignore</code> file and won't appear as changes. To track one anyway, edit the rules or use <code>git add -f &lt;path&gt;</code>.
          </div>
          <ul class="hidden-info-list">${rows}</ul>
          ${ignored.length > 20 ? `<div class="hidden-info-note">…and ${ignored.length - 20} more</div>` : ''}
        </div>
      </div>
    `);
  }

  el.innerHTML = sections.join('');

  // Header click/keyboard toggles the section open/closed.
  el.querySelectorAll('.hidden-info-header.clickable').forEach(header => {
    const toggle = () => {
      const key = header.dataset.toggle;
      hiddenInfoCollapsed[key] = !hiddenInfoCollapsed[key];
      const section = header.closest('.hidden-info-section');
      if (section) section.classList.toggle('collapsed', hiddenInfoCollapsed[key]);
      header.setAttribute('aria-expanded', String(!hiddenInfoCollapsed[key]));
    };
    header.onclick = toggle;
    header.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
  });

  // Wire up gitkeep buttons
  el.querySelectorAll('button[data-action="gitkeep"]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const row = btn.closest('.hidden-info-row');
      const folderPath = row && row.dataset.path;
      if (!folderPath) return;
      const r = await gs.addGitkeep(folderPath);
      if (handleResult(r, `Added .gitkeep to "${folderPath}"`)) {
        hiddenInfoCache = null; // invalidate cache so it refreshes
        await refreshStatus();
      }
    };
  });
}


function renderChanges() {
  const status = state.status;
  if (!status) return;

  // Build unique staged and unstaged file lists from status.files
  const stagedMap = new Map();
  const unstagedMap = new Map();

  (status.files || []).forEach(f => {
    const idx = (f.index || ' ');
    const wt = (f.working_dir || ' ');
    if (idx !== ' ' && idx !== '?') {
      stagedMap.set(f.path, { path: f.path, status: classifyByCode(idx) });
    }
    if (wt !== ' ') {
      unstagedMap.set(f.path, { path: f.path, status: wt === '?' ? 'untracked' : classifyByCode(wt) });
    }
  });

  state.stagedFiles = [...stagedMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  state.unstagedFiles = [...unstagedMap.values()].sort((a, b) => a.path.localeCompare(b.path));

  // Filter by search query (case-insensitive substring)
  const q = state.searchQuery.trim().toLowerCase();
  const matches = (f) => !q || f.path.toLowerCase().includes(q);
  const visibleStaged = state.stagedFiles.filter(matches);
  const visibleUnstaged = state.unstagedFiles.filter(matches);

  // Clean up multiSelected: remove keys for files that no longer exist
  const allValidKeys = new Set();
  state.stagedFiles.forEach(f => allValidKeys.add('staged:' + f.path));
  state.unstagedFiles.forEach(f => allValidKeys.add('unstaged:' + f.path));
  for (const key of [...state.multiSelected]) {
    if (!allValidKeys.has(key)) state.multiSelected.delete(key);
  }

  renderFileList($('#staged-files'), visibleStaged, true);
  renderFileList($('#unstaged-files'), visibleUnstaged, false);

  // Render the Conflicts section at the top of the changes-files column
  renderConflictsSection();

  // Render the hidden-info panel (empty folders, ignored files)
  // Only show it if there are no actual changes — otherwise it adds noise
  if (state.stagedFiles.length === 0 && state.unstagedFiles.length === 0) {
    renderHiddenInfo();
  } else {
    const el = $('#hidden-info');
    if (el) el.innerHTML = '';
  }

  const totalChanges = state.stagedFiles.length + state.unstagedFiles.length;
  const badge = $('#changes-tab-badge');
  if (totalChanges > 0) {
    badge.textContent = totalChanges;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  updateSelectionBar();

  // If selected file is no longer in the list, clear
  if (state.selectedFile) {
    const list = state.selectedFileStaged ? state.stagedFiles : state.unstagedFiles;
    const exists = list.find(f => f.path === state.selectedFile);
    if (!exists) {
      state.selectedFile = null;
      $('#diff-content').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚔</div>
          <p>Select a file to behold its changes.</p>
        </div>
      `;
      $('#diff-header-label').textContent = 'No file selected';
    }
  }
}

function updateSelectionBar() {
  const bar = $('#selection-bar');
  const count = state.multiSelected.size;
  if (count > 1) {
    bar.classList.add('visible');
    $('#sel-count').textContent = count;
    // Show only relevant action buttons depending on what kinds of files are selected
    const keys = [...state.multiSelected];
    const hasStaged = keys.some(k => k.startsWith('staged:'));
    const hasUnstaged = keys.some(k => k.startsWith('unstaged:'));
    $('#sel-stage').style.display = hasUnstaged ? '' : 'none';
    $('#sel-unstage').style.display = hasStaged ? '' : 'none';
    const stashBtn = $('#sel-stash');
    if (stashBtn) stashBtn.style.display = hasUnstaged && !hasStaged ? '' : 'none';
    $('#sel-discard').style.display = hasUnstaged ? '' : 'none';
  } else {
    bar.classList.remove('visible');
  }
}

function classifyByCode(code) {
  const map = {
    'A': 'added', 'M': 'modified', 'D': 'deleted',
    'R': 'renamed', 'C': 'renamed', 'U': 'conflicted', '?': 'untracked'
  };
  return map[code] || 'modified';
}

function renderFileList(container, files, staged) {
  container.innerHTML = '';
  if (!files.length) {
    const msg = state.searchQuery
      ? `No matches for "${escapeHtml(state.searchQuery)}"`
      : (staged ? 'No staged changes' : 'No unstaged changes');
    container.innerHTML = `<li class="file-empty">${msg}</li>`;
    return;
  }
  files.forEach(f => {
    const key = (staged ? 'staged:' : 'unstaged:') + f.path;
    const isMulti = state.multiSelected.has(key);
    const isSelected = state.selectedFile === f.path && state.selectedFileStaged === staged;

    // Check if this file is currently in conflict
    const conflictFiles = (state.conflicts && state.conflicts.files) || [];
    const conflictEntry = conflictFiles.find(c => c.path === f.path);
    const isConflicted = f.status === 'conflicted' || !!conflictEntry;

    const li = document.createElement('li');
    li.className = 'file-item'
      + (isSelected ? ' selected' : '')
      + (isMulti ? ' multi-selected' : '')
      + (isConflicted ? ' is-conflicted' : '');
    li.dataset.path = f.path;
    li.dataset.staged = staged ? '1' : '0';
    li.dataset.key = key;
    li.dataset.context = 'file';

    const letter = ({
      added: 'A', modified: 'M', deleted: 'D', renamed: 'R',
      conflicted: '!', untracked: 'U'
    })[f.status] || 'M';

    let actionsInner;
    if (isConflicted) {
      // Conflicted files: surface resolve actions, no stage/discard
      const isResolvable = conflictEntry && !conflictEntry.isBinary && !conflictEntry.deletedInOurs && !conflictEntry.deletedInTheirs;
      actionsInner = `
        <button class="file-action-btn" data-action="cf-ours" title="Use our version">Ours</button>
        <button class="file-action-btn" data-action="cf-theirs" title="Use their version">Theirs</button>
        ${isResolvable ? `<button class="file-action-btn" data-action="cf-resolve" title="Open three-way resolver" style="border-color:var(--crusader-red);color:var(--crusader-red-bright)">⚜ Resolve</button>` : ''}
      `;
    } else if (staged) {
      actionsInner = `<button class="file-action-btn" data-action="unstage" title="Unstage">⇣</button>`;
    } else {
      actionsInner = `<button class="file-action-btn" data-action="stage" title="Stage">⇡</button>
                     <button class="file-action-btn" data-action="stash" title="Stash this file">⚿</button>
                     <button class="file-action-btn" data-action="discard" title="Discard">✕</button>`;
    }

    li.innerHTML = `
      <div class="file-checkbox" title="Select"></div>
      <div class="file-status ${f.status}">${letter}</div>
      <div class="file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
      <div class="file-actions">${actionsInner}</div>
    `;

    li.onclick = (e) => {
      // Quick-action buttons inside the row
      const btn = e.target.closest('.file-action-btn');
      if (btn) {
        const action = btn.dataset.action;
        e.stopPropagation();
        if (action === 'stage') stageFiles([f.path]);
        else if (action === 'unstage') unstageFiles([f.path]);
        else if (action === 'stash') showStashMenu({ paths: [f.path] });
        else if (action === 'discard') discardFiles([f.path]);
        else if (action === 'cf-ours') {
          (async () => {
            const r = await withLoading('Resolving with ours', () => gs.conflictResolveSide({ filePath: f.path, side: 'ours' }));
            if (handleResult(r, 'Resolved with ours')) await refreshAll();
          })();
        } else if (action === 'cf-theirs') {
          (async () => {
            const r = await withLoading('Resolving with theirs', () => gs.conflictResolveSide({ filePath: f.path, side: 'theirs' }));
            if (handleResult(r, 'Resolved with theirs')) await refreshAll();
          })();
        } else if (action === 'cf-resolve') {
          openConflictResolver(f.path);
        }
        return;
      }

      const isCheckbox = e.target.classList.contains('file-checkbox');

      // Selection model mirrors Windows Explorer:
      //  • Shift+click       → select the contiguous range from the anchor to this row,
      //                        REPLACING the current selection (the anchor stays put).
      //  • Ctrl+Shift+click  → ADD that range to the current selection (anchor stays put).
      //  • Ctrl/Cmd+click or checkbox → toggle just this row; it becomes the new anchor.
      //  • Plain click       → single-select this row (and show its diff); anchor = row.
      const shift = e.shiftKey;
      const ctrl = e.ctrlKey || e.metaKey;

      if (shift && state.lastClickedKey) {
        const range = rangeKeys(state.lastClickedKey, key);
        if (ctrl) {
          for (const k of range) state.multiSelected.add(k);   // Ctrl+Shift: extend
        } else {
          state.multiSelected = new Set(range);                // Shift: replace
        }
        // The anchor deliberately does NOT move on a shift-click.
      } else if (ctrl || isCheckbox) {
        // Toggle just this row (a plain click already put the prior selection in the set,
        // so a previously-selected file is preserved — Windows keeps it).
        toggleMultiSelect(key);
        state.lastClickedKey = key;
      } else {
        // Plain click: this row becomes the whole selection — clear the rest, mark just
        // this one (so its checkbox shows checked, like Windows) and show its diff.
        state.multiSelected.clear();
        state.multiSelected.add(key);
        state.lastClickedKey = key;
        selectFile(f.path, staged);
        // Fall through to the re-render so the checkbox/highlight reflect the selection.
      }

      // Re-render so the row visuals update.
      renderFileList(container, files, staged);
      updateSelectionBar();
    };

    li.oncontextmenu = (e) => {
      e.preventDefault();
      // If the right-clicked item isn't in the multi-selection, treat it as a single
      // selection and make it the anchor, so a later shift-click extends from this row.
      if (!state.multiSelected.has(key)) {
        state.multiSelected.clear();
        state.multiSelected.add(key);
        state.lastClickedKey = key;
      }
      const selectedKeys = [...state.multiSelected];
      const selectedPaths = selectedKeys.map(k => k.split(':').slice(1).join(':'));
      const allStaged = selectedKeys.every(k => k.startsWith('staged:'));
      const allUnstaged = selectedKeys.every(k => k.startsWith('unstaged:'));

      const items = [];
      if (allUnstaged) items.push({ label: `Stage (${selectedPaths.length})`, icon: '⇡', action: () => stageFiles(selectedPaths) });
      if (allStaged) items.push({ label: `Unstage (${selectedPaths.length})`, icon: '⇣', action: () => unstageFiles(selectedPaths) });
      if (allUnstaged) items.push({ label: `Stash (${selectedPaths.length})`, icon: '⚿', action: () => showStashMenu({ paths: selectedPaths }) });
      if (allUnstaged) items.push({ label: `Discard (${selectedPaths.length})`, icon: '✕', danger: true, action: () => discardFiles(selectedPaths) });
      items.push({ label: `Add to .gitignore (${selectedPaths.length})`, icon: '⊘', action: () => addPathsToGitignore(selectedPaths) });
      if (items.length) items.push('sep');
      items.push({ label: 'Copy path' + (selectedPaths.length > 1 ? 's' : ''), icon: '⎘', action: () => {
        navigator.clipboard.writeText(selectedPaths.join('\n'));
        showToast(`Copied ${selectedPaths.length} path${selectedPaths.length === 1 ? '' : 's'}`, 'success');
      }});
      if (selectedKeys.length > 1) {
        items.push('sep');
        items.push({ label: 'Clear selection', icon: '✕', action: () => {
          clearMultiSelection();
          renderChanges();
        }});
      }
      showContextMenu(items, e.pageX, e.pageY);
    };

    container.appendChild(li);
  });
}

function toggleMultiSelect(key) {
  if (state.multiSelected.has(key)) state.multiSelected.delete(key);
  else state.multiSelected.add(key);
}

// Fully reset multi-selection, including the shift-range anchor, so a later shift-click
// starts fresh.
function clearMultiSelection() {
  state.multiSelected.clear();
  state.lastClickedKey = null;
}

// Return the contiguous list of selection keys from `fromKey` to `toKey` in the visible
// (filter-aware) order — staged files first, then unstaged. Used for Shift-range selection;
// order-independent, so it handles the anchor being above or below the clicked row.
function rangeKeys(fromKey, toKey) {
  const q = state.searchQuery.trim().toLowerCase();
  const matches = (f) => !q || f.path.toLowerCase().includes(q);
  const orderedKeys = [
    ...state.stagedFiles.filter(matches).map(f => 'staged:' + f.path),
    ...state.unstagedFiles.filter(matches).map(f => 'unstaged:' + f.path)
  ];
  const a = orderedKeys.indexOf(fromKey);
  const b = orderedKeys.indexOf(toKey);
  if (a < 0 || b < 0) return [toKey];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return orderedKeys.slice(lo, hi + 1);
}

async function selectFile(path, staged) {
  state.selectedFile = path;
  state.selectedFileStaged = staged;
  // Clear all selection visuals first
  $$('.file-item').forEach(el => {
    el.classList.remove('selected');
    el.classList.remove('multi-selected');
  });
  $$('.file-item').forEach(el => {
    if (el.dataset.path === path) {
      const inStaged = el.closest('#staged-files');
      if ((inStaged && staged) || (!inStaged && !staged)) {
        el.classList.add('selected');
      }
    }
  });
  updateSelectionBar();

  $('#diff-header-label').textContent = `${staged ? '⌃' : '⌄'} ${path}`;
  $('#diff-content').innerHTML = '<div class="empty-state"><span class="loading"></span></div>';

  const result = staged ? await gs.diffStaged(path) : await gs.diffUnstaged(path);
  if (!result.ok) {
    $('#diff-content').innerHTML = `<div class="empty-state"><p class="text-red">${escapeHtml(result.error)}</p></div>`;
    return;
  }

  if (!result.data || !result.data.trim()) {
    // Untracked file — show its raw content
    if (!staged) {
      const fileResult = await gs.fileContent(path);
      if (fileResult.ok && fileResult.data !== null) {
        const lines = (fileResult.data || '').split('\n');
        const html = lines.map((l, i) =>
          `<div class="diff-line add"><div class="diff-gutter"></div><div class="diff-gutter">${i + 1}</div><div class="diff-text">+${escapeHtml(l)}</div></div>`
        ).join('');
        $('#diff-content').innerHTML = html || '<div class="empty-state"><p>Empty file.</p></div>';
        return;
      }
    }
    $('#diff-content').innerHTML = '<div class="empty-state"><p>No textual differences (binary or empty).</p></div>';
    return;
  }

  $('#diff-content').innerHTML = renderDiff(result.data);
}

// ============================================
// STATUS BAR
// ============================================
function updateStatusBar() {
  const s = state.status;
  if (!s) return;
  $('#status-branch').textContent = '⑂ ' + (s.current || 'no branch');
  const changes = (s.files || []).length;
  $('#status-changes').textContent = `${changes} change${changes === 1 ? '' : 's'}`;
  $('#status-ahead-behind').textContent = `↑${s.ahead || 0} ↓${s.behind || 0}`;

  const ahead = s.ahead || 0;
  const behind = s.behind || 0;

  // Toolbar — counts of commits to push / to pull, shown directly on the Sync button
  // so they're visible without opening the dropdown.
  const syncCountPush = $('#sync-count-push');
  const syncCountPushN = document.getElementById('sync-count-push-n');
  const syncCountPull = $('#sync-count-pull');
  const syncCountPullN = document.getElementById('sync-count-pull-n');
  if (syncCountPush) {
    syncCountPush.style.display = ahead > 0 ? 'inline-flex' : 'none';
    if (syncCountPushN) syncCountPushN.textContent = ahead;
    syncCountPush.title = ahead > 0 ? `${ahead} commit${ahead === 1 ? '' : 's'} to push` : '';
  }
  if (syncCountPull) {
    syncCountPull.style.display = behind > 0 ? 'inline-flex' : 'none';
    if (syncCountPullN) syncCountPullN.textContent = behind;
    syncCountPull.title = behind > 0 ? `${behind} commit${behind === 1 ? '' : 's'} to pull (last fetched)` : '';
  }

  // Same counts also displayed inside the dropdown next to Push/Pull items.
  const pushBadge = $('#push-badge');
  const pullBadge = $('#pull-badge');
  if (pushBadge) {
    if (ahead > 0) { pushBadge.textContent = ahead; pushBadge.style.display = 'inline-block'; pushBadge.title = `${ahead} commit(s) to push`; }
    else pushBadge.style.display = 'none';
  }
  if (pullBadge) {
    if (behind > 0) { pullBadge.textContent = behind; pullBadge.style.display = 'inline-block'; pullBadge.title = `${behind} commit(s) to pull`; }
    else pullBadge.style.display = 'none';
  }
  // The small dot is redundant now that counts are visible, but keep it for the case
  // when both counts are >0 — it still gives a quick "needs sync" cue at a glance.
  const dot = $('#sync-dot');
  if (dot) {
    const has = (ahead > 0) || (behind > 0);
    dot.style.display = 'none';   // counts now make this redundant
    dot.title = has ? `↑${ahead} to push · ↓${behind} to pull` : '';
  }
}

// ============================================
