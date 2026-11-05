// ============================================
// DEBUG TOOLKIT — commit menu → "Debug from here…"
// ============================================
// One dialog, seven tabs, all about the question "what broke this script, and when?".
// Start is the commit that was right-clicked; End is typed (HEAD by default). The git
// queries are named here and built in main (lib/unity-debug.js) — this file only collects
// choices and draws results. Main-process half: the debug-toolkit section of main.js.
//
// Two jobs run for minutes, not milliseconds: a headless Unity run and the automatic
// bisect. They keep running when the dialog is closed; output is tracked in `dbg.job`
// whether or not the dialog is on screen, and reopening it picks the run back up.

const DBG_TABS = [
  { id: 'trace', icon: '🔎', label: 'Trace a change' },
  { id: 'compare', icon: '⇆', label: 'Compare Start → End' },
  { id: 'unity', icon: '⚠', label: 'Unity suspects' },
  { id: 'search', icon: '⌕', label: 'Search code' },
  { id: 'logs', icon: '☰', label: 'Unity logs' },
  { id: 'tests', icon: '▶', label: 'Compile & test' },
  { id: 'bisect', icon: '⚑', label: 'Find the breaking commit' }
];

// Labels for the ready-made searches; the patterns themselves live in lib/unity-debug.js.
const DBG_SEARCHES = [
  ['logging', 'Leftover logging', 'Debug.Log / LogWarning / LogError…'],
  ['lookups', 'Fragile lookups', 'GameObject.Find, FindObjectOfType, transform.Find'],
  ['lifecycle', 'Init-order suspects', 'Awake, Start, OnEnable, OnDisable, OnDestroy, OnValidate'],
  ['editorOnly', 'Editor-only code', '#if UNITY_EDITOR, using UnityEditor — works in Editor, may break builds'],
  ['stringCalls', 'Calls by string name', 'Invoke("…"), StartCoroutine("…"), SendMessage — renames break them silently'],
  ['getComponent', 'GetComponent calls', 'Costly when called every frame in Update'],
  ['todo', 'TODO / FIXME / HACK', 'Notes someone left behind']
];

const DBG_LINE_CAP = 6000;
const DBG_PREFS_KEY = 'gitgood:debug-toolkit';

const dbg = {
  start: null,
  end: 'HEAD',
  tab: 'trace',
  range: null,
  catalog: null,
  unity: null,
  prefix: '',
  job: null,        // { kind, startedAt, info, steps, current, remaining, raw, status, result }
  rangeTimer: 0,
  tickTimer: 0
};

// ---------------------------------------------------------------------------------------
// ANSI → HTML. git colours its own output (--color=always) and that colouring is the most
// readable form of a word diff or a moved-code diff, so it is kept rather than re-derived.
// Text is escaped here; every tag in the result is one this function wrote.
// ---------------------------------------------------------------------------------------
function ansiToHtml(text, opts) {
  opts = opts || {};
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const clean = String(text || '').replace(/\r/g, '').replace(/\x1b\[[0-9;]*[A-HJKSTfsu]/g, '');
  const st = { fg: null, bg: null, b: false, d: false, i: false, u: false, r: false };
  let out = '';
  const emit = (seg) => {
    if (!seg) return;
    let html = esc(seg);
    // git prints commit hashes in yellow (our log format and `commit <hash>` lines).
    if (opts.linkHashes && st.fg === 3) {
      html = html.replace(/\b[0-9a-f]{7,40}\b/g, h => `<span class="dbg-hash" data-hash="${h}">${h}</span>`);
    }
    const cls = [];
    if (st.fg !== null) cls.push('ansi-fg-' + st.fg);
    if (st.bg !== null) cls.push('ansi-bg-' + st.bg);
    if (st.b) cls.push('ansi-b');
    if (st.d) cls.push('ansi-d');
    if (st.i) cls.push('ansi-i');
    if (st.u) cls.push('ansi-u');
    if (st.r) cls.push('ansi-r');
    out += cls.length ? `<span class="${cls.join(' ')}">${html}</span>` : html;
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(clean))) {
    emit(clean.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(n => parseInt(n, 10) || 0);
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (c === 0) { st.fg = st.bg = null; st.b = st.d = st.i = st.u = st.r = false; }
      else if (c === 1) st.b = true;
      else if (c === 2) st.d = true;
      else if (c === 3) st.i = true;
      else if (c === 4) st.u = true;
      else if (c === 7) st.r = true;
      else if (c === 22) st.b = st.d = false;
      else if (c === 23) st.i = false;
      else if (c === 24) st.u = false;
      else if (c === 27) st.r = false;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c === 49) st.bg = null;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
      else if (c === 38 || c === 48) {
        // 256-colour / truecolour: map the 256 palette's first 16, drop the rest.
        const isFg = c === 38;
        if (codes[k + 1] === 5) { const n = codes[k + 2]; if (n < 16) { if (isFg) st.fg = n; else st.bg = n; } k += 2; }
        else if (codes[k + 1] === 2) k += 4;
      }
    }
  }
  emit(clean.slice(last));
  return out;
}

// Does this search text only make sense as a regex? Plain C# is full of . ( ) < > ? and
// even ||, so only unambiguous regex tells count: a backslash escape (code never has one
// outside a string literal), .* / .+, a leading ^, a range class like [A-Z], or an
// alternation inside a group. "Debug.LogError(" stays literal; "Debug\.LogError\b" does not.
function looksLikeRegex(text) {
  const t = String(text || '');
  return /\\[bBdDwWsS.()[\]{}*+?|^$\\]/.test(t) ||
    /\.[*+]/.test(t) ||
    /^\^/.test(t) ||
    /\[[^\]]*(?:[a-z]-[a-z]|[A-Z]-[A-Z]|\d-\d)[^\]]*\]/.test(t) ||   // [A-Z], not arr[i-1]
    /\([^()|]*[^()|]\|[^()|][^()]*\)/.test(t);   // (a|b), but not C#'s (a || b)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ansiToHtml, looksLikeRegex };
}

