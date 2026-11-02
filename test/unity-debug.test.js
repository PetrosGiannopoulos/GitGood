'use strict';
const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/main/lib/unity-debug');

test('refs that could read as git options are refused', () => {
  assert.throws(() => u.safeRef('--output=x'));
  assert.throws(() => u.safeRef('a b'));
  assert.strictEqual(u.safeRef(' main '), 'main');
  assert.strictEqual(u.rangeSpec('v1.0', 'HEAD', false), 'v1.0..HEAD');
  assert.strictEqual(u.rangeSpec('main', 'HEAD', true), 'main...HEAD');
});

test('pickaxe: -S for exact text, -G for a pattern, paths after --', () => {
  const s = u.debugQueryArgs('pickaxe', { text: 'TakeDamage', start: 'a', end: 'b' });
  assert.ok(s.includes('-STakeDamage'));
  assert.ok(s.includes('a..b'));
  assert.deepStrictEqual(s.slice(s.indexOf('--')), ['--', '*.cs']);
  const g = u.debugQueryArgs('pickaxe', { text: 'health\\s*-=', regex: true, wholeHistory: true, paths: 'Assets/Scripts' });
  assert.ok(g.includes('-Ghealth\\s*-='));
  assert.ok(!g.some(a => a.includes('..')));
  assert.deepStrictEqual(g.slice(g.indexOf('--')), ['--', 'Assets/Scripts']);
  assert.throws(() => u.debugQueryArgs('pickaxe', { text: ' ' }));
});

test('method history turns on the C# function finder, which git needs for indented methods', () => {
  const a = u.debugQueryArgs('method', { func: 'TakeDamage', file: 'Assets/P.cs', attributesFile: '/tmp/attr', wholeHistory: true });
  assert.deepStrictEqual(a.slice(0, 3), ['-c', 'core.attributesFile=/tmp/attr', 'log']);
  assert.ok(a.includes('-L:TakeDamage:Assets/P.cs'));
  assert.throws(() => u.debugQueryArgs('method', { func: 'a:b', file: 'x.cs' }));
});

test('grep escapes plain text and ORs every pattern', () => {
  const a = u.debugQueryArgs('grep', { presets: ['logging'], custom: 'Find(' });
  const es = a.filter((x, i) => a[i - 1] === '-e');
  assert.strictEqual(es.length, 2);
  assert.strictEqual(es[1], 'Find\\(');
  assert.throws(() => u.debugQueryArgs('grep', { presets: [], custom: '' }));
});

test('Unity project facts', () => {
  assert.strictEqual(u.parseProjectVersion('m_EditorVersion: 2022.3.10f1\nm_EditorVersionWithRevision: x'), '2022.3.10f1');
  assert.deepStrictEqual(u.parseProjectIdentity('  companyName: Crusade Co\n  productName: Git Good\n'),
    { company: 'Crusade Co', product: 'Git Good' });
  assert.strictEqual(u.unityLogPath('playerPrev', 'win32', { USERPROFILE: 'C:\\U' }, { company: 'C', product: 'P' }),
    'C:\\U\\AppData\\LocalLow\\C\\P\\Player-prev.log');
  assert.strictEqual(u.unityLogPath('player', 'win32', { USERPROFILE: 'C:\\U' }, { company: '', product: 'P' }), null);
  assert.strictEqual(u.editorExeIn('C:\\Hub\\2022.3.1f1', 'win32'), 'C:\\Hub\\2022.3.1f1\\Editor\\Unity.exe');
});

test('log filter groups an exception with its stack and folds repeats', () => {
  const log = [
    'Loading stuff',
    'NullReferenceException: Object reference not set to an instance of an object',
    'Player.Update () (at Assets/Scripts/Player.cs:42)',
    '',
    'NullReferenceException: Object reference not set to an instance of an object',
    'Player.Update () (at Assets/Scripts/Player.cs:42)',
    '',
    'Assets/Scripts/A.cs(10,5): error CS0103: The name \'x\' does not exist',
    'Assets/Scripts/B.cs(3,1): error CS1002: ; expected',
    'Assets/Scripts/C.cs(1,1): warning CS0414: unused'
  ].join('\r\n');
  const b = u.filterUnityLog(log);
  assert.strictEqual(b.length, 3);
  assert.strictEqual(b[0].kind, 'exception');
  assert.strictEqual(b[0].count, 2);
  assert.strictEqual(b[0].file, 'Assets/Scripts/Player.cs');
  assert.strictEqual(b[0].line, 42);
  assert.strictEqual(b[1].kind, 'compile');
  assert.strictEqual(b[1].line, 10);
  assert.strictEqual(u.filterUnityLog(log, { warnings: true }).length, 4);
  assert.strictEqual(u.filterUnityLog(log, { filter: 'cs1002' }).length, 1);
});

