// ============================================
// COMMAND PALETTE
// ============================================
// Ctrl/Cmd+Shift+P (or Ctrl+K) over everything the app can do. This is cheap to build here
// because the renderer has no module system — every action is already a plain global
// function — and it's the fastest route to a keyboard-first workflow without inventing a
// shortcut for each of forty commands.
//
// Commands are declared, not hard-coded into the UI: each has an `available()` predicate
// so entries that make no sense right now (anything needing a repo, "unstage all" with an
// empty index) simply don't appear rather than failing when chosen.

const palette = {
  open: false,
  items: [],        // the currently filtered list
  active: 0,        // highlighted index
  query: ''
};

// Static commands. Dynamic ones (branches, changed files) are generated per-open by
// paletteDynamicCommands so they always reflect current state.
function paletteCommands() {
  const hasRepo = () => !!state.repo;
  const hasChanges = () => hasRepo() && !!(state.status && (state.status.files || []).length);
  const hasStaged = () => hasRepo() && !!(state.stagedFiles && state.stagedFiles.length);
  const hasUnstaged = () => hasRepo() && !!(state.unstagedFiles && state.unstagedFiles.length);
  const hasFile = () => hasRepo() && !!state.selectedFile;

  return [
    // --- repository ---
    { id: 'repo.open', title: 'Open Repository…', group: 'Repository', icon: '⛬', keys: 'Ctrl+O',
      run: () => openRepoDialog() },
    { id: 'repo.clone', title: 'Clone Repository…', group: 'Repository', icon: '⚔',
      run: () => showCloneDialog() },
    { id: 'repo.init', title: 'Initialize New Repository…', group: 'Repository', icon: '✠',
      run: () => showInitDialog() },
    { id: 'repo.explorer', title: 'Reveal Repository in File Explorer', group: 'Repository', icon: '⛬',
      available: hasRepo, run: () => gs.openInExplorer(state.repo.path) },
    { id: 'repo.close', title: 'Close Repository', group: 'Repository', icon: '✕',
      available: hasRepo, run: () => document.getElementById('btn-close-repo').click() },
    { id: 'repo.refresh', title: 'Refresh Everything', group: 'Repository', icon: '⟳',
      available: hasRepo, run: () => refreshAll() },
    { id: 'repo.submodules', title: 'Submodules…', group: 'Repository', icon: '⛨',
      available: hasRepo, keywords: 'submodule gitlink init update nested',
      run: () => showSubmodulesDialog() },

    // --- sync ---
    { id: 'sync.fetch', title: 'Fetch', group: 'Sync', icon: '⤓', available: hasRepo,
      run: () => document.getElementById('btn-fetch').click() },
    { id: 'sync.pull', title: 'Pull', group: 'Sync', icon: '↓', available: hasRepo,
      run: () => document.getElementById('btn-pull').click() },
    { id: 'sync.pullRebase', title: 'Pull with Rebase', group: 'Sync', icon: '⚔', available: hasRepo,
      keywords: 'rebase linear', run: () => pullRebase() },
    { id: 'sync.push', title: 'Push', group: 'Sync', icon: '↑', available: hasRepo,
      run: () => doPush() },
    { id: 'sync.pushTags', title: 'Push with Tags', group: 'Sync', icon: '✠', available: hasRepo,
      keywords: 'tag tags release publish follow-tags', run: () => doPush(true) },

    // --- changes ---
    { id: 'chg.stageAll', title: 'Stage All Changes', group: 'Changes', icon: '⇡',
      available: hasUnstaged, run: () => document.getElementById('stage-all-btn').click() },
    { id: 'chg.unstageAll', title: 'Unstage All', group: 'Changes', icon: '⇣',
      available: hasStaged, run: () => document.getElementById('unstage-all-btn').click() },
    { id: 'chg.commit', title: 'Commit…', group: 'Changes', icon: '✠', keys: 'Ctrl+Enter',
      available: hasStaged, run: () => { goToTab('changes'); focusCommitBox(); } },
    { id: 'chg.amend', title: 'Amend Last Commit', group: 'Changes', icon: '✎',
      available: hasRepo, keywords: 'reword rewrite',
      run: () => { goToTab('changes'); setAmendMode(true); focusCommitBox(); } },
    { id: 'chg.stash', title: 'Stash All Changes…', group: 'Changes', icon: '⚿',
      available: hasChanges, run: () => showStashMenu() },
    { id: 'chg.stashPop', title: 'Pop Latest Stash', group: 'Changes', icon: '⌃',
      available: () => hasRepo() && !!(state.stashes && state.stashes.length),
      run: () => stashPop(state.stashes[0].index !== undefined ? state.stashes[0].index : 0) },

    // --- history ---
    { id: 'hist.undo', title: 'Undo — History of HEAD…', group: 'History', icon: '↩',
      available: hasRepo, keywords: 'reflog restore recover revert mistake',
      run: () => openUndoPanel() },
    { id: 'hist.branch', title: 'New Branch…', group: 'History', icon: '⑂',
      available: hasRepo, run: () => showBranchMenu() },
    { id: 'hist.squash', title: 'Combine Commits (Squash)…', group: 'History', icon: '⚒',
      available: hasRepo, run: () => showSquashDialog() },
    { id: 'hist.rebase', title: 'Interactive Rebase…', group: 'History', icon: '☰',
      available: hasRepo, keywords: 'reword squash fixup drop reorder',
      run: () => promptInteractiveRebaseTarget() },
    { id: 'hist.blame', title: 'Blame Current File…', group: 'History', icon: '⚔',
      available: hasFile, run: () => openBlame(state.selectedFile) },
    { id: 'hist.fileHistory', title: 'History of Current File…', group: 'History', icon: '⌛',
      available: hasFile, run: () => openFileHistory(state.selectedFile) },

    // --- view ---
    { id: 'view.graph', title: 'Go to Graph', group: 'View', icon: '⚔', available: hasRepo,
      run: () => goToTab('graph') },
    { id: 'view.branches', title: 'Go to Branches', group: 'View', icon: '⑂', available: hasRepo,
      run: () => goToTab('branches') },
    { id: 'view.history', title: 'Go to History', group: 'View', icon: '⌛', available: hasRepo,
      run: () => goToTab('history') },
    { id: 'view.changes', title: 'Go to Changes', group: 'View', icon: '⚒', available: hasRepo,
      run: () => goToTab('changes') },
    { id: 'view.unified', title: 'Diff: Unified View', group: 'View', icon: '☰',
      available: () => state.diffMode !== 'unified', run: () => setDiffMode('unified') },
    { id: 'view.split', title: 'Diff: Split View', group: 'View', icon: '◫',
      available: () => state.diffMode !== 'split', run: () => setDiffMode('split') },
    { id: 'view.whitespace', title: () => state.diffIgnoreWhitespace
        ? 'Diff: Show Whitespace Changes' : 'Diff: Ignore Whitespace Changes',
      group: 'View', icon: '⇥', keywords: 'blank space indent',
      run: () => toggleDiffWhitespace() },
    { id: 'view.syntax', title: () => state.diffSyntax === false
        ? 'Diff: Enable Syntax Highlighting' : 'Diff: Disable Syntax Highlighting',
      group: 'View', icon: '◧', keywords: 'colour color token',
      run: async () => {
        state.diffSyntax = state.diffSyntax === false;
        await gs.setAppSettings({ diffSyntax: state.diffSyntax });
        repaintAllDiffs();
      } },
    { id: 'view.sidebar', title: 'Toggle Sidebar', group: 'View', icon: '⮜', keys: 'Ctrl+B',
      run: () => document.getElementById('sidebar-toggle').click() },
    { id: 'view.popout', title: 'Pop Out the Diff', group: 'View', icon: '⤢',
      available: hasRepo, run: () => openDiffPopout() },

    // --- tools ---
    { id: 'tool.terminal', title: 'Open Terminal', group: 'Tools', icon: '⌨',
      available: hasRepo, run: () => openTerminal() },
    { id: 'tool.settings', title: 'Settings…', group: 'Tools', icon: '⚙',
      run: () => document.getElementById('btn-settings').click() },
    { id: 'tool.ssh', title: 'Forge SSH Key…', group: 'Tools', icon: '⚿',
      run: () => showSshKeyGenerator() }
  ];
}

