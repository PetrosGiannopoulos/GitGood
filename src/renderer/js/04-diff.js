// DIFF RENDERING
// ============================================
// Maximum diff lines to render at once. Beyond this we truncate with a notice;
// the user can still see the rest by switching to git CLI or by viewing per-file.
const DIFF_LINE_CAP = 20000;

function renderDiff(diffText, opts) {
  opts = opts || {};
  if (!diffText || !diffText.trim()) {
    return '<div class="empty-state"><p>No differences.</p></div>';
  }
  // Persist the last diff so the view-mode toggle can re-render without refetching.
  _lastDiff = { text: diffText, opts };
  return state.diffMode === 'split'
    ? renderDiffSplit(diffText, opts)
    : renderDiffUnified(diffText, opts);
}

// Remember the most recently rendered diff so toggling unified/split re-renders instantly.
let _lastDiff = null;
// Last commit-detail diff data for the History tab, so the toggle can re-render it.
let _historyDetailDiff = null;

// Returns HTML for a unified/split toggle reflecting the current mode. Used in the
// Changes pane header and the Graph/History commit-detail "Changes" headers. Clicks
// are handled by a single delegated listener (see below).
function diffModeToggleHtml() {
  const u = state.diffMode === 'split' ? '' : ' active';
  const s = state.diffMode === 'split' ? ' active' : '';
  return `<span class="diff-view-toggle">` +
    `<button class="diff-view-btn${u}" data-diffmode="unified" title="Unified view">☰ Unified</button>` +
    `<button class="diff-view-btn${s}" data-diffmode="split" title="Side-by-side view">◫ Split</button>` +
  `</span>`;
}

