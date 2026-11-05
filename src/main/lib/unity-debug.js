'use strict';
// Pure half of the Debug Toolkit (commit menu → "Debug from here…"): every git command the
// toolkit runs is built here, and every piece of Unity output it reads is parsed here, so
// both can be tested without Electron. main.js only spawns processes and reads files.
//
// Several functions below are ALSO embedded, by source text, into the bisect step script
// that git runs once per commit (see bisectStepScript). That script runs in Electron's
// plain-Node mode outside the app bundle, where requiring this file is not reliable inside
// an asar. Those functions must therefore stay self-contained: no references to anything
// outside their own body. test/unity-debug.test.js checks that by evaluating their source.

// ---------------------------------------------------------------------------------------
// Refs, ranges and paths coming from the dialog
// ---------------------------------------------------------------------------------------

// A ref the user typed. It lands in a git argv, so anything that could read as an option
// (a leading '-') or carry whitespace is refused rather than escaped.
function safeRef(ref) {
  const r = String(ref == null ? '' : ref).trim();
  if (!r) return '';
  if (r.startsWith('-') || /[\s\0]/.test(r) || r.length > 256) {
    throw new Error(`"${r.slice(0, 40)}" is not a commit, branch or tag name.`);
  }
  return r;
}

// Files filter typed as "*.cs, Assets/Scripts" → pathspecs. A pathspec only ever follows
// "--", so it cannot become an option.
function pathList(text, fallback) {
  const parts = String(text == null ? '' : text).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : (fallback || []);
}

// "Compare as": everything between the two (A..B), or only what B added since the two
// lines of history split (A...B, the three-dot form).
function rangeSpec(start, end, diverged) {
  return `${safeRef(start)}${diverged ? '...' : '..'}${safeRef(end)}`;
}

const LOG_FORMAT = '--format=%C(yellow)%h%C(reset) %C(bold)%s%C(reset) %C(dim)— %an, %ar%C(reset)';
const COLOR = '--color=always';

// Unity project files, relative to the project folder inside the repo.
const VERSION_FILES = ['ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json', 'Packages/packages-lock.json'];
const SETTINGS_FILES = [
  'ProjectSettings/ProjectSettings.asset', 'ProjectSettings/DynamicsManager.asset',
  'ProjectSettings/Physics2DSettings.asset', 'ProjectSettings/TimeManager.asset',
  'ProjectSettings/InputManager.asset', 'ProjectSettings/TagManager.asset',
  'ProjectSettings/QualitySettings.asset', 'ProjectSettings/GraphicsSettings.asset',
  'ProjectSettings/EditorBuildSettings.asset', 'ProjectSettings/AudioManager.asset'
];

// The ready-made code searches. Written to mean the same under -P (the default) and -E
// (the fallback for a git built without PCRE): \b, \s and \w only, never \d.
const SEARCH_PRESETS = {
  logging: {
    label: 'Leftover logging',
    pattern: '\\bDebug\\.(Log|LogWarning|LogError|LogException|LogFormat|LogAssertion)\\s*\\('
  },
  lookups: {
    label: 'Fragile lookups (Find…)',
    pattern: '\\bGameObject\\.Find(WithTag|GameObjectsWithTag)?\\s*\\(|\\bFind(First|Any)?Objects?(OfType|ByType)\\s*[<(]|\\btransform\\.Find\\s*\\('
  },
  lifecycle: {
    label: 'Init-order suspects (Awake/Start/OnEnable…)',
    pattern: '\\bvoid\\s+(Awake|Start|OnEnable|OnDisable|OnDestroy|OnValidate)\\s*\\('
  },
  editorOnly: {
    label: 'Editor-only code',
    pattern: '#if\\s+!?\\s*UNITY_EDITOR|\\busing\\s+UnityEditor\\b|\\bUnityEditor\\.'
  },
  stringCalls: {
    label: 'Calls by string name (Invoke, SendMessage…)',
    pattern: '\\b(Invoke|InvokeRepeating|CancelInvoke|StartCoroutine|StopCoroutine|SendMessage|SendMessageUpwards|BroadcastMessage)\\s*\\(\\s*"'
  },
  getComponent: {
    label: 'GetComponent calls',
    pattern: '\\bGetComponents?(InChildren|InParent)?\\s*[<(]'
  },
  todo: {
    label: 'TODO / FIXME / HACK',
    pattern: '\\b(TODO|FIXME|HACK|XXX)\\b'
  }
};

function withPrefix(prefix, files) {
  return files.map(f => (prefix || '') + f);
}