test('log filter: a Debug.LogError message is found through its stack, and a frame never starts an entry', () => {
  // The shape of a real Editor.log entry: the message has no error keyword at all.
  const log = [
    '\t\tAwakeInstancesAfterBackupRestoration (13ms)',
    'Host type is not matching any asset type at Path Packages/x.shadergraph.',
    'UnityEngine.Debug:ExtractStackTraceNoAlloc (byte*,int,string)',
    'UnityEngine.Debug:LogError (object)',
    'UnityEngine.Rendering.Utils:TryEnsure<A, B> (A&,string,bool,System.Exception&) (at ./Library/PackageCache/x/Utils.cs:138)',
    '',
    'Something harmless',
    'UnityEngine.Debug:Log (object)',
    '',
    'Careful now',
    'UnityEngine.Debug:LogWarning (object)',
    ''
  ].join('\n');
  const b = u.filterUnityLog(log);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].kind, 'error');
  assert.ok(b[0].text.startsWith('Host type is not matching'));
  const w = u.filterUnityLog(log, { warnings: true });
  assert.deepStrictEqual(w.map(x => x.kind), ['error', 'warning']);
  assert.ok(w[1].text.startsWith('Careful now'));
});

test('NUnit results: totals and failures, self-closing passed cases included', () => {
  const xml = `<?xml version="1.0"?><test-run id="2" testcasecount="3" result="Failed(Child)" total="3" passed="2" failed="1" inconclusive="0" skipped="0">
    <test-suite><test-case id="1" name="A" fullname="T.A" result="Passed" />
    <test-case id="2" name="B" fullname="T.B" result="Failed"><failure><message><![CDATA[Expected 1 but was 2]]></message></failure></test-case>
    <test-case id="3" name="C" fullname="T.C" result="Passed"></test-case></test-suite></test-run>`;
  const r = u.parseNUnitResults(xml);
  assert.deepStrictEqual([r.total, r.passed, r.failed], [3, 2, 1]);
  assert.deepStrictEqual(r.failures, [{ name: 'T.B', message: 'Expected 1 but was 2' }]);
  assert.strictEqual(u.parseNUnitResults(''), null);
});

test('verdicts: results file is the authority, and not compiling is not a test failure by default', () => {
  const errs = ['Assets/A.cs(1,1): error CS0103: x'];
  assert.strictEqual(u.unityVerdict('editmode', { exitCode: 2, results: { total: 3, passed: 2, failed: 1, failures: [] } }).verdict, 'fail');
  assert.strictEqual(u.unityVerdict('editmode', { exitCode: 0, results: { total: 0, passed: 0, failed: 0 } }).verdict, 'skip');
  assert.strictEqual(u.unityVerdict('editmode', { exitCode: 1, results: null, compileErrors: errs }).verdict, 'skip');
  assert.strictEqual(u.unityVerdict('editmode', { exitCode: 1, results: null, compileErrors: errs, compileFailAs: 'fail' }).verdict, 'fail');
  assert.strictEqual(u.unityVerdict('compile', { exitCode: 1, compileErrors: errs }).verdict, 'fail');
  assert.strictEqual(u.unityVerdict('compile', { exitCode: 1, compileErrors: [] }).verdict, 'skip');
  assert.strictEqual(u.unityVerdict('compile', { exitCode: 0, timedOut: true }).verdict, 'skip');
  // find-the-fix inverts pass/fail, never skip
  assert.deepStrictEqual(['pass', 'fail', 'skip'].map(v => u.bisectExitCode(v, false)), [0, 1, 125]);
  assert.deepStrictEqual(['pass', 'fail', 'skip'].map(v => u.bisectExitCode(v, true)), [1, 0, 125]);
});

test('unityArgs never combines -quit with -runTests', () => {
  const t = u.unityArgs('playmode', { projectPath: 'p', logFile: 'l', resultsFile: 'r', filter: 'Foo' });
  assert.ok(!t.includes('-quit'));
  assert.deepStrictEqual(t.slice(t.indexOf('-testPlatform'), t.indexOf('-testPlatform') + 2), ['-testPlatform', 'PlayMode']);
  assert.ok(u.unityArgs('compile', { projectPath: 'p', logFile: 'l' }).includes('-quit'));
});

test('the functions embedded in the bisect step script are self-contained', () => {
  const src = u.bisectStepScript();
  for (const name of ['unityArgs', 'parseNUnitResults', 'compileErrors', 'unityVerdict', 'bisectExitCode', 'pickEditor', 'parseProjectVersion']) {
    assert.ok(src.includes(`function ${name}(`), name);
  }
  // Evaluated alone, with nothing else in scope, they still work.
  // eslint-disable-next-line no-new-func
  const fns = new Function(`${u.unityVerdict.toString()}\n${u.bisectExitCode.toString()}\n${u.pickEditor.toString()}\nreturn { unityVerdict, bisectExitCode, pickEditor };`)();
  assert.strictEqual(fns.bisectExitCode(fns.unityVerdict('compile', { exitCode: 0 }).verdict, false), 0);
  assert.deepStrictEqual(fns.pickEditor('1', { 1: '/a' }, '/b', true), { path: '/a', version: '1', own: true });
  assert.deepStrictEqual(fns.pickEditor('2', { 1: '/a' }, '/b', true), { path: '/b', version: null, own: false });
  // The script itself parses.
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function('require', 'process', src));
});

