// Bootstrap updates: when an installed shell may run main's source, and when the
// bootstrap must fall back to the installed code instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sb = require('../src/main/lib/source-boot');

const shell = { version: '1.2.3', dependencies: { 'simple-git': '^3.25.0' }, devDependencies: { electron: '^31.0.0' } };

test('sourceCompatibility: same Electron major and identical dependencies', () => {
  assert.deepStrictEqual(sb.sourceCompatibility(shell, { ...shell, version: '1.2.9' }, '31.7.7'), { ok: true });
  // Build tools changing is fine — only electron among devDependencies matters.
  assert.strictEqual(sb.sourceCompatibility(shell, { ...shell, devDependencies: { electron: '^31.2.0', 'electron-builder': '^25' } }, '31.7.7').ok, true);
});

test('sourceCompatibility: a new Electron major needs the installer', () => {
  const r = sb.sourceCompatibility(shell, { ...shell, devDependencies: { electron: '^32.0.0' } }, '31.7.7');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /Electron 32.*Electron 31/);
});

test('sourceCompatibility: any dependency change needs the installer', () => {
  const bumped = sb.sourceCompatibility(shell, { ...shell, dependencies: { 'simple-git': '^3.30.0' } }, '31.7.7');
  assert.strictEqual(bumped.ok, false);
  assert.match(bumped.reason, /simple-git/);
  const added = sb.sourceCompatibility(shell, { ...shell, dependencies: { ...shell.dependencies, chalk: '^5' } }, '31.7.7');
  assert.match(added.reason, /chalk/);
  const removed = sb.sourceCompatibility(shell, { ...shell, dependencies: {} }, '31.7.7');
  assert.strictEqual(removed.ok, false);
  assert.strictEqual(sb.sourceCompatibility(shell, null, '31.7.7').ok, false);
});

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const okSource = { exists: true, pkg: { version: '1.2.4' }, compat: { ok: true } };
const state = (extra) => ({ current: { commit: SHA, version: '1.2.4', dir: 'versions/abcdef123456' }, attempts: {}, bad: [], ...extra });

test('chooseBoot: runs the source when it is present, healthy, compatible and not older', () => {
  assert.strictEqual(sb.chooseBoot({ state: state(), shellVersion: '1.2.3', source: okSource }).use, 'source');
  // Same version: main may have commits after the build, so the source still wins.
  assert.strictEqual(sb.chooseBoot({ state: state(), shellVersion: '1.2.4', source: okSource }).use, 'source');
});

test('chooseBoot: no source configured is the plain installed app, silently', () => {
  assert.deepStrictEqual(sb.chooseBoot({ state: { attempts: {}, bad: [] }, shellVersion: '1.2.3', source: null }), { use: 'bundled' });
});

test('chooseBoot: falls back, and says why, for missing, bad, crashing or incompatible source', () => {
  const missing = sb.chooseBoot({ state: state(), shellVersion: '1.2.3', source: { exists: false } });
  assert.strictEqual(missing.use, 'bundled'); assert.match(missing.note, /missing/);

  const bad = sb.chooseBoot({ state: state({ bad: [SHA] }), shellVersion: '1.2.3', source: okSource });
  assert.strictEqual(bad.use, 'bundled'); assert.match(bad.note, /failed to start/);

  const looping = sb.chooseBoot({ state: state({ attempts: { [SHA]: sb.MAX_BOOT_ATTEMPTS } }), shellVersion: '1.2.3', source: okSource });
  assert.strictEqual(looping.use, 'bundled'); assert.strictEqual(looping.markBad, true);
  const once = sb.chooseBoot({ state: state({ attempts: { [SHA]: sb.MAX_BOOT_ATTEMPTS - 1 } }), shellVersion: '1.2.3', source: okSource });
  assert.strictEqual(once.use, 'source');

  const incompatible = sb.chooseBoot({ state: state(), shellVersion: '1.2.3', source: { ...okSource, compat: { ok: false, reason: 'main needs Electron 32' } } });
  assert.strictEqual(incompatible.use, 'bundled'); assert.match(incompatible.note, /Electron 32/);
});

test('chooseBoot: a newer installed app beats an older source, without a warning', () => {
  const r = sb.chooseBoot({ state: state(), shellVersion: '1.2.10', source: okSource });
  assert.deepStrictEqual(r, { use: 'bundled' });
});

test('boot state: round-trips, and a missing or corrupt file reads as empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-boot-'));
  try {
    assert.deepStrictEqual(sb.readBootState(root), { current: null, attempts: {}, bad: [], lastFailure: null });
    sb.writeBootState(root, state({ attempts: { [SHA]: 1 } }));
    const back = sb.readBootState(root);
    assert.strictEqual(back.current.commit, SHA);
    assert.strictEqual(back.attempts[SHA], 1);
    fs.writeFileSync(path.join(root, 'state.json'), '{ not json');
    assert.strictEqual(sb.readBootState(root).current, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('inspectSource: only a complete export (marker + main.js) counts as present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-boot-'));
  try {
    const cur = { commit: SHA, dir: 'versions/abcdef123456' };
    const dir = path.join(root, cur.dir);
    fs.mkdirSync(path.join(dir, 'src', 'main'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(shell));
    fs.writeFileSync(path.join(dir, 'src', 'main', 'main.js'), '');
    assert.strictEqual(sb.inspectSource(root, cur, shell, '31.0.0').exists, false);
    fs.writeFileSync(path.join(dir, sb.SOURCE_MARKER), '{}');
    const s = sb.inspectSource(root, cur, shell, '31.0.0');
    assert.strictEqual(s.exists, true);
    assert.strictEqual(s.compat.ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('versionDirsToPrune: keeps the new and the running version, drops the rest', () => {
  assert.deepStrictEqual(
    sb.versionDirsToPrune(['aaa', 'bbb', 'ccc', 'ccc.tmp-42'], ['bbb', 'versions/ccc']),
    ['aaa', 'ccc.tmp-42']);
  assert.deepStrictEqual(sb.versionDirsToPrune(['aaa'], ['aaa', null]), []);
});