// Build the argv for one of the toolkit's git queries. Throws on missing input with a
// message the dialog can show as-is. `p.attributesFile` is the temp file that turns on
// git's built-in C# function finder (see 'method').
function debugQueryArgs(kind, p) {
  p = p || {};
  const range = p.wholeHistory ? null : rangeSpec(p.start, p.end, false);
  const paths = pathList(p.paths, ['*.cs']);
  switch (kind) {
    case 'pickaxe': {
      const text = String(p.text || '');
      if (!text.trim()) throw new Error('Type the text or name to look for.');
      const args = ['log', COLOR, LOG_FORMAT, p.regex ? `-G${text}` : `-S${text}`];
      if (p.ignoreCase) args.push('--regexp-ignore-case');
      if (p.showPatch) args.push('-p', '--no-ext-diff', '--no-textconv');
      if (range) args.push(range);
      return args.concat(['--'], paths);
    }
    case 'method': {
      const func = String(p.func || '').trim();
      const file = String(p.file || '').trim();
      if (!file) throw new Error('Choose the script file.');
      if (!/^[A-Za-z_][\w]*$/.test(func)) throw new Error('Type a method name, e.g. TakeDamage.');
      // C# methods are indented, so git's default function finder (a line starting with a
      // letter) never finds one: -L :TakeDamage: fails with "no match". git ships a csharp
      // driver; it is switched on for *.cs through a throwaway attributes file. (verified)
      const pre = p.attributesFile ? ['-c', `core.attributesFile=${p.attributesFile}`] : [];
      const args = pre.concat(['log', COLOR, LOG_FORMAT, `-L:${func}:${file}`]);
      if (range) args.push(range);
      return args;
    }
    case 'blame': {
      const file = String(p.file || '').trim();
      if (!file) throw new Error('Choose the file to blame.');
      // -w ignores whitespace-only edits; -C -C -C follows code moved or copied from any
      // file in any commit, so a refactor doesn't take the credit for the line.
      const args = ['blame', '-w', '-C', '-C', '-C', '--date=short'];
      const from = parseInt(p.fromLine, 10), to = parseInt(p.toLine, 10);
      if (from > 0) args.push(`-L${from},${to >= from ? to : ''}`);
      if (p.end) args.push(safeRef(p.end));
      return args.concat(['--', file]);
    }
    case 'follow': {
      const file = String(p.file || '').trim();
      if (!file) throw new Error('Choose the file.');
      const args = ['log', COLOR, LOG_FORMAT, '--follow', p.showPatch ? '-p' : '--name-status',
        '--no-ext-diff', '--no-textconv'];
      if (range) args.push(range);
      return args.concat(['--', file]);
    }
    case 'stat':
      return ['diff', COLOR, '--stat=200,140', '--summary', '--no-ext-diff',
        rangeSpec(p.start, p.end, p.diverged), '--'].concat(paths);
    case 'commits':
      return ['log', COLOR, LOG_FORMAT, '--stat=160,100',
        rangeSpec(p.start, p.end, p.diverged), '--'].concat(paths);
    case 'words':
      return ['diff', COLOR, '--word-diff=color', '--no-ext-diff', '--no-textconv',
        rangeSpec(p.start, p.end, p.diverged), '--'].concat(p.file ? [String(p.file).trim()] : paths);
    case 'moved':
      return ['diff', COLOR, '--color-moved=zebra', '--color-moved-ws=allow-indentation-change',
        '--no-ext-diff', '--no-textconv', rangeSpec(p.start, p.end, p.diverged), '--'].concat(paths);
    case 'versions':
      return ['log', COLOR, LOG_FORMAT, '-p', '--no-ext-diff', rangeSpec(p.start, p.end, false), '--']
        .concat(withPrefix(p.prefix, VERSION_FILES));
    case 'settings':
      return ['log', COLOR, LOG_FORMAT, '-p', '--no-ext-diff', '--no-textconv', rangeSpec(p.start, p.end, false), '--']
        .concat(withPrefix(p.prefix, SETTINGS_FILES));
    case 'grep': {
      const patterns = (p.presets || []).map(k => SEARCH_PRESETS[k] && SEARCH_PRESETS[k].pattern).filter(Boolean);
      const custom = String(p.custom || '');
      if (custom.trim()) {
        // Plain text is escaped so "Debug.Log(" means exactly that.
        patterns.push(p.regex ? custom : custom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
      if (!patterns.length) throw new Error('Tick a search or type something to look for.');
      // Perl-compatible, because that is the regex people write (C#, JS, editors). git's -E
      // is POSIX ERE, where \d, \D, lazy quantifiers and lookarounds are not errors — they
      // just never match, so a correct pattern silently finds nothing (verified, 2.47).
      // main retries with engine 'E' when git was built without PCRE.
      const args = ['grep', COLOR, '-n', '-I', '--heading', '--break', p.engine === 'E' ? '-E' : '-P'];
      if (p.ignoreCase) args.push('-i');
      patterns.forEach(pt => args.push('-e', pt));
      if (p.atEnd) args.push(safeRef(p.end));
      return args.concat(['--'], paths);
    }
    default:
      throw new Error(`Unknown query "${kind}"`);
  }
}

// ---------------------------------------------------------------------------------------
// Unity project facts
// ---------------------------------------------------------------------------------------

function parseProjectVersion(text) {
  const m = /^m_EditorVersion:\s*(\S+)/m.exec(String(text || ''));
  return m ? m[1] : null;
}

// companyName / productName decide where a built player writes Player.log.
function parseProjectIdentity(text) {
  const t = String(text || '');
  const pick = (k) => { const m = new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm').exec(t); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''; };
  return { company: pick('companyName'), product: pick('productName') };
}

// Where Unity Hub installs editors: its default folder plus the user's "secondary" install
// location, which Hub records as a JSON string in its own config folder.
function hubEditorRoots(platform, env, secondary) {
  env = env || {};
  const roots = [];
  if (secondary) roots.push(secondary);
  if (platform === 'win32') {
    for (const pf of [env.ProgramFiles, env['ProgramW6432'], 'C:\\Program Files']) {
      if (pf) roots.push(`${pf}\\Unity\\Hub\\Editor`);
    }
  } else if (platform === 'darwin') {
    roots.push('/Applications/Unity/Hub/Editor');
  } else if (env.HOME) {
    roots.push(`${env.HOME}/Unity/Hub/Editor`);
  }
  return Array.from(new Set(roots));
}

function hubSecondaryConfigPath(platform, env) {
  env = env || {};
  if (platform === 'win32') return env.APPDATA ? `${env.APPDATA}\\UnityHub\\secondaryInstallPath.json` : null;
  if (platform === 'darwin') return env.HOME ? `${env.HOME}/Library/Application Support/UnityHub/secondaryInstallPath.json` : null;
  return env.HOME ? `${env.HOME}/.config/UnityHub/secondaryInstallPath.json` : null;
}

// The executable inside one Hub version folder.
function editorExeIn(versionDir, platform) {
  const sep = platform === 'win32' ? '\\' : '/';
  if (platform === 'win32') return `${versionDir}${sep}Editor${sep}Unity.exe`;
  if (platform === 'darwin') return `${versionDir}/Unity.app/Contents/MacOS/Unity`;
  return `${versionDir}/Editor/Unity`;
}

function unityLogPath(which, platform, env, identity) {
  env = env || {};
  const prev = /Prev$/.test(which);
  if (/^editor/.test(which)) {
    const name = prev ? 'Editor-prev.log' : 'Editor.log';
    if (platform === 'win32') return env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Unity\\Editor\\${name}` : null;
    if (platform === 'darwin') return env.HOME ? `${env.HOME}/Library/Logs/Unity/${name}` : null;
    return env.HOME ? `${env.HOME}/.config/unity3d/${name}` : null;
  }
  if (/^player/.test(which)) {
    const id = identity || {};
    if (!id.company || !id.product) return null;
    const name = prev ? 'Player-prev.log' : 'Player.log';
    if (platform === 'win32') return env.USERPROFILE ? `${env.USERPROFILE}\\AppData\\LocalLow\\${id.company}\\${id.product}\\${name}` : null;
    if (platform === 'darwin') return env.HOME ? `${env.HOME}/Library/Logs/${id.company}/${id.product}/${name}` : null;
    return env.HOME ? `${env.HOME}/.config/unity3d/${id.company}/${id.product}/${name}` : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Reading Unity's logs
// ---------------------------------------------------------------------------------------

// Group a Unity log into error blocks: the line that reports the problem plus the stack
// lines under it (Unity ends each entry with a blank line). Identical blocks — the same
// exception every frame — are folded into one with a count, in order of first appearance.
function filterUnityLog(text, opts) {
  opts = opts || {};
  const withWarnings = !!opts.warnings;
  const needle = String(opts.filter || '').toLowerCase();
  const maxBlocks = opts.maxBlocks || 500;
  const ERR = /(\b\w*Exception\b|error CS\d{4}|^\s*Error\b|\bAssertion failed\b|The referenced script .* is missing|Missing Prefab|Shader error|\[Error\]|Scripts have compiler errors|Aborting batchmode)/i;
  const WARN = /(warning CS\d{4}|^\s*Warning\b|\[Warning\])/i;
  // A stack frame under an entry: "  at …", "UnityEngine.Debug:LogError (…)",
  // "Player.Update () (at Assets/…)", "(Filename: …)". Compiler errors arrive on
  // consecutive lines with no blank between them, so a line that reports a NEW problem
  // (and is not a frame) starts its own block.
  const FRAME = /^\s*(at |\(at |\(Filename:|UnityEngine\.|UnityEditor\.|System\.|[A-Za-z_][\w.`<>]*[.:][A-Za-z_<][^(]*\(.*\)\s*(\(at .*\))?\s*$)/;
  const lines = String(text || '').replace(/\r/g, '').split('\n');

  // Debug.LogError / LogException / LogWarning messages carry no keyword of their own
  // ("Host type is not matching…") — their level is only in the stack Unity prints under
  // them (UnityEngine.Debug:LogError). So find those frames, walk up past the stack, and
  // mark the message line(s) above it as the start of an entry of that level.
  const marked = new Map();   // line index → 'error' | 'exception' | 'warning'
  const LEVEL = /^UnityEngine\.Debug:Log(Error|Exception|Assertion|Warning)\w*\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const lv = LEVEL.exec(lines[i]);
    if (!lv) continue;
    const kind = lv[1] === 'Warning' ? 'warning' : lv[1] === 'Exception' ? 'exception' : 'error';
    if (kind === 'warning' && !withWarnings) continue;
    let s = i;
    while (s > 0 && lines[s - 1].trim() !== '' && FRAME.test(lines[s - 1])) s--;
    // Only the line right above the stack: walking further up picks up whatever the
    // Editor printed before it (timing lines) as if it were part of the message.
    const m = s - 1;
    if (m >= 0 && lines[m].trim() !== '' && !marked.has(m)) marked.set(m, kind);
  }
  // A frame never starts an entry, even one that mentions "System.Exception&".
  const startsNew = (l, k) => marked.has(k) || ((ERR.test(l) || (withWarnings && WARN.test(l))) && !FRAME.test(l));
  const byKey = new Map();
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!startsNew(line, i)) continue;
    const isErr = marked.has(i) ? marked.get(i) !== 'warning' : ERR.test(line);
    const isWarn = !isErr;
    const body = [line];
    let j = i + 1;
    // A compiler error is one line; whatever follows it belongs to something else.
    const single = /error CS\d{4}|warning CS\d{4}/i.test(line);
    while (!single && j < lines.length && lines[j].trim() !== '' && body.length < 24 && !startsNew(lines[j], j)) {
      body.push(lines[j]);
      j++;
    }
    i = j - 1;
    const blockText = body.join('\n');
    if (needle && !blockText.toLowerCase().includes(needle)) continue;
    const key = blockText;
    if (byKey.has(key)) { const b = byKey.get(key); b.count++; b.lastLine = i + 1; continue; }
    if (blocks.length >= maxBlocks) continue;
    const kind = /error CS\d{4}/i.test(line) ? 'compile'
      : marked.has(i - body.length + 1) ? marked.get(i - body.length + 1)
      : /exception/i.test(line) ? 'exception'
      : isWarn ? 'warning' : 'error';
    // Compiler errors print Windows paths with backslashes; stack frames use '/'.
    const loc = /((?:Assets|Packages)[\\/][^:()\n]+\.cs)(?:\((\d+),\d+\)|:(\d+))/.exec(blockText);
    const b = { kind, text: blockText, count: 1, firstLine: i + 1 - (body.length - 1), lastLine: i + 1,
      file: loc ? loc[1].replace(/\\/g, '/') : null, line: loc ? parseInt(loc[2] || loc[3], 10) : null };
    byKey.set(key, b);
    blocks.push(b);
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------
// Running Unity headless — EMBEDDED in the bisect step script; keep self-contained.
// ---------------------------------------------------------------------------------------

// argv for one headless Unity run. Never -quit with -runTests: Unity quits by itself once
// the tests finish, and with -quit it can exit before they start.
function unityArgs(mode, o) {
  o = o || {};
  const args = ['-batchmode'];
  if (o.noGraphics !== false) args.push('-nographics');
  args.push('-projectPath', o.projectPath, '-logFile', o.logFile);
  if (mode === 'compile') {
    args.push('-quit');
  } else {
    args.push('-runTests', '-testPlatform', mode === 'playmode' ? 'PlayMode' : 'EditMode', '-testResults', o.resultsFile);
    if (o.filter) args.push('-testFilter', o.filter);
  }
  return args;
}

// Unity's test results (NUnit 3 XML). Read with regexes — there is no DOM in the step
// script — which is enough for the two things needed: the run's totals, and each failed
// case with its message.
function parseNUnitResults(xml) {
  const text = String(xml || '');
  const run = /<test-run\b([^>]*)>/.exec(text);
  if (!run) return null;
  const attr = (s, k) => { const m = new RegExp(`\\b${k}="([^"]*)"`).exec(s); return m ? m[1] : ''; };
  const num = (k) => parseInt(attr(run[1], k), 10) || 0;
  const failures = [];
  const re = /<test-case\b([^>]*?)(\/>|>([\s\S]*?)<\/test-case>)/g;
  let m;
  while ((m = re.exec(text)) && failures.length < 200) {
    const result = attr(m[1], 'result');
    if (!/^Failed/.test(result)) continue;
    const inner = m[3] || '';
    const msg = /<message>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/message>/.exec(inner);
    failures.push({ name: attr(m[1], 'fullname') || attr(m[1], 'name'), message: msg ? msg[1].trim() : '' });
  }
  return {
    total: num('total'), passed: num('passed'), failed: num('failed'),
    skipped: num('skipped') + num('inconclusive'),
    result: attr(run[1], 'result'), failures
  };
}

// The compiler errors in a Unity log, once each.
function compileErrors(log) {
  const seen = new Set();
  const out = [];
  const re = /^.*\berror CS\d{4}:.*$/gm;
  let m;
  const text = String(log || '').replace(/\r/g, '');
  while ((m = re.exec(text)) && out.length < 50) {
    const line = m[0].trim();
    if (!seen.has(line)) { seen.add(line); out.push(line); }
  }
  return out;
}

// Was this commit working? → { verdict: 'pass' | 'fail' | 'skip', reason }
//   compile mode: a non-zero exit WITH compiler errors is a fail; without them Unity could
//                 not run at all (licence, crash, wrong version), which says nothing about
//                 the commit — skip.
//   test modes:   the results file is the authority, not the exit code. No file means
//                 Unity never got to the tests: compile errors count as compileFailAs
//                 ('skip' by default, so a commit that doesn't build isn't blamed for a
//                 test failure it never had), anything else is a skip. Zero tests run is
//                 a skip too — "nothing failed" is not "it works".
function unityVerdict(mode, r) {
  r = r || {};
  const errs = r.compileErrors || [];
  if (r.timedOut) return { verdict: 'skip', reason: 'Unity ran past the time limit' };
  if (mode === 'compile') {
    if (r.exitCode === 0) return { verdict: 'pass', reason: 'Compiles' };
    if (errs.length) return { verdict: 'fail', reason: errs[0] };
    return { verdict: 'skip', reason: `Unity could not run (exit ${r.exitCode})` };
  }
  const res = r.results;
  if (!res) {
    if (errs.length) {
      return { verdict: r.compileFailAs === 'fail' ? 'fail' : 'skip', reason: 'Does not compile: ' + errs[0] };
    }
    return { verdict: 'skip', reason: `No test results (exit ${r.exitCode})` };
  }
  if (res.failed > 0) {
    const f = res.failures && res.failures[0];
    return { verdict: 'fail', reason: `${res.failed} of ${res.total} failed` + (f ? ` — ${f.name}` : '') };
  }
  if (!res.total) return { verdict: 'skip', reason: 'No tests ran (check the filter)' };
  return { verdict: 'pass', reason: `${res.passed} of ${res.total} passed` };
}

// Exit code git bisect run understands. 'invert' is the find-the-fix mode, where the old
// commits are the broken ones: a pass then means "new".
function bisectExitCode(verdict, invert) {
  if (verdict === 'skip') return 125;
  const pass = verdict === 'pass';
  return (pass !== !!invert) ? 0 : 1;
}

// Pick the editor for a commit: its own version if Hub has it, else the chosen one.
function pickEditor(version, installed, fallback, useOwnVersion) {
  if (useOwnVersion && version && installed && installed[version]) return { path: installed[version], version, own: true };
  return fallback ? { path: fallback, version: null, own: false } : null;
}

// ---------------------------------------------------------------------------------------
// Reading git bisect's output
// ---------------------------------------------------------------------------------------

function parseBisectOutput(out) {
  const text = String(out || '').replace(/\r/g, '');
  const steps = [];
  const re = /^GITGOOD-STEP (\{.*\})$/gm;
  let m;
  while ((m = re.exec(text))) { try { steps.push(JSON.parse(m[1])); } catch (e) { /* partial line */ } }
  const found = /^([0-9a-f]{40}) is the first (\S+) commit/m.exec(text);
  if (found) return { status: 'found', hash: found[1], term: found[2], steps };
  if (/only 'skip'ped commits left to test/.test(text)) {
    const tail = text.split(/could be any of:/)[1] || '';
    const hashes = (tail.match(/^[0-9a-f]{40}$/gm) || []);
    return { status: 'ambiguous', candidates: hashes, steps };
  }
  return { status: 'unfinished', steps };
}

// "Bisecting: 12 revisions left to test after this (roughly 4 steps)"
function bisectRemaining(text) {
  const all = String(text || '').match(/roughly (\d+) steps?/g);
  if (!all) return null;
  return parseInt(/(\d+)/.exec(all[all.length - 1])[1], 10);
}

function bisectStepsEstimate(count) {
  const n = Math.max(0, count | 0);
  return n <= 1 ? n : Math.ceil(Math.log2(n + 1));
}

// ---------------------------------------------------------------------------------------
// Unity suspects that need more than a git log
// ---------------------------------------------------------------------------------------

function parseScriptMeta(text) {
  const t = String(text || '');
  const g = /^guid:\s*([0-9a-f]{32})/m.exec(t);
  const e = /^\s*executionOrder:\s*(-?\d+)/m.exec(t);
  return { guid: g ? g[1] : null, executionOrder: e ? parseInt(e[1], 10) : 0 };
}

// name-status -z output → [{ status, path, oldPath }]
function parseNameStatusZ(out) {
  const parts = String(out || '').split('\0');
  const rows = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    if (!st) continue;
    if (/^[RC]/.test(st)) { rows.push({ status: st[0], oldPath: parts[i], path: parts[i + 1] }); i += 2; }
    else { rows.push({ status: st[0], path: parts[i] }); i += 1; }
  }
  return rows;
}

// Script changes that break things in the Editor without touching a line of code.
//   changes:   name-status rows for *.cs and *.cs.meta between Start and End
//   metaStart: path → meta text at Start; metaEnd: path → meta text at End (null = absent)
//   endHasMeta(path) → whether <path>.meta exists at End
function scriptMetaFindings(changes, metaStart, metaEnd, endHasMeta) {
  const out = [];
  const get = (map, p) => (map && Object.prototype.hasOwnProperty.call(map, p)) ? map[p] : null;
  for (const c of changes || []) {
    const p = c.path || '';
    if (/\.cs$/i.test(p)) {
      if (c.status === 'D') {
        out.push({ kind: 'deleted', path: p, guid: parseScriptMeta(get(metaStart, p + '.meta')).guid,
          text: 'Script deleted — every scene or prefab that used it now shows "Missing (Mono Script)".' });
      } else if (c.status === 'A' && endHasMeta && !endHasMeta(p)) {
        out.push({ kind: 'nometa', path: p,
          text: 'Script added without its .meta — each machine invents its own GUID, so references made on one machine are missing on the others.' });
      } else if (c.status === 'R' && c.oldPath) {
        const before = parseScriptMeta(get(metaStart, c.oldPath + '.meta')).guid;
        const after = parseScriptMeta(get(metaEnd, p + '.meta')).guid;
        if (before && after && before !== after) {
          out.push({ kind: 'guid', path: p, oldPath: c.oldPath, guid: before, newGuid: after,
            text: `Renamed from ${c.oldPath} and its GUID changed — references to the old script are now missing.` });
        }
      }
      continue;
    }
    if (!/\.cs\.meta$/i.test(p) || c.status === 'D' || c.status === 'A') continue;
    const oldPath = c.oldPath || p;
    const a = parseScriptMeta(get(metaStart, oldPath));
    const b = parseScriptMeta(get(metaEnd, p));
    const script = p.replace(/\.meta$/i, '');
    if (a.guid && b.guid && a.guid !== b.guid) {
      out.push({ kind: 'guid', path: script, guid: a.guid, newGuid: b.guid,
        text: 'GUID changed — scenes and prefabs still point at the old one, so the component shows as missing.' });
    }
    if (a.executionOrder !== b.executionOrder) {
      out.push({ kind: 'order', path: script, from: a.executionOrder, to: b.executionOrder,
        text: `Script execution order changed ${a.executionOrder} → ${b.executionOrder} — Awake/Start/Update now run in a different order.` });
    }
  }
  return out;
}

// Serialized fields that disappeared while another appeared in the same file: Unity stores
// values by field name, so a rename without [FormerlySerializedAs("old")] silently resets
// every value saved in scenes and prefabs. Works on a -U1 diff of *.cs: one line of
// context, because [SerializeField] often sits on the line above an unchanged-attribute
// field, and is then only visible as context.
function findSerializedRenames(diffText) {
  const files = [];
  let cur = null;
  const FIELD = /^\s*((?:\[[^\]]*\]\s*)*)(public|private|protected|internal)?\s*(?:(?:readonly|static|const|new|volatile)\s+)*([\w.<>,\[\]\s?]+?)\s+([A-Za-z_]\w*)\s*(=[^;]*)?;\s*(\/\/.*)?$/;
  const ATTR_ONLY = /^\s*(\[[^\]]*\]\s*)+$/;
  const isSerialized = (attrs, access, line) => {
    if (/\b(static|const|readonly|event)\b/.test(line)) return false;
    if (/NonSerialized/.test(attrs)) return false;
    return /SerializeField|SerializeReference/.test(attrs) || access === 'public';
  };
  // The line above, per side: context counts for both, a removal only for the old side.
  let prevOld = '', prevNew = '';
  for (const raw of String(diffText || '').replace(/\r/g, '').split('\n')) {
    if (raw.startsWith('diff --git ')) { cur = { file: null, removed: [], added: [], formerly: new Set() }; files.push(cur); prevOld = prevNew = ''; continue; }
    if (!cur) continue;
    if (raw.startsWith('+++ ')) { cur.file = raw.slice(4).replace(/^b\//, ''); continue; }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('@@')) { prevOld = prevNew = ''; continue; }
    const sign = raw[0];
    const line = raw.slice(1);
    if (sign === ' ') { prevOld = prevNew = line; continue; }
    if (sign !== '+' && sign !== '-') continue;
    const above = sign === '-' ? prevOld : prevNew;
    if (sign === '-') prevOld = line; else prevNew = line;
    const fs = /FormerlySerializedAs\s*\(\s*"([^"]+)"/g;
    let fm;
    while (sign === '+' && (fm = fs.exec(line))) cur.formerly.add(fm[1]);
    if (/=>|[{}]/.test(line)) continue;                                               // property / block
    if (/\(/.test(line.replace(/\[[^\]]*\]/g, '').replace(/=.*$/, ''))) continue;   // a method or call
    const m = FIELD.exec(line);
    if (!m) continue;
    const attrs = (m[1] || '') + (ATTR_ONLY.test(above) ? above : '');
    if (!isSerialized(attrs, m[2] || '', line)) continue;
    const field = { name: m[4], type: m[3].trim(), line: line.trim() };
    (sign === '-' ? cur.removed : cur.added).push(field);
  }
  const out = [];
  for (const f of files) {
    if (!f.file || f.file === '/dev/null') continue;
    const addedNames = new Set(f.added.map(a => a.name));
    const removedNames = new Set(f.removed.map(r => r.name));
    const gone = f.removed.filter(r => !addedNames.has(r.name) && !f.formerly.has(r.name));
    const fresh = f.added.filter(a => !removedNames.has(a.name));
    for (const r of gone) {
      const sameType = fresh.filter(a => a.type === r.type);
      out.push({ file: f.file, removed: r.name, type: r.type, candidates: (sameType.length ? sameType : fresh).map(a => a.name) });
    }
  }
  return out;
}