function renderDiffUnified(diffText, opts) {
  opts = opts || {};
  if (!diffText || !diffText.trim()) {
    return '<div class="empty-state"><p>No differences.</p></div>';
  }
  const allLines = diffText.split('\n');
  const totalLines = allLines.length;
  const cap = opts.lineCap || DIFF_LINE_CAP;
  const truncatedByCap = totalLines > cap;
  const lines = truncatedByCap ? allLines.slice(0, cap) : allLines;

  const out = [];
  let oldLine = 0, newLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Turn the raw "diff --git a/path b/path" into a clean file header, and drop the
    // other git plumbing lines (index, ---, +++, mode/rename/similarity) entirely.
    if (raw.startsWith('diff --git')) {
      const m = raw.match(/ b\/(.+)$/);
      const path = m ? m[1] : raw.replace('diff --git ', '');
      out.push(`<div class="diff-file-header">⚔ ${escapeHtml(path)}</div>`);
      continue;
    }
    if (raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') ||
        raw.startsWith('old mode ') || raw.startsWith('new mode ') ||
        raw.startsWith('deleted file mode ') || raw.startsWith('new file mode ') ||
        raw.startsWith('similarity index ') || raw.startsWith('rename from ') ||
        raw.startsWith('rename to ') || raw.startsWith('copy from ') || raw.startsWith('copy to ')) {
      continue; // drop git plumbing
    }
    if (raw.startsWith('Binary files')) {
      out.push(`<div class="diff-line hunk"><div class="diff-gutter"></div><div class="diff-gutter"></div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (m) { oldLine = parseInt(m[1]); newLine = parseInt(m[2]); }
      out.push(`<div class="diff-line hunk"><div class="diff-gutter"></div><div class="diff-gutter"></div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push(`<div class="diff-line add"><div class="diff-gutter"></div><div class="diff-gutter">${newLine}</div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
      newLine++;
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      out.push(`<div class="diff-line del"><div class="diff-gutter">${oldLine}</div><div class="diff-gutter"></div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
      oldLine++;
      continue;
    }
    if (raw.startsWith('\\')) {
      continue; // "\ No newline at end of file"
    }
    out.push(`<div class="diff-line"><div class="diff-gutter">${oldLine}</div><div class="diff-gutter">${newLine}</div><div class="diff-text">${escapeHtml(raw)}</div></div>`);
    oldLine++; newLine++;
  }

  let html = out.join('');
  const truncated = truncatedByCap || opts.diffTruncated;
  if (truncated) {
    const reason = truncatedByCap
      ? `Showing first ${cap.toLocaleString()} of ${totalLines.toLocaleString()} lines.`
      : `Diff was truncated to ${Math.round((opts.diffBytes || 0) / 1024 / 1024 * 10) / 10} MB.`;
    html += `<div class="diff-line hunk" style="background:color-mix(in srgb, var(--accent) 12%, transparent);border-top:2px solid var(--accent);padding:10px;"><div class="diff-gutter"></div><div class="diff-gutter"></div><div class="diff-text" style="white-space:pre-wrap;font-style:italic">⚔ ${escapeHtml(reason)} The diff is too large to render fully.</div></div>`;
  }
  return html;
}

// Side-by-side (split) diff. Parses the unified diff into hunks and pairs deleted lines
// on the left with added lines on the right; context lines appear on both sides.
function renderDiffSplit(diffText, opts) {
  opts = opts || {};
  const allLines = diffText.split('\n');
  const totalLines = allLines.length;
  const cap = opts.lineCap || DIFF_LINE_CAP;
  const truncatedByCap = totalLines > cap;
  const lines = truncatedByCap ? allLines.slice(0, cap) : allLines;

  // A row is { type, leftNum, leftText, rightNum, rightText }
  // type: 'meta' (file/hunk header, spans full width), 'context', 'change'
  const rows = [];
  let oldLine = 0, newLine = 0;

  // Buffer consecutive removals/additions so we can align them side-by-side.
  let pendingDel = [];   // {num, text}
  let pendingAdd = [];   // {num, text}
  const flushPending = () => {
    const n = Math.max(pendingDel.length, pendingAdd.length);
    for (let k = 0; k < n; k++) {
      const d = pendingDel[k];
      const a = pendingAdd[k];
      rows.push({
        type: 'change',
        leftNum: d ? d.num : '',
        leftText: d ? d.text : null,     // null => empty filler cell
        rightNum: a ? a.num : '',
        rightText: a ? a.text : null
      });
    }
    pendingDel = [];
    pendingAdd = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('diff --git')) {
      flushPending();
      const m = raw.match(/ b\/(.+)$/);
      const path = m ? m[1] : raw.replace('diff --git ', '');
      rows.push({ type: 'file', text: path });
      continue;
    }
    if (raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') ||
        raw.startsWith('old mode ') || raw.startsWith('new mode ') ||
        raw.startsWith('deleted file mode ') || raw.startsWith('new file mode ') ||
        raw.startsWith('similarity index ') || raw.startsWith('rename from ') ||
        raw.startsWith('rename to ') || raw.startsWith('copy from ') || raw.startsWith('copy to ')) {
      continue; // drop git plumbing
    }
    if (raw.startsWith('Binary files')) {
      flushPending();
      rows.push({ type: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('@@')) {
      flushPending();
      const m = raw.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (m) { oldLine = parseInt(m[1]); newLine = parseInt(m[2]); }
      rows.push({ type: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      pendingAdd.push({ num: newLine, text: raw.slice(1) });
      newLine++;
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      pendingDel.push({ num: oldLine, text: raw.slice(1) });
      oldLine++;
      continue;
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — attach as meta-ish, skip
      continue;
    }
    // Context line — flush any pending change block first, then add to both sides.
    flushPending();
    const text = raw.startsWith(' ') ? raw.slice(1) : raw;
    rows.push({
      type: 'context',
      leftNum: oldLine, leftText: text,
      rightNum: newLine, rightText: text
    });
    oldLine++; newLine++;
  }
  flushPending();

  const parts = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type === 'file') {
      parts[i] = `<div class="dsplit-row meta"><div class="dsplit-file">⚔ ${escapeHtml(r.text)}</div></div>`;
      continue;
    }
    if (r.type === 'meta') {
      parts[i] = `<div class="dsplit-row meta"><div class="dsplit-meta">${escapeHtml(r.text)}</div></div>`;
      continue;
    }
    const leftCls = r.type === 'change' && r.leftText !== null ? 'del' : (r.leftText === null ? 'empty' : '');
    const rightCls = r.type === 'change' && r.rightText !== null ? 'add' : (r.rightText === null ? 'empty' : '');
    const leftText = r.leftText === null ? '' : escapeHtml(r.leftText);
    const rightText = r.rightText === null ? '' : escapeHtml(r.rightText);
    const leftNum = r.leftText === null ? '' : r.leftNum;
    const rightNum = r.rightText === null ? '' : r.rightNum;
    parts[i] =
      `<div class="dsplit-row">` +
        `<div class="dsplit-side ${leftCls}"><span class="dsplit-num">${leftNum}</span><span class="dsplit-text">${leftText}</span></div>` +
        `<div class="dsplit-side ${rightCls}"><span class="dsplit-num">${rightNum}</span><span class="dsplit-text">${rightText}</span></div>` +
      `</div>`;
  }

  let html = `<div class="dsplit">${parts.join('')}</div>`;
  const truncated = truncatedByCap || opts.diffTruncated;
  if (truncated) {
    const reason = truncatedByCap
      ? `Showing first ${cap.toLocaleString()} of ${totalLines.toLocaleString()} lines.`
      : `Diff was truncated to ${Math.round((opts.diffBytes || 0) / 1024 / 1024 * 10) / 10} MB.`;
    html += `<div class="diff-line hunk" style="background:color-mix(in srgb, var(--accent) 12%, transparent);border-top:2px solid var(--accent);padding:10px;"><div class="diff-text" style="white-space:pre-wrap;font-style:italic">⚔ ${escapeHtml(reason)} The diff is too large to render fully.</div></div>`;
  }
  return html;
}

// ============================================
// PER-FILE COMMIT DIFF BROWSER
// Splits a full multi-file unified diff into per-file chunks and shows a file list;
// clicking a file renders only that file's diff (so we don't paint everything at once).
// ============================================

// Split a unified diff into [{path, status, diff}] chunks, one per file.
function splitDiffByFile(diffText) {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  const files = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('diff --git')) {
      if (cur) files.push(cur);
      // Best-effort path from the "diff --git a/X b/Y" header. This can be ambiguous
      // when paths contain " b/", so we refine it below from the +++ / --- lines, which
      // carry a single unambiguous path.
      const m = raw.match(/ b\/(.+)$/);
      const path = m ? m[1] : raw.replace('diff --git ', '');
      cur = { path, status: 'modified', lines: [], pathLocked: false };
      continue;
    }
    if (!cur) {
      cur = { path: '(diff)', status: 'modified', lines: [], pathLocked: false };
    }
    if (raw.startsWith('new file mode')) cur.status = 'added';
    else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (raw.startsWith('rename from') || raw.startsWith('rename to')) cur.status = 'renamed';
    else if (raw.startsWith('Binary files')) cur.binary = true;
    // Refine the path unambiguously: prefer "+++ b/path"; fall back to "--- a/path"
    // for deletions (where +++ is /dev/null).
    else if (!cur.pathLocked && raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '').trim();
      if (p && p !== '/dev/null') { cur.path = p; cur.pathLocked = true; }
    } else if (!cur.pathLocked && raw.startsWith('--- ')) {
      const p = raw.slice(4).replace(/^a\//, '').trim();
      if (p && p !== '/dev/null') cur.path = p; // may be overridden by +++ next line
    }
    cur.lines.push(raw);
  }
  if (cur) files.push(cur);
  return files.map(f => ({ path: f.path, status: f.status, binary: !!f.binary, diff: f.lines.join('\n') }));
}

