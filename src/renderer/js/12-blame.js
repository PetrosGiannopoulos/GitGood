// ============================================
// BLAME & FILE HISTORY
// ============================================
// One overlay with two tabs, because the two questions people actually ask about a file
// are "who wrote this line, and why" (blame) and "how did this file get here" (history),
// and the answer to one usually leads to the other. Clicking a blame line jumps to that
// commit in the history tab; clicking a history entry shows that commit's diff for this
// file alone.

const blameView = {
  path: null,
  rev: null,
  tab: 'blame',        // 'blame' | 'history'
  blame: null,         // { lines, commitCount }
  history: null,       // { commits }
  selectedHash: null,
  // Colour assignment is per-commit and stable for the life of one overlay, so the same
  // commit keeps its stripe as you scroll.
  commitColors: new Map()
};

// A commit's stripe colour. Hue is derived from the hash so it's deterministic — the same
// commit gets the same colour every time you open the view.
function blameColorFor(hash) {
  if (blameView.commitColors.has(hash)) return blameView.commitColors.get(hash);
  let h = 0;
  for (let i = 0; i < hash.length; i++) h = (h * 31 + hash.charCodeAt(i)) >>> 0;
  const color = `hsl(${h % 360}, 55%, 52%)`;
  blameView.commitColors.set(hash, color);
  return color;
}

async function openBlame(filePath, opts) {
  opts = opts || {};
  if (!filePath) return;
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }

  blameView.path = filePath;
  blameView.rev = opts.rev || null;
  blameView.tab = opts.tab === 'history' ? 'history' : 'blame';
  blameView.blame = null;
  blameView.history = null;
  blameView.selectedHash = null;
  blameView.commitColors = new Map();

  renderBlameOverlay();
  showBlameOverlay();
  // Dispatch on the tab that was actually asked for. Always calling the blame loader
  // would fetch blame data and then bail at its own "am I still the active tab?" guard,
  // leaving the spinner up forever whenever the caller wanted history.
  await loadActiveBlameTab();
}

// Load whichever tab is current. Used by openBlame and by the tab buttons, so there is
// one place that maps blameView.tab to its loader.
function loadActiveBlameTab() {
  return blameView.tab === 'history' ? loadHistoryTab() : loadBlameTab();
}

function openFileHistory(filePath, opts) {
  return openBlame(filePath, Object.assign({}, opts, { tab: 'history' }));
}

function showBlameOverlay() {
  const el = document.getElementById('blame-overlay');
  if (el) el.classList.remove('hidden');
}

function hideBlameOverlay() {
  const el = document.getElementById('blame-overlay');
  if (el) el.classList.add('hidden');
}

function renderBlameOverlay() {
  const el = document.getElementById('blame-overlay');
  if (!el) return;
  const short = blameView.rev ? ` @ ${blameView.rev.slice(0, 7)}` : '';
  el.innerHTML = `
    <div class="blame-window">
      <div class="blame-header">
        <div class="blame-title">
          <span class="blame-icon">⚜</span>
          <span class="blame-path" title="${escapeHtml(blameView.path)}">${escapeHtml(blameView.path)}</span>
          <span class="blame-rev">${escapeHtml(short)}</span>
        </div>
        <div class="blame-tabs">
          <button class="blame-tab${blameView.tab === 'blame' ? ' active' : ''}" data-blame-tab="blame">⚔ Blame</button>
          <button class="blame-tab${blameView.tab === 'history' ? ' active' : ''}" data-blame-tab="history">⌛ History</button>
        </div>
        <button class="blame-close" id="blame-close" title="Close">✕</button>
      </div>
      <div class="blame-body" id="blame-body">
        <div class="empty-state"><span class="loading"></span></div>
      </div>
    </div>`;

  el.querySelector('#blame-close').onclick = hideBlameOverlay;
  el.querySelectorAll('[data-blame-tab]').forEach(btn => {
    btn.onclick = () => {
      const tab = btn.dataset.blameTab;
      if (tab === blameView.tab) return;
      blameView.tab = tab;
      renderBlameOverlay();
      loadActiveBlameTab();
    };
  });
}