// Commands generated from live state: branches to check out, and files to jump to.
function paletteDynamicCommands() {
  const out = [];
  if (!state.repo) return out;

  const current = (state.branches.local && state.branches.local.current) || '';
  ((state.branches.local && state.branches.local.all) || []).forEach(b => {
    if (b === current) return;
    out.push({
      id: 'branch.checkout.' + b,
      title: `Checkout ${b}`,
      group: 'Branches', icon: '⑂', keywords: 'switch branch ' + b,
      run: () => checkoutBranch(b)
    });
  });
  ((state.branches.local && state.branches.local.all) || []).forEach(b => {
    if (b === current) return;
    out.push({
      id: 'branch.rebase.' + b,
      title: `Rebase onto ${b}`,
      group: 'Branches', icon: '⚔', keywords: 'rebase ' + b,
      run: () => showRebaseDialog(b)
    });
  });

  const seen = new Set();
  [...(state.stagedFiles || []), ...(state.unstagedFiles || [])].forEach(f => {
    if (seen.has(f.path)) return;
    seen.add(f.path);
    out.push({
      id: 'file.open.' + f.path,
      title: f.path,
      subtitle: 'changed file',
      group: 'Files', icon: '⚒', keywords: f.path,
      run: () => { goToTab('changes'); selectFile(f.path, !!f.staged); }
    });
  });

  return out;
}

