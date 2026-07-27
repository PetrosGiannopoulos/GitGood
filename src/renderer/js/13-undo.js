// ============================================
// UNDO — the reflog as a recovery panel
// ============================================
// GitGood can now rewrite history in several ways (amend, interactive rebase, squash,
// discard-hunk, drag-a-branch), and the reflog is what makes all of them reversible: it
// records every value HEAD has held, so entry N is the state left behind by operation N
// and restoring entry 1 undoes the most recent thing you did.
//
// The panel deliberately offers two routes out. "Restore" moves the current branch (a
// reset — destructive, with an optional backup branch) and "Branch here" is the
// non-destructive alternative that leaves the current branch alone.

const undoView = {
  entries: [],
  current: null,
  detached: false,
  dirty: false,
  selected: null,     // ordinal of the highlighted entry
  loading: false
};

// Icon + label per operation type, so a glance down the list reads as a story of what
// you did rather than a wall of hashes.
const REFLOG_TYPES = {
  commit:        { icon: '✠', label: 'commit' },
  amend:         { icon: '✎', label: 'amend' },
  reset:         { icon: '↺', label: 'reset' },
  checkout:      { icon: '⑂', label: 'checkout' },
  merge:         { icon: '⚒', label: 'merge' },
  rebase:        { icon: '⚔', label: 'rebase' },
  'cherry-pick': { icon: '⚒', label: 'cherry-pick' },
  revert:        { icon: '↶', label: 'revert' },
  pull:          { icon: '↓', label: 'pull' },
  clone:         { icon: '⎘', label: 'clone' },
  branch:        { icon: '⑂', label: 'branch' },
  stash:         { icon: '⚿', label: 'stash' },
  other:         { icon: '·', label: 'other' }
};

async function openUndoPanel() {
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }
  undoView.selected = null;
  renderUndoModal();
  await loadUndoEntries();
}