// ============================================
// BLAME TAB
// ============================================
async function loadBlameTab() {
  const bodyEl = document.getElementById('blame-body');
  if (!bodyEl) return;

  if (!blameView.blame) {
    bodyEl.innerHTML = '<div class="empty-state"><span class="loading"></span></div>';
    const r = await gs.blame({ path: blameView.path, rev: blameView.rev || undefined });
    if (!r.ok) {
      bodyEl.innerHTML = `<div class="empty-state"><p class="text-red">${escapeHtml(r.error)}</p></div>`;
      return;
    }
    blameView.blame = r.data;
  }
  // The tab may have been switched while the request was in flight.
  if (blameView.tab !== 'blame') return;
  renderBlameLines(bodyEl, blameView.blame);
}

function renderBlameLines(bodyEl, data) {
  const lines = data.lines || [];
  if (!lines.length) {
    bodyEl.innerHTML = '<div class="empty-state"><p>This file has no lines to blame (it may be empty or binary).</p></div>';
    return;
  }

  // Only print the commit details on the first line of each run by the same commit —
  // repeating them on every line turns the gutter into noise.
  let prevHash = null;
  const rows = lines.map(l => {
    const isNew = l.hash !== prevHash;
    prevHash = l.hash;
    const color = l.uncommitted ? 'var(--muted-text)' : blameColorFor(l.hash);
    const when = l.authorTime ? relativeTime(new Date(l.authorTime * 1000)) : '';
    const meta = l.uncommitted
      ? `<span class="blame-uncommitted">Not committed yet</span>`
      : `<span class="blame-hash">${escapeHtml(l.short)}</span>` +
        `<span class="blame-author" title="${escapeHtml(l.authorMail)}">${escapeHtml(l.author)}</span>` +
        `<span class="blame-when">${escapeHtml(when)}</span>`;
    return `
      <div class="blame-row${isNew ? ' run-start' : ''}${l.uncommitted ? ' uncommitted' : ''}"
           data-blame-hash="${escapeHtml(l.hash)}"
           title="${escapeHtml(l.uncommitted ? 'Uncommitted change' : l.summary)}">
        <span class="blame-stripe" style="background:${color}"></span>
        <span class="blame-meta">${isNew ? meta : ''}</span>
        <span class="blame-lineno">${l.line}</span>
        <span class="blame-code">${escapeHtml(l.content)}</span>
      </div>`;
  }).join('');

  bodyEl.innerHTML = `
    <div class="blame-summary">⚜ ${lines.length} line${lines.length === 1 ? '' : 's'} ·
      ${data.commitCount} commit${data.commitCount === 1 ? '' : 's'} ·
      click a line to see its commit</div>
    <div class="blame-lines">${rows}</div>`;

  bodyEl.querySelectorAll('.blame-row').forEach(row => {
    row.onclick = () => {
      const hash = row.dataset.blameHash;
      if (!hash || /^0+$/.test(hash)) return;
      blameView.selectedHash = hash;
      blameView.tab = 'history';
      renderBlameOverlay();
      loadActiveBlameTab();
    };
    row.oncontextmenu = (e) => {
      const hash = row.dataset.blameHash;
      if (!hash || /^0+$/.test(hash)) return;
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        { label: 'Copy commit hash', icon: '⎘', action: () => copyText(hash, 'Hash copied') },
        { label: 'Show this commit', icon: '⚜', action: () => {
            blameView.selectedHash = hash;
            blameView.tab = 'history';
            renderBlameOverlay();
            loadActiveBlameTab();
          } },
        'sep',
        { label: 'Blame the parent of this commit', icon: '↩', action: () => {
            // Walking back one commit is how you get past a reformatting or rename commit
            // to whoever actually wrote the line.
            blameView.rev = hash + '^';
            blameView.blame = null;
            blameView.tab = 'blame';
            renderBlameOverlay();
            loadActiveBlameTab();
          } }
      ], e.pageX, e.pageY);
    };
  });
}