function paletteTitleOf(cmd) {
  return typeof cmd.title === 'function' ? cmd.title() : cmd.title;
}

function goToTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

function focusCommitBox() {
  const el = document.getElementById('commit-summary');
  if (el) setTimeout(() => el.focus(), 60);
}

// ============================================
// FUZZY MATCHING
// ============================================
// Subsequence matching with a score that rewards matches at word starts and consecutive
// runs, so "gtc" finds "Go to Changes" and "ir" finds "Interactive Rebase" — the whole
// point of a palette is not having to type the exact wording.
function fuzzyScore(text, query) {
  if (!query) return 1;
  const hay = text.toLowerCase();
  const q = query.toLowerCase();
  if (hay === q) return 1000;

  // A plain substring hit outranks any scattered subsequence.
  const idx = hay.indexOf(q);
  if (idx !== -1) return 500 - idx + (idx === 0 ? 100 : 0);

  let score = 0, hi = 0, streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let i = hi; i < hay.length; i++) {
      if (hay[i] === ch) { found = i; break; }
    }
    if (found === -1) return 0;                    // not a subsequence at all
    const atWordStart = found === 0 || /[\s\-_/.:]/.test(hay[found - 1]);
    score += 10;
    if (atWordStart) score += 15;
    if (found === hi) { streak++; score += 5 * streak; } else { streak = 0; }
    hi = found + 1;
  }
  // Prefer shorter targets when scores are otherwise close.
  return score + Math.max(0, 30 - hay.length / 4);
}

function paletteFilter(query) {
  const all = paletteCommands().concat(paletteDynamicCommands());
  const usable = all.filter(c => !c.available || c.available());
  const q = (query || '').trim();

  const scored = usable.map(c => {
    const title = paletteTitleOf(c);
    const hay = `${title} ${c.group || ''} ${c.keywords || ''}`;
    return { cmd: c, title, score: q ? fuzzyScore(hay, q) : 1 };
  }).filter(x => x.score > 0);

  if (q) scored.sort((a, b) => b.score - a.score);
  // With no query, keep the declaration order (which is grouped sensibly) rather than
  // shuffling it by an arbitrary score.
  return scored.slice(0, 60);
}

// ============================================
// UI
// ============================================
function openCommandPalette() {
  if (palette.open) return;
  palette.open = true;
  palette.query = '';
  palette.active = 0;

  const el = document.getElementById('palette-overlay');
  if (!el) return;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="palette">
      <div class="palette-input-wrap">
        <span class="palette-prompt">⚜</span>
        <input type="text" class="palette-input" id="palette-input" autocomplete="off"
               spellcheck="false" placeholder="Type a command…" />
      </div>
      <div class="palette-list" id="palette-list"></div>
      <div class="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>Enter</kbd> run</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </div>`;

  const input = document.getElementById('palette-input');
  renderPaletteList();
  input.addEventListener('input', () => {
    palette.query = input.value;
    palette.active = 0;
    renderPaletteList();
  });
  input.addEventListener('keydown', onPaletteKey);
  setTimeout(() => input.focus(), 20);

  // Clicking the backdrop (but not the panel) dismisses.
  el.onclick = (e) => { if (e.target === el) closeCommandPalette(); };
}