test('bisect output: found, only-skipped, and per-step lines', () => {
  const h = 'a'.repeat(40), h2 = 'b'.repeat(40);
  const out = `GITGOOD-STEP {"hash":"abc","verdict":"pass"}\r\nBisecting: 3 revisions left to test after this (roughly 2 steps)\n${h} is the first bad commit\ncommit ${h}\n`;
  const r = u.parseBisectOutput(out);
  assert.strictEqual(r.status, 'found');
  assert.strictEqual(r.hash, h);
  assert.strictEqual(r.steps.length, 1);
  assert.strictEqual(u.bisectRemaining(out), 2);
  const fixed = u.parseBisectOutput(`${h} is the first fixed commit\n`);
  assert.strictEqual(fixed.term, 'fixed');
  const amb = u.parseBisectOutput(`There are only 'skip'ped commits left to test.\nThe first bad commit could be any of:\n${h}\n${h2}\nWe cannot bisect more!\n`);
  assert.deepStrictEqual(amb, { status: 'ambiguous', candidates: [h, h2], steps: [] });
  assert.strictEqual(u.bisectStepsEstimate(100), 7);
});

test('script .meta findings: GUID change, execution order, deleted script, missing meta', () => {
  const meta = (g, o) => `fileFormatVersion: 2\nguid: ${g}\nMonoImporter:\n  executionOrder: ${o}\n`;
  const g1 = '1'.repeat(32), g2 = '2'.repeat(32);
  const f = u.scriptMetaFindings(
    [{ status: 'M', path: 'A/P.cs.meta' }, { status: 'D', path: 'A/Gone.cs' }, { status: 'A', path: 'A/New.cs' }, { status: 'A', path: 'A/Ok.cs' }],
    { 'A/P.cs.meta': meta(g1, 0), 'A/Gone.cs.meta': meta(g2, 0) },
    { 'A/P.cs.meta': meta(g2, -100) },
    p => p === 'A/Ok.cs');
  assert.deepStrictEqual(f.map(x => x.kind), ['guid', 'order', 'deleted', 'nometa']);
  assert.strictEqual(f[0].path, 'A/P.cs');
  assert.strictEqual(f[2].guid, g2);
  assert.deepStrictEqual(u.parseNameStatusZ('M\0a.cs\0R100\0old.cs\0new.cs\0'),
    [{ status: 'M', path: 'a.cs' }, { status: 'R', oldPath: 'old.cs', path: 'new.cs' }]);
});

test('serialized field renames: flagged unless FormerlySerializedAs carries the old name', () => {
  const diff = [
    'diff --git a/P.cs b/P.cs', '--- a/P.cs', '+++ b/P.cs',
    '@@ -3,3 +3,3 @@',
    '-    [SerializeField] private int maxHp = 5;',
    '+    [SerializeField] private int maxHealth = 5;',
    '@@ -9,3 +9,3 @@',
    '     [SerializeField]',
    '-    private float speed;',
    '+    private float moveSpeed;',
    '-    public int Count => 3;',
    '+    public int Total => 3;',
    '-    private int cache;',
    '+    private int cache2;',
    'diff --git a/Q.cs b/Q.cs', '--- a/Q.cs', '+++ b/Q.cs',
    '@@ -1,2 +1,3 @@',
    '-    public string title;',
    '+    [FormerlySerializedAs("title")]',
    '+    public string heading;'
  ].join('\n');
  const r = u.findSerializedRenames(diff);
  assert.deepStrictEqual(r.map(x => [x.file, x.removed, x.candidates[0]]),
    [['P.cs', 'maxHp', 'maxHealth'], ['P.cs', 'speed', 'moveSpeed']]);
});

test('editor leaks: UnityEditor outside #if UNITY_EDITOR, in non-Editor folders', () => {
  const src = [
    'using UnityEngine;',
    '#if UNITY_EDITOR',
    'using UnityEditor;',
    '#else',
    'using UnityEditor.Fake; // in #else: compiled in builds',
    '#endif',
    '// UnityEditor in a comment',
    'var s = "UnityEditor";',
    '#if !UNITY_EDITOR',
    '#else',
    'UnityEditor.AssetDatabase.Refresh();',
    '#endif',
    'UnityEditor.EditorUtility.SetDirty(this);'
  ].join('\n');
  assert.deepStrictEqual(u.editorLeaks(src).map(x => x.line), [5, 13]);
  assert.ok(u.isEditorOnlyPath('Assets/Tools/Editor/X.cs'));
  assert.ok(u.isEditorOnlyPath('Assets/EdAsm/X.cs', ['Assets/EdAsm']));
  assert.ok(!u.isEditorOnlyPath('Assets/Editorial/X.cs'));
});