// ============================================
// HISTORY TAB
// ============================================
async function loadHistoryTab() {
  const bodyEl = document.getElementById('blame-body');
  if (!bodyEl) return;

  if (!blameView.history) {
    bodyEl.innerHTML = '<div class="empty-state"><span class="loading"></span></div>';
    const r = await gs.fileHistory({ path: blameView.path, limit: 300 });
    if (!r.ok) {
      bodyEl.innerHTML = `<div class="empty-state"><p class="text-red">${escapeHtml(r.error)}</p></div>`;
      return;
    }
    blameView.history = r.data;
  }
  if (blameView.tab !== 'history') return;

  const commits = blameView.history.commits || [];
  if (!commits.length) {
    bodyEl.innerHTML = '<div class="empty-state"><p>No commits touched this file.</p></div>';
    return;
  }

  const STATUS_LABEL = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
  const listHtml = commits.map(c => `
    <div class="fh-row${c.hash === blameView.selectedHash ? ' selected' : ''}" data-fh-hash="${escapeHtml(c.hash)}">
      <span class="fh-stripe" style="background:${blameColorFor(c.hash)}"></span>
      <div class="fh-body">
        <div class="fh-subject">${escapeHtml(c.subject)}</div>
        <div class="fh-meta">
          <span class="text-mono text-red">${escapeHtml(c.short)}</span>
          <span>${escapeHtml(c.author)}</span>
          <span>${escapeHtml(relativeTime(c.date))}</span>
          <span class="fh-status ${escapeHtml(c.status)}">${escapeHtml(STATUS_LABEL[c.status] || c.status)}</span>
        </div>
        ${c.status === 'R' && c.oldPath ? `<div class="fh-rename">↳ renamed from ${escapeHtml(c.oldPath)}</div>` : ''}
      </div>
    </div>`).join('');

  bodyEl.innerHTML = `
    <div class="fh-layout">
      <div class="fh-list">
        <div class="blame-summary">⚜ ${commits.length} commit${commits.length === 1 ? '' : 's'} touched this file</div>
        ${listHtml}
      </div>
      <div class="fh-diff diff-content" id="fh-diff">
        <div class="empty-state"><p>Select a commit to see what it changed here.</p></div>
      </div>
    </div>`;

  bodyEl.querySelectorAll('.fh-row').forEach(row => {
    row.onclick = () => selectFileHistoryCommit(row.dataset.fhHash);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hash = row.dataset.fhHash;
      showContextMenu([
        { label: 'Copy commit hash', icon: '⎘', action: () => copyText(hash, 'Hash copied') },
        { label: 'Blame this file at this commit', icon: '⚔', action: () => {
            blameView.rev = hash;
            blameView.blame = null;
            blameView.tab = 'blame';
            renderBlameOverlay();
            loadActiveBlameTab();
          } },
        'sep',
        { label: 'Restore this version to working tree', icon: '↩', action: () => {
            hideBlameOverlay();
            restoreFilesFromCommit(hash, [blameView.path]);
          } }
      ], e.pageX, e.pageY);
    };
  });

  // Auto-select: whatever the blame tab sent us here for, else the newest commit.
  const initial = blameView.selectedHash && commits.some(c => c.hash === blameView.selectedHash)
    ? blameView.selectedHash
    : commits[0].hash;
  selectFileHistoryCommit(initial);
}

async function selectFileHistoryCommit(hash) {
  if (!hash) return;
  blameView.selectedHash = hash;
  document.querySelectorAll('.fh-row').forEach(r =>
    r.classList.toggle('selected', r.dataset.fhHash === hash));

  const diffEl = document.getElementById('fh-diff');
  if (!diffEl) return;
  diffEl.innerHTML = '<div class="empty-state"><span class="loading"></span></div>';

  const r = await gs.fileDiffAtCommit({ hash, path: blameView.path });
  // Guard against a slower request landing after the user clicked something else.
  if (blameView.selectedHash !== hash) return;
  if (!r.ok) {
    diffEl.innerHTML = `<div class="empty-state"><p class="text-red">${escapeHtml(r.error)}</p></div>`;
    return;
  }
  if (!r.data || !r.data.trim()) {
    diffEl.innerHTML = '<div class="empty-state"><p>No textual change to this file in that commit (it may be a rename or a binary file).</p></div>';
    return;
  }
  diffEl.innerHTML = renderDiff(r.data);
}

// Esc closes the overlay. Registered as a capture-phase listener so it runs before the
// global Esc handler in 01-core hides the modal underneath it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const el = document.getElementById('blame-overlay');
  if (el && !el.classList.contains('hidden')) {
    e.stopPropagation();
    hideBlameOverlay();
  }
}, true);
