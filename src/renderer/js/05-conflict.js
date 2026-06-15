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
    const files = (state.conflicts && state.conflicts.files) || [];
    // Find the first file that's still in conflict and is resolvable interactively
    const firstText = files.find(f => {
      const conflicted = /^U$/.test(f.indexStatus) || /^U$/.test(f.workingDir);
      return conflicted && !f.isBinary && !f.deletedInOurs && !f.deletedInTheirs;
    });
    if (firstText) {
      openConflictResolver(firstText.path);
      return;
    }
    // No text conflict to resolve — fall back to switching to Changes tab so the user
    // can use Keep File / Delete File / Use Ours / Use Theirs on the non-text conflicts.
    const tab = document.querySelector('.tab[data-tab="changes"]');
    if (tab) tab.click();
    setTimeout(() => {
      const first = document.querySelector('.conflict-file-item');
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
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

  // Filter: files still appearing as conflicted in status (U in either column,
  // or files reported by ls-files --unmerged at all — they are by definition unmerged)
  // We use a permissive filter so that conflicts always surface, even if the status
  // letters are unexpected (e.g. AA, DU, UA).
  const conflictedFiles = files.filter(f =>
    /^[UAD]$/.test(f.indexStatus || '') ||
    /^[UAD]$/.test(f.workingDir || '') ||
    !f.indexStatus || !f.workingDir
  );
  if (!conflictedFiles.length) return;

  // Insert at the top of the changes-files column (before the search wrap area's siblings)
  const stagedList = document.querySelector('#staged-files');
  if (!stagedList) {
    console.warn('[renderConflictsSection] #staged-files not in DOM');
    return;
  }
  const filesCol = stagedList.closest('.changes-files');
  if (!filesCol) {
    console.warn('[renderConflictsSection] .changes-files not in DOM');
    return;
  }

  const section = document.createElement('div');
  section.className = 'conflicts-section';
  section.innerHTML = `
    <div class="conflicts-header">
      <span>⚔ Conflicts (${conflictedFiles.length})</span>
      <button class="conflict-mini-btn" id="conflicts-resolve-all">⚜ Open Resolver</button>
    </div>
    <ul class="conflict-file-list" id="conflict-file-list"></ul>
  `;

  // Insert right after the search wrap and selection bar (i.e., before the first .changes-section)
  const firstChangesSec = filesCol.querySelector('.changes-section');
  if (firstChangesSec) filesCol.insertBefore(section, firstChangesSec);
  else filesCol.appendChild(section);

  const list = section.querySelector('#conflict-file-list');
  conflictedFiles.forEach(f => {
    let kindLabel = 'both modified';
    if (f.deletedInOurs && !f.deletedInTheirs) kindLabel = 'deleted by us · modified by them';
    else if (f.deletedInTheirs && !f.deletedInOurs) kindLabel = 'modified by us · deleted by them';
    else if (!f.base && f.ours && f.theirs) kindLabel = 'both added';
    if (f.isBinary) kindLabel += ' · binary';

    const li = document.createElement('li');
    li.className = 'conflict-file-item';

    // Three action sets depending on conflict kind
    let actionsHtml = '';
    if (f.deletedInOurs || f.deletedInTheirs) {
      actionsHtml = `
        <button class="conflict-mini-btn" data-action="keep" title="Keep the file (whichever side has it)">Keep File</button>
        <button class="conflict-mini-btn" data-action="delete" title="Delete the file">Delete File</button>
      `;
    } else if (f.isBinary) {
      actionsHtml = `
        <button class="conflict-mini-btn" data-action="ours" title="Take our version">Use Ours</button>
        <button class="conflict-mini-btn" data-action="theirs" title="Take their version">Use Theirs</button>
      `;
    } else {
      actionsHtml = `
        <button class="conflict-mini-btn" data-action="ours" title="Replace with our version">Use Ours</button>
        <button class="conflict-mini-btn" data-action="theirs" title="Replace with their version">Use Theirs</button>
        <button class="conflict-mini-btn primary" data-action="resolve" title="Open in three-way resolver">⚜ Resolve…</button>
      `;
    }

    li.innerHTML = `
      <div class="conflict-file-icon">⚔</div>
      <div class="conflict-file-info">
        <div class="conflict-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
        <div class="conflict-file-meta">${escapeHtml(kindLabel)}</div>
      </div>
      <div class="conflict-file-actions">${actionsHtml}</div>
    `;

    li.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'ours' || action === 'theirs') {
          const r = await withLoading(`Resolving with ${action}`, () => gs.conflictResolveSide({ filePath: f.path, side: action }));
          if (handleResult(r, `Resolved with ${action}`)) await refreshAll();
        } else if (action === 'keep') {
          const r = await withLoading('Keeping file', () => gs.conflictKeepFile(f.path));
          if (handleResult(r, 'File kept')) await refreshAll();
        } else if (action === 'delete') {
          const sure = await modal.confirm({
            title: 'Delete File',
            message: `Delete "${f.path}" as part of this conflict resolution? This stages the deletion.`,
            danger: true, confirmText: 'Delete'
          });
          if (!sure) return;
          const r = await withLoading('Deleting file', () => gs.conflictDeleteFile(f.path));
          if (handleResult(r, 'File deleted')) await refreshAll();
        } else if (action === 'resolve') {
          openConflictResolver(f.path);
        }
      };
    });

    // Click on the row itself (not buttons) opens the resolver for text files
    li.onclick = (e) => {
      if (e.target.closest('button')) return;
      if (!f.isBinary && !f.deletedInOurs && !f.deletedInTheirs) {
        openConflictResolver(f.path);
      }
    };

    list.appendChild(li);
  });

  // "Open Resolver" header button — opens first conflicted text file
  const resolveAllBtn = section.querySelector('#conflicts-resolve-all');
  if (resolveAllBtn) resolveAllBtn.onclick = () => {
    const first = conflictedFiles.find(f => !f.isBinary && !f.deletedInOurs && !f.deletedInTheirs);
    if (first) openConflictResolver(first.path);
    else showToast('No text conflicts to resolve interactively', 'info');
  };
}