// Lines that use UnityEditor outside #if UNITY_EDITOR, in a file that is part of a player
// build. They compile in the Editor and break the build. A preprocessor stack decides
// whether each line is guarded; '!UNITY_EDITOR' and an '||' with something else are not.
function editorLeaks(text) {
  const out = [];
  const stack = [];   // { guarded, elseGuarded }
  const guardedBy = (cond) => /\bUNITY_EDITOR\b/.test(cond) && !/!\s*UNITY_EDITOR\b/.test(cond) && !/\|\|/.test(cond);
  const negated = (cond) => /^\s*!\s*UNITY_EDITOR\s*$/.test(cond);
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const pp = /^\s*#\s*(if|elif|else|endif)\b(.*)$/.exec(line);
    if (pp) {
      const cond = pp[2].replace(/\/\/.*$/, '');
      if (pp[1] === 'if') stack.push({ guarded: guardedBy(cond), elseGuarded: negated(cond) });
      else if (pp[1] === 'elif' && stack.length) { const top = stack[stack.length - 1]; top.guarded = guardedBy(cond); top.elseGuarded = false; }
      else if (pp[1] === 'else' && stack.length) { const top = stack[stack.length - 1]; top.guarded = top.elseGuarded; }
      else if (pp[1] === 'endif') stack.pop();
      continue;
    }
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (/\/\*/.test(code)) inBlockComment = true;
    if (!/\bUnityEditor\b/.test(code)) continue;
    if (stack.some(s => s.guarded)) continue;
    out.push({ line: i + 1, text: lines[i].trim() });
  }
  return out;
}