const FILE_STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

// Render a commit's changes as a file list + a single-file diff pane into `panelEl`.
// `opts` carries diffTruncated/diffBytes for the truncation notice, and `opts.hash`
// (the commit) so files can be restored from it.
function renderCommitFileBrowser(panelEl, diffText, opts) {
  opts = opts || {};
  if (!panelEl) return;
  const files = splitDiffByFile(diffText);
  if (!files.length) {
    panelEl.innerHTML = '<div class="empty-state"><p>No differences.</p></div>';
    return;
  }

  const listHtml = files.map((f, idx) =>
    `<div class="cfile-item${idx === 0 ? ' active' : ''}" data-cfile="${idx}" title="${escapeHtml(f.path)}">` +
      `<input type="checkbox" class="cfile-check" data-cfile-check="${idx}" title="Select file">` +
      `<span class="cfile-status ${f.status}">${FILE_STATUS_LETTER[f.status] || 'M'}</span>` +
      `<span class="cfile-path">${escapeHtml(f.path)}</span>` +
    `</div>`
  ).join('');

  panelEl.innerHTML =
    `<div class="cfile-browser">` +
      `<div class="cfile-toolbar">` +
        `<label class="cfile-selall"><input type="checkbox" class="cfile-selall-check"> Select all</label>` +
        `<span class="cfile-selcount" aria-live="polite"></span>` +
        `<button class="cfile-restore-btn" type="button" disabled>↩ Restore selected</button>` +
      `</div>` +
      `<div class="cfile-searchbar">` +
        `<input type="search" class="cfile-search" placeholder="Filter files…" title="Filter files in this commit" />` +
      `</div>` +
      `<div class="cfile-list">${listHtml}</div>` +
      `<div class="cfile-diff diff-content" id="cfile-diff"></div>` +
    `</div>`;

  const diffEl = panelEl.querySelector('#cfile-diff');
  // Stash state on the panel so the diff-mode toggle can re-render the *current* file
  // in place, preserving the selected file and scroll positions.
  panelEl._cfiles = files;
  panelEl._cfileOpts = opts;
  panelEl._cfileActive = 0;
  panelEl._cfileHash = opts.hash || null;

  const renderOne = (idx) => {
    const f = files[idx];
    if (!f || !diffEl) return;
    panelEl._cfileActive = idx;
    try {
      diffEl.innerHTML = renderDiff(f.diff, opts);
    } catch (err) {
      diffEl.innerHTML = `<div class="empty-state"><p style="color:var(--crusader-red-bright)">⚔ Failed to render diff: ${escapeHtml(err.message || String(err))}</p></div>`;
    }
    diffEl.scrollTop = 0; // new file → start at top
  };

  // --- checkbox / selection plumbing ---
  const list = panelEl.querySelector('.cfile-list');
  const selAll = panelEl.querySelector('.cfile-selall-check');
  const count = panelEl.querySelector('.cfile-selcount');
  const restoreBtn = panelEl.querySelector('.cfile-restore-btn');

  const checkedPaths = () => Array.from(panelEl.querySelectorAll('.cfile-check:checked'))
    .map(cb => files[parseInt(cb.dataset.cfileCheck, 10)]).filter(Boolean).map(f => f.path);

  const syncSelectionUI = () => {
    const checks = Array.from(panelEl.querySelectorAll('.cfile-check'));
    const checkedCount = checks.filter(c => c.checked).length;
    if (count) count.textContent = checkedCount ? `${checkedCount} selected` : '';
    if (restoreBtn) restoreBtn.disabled = checkedCount === 0;
    if (selAll) {
      selAll.checked = checkedCount > 0 && checkedCount === checks.length;
      selAll.indeterminate = checkedCount > 0 && checkedCount < checks.length;
    }
  };

  list.addEventListener('click', (e) => {
    // Clicking the checkbox toggles selection without changing the previewed file.
    if (e.target.closest('.cfile-check')) { syncSelectionUI(); return; }
    const item = e.target.closest('.cfile-item');
    if (!item) return;
    panelEl.querySelectorAll('.cfile-item').forEach(el => el.classList.toggle('active', el === item));
    renderOne(parseInt(item.dataset.cfile, 10));
  });

  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.cfile-item');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = parseInt(item.dataset.cfile, 10);
    const rightClickedPath = files[idx] && files[idx].path;
    // Operate on the checked set if any; otherwise the right-clicked file.
    let targets = checkedPaths();
    if (!targets.length && rightClickedPath) targets = [rightClickedPath];
    showCommitFileContextMenu(panelEl._cfileHash, targets, rightClickedPath, e.pageX, e.pageY);
  });

  if (selAll) selAll.addEventListener('change', () => {
    panelEl.querySelectorAll('.cfile-check').forEach(c => { c.checked = selAll.checked; });
    syncSelectionUI();
  });

  if (restoreBtn) restoreBtn.addEventListener('click', () => {
    const paths = checkedPaths();
    if (paths.length) restoreFilesFromCommit(panelEl._cfileHash, paths);
  });

  // File filter — show only items whose path matches the query (all terms must match).
  const fileSearch = panelEl.querySelector('.cfile-search');
  if (fileSearch) {
    let ft = null;
    const applyFileFilter = () => {
      const q = fileSearch.value.trim().toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      let visible = 0;
      panelEl.querySelectorAll('.cfile-item').forEach(item => {
        const idx = parseInt(item.dataset.cfile, 10);
        const path = (files[idx] && files[idx].path || '').toLowerCase();
        const show = !terms.length || terms.every(t => path.includes(t));
        item.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      fileSearch.classList.toggle('has-no-matches', !!q && visible === 0);
    };
    fileSearch.oninput = () => { clearTimeout(ft); ft = setTimeout(applyFileFilter, 120); };
    fileSearch.onkeydown = (e) => {
      if (e.key === 'Escape') { fileSearch.value = ''; applyFileFilter(); }
    };
  }

  // Show the first file by default.
  renderOne(0);
  syncSelectionUI();
}

// Context menu for a file (or selected files) within a commit preview.
function showCommitFileContextMenu(hash, targetPaths, rightClickedPath, x, y) {
  const many = targetPaths.length > 1;
  const label = many ? `Restore ${targetPaths.length} files to working tree`
                      : `Restore “${shortenPath(rightClickedPath || targetPaths[0])}” to working tree`;
  const items = [
    { label, icon: '↩', action: () => restoreFilesFromCommit(hash, targetPaths) },
    'sep',
    { label: 'Copy path' + (many ? 's' : ''), icon: '⎘', action: () => {
        navigator.clipboard.writeText(targetPaths.join('\n'));
        showToast('Path' + (many ? 's' : '') + ' copied', 'success');
      } }
  ];
  showContextMenu(items, x, y);
}

function shortenPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// Restore files from a commit into the current working tree (git checkout <hash> -- paths).
async function restoreFilesFromCommit(hash, paths) {
  if (!hash || !paths || !paths.length) return;
  const many = paths.length > 1;
  const confirmed = await modal.confirm({
    title: many ? `Restore ${paths.length} Files` : 'Restore File',
    message: many
      ? `Overwrite ${paths.length} files in your working tree with their version from commit ${hash.slice(0,7)}? This changes your working files.`
      : `Overwrite “${paths[0]}” in your working tree with its version from commit ${hash.slice(0,7)}? This changes your working file.`,
    confirmText: 'Restore',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;
  const r = await withLoading('Restoring', () => gs.restoreFromCommit(hash, paths));
  if (!r.ok) { showToast(r.error || 'Restore failed', 'error', 6000); return; }
  showToast(many ? `Restored ${paths.length} files` : 'File restored', 'success');
  await refreshAll();
}

// Re-render only the currently-selected file's diff in the active browser(s) — used by
// the unified/split toggle so it doesn't rebuild the whole pane (which would reset the
// selected file and scroll position).
function rerenderActiveCommitFile(panelEl) {
  if (!panelEl || !panelEl._cfiles) return false;
  const diffEl = panelEl.querySelector('#cfile-diff');
  if (!diffEl) return false;
  const f = panelEl._cfiles[panelEl._cfileActive || 0];
  if (!f) return false;
  const prevScroll = diffEl.scrollTop;
  try {
    diffEl.innerHTML = renderDiff(f.diff, panelEl._cfileOpts || {});
  } catch (err) {
    diffEl.innerHTML = `<div class="empty-state"><p style="color:var(--crusader-red-bright)">⚔ ${escapeHtml(err.message || String(err))}</p></div>`;
  }
  diffEl.scrollTop = prevScroll; // keep the diff scroll position across mode switch
  return true;
}
function classifyFile(file) {
  // Returns { status, letter, staged }
  const idx = (file.index || ' ').trim();
  const wt = (file.working_dir || ' ').trim();

  if (file.path && state.status && state.status.not_added && state.status.not_added.includes(file.path)) {
    return { status: 'untracked', letter: 'U', staged: false };
  }
  if (idx === '?' || wt === '?') return { status: 'untracked', letter: 'U', staged: false };

  const map = {
    A: { status: 'added', letter: 'A' },
    M: { status: 'modified', letter: 'M' },
    D: { status: 'deleted', letter: 'D' },
    R: { status: 'renamed', letter: 'R' },
    C: { status: 'renamed', letter: 'C' },
    U: { status: 'conflicted', letter: 'U' }
  };
  if (idx && idx !== ' ' && map[idx]) return { ...map[idx], staged: true };
  if (wt && wt !== ' ' && map[wt]) return { ...map[wt], staged: false };
  return { status: 'modified', letter: '?', staged: false };
}

// ============================================