// ============================================
// CONFLICT RESOLVER MODAL
// ============================================
async function openConflictResolver(filePath) {
  // Fetch parsed hunks and the three versions
  const parsedR = await withLoading('Loading conflict', () => gs.parseConflictFile(filePath));
  if (!parsedR.ok) {
    showToast('Could not parse: ' + parsedR.error, 'error', 6000);
    return;
  }
  const { hunks, eol } = parsedR.data;
  const fileEol = eol || '\n';

  // Per-hunk resolution: index → { type: 'ours' | 'theirs' | 'ours-theirs' | 'theirs-ours' | 'custom', custom: string[] }
  // Initialize: nothing resolved yet
  const resolutions = new Map();

  const body = document.createElement('div');
  body.className = 'conflict-resolver';
  body.innerHTML = `
    <div class="conflict-resolver-toolbar">
      <span class="text-red">⚔</span>
      <span class="text-mono">${escapeHtml(filePath)}</span>
      <span class="conflict-resolver-progress" id="cr-progress"></span>
    </div>
    <div class="conflict-resolver-body" id="cr-body"></div>
  `;

  const bodyEl = body.querySelector('#cr-body');
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
            // Replace resolution area with a textarea pre-filled with current resolution or ours
            const existing = resolutions.get(idx);
            const initial = existing && existing.custom
              ? existing.custom.join('\n')
              : computeResolutionLines(h, existing ? existing.type : 'ours').join('\n');
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
            // Set initial state
            resolutions.set(idx, { type: 'custom', custom: ta.value.split('\n') });
            div.classList.add('resolved');
            // Update button states
            div.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === btn));
          } else {
            resolutions.set(idx, { type: pick });
            div.classList.add('resolved');
            div.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === btn));
            // Show resolution preview
            const resArea = div.querySelector('[data-resolution]');
            resArea.style.display = 'block';
            const contentDiv = resArea.querySelector('.cr-resolution-content');
            const lines = computeResolutionLines(h, pick);
            contentDiv.innerHTML = lines.map(l => `<div class="cr-resolution-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
          }
          renderProgress();
        };
      });

      bodyEl.appendChild(div);
    }
  });

  function computeResolutionLines(hunk, type) {
    if (type === 'ours') return hunk.ours || [];
    if (type === 'theirs') return hunk.theirs || [];
    if (type === 'ours-theirs') return [...(hunk.ours || []), ...(hunk.theirs || [])];
    if (type === 'theirs-ours') return [...(hunk.theirs || []), ...(hunk.ours || [])];
    return [];
  }

  function renderProgress() {
    const total = conflictHunkIndices.length;
    const done = conflictHunkIndices.filter(i => resolutions.has(i)).length;
    const progress = body.querySelector('#cr-progress');
    if (progress) progress.innerHTML = `Resolved <strong>${done}</strong> / ${total} hunks`;
    if (saveBtn) {
      saveBtn.disabled = done < total;
      saveBtn.title = done < total ? `${total - done} hunk(s) remain` : 'Save and mark as resolved';
    }
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const allOursBtn = document.createElement('button');
  allOursBtn.className = 'btn-medieval';
  allOursBtn.textContent = 'All Ours';
  allOursBtn.title = 'Take ours for every remaining conflict';
  allOursBtn.onclick = () => {
    conflictHunkIndices.forEach(i => {
      if (!resolutions.has(i)) {
        resolutions.set(i, { type: 'ours' });
        const hunkDiv = body.querySelector(`[data-hunk-idx="${i}"]`);
        if (hunkDiv) {
          hunkDiv.classList.add('resolved');
          const oursBtn = hunkDiv.querySelector('button[data-pick="ours"]');
          if (oursBtn) {
            hunkDiv.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === oursBtn));
          }
          const resArea = hunkDiv.querySelector('[data-resolution]');
          if (resArea) {
            resArea.style.display = 'block';
            const lines = hunks[i].ours || [];
            resArea.querySelector('.cr-resolution-content').innerHTML = lines.map(l => `<div class="cr-resolution-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
          }
        }
      }
    });
    renderProgress();
  };

  const allTheirsBtn = document.createElement('button');
  allTheirsBtn.className = 'btn-medieval';
  allTheirsBtn.textContent = 'All Theirs';
  allTheirsBtn.onclick = () => {
    conflictHunkIndices.forEach(i => {
      if (!resolutions.has(i)) {
        resolutions.set(i, { type: 'theirs' });
        const hunkDiv = body.querySelector(`[data-hunk-idx="${i}"]`);
        if (hunkDiv) {
          hunkDiv.classList.add('resolved');
          const theirsBtn = hunkDiv.querySelector('button[data-pick="theirs"]');
          if (theirsBtn) {
            hunkDiv.querySelectorAll('button[data-pick]').forEach(b => b.classList.toggle('active', b === theirsBtn));
          }
          const resArea = hunkDiv.querySelector('[data-resolution]');
          if (resArea) {
            resArea.style.display = 'block';
            const lines = hunks[i].theirs || [];
            resArea.querySelector('.cr-resolution-content').innerHTML = lines.map(l => `<div class="cr-resolution-line">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
          }
        }
      }
    });
    renderProgress();
  };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-medieval primary';
  saveBtn.innerHTML = '<span class="btn-icon">✓</span> Save & Mark Resolved';
  saveBtn.disabled = true;
  saveBtn.onclick = async () => {
    // Build the final file content by walking hunks and substituting resolutions
    const out = [];
    hunks.forEach((h, idx) => {
      if (h.type === 'common') {
        out.push(...h.lines);
      } else {
        const r = resolutions.get(idx);
        if (!r) {
          // Should not happen since save is disabled until all resolved, but be safe
          out.push(`<<<<<<< ${h.oursLabel || 'HEAD'}`);
          out.push(...(h.ours || []));
          out.push('=======');
          out.push(...(h.theirs || []));
          out.push(`>>>>>>> ${h.theirsLabel || 'incoming'}`);
        } else if (r.type === 'custom') {
          out.push(...(r.custom || []));
        } else {
          out.push(...computeResolutionLines(h, r.type));
        }
      }
    });
    const content = out.join(fileEol);
    modal.hide();

    // Write the resolved file, then stage it
    const writeR = await gs.writeFile({ path: filePath, content });
    if (!writeR.ok) { showToast('Write failed: ' + writeR.error, 'error', 6000); return; }
    const markR = await gs.conflictMarkResolved(filePath);
    if (!handleResult(markR, `Resolved: ${filePath}`)) return;
    await refreshAll();
  };

  renderProgress();

  modal.show({
    title: 'Resolve Conflict',
    body,
    footer: [cancelBtn, allOursBtn, allTheirsBtn, saveBtn]
  });
}


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

      // Checkbox click = pure toggle, no view-diff
      const isCheckbox = e.target.classList.contains('file-checkbox');

      // Modifier keys: Ctrl/Cmd to toggle, Shift for range
      if (e.shiftKey && state.lastClickedKey) {
        selectRange(state.lastClickedKey, key);
      } else if (e.ctrlKey || e.metaKey || isCheckbox) {
        toggleMultiSelect(key);
      } else {
        // Plain click: clear multi-select, select single file
        state.multiSelected.clear();
        state.lastClickedKey = key;
        selectFile(f.path, staged);
        return;
      }

      state.lastClickedKey = key;
      // Re-render so the row visuals update
      renderFileList(container, files, staged);
      updateSelectionBar();
    };

    li.oncontextmenu = (e) => {
      e.preventDefault();
      // If the right-clicked item isn't in the multi-selection, treat it as a single
      if (!state.multiSelected.has(key)) {
        state.multiSelected.clear();
        state.multiSelected.add(key);
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
      if (items.length) items.push('sep');
      items.push({ label: 'Copy path' + (selectedPaths.length > 1 ? 's' : ''), icon: '⎘', action: () => {
        navigator.clipboard.writeText(selectedPaths.join('\n'));
        showToast(`Copied ${selectedPaths.length} path${selectedPaths.length === 1 ? '' : 's'}`, 'success');
      }});
      if (selectedKeys.length > 1) {
        items.push('sep');
        items.push({ label: 'Clear selection', icon: '✕', action: () => {
          state.multiSelected.clear();
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

function selectRange(fromKey, toKey) {
  // Build the visible ordered list of keys (staged first, then unstaged) considering filter
  const q = state.searchQuery.trim().toLowerCase();
  const matches = (f) => !q || f.path.toLowerCase().includes(q);
  const orderedKeys = [
    ...state.stagedFiles.filter(matches).map(f => 'staged:' + f.path),
    ...state.unstagedFiles.filter(matches).map(f => 'unstaged:' + f.path)
  ];
  const a = orderedKeys.indexOf(fromKey);
  const b = orderedKeys.indexOf(toKey);
  if (a < 0 || b < 0) {
    state.multiSelected.add(toKey);
    return;
  }
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) state.multiSelected.add(orderedKeys[i]);
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

  // Toolbar badges
  const pushBadge = $('#push-badge');
  const pullBadge = $('#pull-badge');
  if (s.ahead > 0) { pushBadge.textContent = s.ahead; pushBadge.style.display = 'inline-block'; }
  else pushBadge.style.display = 'none';
  if (s.behind > 0) { pullBadge.textContent = s.behind; pullBadge.style.display = 'inline-block'; }
  else pullBadge.style.display = 'none';
}

// ============================================