// A folder that Unity leaves out of player builds: any folder named "Editor", or one
// covered by an editor-only assembly definition.
function isEditorOnlyPath(p, editorAsmdefDirs) {
  const s = String(p || '').replace(/\\/g, '/');
  if (/(^|\/)Editor\//.test(s)) return true;
  return (editorAsmdefDirs || []).some(d => d === '' || s.startsWith(d.endsWith('/') ? d : d + '/'));
}

// ---------------------------------------------------------------------------------------
// The step script git bisect runs once per commit
// ---------------------------------------------------------------------------------------

// Source of the script. Its config (what to test, where Unity is, which files to clean
// up) is a JSON file passed as its only argument. It prints one "GITGOOD-STEP {json}"
// line per commit — git passes the script's stdout through — and exits 0 / 1 / 125.
function bisectStepScript() {
  const embed = [unityArgs, parseNUnitResults, compileErrors, unityVerdict, bisectExitCode, pickEditor, parseProjectVersion]
    .map(f => f.toString()).join('\n\n');
  return `'use strict';
// GitGood bisect step — generated; see src/main/lib/unity-debug.js.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));

${embed}

function git(args) {
  return cp.spawnSync('git', args, { cwd: cfg.repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
}
function readOr(p, d) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return d; } }

const t0 = Date.now();
const hash = (git(['rev-parse', 'HEAD']).stdout || '').trim();
const subject = (git(['log', '-1', '--format=%s']).stdout || '').trim();
let verdict = 'skip', reason = '', extra = {};

function emit(kind, obj) { process.stdout.write('GITGOOD-' + kind + ' ' + JSON.stringify(obj) + '\\n'); }

try {
  if (cfg.kind === 'command') {
    emit('INFO', { hash, subject, text: 'Running: ' + cfg.command });
    const r = cp.spawnSync(cfg.command, { cwd: cfg.cwd, shell: true, stdio: ['ignore', 'inherit', 'inherit'],
      timeout: cfg.timeoutMs || undefined, windowsHide: true });
    if (r.error && r.error.code === 'ETIMEDOUT') { verdict = 'skip'; reason = 'Ran past the time limit'; }
    else if (r.status === 0) { verdict = 'pass'; reason = 'Exit 0'; }
    else if (r.status === 125) { verdict = 'skip'; reason = 'The command asked to skip (exit 125)'; }
    else if (r.status == null) { verdict = 'skip'; reason = 'The command did not run' + (r.error ? ': ' + r.error.message : ''); }
    else { verdict = 'fail'; reason = 'Exit ' + r.status; }
  } else {
    const proj = path.join(cfg.repo, cfg.prefix || '');
    const version = parseProjectVersion(readOr(path.join(proj, 'ProjectSettings', 'ProjectVersion.txt'), ''));
    const ed = pickEditor(version, cfg.installed, cfg.editor, cfg.useOwnVersion);
    if (!ed) {
      verdict = 'skip'; reason = 'No Unity editor for ' + (version || 'this commit');
    } else {
      emit('INFO', { hash, subject, text: 'Unity ' + (ed.own ? version : (version ? version + ' (using the chosen editor)' : '')) + ' — ' + cfg.mode });
      const stamp = Date.now();
      const logFile = path.join(cfg.tmp, 'step-' + stamp + '.log');
      const resultsFile = path.join(cfg.tmp, 'step-' + stamp + '.xml');
      const args = unityArgs(cfg.mode, { projectPath: proj, logFile, resultsFile, filter: cfg.filter, noGraphics: cfg.noGraphics });
      const r = cp.spawnSync(ed.path, args, { cwd: proj, stdio: 'ignore', timeout: cfg.timeoutMs || undefined, windowsHide: true });
      const log = readOr(logFile, '');
      const results = cfg.mode === 'compile' ? null : parseNUnitResults(readOr(resultsFile, ''));
      const v = unityVerdict(cfg.mode, { exitCode: r.status, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'),
        results, compileErrors: compileErrors(log), compileFailAs: cfg.compileFailAs });
      verdict = v.verdict; reason = v.reason;
      if (results) extra = { passed: results.passed, failed: results.failed, total: results.total };
      extra.log = logFile;
    }
  }
} catch (e) {
  verdict = 'skip'; reason = 'Step failed: ' + (e && e.message || e);
}

// Put the checkout back the way git left it, so the next "git checkout" cannot be refused
// over files Unity rewrote (packages-lock.json, upgraded settings, new .meta files). The
// tree was verified clean before the bisect started, so every tracked change here is the
// test's own; untracked files are removed only if they were not there at the start, and
// never inside Unity's cache folders.
if (cfg.cleanup) {
  try {
    git(['reset', '--hard', '-q']);
    const now = (git(['ls-files', '-o', '--exclude-standard', '-z']).stdout || '').split('\\0').filter(Boolean);
    const before = new Set(cfg.baselineUntracked || []);
    for (const f of now) {
      if (before.has(f)) continue;
      if (/(^|\\/)(Library|Temp|Logs|obj|UserSettings)\\//.test(f)) continue;
      try { fs.unlinkSync(path.join(cfg.repo, f)); } catch (e) {}
    }
  } catch (e) {}
}

emit('STEP', Object.assign({ hash, subject, verdict, reason, seconds: Math.round((Date.now() - t0) / 1000) }, extra));
process.exit(bisectExitCode(verdict, cfg.invert));
`;
}

module.exports = {
  safeRef, pathList, rangeSpec, debugQueryArgs, SEARCH_PRESETS, VERSION_FILES, SETTINGS_FILES,
  parseProjectVersion, parseProjectIdentity, hubEditorRoots, hubSecondaryConfigPath, editorExeIn, unityLogPath,
  filterUnityLog, unityArgs, parseNUnitResults, compileErrors, unityVerdict, bisectExitCode, pickEditor,
  parseBisectOutput, bisectRemaining, bisectStepsEstimate,
  parseScriptMeta, parseNameStatusZ, scriptMetaFindings, findSerializedRenames, editorLeaks, isEditorOnlyPath,
  bisectStepScript
};