function closeCommandPalette() {
  palette.open = false;
  const el = document.getElementById('palette-overlay');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

function renderPaletteList() {
  const listEl = document.getElementById('palette-list');
  if (!listEl) return;
  palette.items = paletteFilter(palette.query);

  if (!palette.items.length) {
    listEl.innerHTML = `<div class="palette-empty">No command matches “${escapeHtml(palette.query)}”.</div>`;
    return;
  }

  // Group headers only make sense while browsing. Once a query is active the list is
  // ordered by relevance, so groups interleave and headers would repeat — show the group
  // as a dimmed suffix on each row instead.
  const grouped = !palette.query.trim();
  let lastGroup = null;
  listEl.innerHTML = palette.items.map((it, i) => {
    const g = it.cmd.group || '';
    let header = '';
    if (grouped && g && g !== lastGroup) {
      header = `<div class="palette-group">${escapeHtml(g)}</div>`;
      lastGroup = g;
    }
    const meta = it.cmd.subtitle || (!grouped && g ? g.toLowerCase() : '');
    return header + `
      <div class="palette-item${i === palette.active ? ' active' : ''}" data-pi="${i}">
        <span class="palette-icon">${it.cmd.icon || '·'}</span>
        <span class="palette-title">${escapeHtml(it.title)}</span>
        ${meta ? `<span class="palette-sub">${escapeHtml(meta)}</span>` : ''}
        ${it.cmd.keys ? `<kbd class="palette-keys">${escapeHtml(it.cmd.keys)}</kbd>` : ''}
      </div>`;
  }).join('');

  listEl.querySelectorAll('.palette-item').forEach(node => {
    node.onmousemove = () => {
      const i = parseInt(node.dataset.pi, 10);
      if (i !== palette.active) { palette.active = i; markPaletteActive(); }
    };
    node.onclick = () => runPaletteItem(parseInt(node.dataset.pi, 10));
  });
  scrollPaletteActiveIntoView();
}

function markPaletteActive() {
  document.querySelectorAll('.palette-item').forEach(n =>
    n.classList.toggle('active', parseInt(n.dataset.pi, 10) === palette.active));
  scrollPaletteActiveIntoView();
}

function scrollPaletteActiveIntoView() {
  const node = document.querySelector(`.palette-item[data-pi="${palette.active}"]`);
  if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
}

function onPaletteKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    palette.active = Math.min(palette.active + 1, palette.items.length - 1);
    markPaletteActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    palette.active = Math.max(palette.active - 1, 0);
    markPaletteActive();
  } else if (e.key === 'Home') {
    e.preventDefault(); palette.active = 0; markPaletteActive();
  } else if (e.key === 'End') {
    e.preventDefault(); palette.active = palette.items.length - 1; markPaletteActive();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPaletteItem(palette.active);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeCommandPalette();
  }
}

function runPaletteItem(index) {
  const item = palette.items[index];
  if (!item) return;
  // Close FIRST: most commands open a modal of their own, and two overlays fighting over
  // focus is the classic palette bug.
  closeCommandPalette();
  try {
    Promise.resolve(item.cmd.run()).catch(err => {
      showToast('Command failed: ' + (err.message || err), 'error', 6000);
    });
  } catch (err) {
    showToast('Command failed: ' + (err.message || err), 'error', 6000);
  }
}

// ============================================
// GLOBAL SHORTCUT
// ============================================
// Capture phase, so the palette opens even when focus is inside an input — otherwise the
// one time you most want it (mid commit message) is the time it doesn't work.
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const isPaletteKey = mod && ((e.shiftKey && (e.key === 'P' || e.key === 'p')) ||
                               (!e.shiftKey && (e.key === 'k' || e.key === 'K')));
  if (isPaletteKey) {
    e.preventDefault();
    e.stopPropagation();
    if (palette.open) closeCommandPalette(); else openCommandPalette();
    return;
  }
  // Esc closes the palette before the global handler in 01-core hides other things.
  if (e.key === 'Escape' && palette.open) {
    e.preventDefault();
    e.stopPropagation();
    closeCommandPalette();
  }
}, true);