function renderUndoModal() {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Every operation that moved <strong>HEAD</strong>, newest first. Restoring an
      entry moves <strong class="text-red">${escapeHtml(undoView.current || 'the current branch')}</strong>
      back to where it pointed at that moment.</p>
    <div class="undo-body" id="undo-body">
      <div class="empty-state"><span class="loading"></span></div>
    </div>
    <p class="modal-text text-muted" id="undo-note" style="font-size:12px;margin-top:10px"></p>
  `;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Close';
  cancelBtn.onclick = () => modal.hide();

  const undoLastBtn = document.createElement('button');
  undoLastBtn.className = 'btn-medieval';
  undoLastBtn.id = 'undo-last-btn';
  undoLastBtn.innerHTML = '<span class="btn-icon">↩</span> Undo Last Operation';
  undoLastBtn.disabled = true;
  undoLastBtn.onclick = () => {
    // Entry 1 is the state before the most recent operation.
    const target = undoView.entries[1];
    if (target) confirmUndoRestore(target, { undoingLast: true });
  };

  modal.show({ title: 'Undo · History of HEAD', body, footer: [cancelBtn, undoLastBtn] });
}

async function loadUndoEntries() {
  undoView.loading = true;
  const r = await gs.reflog({ limit: 200 });
  undoView.loading = false;
  const bodyEl = document.getElementById('undo-body');
  if (!bodyEl) return;   // modal was closed while loading

  if (!r.ok) {
    bodyEl.innerHTML = `<div class="empty-state"><p class="text-red">${escapeHtml(r.error)}</p></div>`;
    return;
  }
  undoView.entries = r.data.entries || [];
  undoView.current = r.data.current;
  undoView.detached = !!r.data.detached;
  undoView.dirty = !!r.data.dirty;

  if (!undoView.entries.length) {
    bodyEl.innerHTML = '<div class="empty-state"><p>No reflog entries yet — nothing to undo.</p></div>';
    return;
  }
  renderUndoList(bodyEl);
}

function renderUndoList(bodyEl) {
  const rows = undoView.entries.map(e => {
    const t = REFLOG_TYPES[e.type] || REFLOG_TYPES.other;
    // Entry 0 is where HEAD is right now, so it is context rather than a restore target.
    const isCurrent = e.ordinal === 0;
    return `
      <div class="undo-row${isCurrent ? ' current' : ''}" data-undo="${e.ordinal}">
        <span class="undo-type type-${escapeHtml(e.type)}" title="${escapeHtml(e.raw)}">
          <span class="undo-icon">${t.icon}</span><span class="undo-label">${escapeHtml(t.label)}</span>
        </span>
        <span class="undo-detail" title="${escapeHtml(e.raw)}">${escapeHtml(e.detail)}</span>
        <span class="undo-hash text-mono">${escapeHtml(e.short)}</span>
        <span class="undo-when">${escapeHtml(undoRelative(e.date))}</span>
        <span class="undo-sel text-mono">${isCurrent ? 'now' : escapeHtml(e.selector)}</span>
      </div>`;
  }).join('');

  bodyEl.innerHTML = `<div class="undo-list">${rows}</div>`;

  bodyEl.querySelectorAll('.undo-row').forEach(row => {
    const ord = parseInt(row.dataset.undo, 10);
    const entry = undoView.entries[ord];
    row.onclick = () => {
      undoView.selected = ord;
      bodyEl.querySelectorAll('.undo-row').forEach(r => r.classList.toggle('selected', r === row));
      updateUndoNote(entry);
    };
    row.ondblclick = () => { if (ord !== 0) confirmUndoRestore(entry); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [];
      if (ord !== 0) {
        items.push({ label: `Restore ${undoView.current || 'branch'} to here`, icon: '↩', action: () => confirmUndoRestore(entry) });
      }
      items.push({ label: 'Create branch here…', icon: '+', action: () => {
        modal.hide();
        showCreateBranchDialog(entry.hash);
      }});
      items.push('sep');
      items.push({ label: 'Copy hash', icon: '⎘', action: () => copyText(entry.hash, 'Hash copied') });
      items.push({ label: 'Copy reflog selector', icon: '⎘', action: () => copyText(entry.selector, 'Selector copied') });
      showContextMenu(items, e.pageX, e.pageY);
    };
  });

  const undoLastBtn = document.getElementById('undo-last-btn');
  if (undoLastBtn) {
    const target = undoView.entries[1];
    undoLastBtn.disabled = !target;
    if (target) {
      const t = REFLOG_TYPES[undoView.entries[0].type] || REFLOG_TYPES.other;
      undoLastBtn.title = `Undo the ${t.label} and return to ${target.short}`;
    } else {
      undoLastBtn.title = 'There is only one reflog entry — nothing to undo';
    }
  }
  updateUndoNote(undoView.entries[0]);
}

// The note under the list explains the consequence of the current selection, including the
// two conditions that change it: a dirty tree (a hard reset would take the changes with it)
// and detached HEAD (there is no branch to move).
function updateUndoNote(entry) {
  const note = document.getElementById('undo-note');
  if (!note) return;
  const bits = [];
  if (undoView.detached) {
    bits.push('⚠ HEAD is detached, so restoring moves HEAD only — no branch will follow it.');
  }
  if (undoView.dirty) {
    bits.push('⚠ You have uncommitted changes. A hard restore discards them; choose "Keep changes" in the dialog to preserve them.');
  }
  if (entry && entry.ordinal === 0) {
    bits.push('This is where HEAD is now. Select an earlier entry to restore to it, or right-click any entry to branch from it instead.');
  }
  note.innerHTML = bits.map(escapeHtml).join('<br>');
}

// Reflog dates arrive as "2026-07-27 17:56:09 +0300"; Safari-era Date parsing is fussy
// about that shape, so normalise to ISO before handing it to relativeTime.
function undoRelative(dateStr) {
  if (!dateStr) return '';
  const iso = String(dateStr).replace(' ', 'T').replace(/ \+/, '+').replace(/ -/, '-');
  const d = new Date(iso);
  if (isNaN(d.getTime())) return dateStr;
  return relativeTime(d);
}

// Confirm and run a restore. Offers the reset mode as a plain-language choice rather than
// git's --hard/--mixed vocabulary, and defaults to stamping a backup branch.
function confirmUndoRestore(entry, opts) {
  opts = opts || {};
  if (!entry) return;
  const t = REFLOG_TYPES[entry.type] || REFLOG_TYPES.other;
  const undone = undoView.entries[0];
  const undoneType = undone ? (REFLOG_TYPES[undone.type] || REFLOG_TYPES.other).label : 'last operation';

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">${opts.undoingLast
      ? `Undo the <strong class="text-red">${escapeHtml(undoneType)}</strong> and move
         <strong>${escapeHtml(undoView.current || 'HEAD')}</strong> back to`
      : `Move <strong>${escapeHtml(undoView.current || 'HEAD')}</strong> back to`}
      <code class="text-mono text-red">${escapeHtml(entry.short)}</code> —
      the state after <em>${escapeHtml(t.label)}: ${escapeHtml(entry.detail)}</em>
      (${escapeHtml(undoRelative(entry.date))}).</p>

    <div class="merge-strategies" id="undo-modes">
      <label class="merge-strategy selected" data-mode="hard">
        <input type="radio" name="undo-mode" value="hard" checked />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">↺ Discard changes (recommended)</div>
          <div class="merge-strategy-desc">Put the working tree and index back exactly as they were at
            <code class="text-mono">${escapeHtml(entry.short)}</code>. Any uncommitted work is lost.</div>
        </div>
      </label>
      <label class="merge-strategy" data-mode="mixed">
        <input type="radio" name="undo-mode" value="mixed" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">⌥ Keep changes as unstaged</div>
          <div class="merge-strategy-desc">Move the branch but leave your files untouched, so the difference
            shows up as uncommitted changes you can re-stage.</div>
        </div>
      </label>
      <label class="merge-strategy" data-mode="soft">
        <input type="radio" name="undo-mode" value="soft" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">⇡ Keep changes staged</div>
          <div class="merge-strategy-desc">Move the branch and leave the difference staged, ready to
            re-commit as one commit.</div>
        </div>
      </label>
    </div>

    <label class="modal-checkbox">
      <input type="checkbox" id="undo-backup" checked />
      Stamp a backup branch at the current position first (recommended — lets you undo the undo)
    </label>
  `;

  body.querySelectorAll('#undo-modes .merge-strategy').forEach(card => {
    card.onclick = () => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
      body.querySelectorAll('#undo-modes .merge-strategy').forEach(c => c.classList.toggle('selected', c === card));
    };
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary';
  okBtn.innerHTML = '<span class="btn-icon">↩</span> Restore';
  okBtn.onclick = async () => {
    const mode = (body.querySelector('input[name="undo-mode"]:checked') || {}).value || 'hard';
    const backup = !!(body.querySelector('#undo-backup') || {}).checked;
    modal.hide();
    const r = await withLoading('Restoring', () => gs.reflogRestore({ hash: entry.hash, mode, backup }));
    if (!r.ok) { showToast(r.error || 'Restore failed', 'error', 9000); return; }
    await refreshAll();
    const ref = r.data && r.data.backupRef;
    showToast(`Restored to ${entry.short}` + (ref ? ` · backup at ${ref}` : ''), 'success', ref ? 7000 : 3500);
  };

  modal.show({ title: opts.undoingLast ? 'Undo Last Operation' : 'Restore From Reflog', body, footer: [cancelBtn, okBtn] });
}

// Toolbar button.
(() => {
  const btn = document.getElementById('btn-undo');
  if (btn) btn.onclick = () => openUndoPanel();
})();