// escapeHtml leaves quotes alone; anything inside an attribute goes through this.
function dbgAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------------------
// Preferences: every input with data-pref keeps its last value (per machine, not shared).
// ---------------------------------------------------------------------------------------
function dbgLoadPrefs() {
  try { return JSON.parse(localStorage.getItem(DBG_PREFS_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function dbgSavePref(el) {
  const prefs = dbgLoadPrefs();
  const key = el.dataset.pref;
  if (el.type === 'radio') { if (el.checked) prefs[key] = el.value; }
  else if (el.type === 'checkbox') prefs[key] = el.checked;
  else prefs[key] = el.value;
  try { localStorage.setItem(DBG_PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
}
function dbgApplyPrefs(root) {
  const prefs = dbgLoadPrefs();
  root.querySelectorAll('[data-pref]').forEach(el => {
    const v = prefs[el.dataset.pref];
    if (v === undefined) return;
    if (el.type === 'radio') el.checked = (el.value === v);
    else if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}

// ---------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------
async function openDebugToolkit(hash) {
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }
  if (hash) dbg.start = hash;
  if (!dbg.start) dbg.start = 'HEAD';
  dbg.range = null;
  const body = dbgBuildBody();
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-medieval';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => modal.hide();
  modal.show({ title: '⚑ Debug Toolkit', body, footer: [closeBtn], cls: 'dbg-modal' });
  dbgSelectTab(dbg.tab);
  dbgRefreshRange();
  // Pickers and Unity facts load behind the form; nothing waits on them.
  gs.debugCatalog().then(r => { if (r.ok) { dbg.catalog = r.data; dbgFillPickers(); } });
  dbgLoadUnityInfo();
  // A run started earlier (dialog closed since) is picked back up.
  const st = await gs.debugBisectState();
  if (st.ok) {
    if (st.data.running && !dbg.job && st.data.job) {
      dbg.job = dbgNewJob(st.data.job.kind, st.data.job.info, st.data.job.startedAt);
      if (st.data.job.kind === 'bisect') dbgFeedBisect(st.data.job.output || '');
      else dbg.job.status = st.data.job.output || '';
    }
    dbg.staleBisect = st.data.bisecting && !st.data.running;
    dbgRenderJob();
  }
}

function dbgEl(sel) { return document.querySelector('.dbg ' + sel); }
function dbgAll(sel) { return Array.from(document.querySelectorAll('.dbg ' + sel)); }
function dbgOpen() { return !!document.querySelector('#modal-body .dbg'); }

function dbgBuildBody() {
  const body = document.createElement('div');
  body.className = 'dbg';
  const short = (dbg.start || '').length === 40 ? dbg.start.slice(0, 7) : dbg.start;
  body.innerHTML = `
    <div class="dbg-range">
      <div class="dbg-range-field">
        <label for="dbg-start">Start <span class="text-muted">(the commit you picked)</span></label>
        <input id="dbg-start" class="modal-input dbg-start" data-suggest="refs" value="${dbgAttr(short)}" autocomplete="off" spellcheck="false" />
        <div class="dbg-commit" data-role="start"></div>
      </div>
      <button type="button" class="dbg-swap" title="Swap Start and End">⇄</button>
      <div class="dbg-range-field">
        <label for="dbg-end">End <span class="text-muted">(a commit, branch or tag)</span></label>
        <input id="dbg-end" class="modal-input dbg-end" data-suggest="refs" value="${dbgAttr(dbg.end || 'HEAD')}" autocomplete="off" spellcheck="false" />
        <div class="dbg-commit" data-role="end"></div>
      </div>
    </div>
    <div class="dbg-range-info" aria-live="polite"></div>
    <div class="dbg-main">
      <nav class="dbg-nav" role="tablist">${DBG_TABS.map(t =>
        `<button type="button" class="dbg-tab" role="tab" data-tab="${t.id}"><span class="dbg-tab-icon">${t.icon}</span><span>${t.label}</span><span class="dbg-tab-badge" data-badge="${t.id}"></span></button>`).join('')}
      </nav>
      <div class="dbg-panes">
        ${dbgPaneTrace()}${dbgPaneCompare()}${dbgPaneUnity()}${dbgPaneSearch()}${dbgPaneLogs()}${dbgPaneTests()}${dbgPaneBisect()}
      </div>
    </div>`;

  dbgApplyPrefs(body);
  dbgEnhanceSelects(body);
  dbg.regexAuto = false;      // Pattern (regex) was ticked by dbgRecogniseRegex, not by hand
  dbg.regexUserOff = false;   // ...and the user has since unticked it themselves
  body.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.pref) dbgSavePref(e.target);
    if (e.target.name && /^dbg-.*-kind$/.test(e.target.name)) dbgSyncChoices(body);
    if (e.target.closest('.dbg-pane[data-pane="bisect"]')) dbgBisectEstimate();
    if (e.target.matches('.dbg-log-which, .dbg-log-mode')) {
      if (e.target.matches('.dbg-log-which')) dbg.customLog = null;
      dbgRunLogs();
    }
    // A hand-made choice beats the guess: untick it and the guess stops re-ticking.
    if (e.target.matches('.dbg-s-regex') && e.isTrusted) {
      dbg.regexAuto = false;
      dbg.regexUserOff = !e.target.checked;
      dbgRegexNote('');
    }
  });
  body.addEventListener('input', (e) => {
    if (e.target.dataset && e.target.dataset.suggest && !dbgSuggestMute) dbgSuggest(e.target);
    if (e.target.matches('.dbg-s-custom')) dbgRecogniseRegex(e.target.value);
    if (e.target.matches('.dbg-start, .dbg-end')) {
      clearTimeout(dbg.rangeTimer);
      dbg.rangeTimer = setTimeout(dbgRefreshRange, 350);
    }
  });
  body.addEventListener('focusout', (e) => { if (dbgPop && dbgPop.owner === e.target) dbgPopClose(); });
  body.addEventListener('keydown', (e) => {
    if (e.target.dataset && e.target.dataset.suggest && dbgSuggestKey(e)) return;
    // Enter in a field runs that pane's main action.
    if (e.key === 'Enter' && e.target.matches('input[type="text"], input[type="search"], input:not([type])')) {
      const pane = e.target.closest('.dbg-pane');
      const btn = pane && pane.querySelector('[data-primary]');
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    }
  });
  body.addEventListener('click', dbgOnClick);
  body.querySelector('.dbg-swap').onclick = () => {
    const s = body.querySelector('.dbg-start'), en = body.querySelector('.dbg-end');
    const t = s.value; s.value = en.value; en.value = t;
    dbgRefreshRange();
  };
  dbgSyncChoices(body);
  return body;
}

// Show the fields that belong to the ticked choice: <… data-for="pickaxe method">.
function dbgSyncChoices(root) {
  (root || document).querySelectorAll('.dbg-pane').forEach(pane => {
    const picked = pane.querySelector('input[type="radio"][name$="-kind"]:checked');
    const v = picked ? picked.value : '';
    pane.querySelectorAll('[data-for]').forEach(el => {
      el.hidden = !el.dataset.for.split(' ').includes(v);
    });
  });
}

function dbgSelectTab(id) {
  dbg.tab = id;
  dbgAll('.dbg-tab').forEach(b => {
    const on = b.dataset.tab === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  dbgAll('.dbg-pane').forEach(p => { p.hidden = p.dataset.pane !== id; });
  if (id === 'logs' && !dbgEl('.dbg-pane[data-pane="logs"] .dbg-out').dataset.loaded) dbgRunLogs();
  if (id === 'bisect') dbgBisectEstimate();
}

function dbgRefs() {
  return { start: (dbgEl('.dbg-start').value || '').trim(), end: (dbgEl('.dbg-end').value || '').trim() || 'HEAD' };
}

async function dbgRefreshRange() {
  if (!dbgOpen()) return;
  const { start, end } = dbgRefs();
  dbg.start = start; dbg.end = end;
  const info = dbgEl('.dbg-range-info');
  const r = await gs.debugRange({ start, end });
  if (!dbgOpen()) return;
  const now = dbgRefs();
  if (now.start !== start || now.end !== end) return;   // typed on since
  const sEl = dbgEl('.dbg-commit[data-role="start"]'), eEl = dbgEl('.dbg-commit[data-role="end"]');
  if (!r.ok) {
    dbg.range = null;
    info.className = 'dbg-range-info error';
    info.textContent = r.error;
    sEl.textContent = eEl.textContent = '';
    dbgBisectEstimate();
    return;
  }
  const d = dbg.range = r.data;
  const line = (c) => c ? `<code class="text-mono">${escapeHtml(c.short)}</code> ${escapeHtml(c.subject || '')} <span class="text-muted">— ${escapeHtml(c.author || '')}, ${escapeHtml(relativeTime(c.date))}</span>` : '';
  sEl.innerHTML = line(d.startInfo);
  eEl.innerHTML = line(d.endInfo);
  info.className = 'dbg-range-info' + (d.relation === 'unrelated' ? ' warn' : '');
  info.textContent = d.relation === 'same' ? 'Start and End are the same commit.'
    : d.relation === 'unrelated' ? 'Start and End are on separate lines of history. Compare and search still work; the bisect needs one to contain the other.'
    : `${d.count} commit${d.count === 1 ? '' : 's'} between them · ${d.relation === 'start-older' ? 'Start is older' : 'End is older'}`;
  dbgBisectEstimate();
}

// The catalog arrives after the form is drawn; a box typed into meanwhile gets its list now.
function dbgFillPickers() {
  if (!dbgOpen() || !dbg.catalog) return;
  const el = document.activeElement;
  if (el && el.dataset && el.dataset.suggest && el.closest('.dbg')) dbgSuggest(el);
}

// ---------------------------------------------------------------------------------------
// Themed pickers. A native <select> popup and a <datalist> are drawn by the OS — white,
// whatever the theme — and a datalist lists every entry the moment its box is clicked.
// Both are replaced by one popup in the app's colours. It lives on <body> with a fixed
// position so the pane's scroll box cannot clip it. Suggestions appear only once
// something is typed; an empty box is just a box.
// ---------------------------------------------------------------------------------------
const DBG_SUGGEST_MAX = 60;
let dbgPop = null;          // { el, owner, items: [{ value, html }], index, pick }
let dbgSuggestMute = false; // set while a pick writes the value back, so it doesn't reopen

function dbgPopClose() {
  if (!dbgPop) return;
  dbgPop.el.remove();
  dbgPop.owner.classList.remove('dbg-pop-open');
  dbgPop = null;
}

function dbgPopShow(owner, items, index, pick, foot) {
  if (!items.length) { dbgPopClose(); return; }
  if (!dbgPop || dbgPop.owner !== owner) {
    dbgPopClose();
    const el = document.createElement('div');
    el.className = 'dbg-pop';
    el.setAttribute('role', 'listbox');
    el.addEventListener('mousedown', e => e.preventDefault());   // keep focus in the field
    el.addEventListener('click', e => {
      const row = e.target.closest('.dbg-pop-item');
      if (row && dbgPop) dbgPop.pick(dbgPop.items[+row.dataset.i].value);
    });
    document.body.appendChild(el);
    dbgPop = { el, owner };
    owner.classList.add('dbg-pop-open');
  }
  Object.assign(dbgPop, { items, index, pick });
  dbgPop.el.innerHTML = items.map((it, i) =>
    `<div class="dbg-pop-item${i === index ? ' active' : ''}" role="option" data-i="${i}">${it.html}</div>`).join('') +
    (foot ? `<div class="dbg-pop-foot">${escapeHtml(foot)}</div>` : '');
  dbgPopPlace();
  const act = dbgPop.el.querySelector('.dbg-pop-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function dbgPopPlace() {
  if (!dbgPop) return;
  const owner = dbgPop.owner;
  const r = owner.getBoundingClientRect();
  if (!owner.isConnected || !r.width) { dbgPopClose(); return; }
  const el = dbgPop.el;
  const maxW = Math.max(r.width, Math.min(640, window.innerWidth - 8));
  el.style.minWidth = r.width + 'px';
  el.style.maxWidth = maxW + 'px';
  el.style.left = Math.max(4, Math.min(r.left, window.innerWidth - el.offsetWidth - 4)) + 'px';
  const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
  const want = Math.min(el.scrollHeight, 320);
  if (below < want && above > below) {
    el.style.top = ''; el.style.bottom = (window.innerHeight - r.top + 2) + 'px';
    el.style.maxHeight = Math.min(320, above) + 'px';
  } else {
    el.style.bottom = ''; el.style.top = (r.bottom + 2) + 'px';
    el.style.maxHeight = Math.min(320, below) + 'px';
  }
}

function dbgPopMove(delta) {
  const n = dbgPop.items.length;
  dbgPop.index = dbgPop.index < 0 ? (delta > 0 ? 0 : n - 1) : (dbgPop.index + delta + n) % n;
  dbgPop.el.querySelectorAll('.dbg-pop-item').forEach((row, i) => row.classList.toggle('active', i === dbgPop.index));
  const act = dbgPop.el.querySelector('.dbg-pop-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

// Capturing, so a scroll in any pane carries the popup along with its field. Guarded:
// the tests require this file in Node, where there is no document.
if (typeof document !== 'undefined') {
  document.addEventListener('scroll', (e) => { if (dbgPop && e.target !== dbgPop.el) dbgPopPlace(); }, true);
  window.addEventListener('resize', () => dbgPopClose());
  document.addEventListener('mousedown', (e) => {
    if (dbgPop && !dbgPop.el.contains(e.target) && !dbgPop.owner.contains(e.target)) dbgPopClose();
  }, true);
}

// ---- Suggestions for typed fields (refs, script paths) ----

function dbgSuggestList(kind) {
  const c = dbg.catalog || {};
  return kind === 'refs' ? ['HEAD'].concat(c.refs || []) : (c.scripts || []);
}

// Every space-separated term must appear (the app's usual filter idiom). Ranked by where
// the first term lands: start of the file name, inside it, start of the path, anywhere.
function dbgSuggestMatches(kind, text) {
  const terms = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], more: 0 };
  const hits = [];
  for (const v of dbgSuggestList(kind)) {
    const low = v.toLowerCase();
    if (!terms.every(t => low.includes(t))) continue;
    const base = low.slice(low.lastIndexOf('/') + 1);
    const t0 = terms[0];
    hits.push({ v, rank: base.startsWith(t0) ? 0 : base.includes(t0) ? 1 : low.startsWith(t0) ? 2 : 3 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.v.length - b.v.length || a.v.localeCompare(b.v));
  return { hits: hits.slice(0, DBG_SUGGEST_MAX).map(h => h.v), more: Math.max(0, hits.length - DBG_SUGGEST_MAX) };
}

function dbgSuggestHtml(v) {
  const cut = v.lastIndexOf('/') + 1;
  return `<span class="dbg-pop-dir">${escapeHtml(v.slice(0, cut))}</span>${escapeHtml(v.slice(cut))}`;
}

function dbgSuggest(input) {
  const text = input.value;
  const { hits, more } = dbgSuggestMatches(input.dataset.suggest, text);
  // Nothing typed, nothing found, or the box already holds the one answer: no popup.
  if (!hits.length || (hits.length === 1 && hits[0] === text.trim())) {
    if (dbgPop && dbgPop.owner === input) dbgPopClose();
    return;
  }
  dbgPopShow(input, hits.map(v => ({ value: v, html: dbgSuggestHtml(v) })), -1, (v) => {
    dbgPopClose();
    dbgSuggestMute = true;
    try {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally { dbgSuggestMute = false; }
  }, more ? `…and ${more.toLocaleString()} more — keep typing` : '');
}

// Arrow keys walk the list, Enter takes the highlighted row, Escape closes only the popup
// (not the dialog). Returns true when the key was the popup's, so Enter-runs-the-pane waits.
function dbgSuggestKey(e) {
  const open = dbgPop && dbgPop.owner === e.target;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) { dbgSuggest(e.target); if (!dbgPop || dbgPop.owner !== e.target) return false; }
    e.preventDefault();
    dbgPopMove(e.key === 'ArrowDown' ? 1 : -1);
    return true;
  }
  if (!open) return false;
  if (e.key === 'Enter' && dbgPop.index >= 0) {
    e.preventDefault();
    dbgPop.pick(dbgPop.items[dbgPop.index].value);
    return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dbgPopClose(); return true; }
  if (e.key === 'Tab' || e.key === 'Enter') dbgPopClose();
  return false;
}

// ---- Selects ----
// The <select> stays in the DOM, hidden, as the value: prefs, dbgVal and the change
// handlers keep working on it untouched. A button in its place shows and picks the value.
function dbgEnhanceSelects(root) {
  root.querySelectorAll('select.modal-input:not([data-enhanced])').forEach(sel => {
    sel.dataset.enhanced = '1';
    sel.hidden = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-input dbg-select-btn';
    btn.innerHTML = '<span class="dbg-select-text"></span><span class="cs-caret">▼</span>';
    const sync = () => {
      const o = sel.options[sel.selectedIndex];
      btn.querySelector('.dbg-select-text').textContent = o ? o.textContent : '';
    };
    sync();
    sel.addEventListener('change', sync);
    const open = () => {
      const items = Array.from(sel.options).map(o => ({ value: o.value, html: escapeHtml(o.textContent) }));
      dbgPopShow(btn, items, sel.selectedIndex, (v) => {
        dbgPopClose();
        btn.focus();
        if (sel.value === v) return;
        sel.value = v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    btn.addEventListener('click', () => { if (dbgPop && dbgPop.owner === btn) dbgPopClose(); else open(); });
    btn.addEventListener('blur', () => { if (dbgPop && dbgPop.owner === btn) dbgPopClose(); });
    btn.addEventListener('keydown', (e) => {
      const isOpen = dbgPop && dbgPop.owner === btn;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) open(); else dbgPopMove(e.key === 'ArrowDown' ? 1 : -1);
      } else if ((e.key === 'Enter' || e.key === ' ') && isOpen) {
        e.preventDefault();
        if (dbgPop.index >= 0) dbgPop.pick(dbgPop.items[dbgPop.index].value);
      } else if (e.key === 'Escape' && isOpen) {
        e.preventDefault(); e.stopPropagation(); dbgPopClose();
      }
    });
    sel.after(btn);
  });
}

// ---------------------------------------------------------------------------------------
// Small builders for the panes
// ---------------------------------------------------------------------------------------
function dbgChoice(name, value, title, desc, pref, checked) {
  return `<label class="dbg-choice"><input type="radio" name="${name}" value="${value}" data-pref="${pref}"${checked ? ' checked' : ''} />
    <span><strong>${title}</strong><span class="dbg-desc">${desc}</span></span></label>`;
}
function dbgCheck(cls, label, pref, checked, extra, attrs) {
  return `<label class="modal-checkbox dbg-check"><input type="checkbox" class="${cls}" data-pref="${pref}"${attrs || ''}${checked ? ' checked' : ''} /> <span>${label}${extra ? `<span class="dbg-desc">${extra}</span>` : ''}</span></label>`;
}
function dbgField(label, inner, forKinds, hint) {
  return `<div class="modal-field dbg-field"${forKinds ? ` data-for="${forKinds}"` : ''}><label>${label}</label>${inner}${hint ? `<div class="dbg-hint">${hint}</div>` : ''}</div>`;
}
function dbgInput(cls, pref, placeholder, value, suggest) {
  return `<input type="text" class="modal-input ${cls}" data-pref="${pref}" placeholder="${dbgAttr(placeholder || '')}" value="${dbgAttr(value || '')}"${suggest ? ` data-suggest="${suggest}"` : ''} autocomplete="off" spellcheck="false" />`;
}
function dbgWhere(name, pref, forKinds) {
  return `<div class="dbg-inline"${forKinds ? ` data-for="${forKinds}"` : ''}><span class="dbg-inline-label">Look in:</span>
    <label class="dbg-pill"><input type="radio" name="${name}" value="range" data-pref="${pref}" checked /> Between Start and End</label>
    <label class="dbg-pill"><input type="radio" name="${name}" value="all" data-pref="${pref}" /> The whole history</label></div>`;
}
function dbgActions(primaryLabel, action, extra) {
  return `<div class="dbg-actions"><button type="button" class="btn-medieval primary" data-action="${action}" data-primary>${primaryLabel}</button>${extra || ''}</div>`;
}

function dbgPaneTrace() {
  return `<section class="dbg-pane" data-pane="trace" role="tabpanel">
    <p class="dbg-intro">Find when a line, name or method changed, and who changed it.</p>
    <div class="dbg-choices">
      ${dbgChoice('dbg-trace-kind', 'pickaxe', 'When did this text appear or disappear?', 'A method, field or any text — finds the commits that added or removed it.', 'trace.kind', true)}
      ${dbgChoice('dbg-trace-kind', 'method', 'History of one method', 'Every change to one method, even as it moves around the file.', 'trace.kind')}
      ${dbgChoice('dbg-trace-kind', 'blame', 'Who wrote each line?', 'Ignores whitespace edits and follows code moved or copied from other files.', 'trace.kind')}
      ${dbgChoice('dbg-trace-kind', 'follow', 'History of one file', 'Follows the file through renames.', 'trace.kind')}
    </div>
    ${dbgField('Text or name to look for', dbgInput('dbg-trace-text', 'trace.text', 'e.g. TakeDamage'), 'pickaxe')}
    <div class="dbg-checks" data-for="pickaxe">
      ${dbgCheck('dbg-trace-regex', 'It\'s a pattern (regex), and also find commits that only <em>edited</em> lines containing it', 'trace.regex', false)}
      ${dbgCheck('dbg-trace-case', 'Ignore upper/lower case', 'trace.case', false)}
    </div>
    ${dbgField('Script file', dbgInput('dbg-trace-file', 'trace.file', 'Start typing a path…', '', 'scripts'), 'method blame follow')}
    ${dbgField('Method name', dbgInput('dbg-trace-func', 'trace.func', 'e.g. TakeDamage'), 'method')}
    <div class="dbg-inline" data-for="blame"><span class="dbg-inline-label">Only lines</span>
      <input type="number" min="1" class="modal-input dbg-num dbg-trace-from" placeholder="from" />
      <span>to</span><input type="number" min="1" class="modal-input dbg-num dbg-trace-to" placeholder="to" />
      <span class="text-muted">(optional) · as of End</span></div>
    ${dbgField('In files', dbgInput('dbg-trace-paths', 'trace.paths', '*.cs', '*.cs'), 'pickaxe', 'Comma-separated. *.cs is every script; Assets/Scripts narrows to one folder.')}
    <div class="dbg-checks" data-for="pickaxe follow">${dbgCheck('dbg-trace-patch', 'Show the code changes, not just the commits', 'trace.patch', true)}</div>
    ${dbgWhere('dbg-trace-where', 'trace.where', 'pickaxe method follow')}
    ${dbgActions('Trace', 'trace', '<button type="button" class="btn-medieval" data-action="open-blame" data-for="blame">Open in Blame view</button>')}
    <div class="dbg-out"></div>
  </section>`;
}

function dbgPaneCompare() {
  return `<section class="dbg-pane" data-pane="compare" role="tabpanel" hidden>
    <p class="dbg-intro">What changed between Start (worked) and End (broken)?</p>
    <div class="dbg-choices">
      ${dbgChoice('dbg-compare-kind', 'stat', 'Which scripts changed', 'A summary: every changed file and how much.', 'compare.kind', true)}
      ${dbgChoice('dbg-compare-kind', 'commits', 'Commits that touched them', 'Each commit in between, with the files it changed.', 'compare.kind')}
      ${dbgChoice('dbg-compare-kind', 'words', 'Word-by-word changes', 'Makes a flipped sign or a swapped argument stand out.', 'compare.kind')}
      ${dbgChoice('dbg-compare-kind', 'moved', 'Moved vs. really changed', 'Code that was only moved is coloured differently, so a real edit hidden in a refactor stands out.', 'compare.kind')}
    </div>
    ${dbgField('One file only (optional)', dbgInput('dbg-compare-file', 'compare.file', 'Leave empty for all matching files', '', 'scripts'), 'words')}
    ${dbgField('In files', dbgInput('dbg-compare-paths', 'compare.paths', '*.cs', '*.cs'), 'stat commits words moved', 'Comma-separated. Use * for every file.')}
    <div class="dbg-inline"><span class="dbg-inline-label">Compare:</span>
      <label class="dbg-pill"><input type="radio" name="dbg-compare-mode" value="direct" data-pref="compare.mode" checked /> Everything between them</label>
      <label class="dbg-pill" title="Three-dot: what End's branch added after it split from Start — ignores what Start's branch gained meanwhile"><input type="radio" name="dbg-compare-mode" value="diverged" data-pref="compare.mode" /> Only what End added since they split</label></div>
    ${dbgActions('Compare', 'compare')}
    <div class="dbg-out"></div>
  </section>`;
}

function dbgPaneUnity() {
  return `<section class="dbg-pane" data-pane="unity" role="tabpanel" hidden>
    <p class="dbg-intro">Causes that aren't in the code you read: GUIDs, versions, settings, renamed fields.</p>
    <div class="dbg-checks dbg-checks-cards">
      ${dbgCheck('dbg-u-versions', '<strong>Unity &amp; package versions</strong>', 'unity.versions', true, 'ProjectVersion.txt, manifest.json, packages-lock.json — behaviour often changes with an upgrade.')}
      ${dbgCheck('dbg-u-metas', '<strong>Missing scripts &amp; GUIDs</strong>', 'unity.metas', true, 'Deleted scripts, changed GUIDs, scripts committed without .meta, execution-order changes — and which scenes/prefabs are hit.')}
      ${dbgCheck('dbg-u-renames', '<strong>Renamed serialized fields</strong>', 'unity.renames', true, 'A renamed field loses every value saved in scenes and prefabs unless it has [FormerlySerializedAs].')}
      ${dbgCheck('dbg-u-settings', '<strong>Project settings</strong>', 'unity.settings', true, 'Physics, time step, input, tags &amp; layers, quality, build scenes.')}
      ${dbgCheck('dbg-u-leaks', '<strong>Editor-only code that breaks builds</strong>', 'unity.leaks', true, 'UnityEditor used outside #if UNITY_EDITOR and outside Editor folders (current files).')}
    </div>
    ${dbgActions('Check', 'unity')}
    <details class="dbg-sub">
      <summary>Who uses this script?</summary>
      <div class="dbg-inline">${dbgInput('dbg-u-script', 'unity.script', 'Assets/Scripts/Player.cs', '', 'scripts')}
        <button type="button" class="btn-medieval" data-action="script-users">Find scenes &amp; prefabs</button></div>
      <div class="dbg-hint">Looks up the script's GUID in its .meta at End and lists every scene, prefab and asset that references it.</div>
      <div class="dbg-out dbg-out-users"></div>
    </details>
    <div class="dbg-out"></div>
  </section>`;
}

function dbgPaneSearch() {
  return `<section class="dbg-pane" data-pane="search" role="tabpanel" hidden>
    <p class="dbg-intro">Search the scripts for patterns that commonly cause bugs.</p>
    <div class="dbg-checks dbg-checks-grid">
      ${DBG_SEARCHES.map(([k, label, desc]) => dbgCheck('dbg-s-preset', `<strong>${label}</strong>`, `search.${k}`, k === 'logging', desc, ` data-preset="${k}"`)).join('')}
    </div>
    ${dbgField('And/or your own search', dbgInput('dbg-s-custom', 'search.custom', 'e.g. health -=') +
      `<div class="dbg-checks dbg-checks-row">${dbgCheck('dbg-s-regex', 'Pattern (regex)', 'search.regex', false)}${dbgCheck('dbg-s-case', 'Ignore case', 'search.case', false)}<span class="dbg-regex-note" aria-live="polite"></span></div>` +
      '<div class="dbg-hint">Patterns are Perl-compatible, as in C#: <code>\\b</code>, <code>\\d</code>, <code>\\s</code>, <code>(a|b)</code>, <code>.*?</code>. Typing one ticks Pattern (regex) for you.</div>')}
    ${dbgField('In files', dbgInput('dbg-s-paths', 'search.paths', '*.cs', '*.cs'))}
    <div class="dbg-inline"><span class="dbg-inline-label">Search:</span>
      <label class="dbg-pill"><input type="radio" name="dbg-s-where" value="worktree" data-pref="search.where" checked /> The files on disk now</label>
      <label class="dbg-pill"><input type="radio" name="dbg-s-where" value="end" data-pref="search.where" /> The End commit</label></div>
    ${dbgActions('Search', 'search')}
    <div class="dbg-out"></div>
  </section>`;
}

function dbgPaneLogs() {
  return `<section class="dbg-pane" data-pane="logs" role="tabpanel" hidden>
    <p class="dbg-intro">Errors and exceptions from Unity's own logs, grouped and counted.</p>
    <div class="dbg-inline dbg-logs-bar">
      <select class="modal-input dbg-log-which" data-pref="logs.which">
        <option value="editor">Editor log</option>
        <option value="editorPrev">Editor log — previous session</option>
        <option value="player">Player log (your built game)</option>
        <option value="playerPrev">Player log — previous run</option>
        <option value="custom">Another log file…</option>
      </select>
      <select class="modal-input dbg-log-mode" data-pref="logs.mode">
        <option value="errors">Errors &amp; exceptions</option>
        <option value="warnings">Errors + warnings</option>
        <option value="all">Everything (last 3,000 lines)</option>
      </select>
      <input type="search" class="modal-input dbg-log-filter" placeholder="Filter…" />
      <button type="button" class="btn-medieval primary" data-action="logs" data-primary>↻ Refresh</button>
    </div>
    <div class="dbg-out"></div>
  </section>`;
}

function dbgPaneTests() {
  return `<section class="dbg-pane" data-pane="tests" role="tabpanel" hidden>
    <p class="dbg-intro">Run Unity without its window, on the files on disk now. Close the Editor first — Unity cannot open a project twice.</p>
    <div class="dbg-unity-card"></div>
    <div class="dbg-choices">
      ${dbgChoice('dbg-tests-kind', 'compile', 'Compile check', 'Does every script compile? Lists the errors if not.', 'tests.kind', true)}
      ${dbgChoice('dbg-tests-kind', 'editmode', 'EditMode tests', 'Unit tests that run without entering Play Mode.', 'tests.kind')}
      ${dbgChoice('dbg-tests-kind', 'playmode', 'PlayMode tests', 'Tests that run the game loop.', 'tests.kind')}
    </div>
    ${dbgField('Only tests matching (optional)', dbgInput('dbg-tests-filter', 'tests.filter', 'e.g. PlayerTests or a full test name'), 'editmode playmode', 'Unity\'s -testFilter: a name, namespace or regex. Empty runs them all.')}
    <div class="dbg-checks">${dbgCheck('dbg-tests-nogfx', 'No graphics (faster; untick for tests that render)', 'tests.nogfx', true)}</div>
    ${dbgActions('Run', 'tests', '<button type="button" class="btn-medieval danger" data-action="cancel" hidden>Cancel</button>')}
    <div class="dbg-job" data-job="unity"></div>
    <div class="dbg-out"></div>
  </section>`;
}

function dbgPaneBisect() {
  return `<section class="dbg-pane" data-pane="bisect" role="tabpanel" hidden>
    <p class="dbg-intro">Let git find the exact commit: it checks out commits between Start and End, tests each one, and halves the range every time.</p>
    <div class="dbg-bisect-stale" hidden></div>
    <div class="dbg-unity-card" data-for="unity-editmode unity-playmode unity-compile"></div>
    <div class="dbg-field"><label>What are you looking for?</label>
      <div class="dbg-choices dbg-choices-row">
        ${dbgChoice('dbg-b-find', 'break', 'The commit that broke it', 'The older commit works, the newer one doesn\'t.', 'bisect.find', true)}
        ${dbgChoice('dbg-b-find', 'fix', 'The commit that fixed it', 'The older commit is broken, the newer one works.', 'bisect.find')}
      </div></div>
    <div class="dbg-field"><label>How should each commit be tested?</label>
      <div class="dbg-choices">
        ${dbgChoice('dbg-bisect-kind', 'unity-editmode', 'Unity EditMode tests', 'Works when every test passes.', 'bisect.kind', true)}
        ${dbgChoice('dbg-bisect-kind', 'unity-playmode', 'Unity PlayMode tests', 'Works when every test passes. Slower.', 'bisect.kind')}
        ${dbgChoice('dbg-bisect-kind', 'unity-compile', 'Unity compile check', 'Works when every script compiles — finds the commit that broke the build.', 'bisect.kind')}
        ${dbgChoice('dbg-bisect-kind', 'command', 'My own command', 'Any command or script: exit code 0 = works, 125 = can\'t tell (skip), anything else = broken.', 'bisect.kind')}
      </div></div>
    ${dbgField('Only tests matching (optional)', dbgInput('dbg-b-filter', 'bisect.filter', 'e.g. PlayerTests.TakeDamage_ReducesHealth'), 'unity-editmode unity-playmode', 'Point it at the test that shows the bug — it is faster, and other failing tests won\'t mislead it.')}
    ${dbgField('Command', dbgInput('dbg-b-command', 'bisect.command', 'e.g. npm test   or   run-checks.bat'), 'command', 'Runs in the repository folder, through the system shell.')}
    <div class="dbg-checks" data-for="unity-editmode unity-playmode">
      ${dbgCheck('dbg-b-compileskip', 'If a commit doesn\'t compile, skip it instead of calling it broken', 'bisect.compileSkip', true, 'Recommended: a commit that doesn\'t build says nothing about the bug you\'re hunting.')}
    </div>
    <div class="dbg-checks" data-for="unity-editmode unity-playmode unity-compile">
      ${dbgCheck('dbg-b-ownver', 'Use each commit\'s own Unity version when it is installed', 'bisect.ownVersion', true)}
      ${dbgCheck('dbg-b-nogfx', 'No graphics (faster)', 'bisect.nogfx', true)}
    </div>
    <div class="dbg-checks">
      ${dbgCheck('dbg-b-cleanup', 'Undo files the test rewrites between steps', 'bisect.cleanup', true, 'Unity rewrites packages-lock.json, settings and .meta files; left alone they block the next checkout. Only files the test changed are touched.')}
    </div>
    <div class="dbg-inline"><span class="dbg-inline-label">Give up on a commit after</span>
      <input type="number" min="1" max="600" class="modal-input dbg-num dbg-b-timeout" data-pref="bisect.timeout" value="30" /> <span>minutes (it is then skipped)</span></div>
    <div class="dbg-bisect-estimate"></div>
    ${dbgActions('⚑ Start', 'bisect', '<button type="button" class="btn-medieval danger" data-action="cancel" hidden>Cancel</button>')}
    <div class="dbg-job" data-job="bisect"></div>
    <div class="dbg-out"></div>
  </section>`;
}

// ---------------------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------------------
function dbgOnClick(e) {
  const tab = e.target.closest('.dbg-tab');
  if (tab) { dbgSelectTab(tab.dataset.tab); return; }
  const hashEl = e.target.closest('.dbg-hash');
  if (hashEl) { dbgHashMenu(hashEl.dataset.hash, e.pageX, e.pageY); return; }
  const blame = e.target.closest('[data-blame]');
  if (blame) { modal.hide(); openBlame(blame.dataset.blame); return; }
  const act = e.target.closest('[data-action]');
  if (!act || act.disabled) return;
  const a = act.dataset.action;
  if (a === 'trace') dbgRunTrace();
  else if (a === 'open-blame') { const f = dbgEl('.dbg-trace-file').value.trim(); if (f) { modal.hide(); openBlame(f, { rev: dbgRefs().end }); } else showToast('Choose a file first', 'error'); }
  else if (a === 'compare') dbgRunCompare();
  else if (a === 'unity') dbgRunUnity();
  else if (a === 'script-users') dbgRunScriptUsers(act.dataset.file);
  else if (a === 'search') dbgRunSearch();
  else if (a === 'logs') dbgRunLogs();
  else if (a === 'log-folder') gs.debugOpenPath(act.dataset.path);
  else if (a === 'tests') dbgRunTests();
  else if (a === 'bisect') dbgRunBisect();
  else if (a === 'cancel') gs.debugCancel();
  else if (a === 'locate-unity') dbgLocateUnity(false);
  else if (a === 'reset-unity') dbgLocateUnity(true);
  else if (a === 'bisect-reset') dbgResetStale();
  else if (a === 'use-range') dbgUseRange(act.dataset.start, act.dataset.end, act.dataset.then);
  else if (a === 'checkout') { modal.hide(); checkoutCommit(act.dataset.hash); }
  else if (a === 'copy') copyText(act.dataset.text, 'Copied');
}

// A hash anywhere in the output: copy it, or make it Start/End for the next question.
function dbgHashMenu(hash, x, y) {
  showContextMenu([
    { label: 'Copy hash', icon: '⎘', action: () => copyText(hash, 'Hash copied') },
    { label: 'Use as Start', icon: '◁', action: () => { dbgEl('.dbg-start').value = hash; dbgRefreshRange(); } },
    { label: 'Use as End', icon: '▷', action: () => { dbgEl('.dbg-end').value = hash; dbgRefreshRange(); } },
    { label: 'Show its changes (Compare)', icon: '⇆', action: () => dbgUseRange(hash + '^', hash, 'compare') }
  ], x, y);
}

function dbgUseRange(start, end, then) {
  dbgEl('.dbg-start').value = start;
  dbgEl('.dbg-end').value = end;
  dbgRefreshRange();
  if (then === 'compare') {
    const commits = dbgEl('input[name="dbg-compare-kind"][value="commits"]');
    if (commits) { commits.checked = true; dbgSyncChoices(); }
    dbgEl('.dbg-compare-paths').value = '*';
    dbgSelectTab('compare');
    dbgRunCompare();
  }
}

// ---------------------------------------------------------------------------------------
// Running the queries
// ---------------------------------------------------------------------------------------
function dbgPane(id) { return dbgEl(`.dbg-pane[data-pane="${id}"]`); }
function dbgOut(id) { return dbgPane(id).querySelector(':scope > .dbg-out'); }
function dbgVal(sel) { const el = dbgEl(sel); return el ? el.value : ''; }
function dbgChecked(sel) { const el = dbgEl(sel); return !!(el && el.checked); }
function dbgRadio(name) { const el = dbgEl(`input[name="${name}"]:checked`); return el ? el.value : ''; }

// The forms are tall; a result drawn below the fold looks like nothing happened.
function dbgReveal(el) {
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function dbgBusy(out, label) {
  out.innerHTML = `<div class="dbg-busy"><span class="dbg-spinner"></span>${escapeHtml(label)}…</div>`;
}
function dbgError(out, msg) {
  out.innerHTML = `<div class="dbg-error">⚔ ${escapeHtml(msg || 'Failed')}</div>`;
}

// Draw git's (coloured) text output, capped, with the equivalent command above it.
function dbgTextHtml(text, opts) {
  opts = opts || {};
  const lines = String(text || '').split('\n');
  while (lines.length && !lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim()) lines.pop();
  if (!lines.length) return `<div class="dbg-empty">${escapeHtml(opts.empty || 'Nothing found.')}</div>`;
  const capped = lines.length > DBG_LINE_CAP;
  const shown = capped ? lines.slice(0, DBG_LINE_CAP) : lines;
  return `<pre class="dbg-pre">${ansiToHtml(shown.join('\n'), { linkHashes: true })}</pre>` +
    ((capped || opts.truncated) ? `<div class="dbg-note">Output cut short${capped ? ` at ${DBG_LINE_CAP.toLocaleString()} lines` : ''} — narrow the files or the range to see the rest.</div>` : '');
}

function dbgCommandHtml(cmd) {
  return cmd ? `<div class="dbg-cmd" title="The same thing in a terminal"><code>$ ${escapeHtml(cmd)}</code>
    <button type="button" class="dbg-mini" data-action="copy" data-text="${dbgAttr(cmd)}">Copy</button></div>` : '';
}

async function dbgRunQuery(paneId, params, label, empty) {
  const out = dbgOut(paneId);
  dbgBusy(out, label);
  const r = await gs.debugQuery(params);
  if (!dbgOpen()) return;
  if (!r.ok) { dbgError(out, r.error); return; }
  out.innerHTML = dbgCommandHtml(r.data.command) + dbgTextHtml(r.data.text, { truncated: r.data.truncated, empty });
  dbgReveal(out);
}

function dbgRunTrace() {
  const kind = dbgRadio('dbg-trace-kind');
  const { start, end } = dbgRefs();
  const whole = dbgRadio('dbg-trace-where') === 'all';
  const p = { kind, start, end, wholeHistory: whole };
  if (kind === 'pickaxe') {
    Object.assign(p, { text: dbgVal('.dbg-trace-text'), regex: dbgChecked('.dbg-trace-regex'), ignoreCase: dbgChecked('.dbg-trace-case'),
      showPatch: dbgChecked('.dbg-trace-patch'), paths: dbgVal('.dbg-trace-paths') });
    if (!p.text.trim()) { showToast('Type the text or name to look for', 'error'); return; }
  } else {
    p.file = dbgVal('.dbg-trace-file').trim();
    if (!p.file) { showToast('Choose the script file', 'error'); return; }
    if (kind === 'method') p.func = dbgVal('.dbg-trace-func').trim();
    if (kind === 'blame') { p.fromLine = dbgVal('.dbg-trace-from'); p.toLine = dbgVal('.dbg-trace-to'); p.wholeHistory = false; }
    if (kind === 'follow') p.showPatch = dbgChecked('.dbg-trace-patch');
  }
  const empty = kind === 'pickaxe'
    ? (whole ? 'No commit in the whole history added or removed that text.' : 'No commit between Start and End added or removed that text. Try "The whole history".')
    : 'No changes found.';
  dbgRunQuery('trace', p, 'Tracing', empty);
}

function dbgRunCompare() {
  const kind = dbgRadio('dbg-compare-kind');
  const { start, end } = dbgRefs();
  dbgRunQuery('compare', {
    kind, start, end, diverged: dbgRadio('dbg-compare-mode') === 'diverged',
    paths: dbgVal('.dbg-compare-paths') === '*' ? '.' : dbgVal('.dbg-compare-paths'),
    file: kind === 'words' ? dbgVal('.dbg-compare-file').trim() : ''
  }, 'Comparing', 'No differences in those files.');
}

function dbgRegexNote(text) {
  const n = dbgEl('.dbg-regex-note');
  if (n) n.textContent = text;
}

// Tick Pattern (regex) as soon as the text can only be a regex, and untick it again if it
// stops being one — but only a tick this made; a choice made by hand is left alone.
function dbgRecogniseRegex(text) {
  const box = dbgEl('.dbg-s-regex');
  if (!box) return;
  if (!text.trim()) dbg.regexUserOff = false;
  const isRegex = looksLikeRegex(text);
  if (isRegex && !box.checked && !dbg.regexUserOff) {
    box.checked = true;
    dbg.regexAuto = true;
    dbgSavePref(box);
    dbgRegexNote('✓ Recognised as a regex');
  } else if (!isRegex && box.checked && dbg.regexAuto) {
    box.checked = false;
    dbg.regexAuto = false;
    dbgSavePref(box);
    dbgRegexNote('');
  }
}

// Each ticked search is its own git grep, drawn under its own heading. One combined
// `grep -e A -e B` can't say which pattern a line matched, so a custom search for
// "Debug.LogError\b" was buried among the default preset's Debug.Log hits and read as
// if the regex had been ignored.
async function dbgRunSearch() {
  const presets = dbgAll('.dbg-s-preset').filter(c => c.checked).map(c => c.dataset.preset);
  const custom = dbgVal('.dbg-s-custom');
  if (!presets.length && !custom.trim()) { showToast('Tick a search or type something to look for', 'error'); return; }
  const regex = dbgChecked('.dbg-s-regex');
  const common = {
    kind: 'grep', regex, ignoreCase: dbgChecked('.dbg-s-case'),
    atEnd: dbgRadio('dbg-s-where') === 'end', end: dbgRefs().end, paths: dbgVal('.dbg-s-paths')
  };
  const runs = [];
  if (custom.trim()) runs.push({ label: `Your search: ${custom.trim()}`, params: Object.assign({}, common, { presets: [], custom }), custom: true });
  presets.forEach(k => {
    const def = DBG_SEARCHES.find(d => d[0] === k);
    runs.push({ label: def ? def[1] : k, params: Object.assign({}, common, { presets: [k], custom: '' }) });
  });

  const out = dbgOut('search');
  dbgBusy(out, 'Searching');
  const results = await Promise.all(runs.map(r => gs.debugQuery(r.params)));
  if (!dbgOpen()) return;
  out.innerHTML = runs.map((run, i) => {
    const r = results[i];
    const head = (count) => `<div class="dbg-group-head">${escapeHtml(run.label)}${count == null ? '' : `<span class="dbg-group-count">${count.toLocaleString()} match${count === 1 ? '' : 'es'}</span>`}</div>`;
    if (!r.ok) return `<div class="dbg-group">${head(null)}<div class="dbg-error">⚔ ${escapeHtml(r.error || 'Failed')}</div></div>`;
    const count = String(r.data.text || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(l => /^\d+:/.test(l)).length;
    // Unticked, the text is searched literally — "\b" then means a backslash and a b.
    const literalNote = run.custom && !regex && /\\[bBsSwWdD]/.test(custom)
      ? '<div class="dbg-hint">Searched for this text literally. Tick <strong>Pattern (regex)</strong> for <code>\\b</code>, <code>\\s</code> and friends to mean what they do in a regex.</div>' : '';
    return `<div class="dbg-group">${head(count)}${literalNote}${dbgCommandHtml(r.data.command)}${dbgTextHtml(r.data.text, { truncated: r.data.truncated, empty: 'No matches.' })}</div>`;
  }).join('');
  dbgReveal(out);
}

// ---- Unity suspects --------------------------------------------------------------------

async function dbgRunUnity() {
  const checks = [['versions', '.dbg-u-versions'], ['metas', '.dbg-u-metas'], ['renames', '.dbg-u-renames'], ['settings', '.dbg-u-settings'], ['leaks', '.dbg-u-leaks']]
    .filter(([, sel]) => dbgChecked(sel)).map(([k]) => k);
  if (!checks.length) { showToast('Tick at least one check', 'error'); return; }
  const out = dbgOut('unity');
  dbgBusy(out, 'Checking');
  const { start, end } = dbgRefs();
  const r = await gs.debugSuspects({ checks, start, end, prefix: dbg.prefix });
  if (!dbgOpen()) return;
  if (!r.ok) { dbgError(out, r.error); return; }
  let total = 0;
  out.innerHTML = r.data.sections.map(s => {
    let inner = '', n = 0;
    if (s.error) inner = `<div class="dbg-error">${escapeHtml(s.error)}</div>`;
    else if (s.id === 'versions' || s.id === 'settings') {
      n = (s.text.match(/\x1b\[33m[0-9a-f]{7,}/g) || []).length || (s.text.trim() ? 1 : 0);
      inner = dbgTextHtml(s.text, { truncated: s.truncated, empty: s.id === 'versions' ? 'No Unity or package version changes between Start and End.' : 'No project settings changed between Start and End.' });
    } else if (s.id === 'metas') { n = s.findings.length; inner = dbgMetaHtml(s.findings); }
    else if (s.id === 'renames') { n = s.renames.length; inner = dbgRenamesHtml(s.renames, s.truncated); }
    else if (s.id === 'leaks') { n = s.leaks.files.length; inner = dbgLeaksHtml(s.leaks); }
    total += n;
    return `<details class="dbg-section${n ? ' hit' : ''}"${n ? ' open' : ''}><summary>${n ? `<span class="dbg-count">${n}</span>` : '<span class="dbg-ok">✓</span>'} ${escapeHtml(s.title)}</summary>${inner}</details>`;
  }).join('');
  dbgBadge('unity', total);
  dbgReveal(out);
}

function dbgFileLink(p, line) {
  return `<button type="button" class="dbg-link" data-blame="${dbgAttr(p)}" title="Open in Blame view">${escapeHtml(p)}${line ? `:${line}` : ''}</button>`;
}

function dbgUsersHtml(users) {
  if (!users || !users.length) return '<div class="dbg-sub-note">Not referenced by any scene or prefab at End.</div>';
  return `<div class="dbg-sub-note">Referenced at End by ${users.length} file${users.length === 1 ? '' : 's'}:</div><ul class="dbg-users">${
    users.map(u => `<li><span class="text-mono">${escapeHtml(u.path)}</span> <span class="text-muted">×${u.count}</span></li>`).join('')}</ul>`;
}

function dbgMetaHtml(findings) {
  if (!findings.length) return '<div class="dbg-empty">No script was deleted, lost its GUID, missed its .meta or changed execution order.</div>';
  const icon = { deleted: '✗', guid: '⚠', nometa: '⚠', order: '⇅' };
  return `<ul class="dbg-findings">${findings.map(f => `<li class="dbg-finding k-${f.kind}">
    <div><span class="dbg-finding-icon">${icon[f.kind] || '•'}</span> ${f.kind === 'deleted' ? `<span class="text-mono">${escapeHtml(f.path)}</span>` : dbgFileLink(f.path)}</div>
    <div class="dbg-finding-text">${escapeHtml(f.text)}</div>
    ${f.kind === 'guid' ? `<div class="dbg-sub-note text-mono">${escapeHtml(f.guid)} → ${escapeHtml(f.newGuid)}</div>` : ''}
    ${f.users ? dbgUsersHtml(f.users) : ''}</li>`).join('')}</ul>`;
}

function dbgRenamesHtml(renames, truncated) {
  if (!renames.length) return `<div class="dbg-empty">No serialized field disappeared without [FormerlySerializedAs].${truncated ? ' (The diff was too large to read in full.)' : ''}</div>`;
  return `<ul class="dbg-findings">${renames.map(r => `<li class="dbg-finding k-guid">
    <div><span class="dbg-finding-icon">⚠</span> ${dbgFileLink(r.file)} — <code>${escapeHtml(r.type)} ${escapeHtml(r.removed)}</code>${
      r.candidates.length ? ` became <code>${r.candidates.map(escapeHtml).join('</code> or <code>')}</code>?` : ' was removed'}</div>
    <div class="dbg-finding-text">Values saved in scenes and prefabs for <code>${escapeHtml(r.removed)}</code> are dropped.${
      r.candidates.length ? ` To keep them, add <code>[FormerlySerializedAs("${escapeHtml(r.removed)}")]</code> above <code>${escapeHtml(r.candidates[0])}</code>.` : ''}</div></li>`).join('')}</ul>`;
}

function dbgLeaksHtml(l) {
  const head = `<div class="dbg-sub-note">${l.scanned} script${l.scanned === 1 ? '' : 's'} outside Editor folders mention UnityEditor${l.editorAsmdefs ? ` · ${l.editorAsmdefs} editor-only assembl${l.editorAsmdefs === 1 ? 'y' : 'ies'} excluded` : ''}.</div>`;
  if (!l.files.length) return head + '<div class="dbg-empty">Every use is inside #if UNITY_EDITOR. ✓</div>';
  return head + `<ul class="dbg-findings">${l.files.map(f => `<li class="dbg-finding k-guid">
    <div><span class="dbg-finding-icon">⚠</span> ${dbgFileLink(f.path)}</div>
    ${f.lines.map(x => `<div class="dbg-code-line"><span class="text-muted">${x.line}</span> <code>${escapeHtml(x.text)}</code></div>`).join('')}</li>`).join('')}</ul>
    <div class="dbg-hint">Wrap these in <code>#if UNITY_EDITOR … #endif</code>, or move the script into a folder named Editor.</div>`;
}

async function dbgRunScriptUsers() {
  const file = dbgVal('.dbg-u-script').trim();
  const out = dbgEl('.dbg-out-users');
  if (!file) { showToast('Choose a script', 'error'); return; }
  dbgBusy(out, 'Looking up its GUID');
  const r = await gs.debugScriptUsers({ file, end: dbgRefs().end });
  if (!dbgOpen()) return;
  if (!r.ok) { dbgError(out, r.error); return; }
  out.innerHTML = `<div class="dbg-sub-note">GUID <code>${escapeHtml(r.data.guid)}</code></div>` + dbgUsersHtml(r.data.users);
}

// ---- Logs --------------------------------------------------------------------------------

async function dbgRunLogs() {
  const out = dbgOut('logs');
  out.dataset.loaded = '1';
  const which = dbgVal('.dbg-log-which');
  // "Another log file…" asks once; Refresh re-reads the same file. Choosing the option
  // again from the list (see the change handler) asks again.
  if (which === 'custom' && !dbg.customLog) {
    const p = await gs.debugPickLogFile();
    if (p.ok && p.data) dbg.customLog = p.data;
    if (!dbg.customLog) { out.innerHTML = '<div class="dbg-empty">Pick a log file to read.</div>'; return; }
  }
  const customPath = which === 'custom' ? dbg.customLog : null;
  dbgBusy(out, 'Reading the log');
  const r = await gs.debugUnityLog({ which, path: customPath, mode: dbgVal('.dbg-log-mode'), filter: dbgVal('.dbg-log-filter'), prefix: dbg.prefix });
  if (!dbgOpen()) return;
  if (!r.ok) { dbgError(out, r.error); return; }
  const d = r.data;
  if (!d.exists) {
    out.innerHTML = `<div class="dbg-empty">No log at <code>${escapeHtml(d.path || '?')}</code>${/^player/.test(which) ? ' — the game has not been run on this machine yet, or its company/product name changed.' : '.'}</div>`;
    return;
  }
  const head = `<div class="dbg-cmd"><code>${escapeHtml(d.path)}</code> <span class="text-muted">· ${(d.size / 1024).toFixed(0)} KB · ${escapeHtml(relativeTime(d.mtime))}${d.truncated ? ' · last 6 MB read' : ''}</span>
    <button type="button" class="dbg-mini" data-action="log-folder" data-path="${dbgAttr(d.path)}">Show in folder</button></div>`;
  if (d.text !== undefined) {
    out.innerHTML = head + `<pre class="dbg-pre">${escapeHtml(d.text)}</pre>`;
    const pre = out.querySelector('.dbg-pre'); if (pre) pre.scrollTop = pre.scrollHeight;
    return;
  }
  dbgBadge('logs', d.blocks.reduce((n, b) => n + (b.kind === 'warning' ? 0 : 1), 0));
  if (!d.blocks.length) { out.innerHTML = head + '<div class="dbg-empty">No errors or exceptions in this log. ✓</div>'; return; }
  const label = { compile: 'Compile error', exception: 'Exception', error: 'Error', warning: 'Warning' };
  out.innerHTML = head + `<div class="dbg-sub-note">${d.blocks.length} distinct problem${d.blocks.length === 1 ? '' : 's'}, newest last. Identical repeats are counted, not repeated.</div>` +
    d.blocks.map(b => `<div class="dbg-logblock k-${b.kind}">
      <div class="dbg-logblock-head"><span class="dbg-logkind">${label[b.kind]}</span>${b.count > 1 ? `<span class="dbg-count">×${b.count}</span>` : ''}
        ${b.file ? dbgFileLink(dbg.prefix + b.file, b.line) : ''}<span class="text-muted dbg-logline">line ${b.firstLine}</span></div>
      <pre class="dbg-pre dbg-pre-small">${escapeHtml(b.text)}</pre></div>`).join('');
}

// ---- Unity editor card ---------------------------------------------------------------

async function dbgLoadUnityInfo() {
  const r = await gs.debugUnityInfo();
  if (!r.ok) return;
  dbg.unity = r.data;
  const projects = r.data.projects || [];
  if (projects.length && !projects.some(p => p.prefix === dbg.prefix)) dbg.prefix = projects[0].prefix;
  dbgRenderUnityCard();
}

// The same card sits in the Compile & test tab and the bisect tab.
function dbgRenderUnityCard() {
  if (!dbgOpen()) return;
  const u = dbg.unity;
  if (!u) return;
  dbgAll('.dbg-unity-card').forEach(card => dbgFillUnityCard(card, u));
}

function dbgFillUnityCard(card, u) {
  if (!u.projects.length) {
    card.innerHTML = '<div class="dbg-warn">No Unity project in this repository (no ProjectSettings/ProjectVersion.txt). The Unity runs need one; "My own command" in the bisect tab works without.</div>';
    return;
  }
  const p = u.projects.find(x => x.prefix === dbg.prefix) || u.projects[0];
  const picker = u.projects.length > 1
    ? `<select class="modal-input dbg-project">${u.projects.map(x => `<option value="${dbgAttr(x.prefix)}"${x.prefix === p.prefix ? ' selected' : ''}>${escapeHtml(x.prefix || '(repository root)')}</option>`).join('')}</select>`
    : `<span class="text-mono">${escapeHtml(p.prefix || 'repository root')}</span>`;
  const ed = p.editor
    ? `<span class="dbg-ok">✓</span> <span class="text-mono dbg-path" title="${dbgAttr(p.editor.path)}">${escapeHtml(p.editor.path)}</span> <span class="text-muted">(${p.editor.source === 'chosen' ? 'chosen by you' : 'found in Unity Hub'})</span>`
    : `<span class="dbg-bad">✗</span> Unity ${escapeHtml(p.version || '')} is not installed through Unity Hub here.`;
  card.innerHTML = `
    <div class="dbg-kv"><span>Project</span><span>${picker} · Unity <strong>${escapeHtml(p.version || 'unknown')}</strong></span></div>
    <div class="dbg-kv"><span>Editor</span><span>${ed}
      <button type="button" class="dbg-mini" data-action="locate-unity">Locate Unity…</button>
      ${u.override ? '<button type="button" class="dbg-mini" data-action="reset-unity">Use Unity Hub\'s</button>' : ''}</span></div>
    ${p.locked === 'yes' ? '<div class="dbg-warn">Unity has this project open. Close the Editor before running.</div>'
      : p.locked === 'maybe' ? '<div class="dbg-hint">Temp/UnityLockfile exists — if the Editor is open on this project, close it first.</div>' : ''}`;
  dbgEnhanceSelects(card);
  const sel = card.querySelector('.dbg-project');
  if (sel) sel.onchange = () => { dbg.prefix = sel.value; dbgRenderUnityCard(); };
}

async function dbgLocateUnity(reset) {
  const r = reset ? await gs.debugClearUnityEditor() : await gs.debugSetUnityEditor();
  if (!r.ok) { showToast(r.error, 'error', 6000); return; }
  dbg.unity = r.data;
  dbgRenderUnityCard();
}

// ---------------------------------------------------------------------------------------
// Long jobs: headless Unity run and bisect
// ---------------------------------------------------------------------------------------
function dbgNewJob(kind, info, startedAt) {
  return { kind, info: info || {}, startedAt: startedAt || Date.now(), steps: [], current: null, remaining: null, raw: '', pending: '', status: '', result: null, op: null };
}

function dbgBadge(tab, n) {
  const el = dbgEl(`[data-badge="${tab}"]`);
  if (el) el.textContent = n ? String(n) : '';
}

// Bisect output arrives in chunks; lines are complete only at '\n'.
function dbgFeedBisect(text) {
  const job = dbg.job;
  if (!job) return;
  job.raw += text;
  if (job.raw.length > 400000) job.raw = job.raw.slice(-300000);
  const all = (job.pending + text).replace(/\r/g, '');
  const lines = all.split('\n');
  job.pending = lines.pop();
  for (const line of lines) {
    let m;
    if ((m = /^GITGOOD-STEP (\{.*\})$/.exec(line))) {
      try { job.steps.push(JSON.parse(m[1])); job.current = null; } catch (e) {}
    } else if ((m = /^GITGOOD-INFO (\{.*\})$/.exec(line))) {
      try { job.current = Object.assign(JSON.parse(m[1]), { since: Date.now() }); } catch (e) {}
    } else if ((m = /roughly (\d+) steps?/.exec(line))) {
      job.remaining = parseInt(m[1], 10);
    }
  }
}

// Registered once, at load — not per dialog — so a run keeps being tracked while the
// dialog is closed. (Skipped under Node, where the file is loaded only for its tests.)
if (typeof gs !== 'undefined' && gs.onDebugOutput) {
  gs.onDebugOutput((p) => {
    if (!dbg.job || dbg.job.result) return;
    if (p.kind === 'bisect' && dbg.job.kind === 'bisect') dbgFeedBisect(p.text || '');
    else if (p.kind === 'unity-status' && dbg.job.kind === 'unity') dbg.job.status = p.text || '';
    dbgRenderJob();
  });
}

function dbgElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const DBG_VERDICT = { pass: ['works', 'v-pass'], fail: ['broken', 'v-fail'], skip: ['skipped', 'v-skip'] };

function dbgRenderJob() {
  if (!dbgOpen()) return;
  const job = dbg.job;
  const running = !!(job && !job.result);
  // Buttons: one job at a time, across both panes.
  dbgAll('[data-action="tests"], [data-action="bisect"]').forEach(b => { b.disabled = running; });
  dbgAll('[data-action="cancel"]').forEach(b => { b.hidden = !(running && b.closest('.dbg-pane').dataset.pane === (job.kind === 'bisect' ? 'bisect' : 'tests')); });
  const stale = dbgEl('.dbg-bisect-stale');
  if (stale) {
    stale.hidden = !(dbg.staleBisect && !running);
    stale.innerHTML = '<div class="dbg-warn">A bisect from earlier is still in progress in this repository (git is keeping the checkout on a commit it was testing). <button type="button" class="dbg-mini" data-action="bisect-reset">Reset it and go back to your branch</button></div>';
  }
  if (!job) return;
  clearInterval(dbg.tickTimer);
  if (running) dbg.tickTimer = setInterval(() => { if (dbgOpen() && dbg.job && !dbg.job.result) dbgRenderJob(); else clearInterval(dbg.tickTimer); }, 1000);

  if (job.kind === 'unity') {
    const el = dbgEl('.dbg-job[data-job="unity"]');
    if (!el) return;
    el.innerHTML = running ? `<div class="dbg-live"><span class="dbg-spinner"></span>
      <div><strong>Unity is running (${escapeHtml(job.info.mode || '')})</strong> · ${dbgElapsed(Date.now() - job.startedAt)}
      <div class="dbg-live-status text-mono">${escapeHtml(job.status || 'Starting Unity…')}</div></div></div>` : '';
    return;
  }
  const el = dbgEl('.dbg-job[data-job="bisect"]');
  if (!el) return;
  const info = job.info || {};
  const total = info.steps || 0;
  const done = job.steps.length;
  const cur = job.current;
  const progress = running ? `<div class="dbg-live"><span class="dbg-spinner"></span><div>
      <strong>Step ${done + 1}${total ? ` of about ${Math.max(total, done + 1 + (job.remaining || 0))}` : ''}</strong> · ${dbgElapsed(Date.now() - job.startedAt)} total
      ${cur ? `<div class="dbg-live-status">Testing <code class="text-mono">${escapeHtml(String(cur.hash || '').slice(0, 7))}</code> ${escapeHtml(cur.subject || '')} <span class="text-muted">— ${escapeHtml(cur.text || '')} · ${dbgElapsed(Date.now() - cur.since)}</span></div>` : '<div class="dbg-live-status text-muted">Checking out the next commit…</div>'}
    </div></div>` : '';
  const steps = job.steps.length ? `<table class="dbg-steps"><thead><tr><th>#</th><th>Commit</th><th>Result</th><th>Why</th><th>Time</th></tr></thead><tbody>${
    job.steps.map((s, i) => {
      // In find-the-fix mode a pass is the "new" side; the labels say what the test saw.
      const v = DBG_VERDICT[s.verdict] || ['?', ''];
      return `<tr><td>${i + 1}</td><td><span class="dbg-hash text-mono" data-hash="${dbgAttr(s.hash)}">${escapeHtml(String(s.hash).slice(0, 7))}</span> ${escapeHtml(s.subject || '')}</td>
        <td><span class="dbg-verdict ${v[1]}">${v[0]}</span></td><td class="dbg-why">${escapeHtml(s.reason || '')}</td><td>${dbgElapsed((s.seconds || 0) * 1000)}</td></tr>`;
    }).join('')}</tbody></table>` : '';
  const raw = job.raw ? `<details class="dbg-sub"><summary>git's output</summary><pre class="dbg-pre dbg-pre-small">${ansiToHtml(job.raw.slice(-60000), { linkHashes: true })}</pre></details>` : '';
  el.innerHTML = progress + dbgBisectResultHtml(job) + steps + raw;
}

function dbgBisectResultHtml(job) {
  const r = job.result;
  if (!r) return '';
  if (r.error) return `<div class="dbg-error">⚔ ${escapeHtml(r.error)}</div>`;
  const back = r.reset && r.reset !== 'done' ? `<div class="dbg-warn">Could not return to your branch: ${escapeHtml(r.reset)}. Use "git bisect reset".</div>` : '';
  if (r.status === 'found' && r.commit) {
    const c = r.commit;
    const what = r.find === 'fix' ? 'fixed it' : 'broke it';
    return `<div class="dbg-found">
      <div class="dbg-found-title">⚑ Found the commit that ${what}</div>
      <div class="dbg-found-commit"><span class="dbg-hash text-mono" data-hash="${dbgAttr(c.hash)}">${escapeHtml(c.short)}</span> <strong>${escapeHtml(c.subject)}</strong>
        <span class="text-muted">— ${escapeHtml(c.author)}, ${escapeHtml(relativeTime(c.date))}</span></div>
      <pre class="dbg-pre dbg-pre-small">${escapeHtml(r.stat || '')}</pre>
      <div class="dbg-actions">
        <button type="button" class="btn-medieval primary" data-action="use-range" data-start="${dbgAttr(c.hash)}^" data-end="${dbgAttr(c.hash)}" data-then="compare">Show its changes</button>
        <button type="button" class="btn-medieval" data-action="copy" data-text="${dbgAttr(c.hash)}">Copy hash</button>
        <button type="button" class="btn-medieval" data-action="checkout" data-hash="${dbgAttr(c.hash)}">Check out this commit</button>
      </div>
      <div class="dbg-sub-note">Tested ${r.steps.length} of ${r.count} commits. You are back on your branch.</div>${back}</div>`;
  }
  if (r.status === 'ambiguous') {
    return `<div class="dbg-warn"><strong>Narrowed down, but not to one commit.</strong> These could not be tested (skipped), so it is one of them:
      <ul class="dbg-users">${(r.candidates || []).map(c => `<li><span class="dbg-hash text-mono" data-hash="${dbgAttr(c.hash)}">${escapeHtml(c.short)}</span> ${escapeHtml(c.subject)}</li>`).join('')}</ul>
      Look at the "Why" column below for what stopped them.</div>${back}`;
  }
  if (r.status === 'canceled') return `<div class="dbg-note">Cancelled after ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}. You are back on your branch.</div>${back}`;
  return `<div class="dbg-error">The bisect stopped without an answer — see git's output below.${
    r.steps.length === 0 ? ' No commit was tested: check the command or the Unity editor.' : ''}</div>${back}`;
}

async function dbgRunTests() {
  const mode = dbgRadio('dbg-tests-kind');
  const out = dbgOut('tests');
  out.innerHTML = '';
  dbg.job = dbgNewJob('unity', { mode: { compile: 'compile check', editmode: 'EditMode tests', playmode: 'PlayMode tests' }[mode] });
  const job = dbg.job;
  job.op = opProgress.begin('Running Unity');
  dbgRenderJob();
  dbgReveal(dbgEl('.dbg-job[data-job="unity"]'));
  const r = await gs.debugUnityRun({ mode, prefix: dbg.prefix, filter: dbgVal('.dbg-tests-filter'), noGraphics: dbgChecked('.dbg-tests-nogfx') });
  job.result = r.ok ? (r.data || {}) : { error: r.error };
  opProgress.end(job.op, !r.ok);
  dbgRenderJob();
  if (!dbgOpen()) {
    showToast(!r.ok ? `Unity run failed: ${r.error}` : r.data.canceled ? 'Unity run cancelled' : `Unity: ${r.data.verdict.reason}`, r.ok && r.data.verdict && r.data.verdict.verdict === 'pass' ? 'success' : 'info', 8000);
    return;
  }
  if (!r.ok) { dbgError(out, r.error); return; }
  const d = r.data;
  if (d.canceled) { out.innerHTML = '<div class="dbg-note">Cancelled.</div>'; return; }
  const v = DBG_VERDICT[d.verdict.verdict] || ['?', ''];
  const label = d.verdict.verdict === 'pass' ? (mode === 'compile' ? 'Compiles' : 'All tests passed')
    : d.verdict.verdict === 'fail' ? (mode === 'compile' ? 'Does not compile' : 'Tests failed') : 'Could not tell';
  out.innerHTML = `<div class="dbg-result ${v[1]}"><strong>${label}</strong> — ${escapeHtml(d.verdict.reason)} <span class="text-muted">· Unity ${escapeHtml(d.version || '')} · ${dbgElapsed(d.seconds * 1000)}</span>
      <button type="button" class="dbg-mini" data-action="log-folder" data-path="${dbgAttr(d.logFile)}">Show full log</button></div>
    ${d.results && d.results.failures.length ? `<div class="dbg-sub-note">Failed tests:</div><ul class="dbg-findings">${d.results.failures.map(f =>
      `<li class="dbg-finding k-guid"><div><span class="dbg-finding-icon">✗</span> <code>${escapeHtml(f.name)}</code></div>${f.message ? `<pre class="dbg-pre dbg-pre-small">${escapeHtml(f.message)}</pre>` : ''}</li>`).join('')}</ul>` : ''}
    ${d.compileErrors.length ? `<div class="dbg-sub-note">Compiler errors:</div><pre class="dbg-pre dbg-pre-small">${escapeHtml(d.compileErrors.join('\n'))}</pre>` : ''}
    ${d.verdict.verdict === 'skip' ? `<details class="dbg-sub" open><summary>End of Unity's log</summary><pre class="dbg-pre dbg-pre-small">${escapeHtml(d.logTail || '')}</pre></details>` : ''}`;
  dbgReveal(out);
}

function dbgBisectEstimate() {
  if (!dbgOpen()) return;
  const el = dbgEl('.dbg-bisect-estimate');
  if (!el) return;
  const d = dbg.range;
  if (!d) { el.innerHTML = ''; return; }
  if (d.relation === 'same' || d.relation === 'unrelated') {
    el.innerHTML = `<div class="dbg-warn">${d.relation === 'same' ? 'Start and End are the same commit.' : 'Start and End are on separate lines of history — pick an End that was built on top of Start.'}</div>`;
    return;
  }
  const fix = dbgRadio('dbg-b-find') === 'fix';
  const older = d.relation === 'start-older' ? 'Start' : 'End';
  const newer = older === 'Start' ? 'End' : 'Start';
  const unity = /^unity-/.test(dbgRadio('dbg-bisect-kind'));
  el.innerHTML = `<div class="dbg-plan">
    <div><strong>${older}</strong> (older) is assumed to <strong>${fix ? 'be broken' : 'work'}</strong>; <strong>${newer}</strong> (newer) to <strong>${fix ? 'work' : 'be broken'}</strong>. Neither is re-tested, so be sure of both.</div>
    <div>${d.count} commit${d.count === 1 ? '' : 's'} between them → about <strong>${d.steps}</strong> test run${d.steps === 1 ? '' : 's'}${unity ? ', each one a full Unity import and run' : ''}.</div>
    <div class="text-muted">Needs no uncommitted changes${unity ? ' and the Unity Editor closed' : ''}. When it finishes you are put back on your branch.</div></div>`;
}

async function dbgRunBisect() {
  if (!dbg.range || dbg.range.relation === 'same' || dbg.range.relation === 'unrelated') {
    showToast('Pick a Start and End where one comes after the other', 'error');
    return;
  }
  const kind = dbgRadio('dbg-bisect-kind');
  if (kind === 'command' && !dbgVal('.dbg-b-command').trim()) { showToast('Type the command that tests a commit', 'error'); return; }
  const { start, end } = dbgRefs();
  const out = dbgOut('bisect');
  out.innerHTML = '';
  dbg.staleBisect = false;
  dbg.job = dbgNewJob('bisect', { steps: dbg.range.steps, count: dbg.range.count });
  const job = dbg.job;
  job.op = opProgress.begin('Bisecting');
  dbgRenderJob();
  dbgReveal(dbgEl('.dbg-job[data-job="bisect"]'));
  const r = await gs.debugBisect({
    start, end, prefix: dbg.prefix,
    find: dbgRadio('dbg-b-find'),
    test: { kind, filter: dbgVal('.dbg-b-filter'), command: dbgVal('.dbg-b-command') },
    compileFailAs: dbgChecked('.dbg-b-compileskip') ? 'skip' : 'fail',
    useOwnVersion: dbgChecked('.dbg-b-ownver'),
    noGraphics: dbgChecked('.dbg-b-nogfx'),
    cleanup: dbgChecked('.dbg-b-cleanup'),
    timeoutMinutes: dbgVal('.dbg-b-timeout')
  });
  job.result = r.ok ? r.data : { error: r.error, steps: job.steps };
  // Refused because an older bisect is still open: offer the reset right there.
  if (!r.ok && /already in progress/.test(r.error || '')) dbg.staleBisect = true;
  // The steps the live stream saw are the record; the final parse fills any gap.
  if (r.ok && r.data.steps && r.data.steps.length > job.steps.length) job.steps = r.data.steps;
  opProgress.end(job.op, !r.ok);
  await refreshAll();
  if (dbgOpen()) {
    dbgRenderJob();
    dbgReveal(dbgEl('.dbg-job[data-job="bisect"]'));   // the result card is its first child
    return;
  }
  if (!r.ok) showToast(`Bisect: ${r.error}`, 'error', 10000);
  else if (r.data.status === 'found') showToast(`Bisect found ${r.data.commit.short}: ${r.data.commit.subject} — reopen Debug Toolkit for details`, 'success', 12000);
  else showToast(`Bisect ${r.data.status === 'canceled' ? 'cancelled' : 'finished without a single answer'} — reopen Debug Toolkit for details`, 'info', 10000);
}

async function dbgResetStale() {
  const r = await gs.debugBisectReset();
  if (!r.ok) { showToast(r.error, 'error', 8000); return; }
  dbg.staleBisect = false;
  showToast('Bisect reset — back on your branch', 'success');
  dbgRenderJob();
  refreshAll();
}
