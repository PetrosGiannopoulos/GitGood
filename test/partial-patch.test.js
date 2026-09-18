// Partial staging: the `reverse` flag decides which side of the diff git reads as the
// source, so unselected lines must be treated in mirror image. Getting it backwards is the
// classic "patch does not apply" bug, and it is silent until a user loses work — which is
// why it is tested here rather than trusted to the comment above buildPartialPatch.
const test = require('node:test');
const assert = require('node:assert');

// 04-diff.js is a renderer script; it registers one document-level listener at load. A
// stub is all it needs to be required outside a browser.
global.document = { addEventListener() {}, createElement() { return {}; }, getElementById() { return null; } };
global.window = {};

const { parseUnifiedDiff, buildPartialPatch, hunkLineKeys } = require('../src/renderer/js/04-diff.js');

// One hunk, two removals and two additions, so a selection can take one pair and leave
// the other — the only shape that exercises the mirror rule.
//   li 0 ' one'   1 '-two'   2 '-three'   3 '+TWO'   4 '+THREE'   5 ' four'
const DIFF = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,4 +1,4 @@',
  ' one',
  '-two',
  '-three',
  '+TWO',
  '+THREE',
  ' four',
  ''
].join('\n');

const parseOne = (text) => parseUnifiedDiff(text).files[0];
const TWO_PAIR = new Set(['0:1', '0:3']); // '-two' and '+TWO'

test('parseUnifiedDiff: reads the path, hunk header and line types', () => {
  const file = parseOne(DIFF);
  assert.strictEqual(file.path, 'f.txt');
  assert.strictEqual(file.hunks.length, 1);
  const h = file.hunks[0];
  assert.deepStrictEqual(
    [h.oldStart, h.oldCount, h.newStart, h.newCount], [1, 4, 1, 4]);
  assert.deepStrictEqual(h.lines.map(l => l.type), [' ', '-', '-', '+', '+', ' ']);
  assert.deepStrictEqual(h.lines.map(l => l.text), ['one', 'two', 'three', 'TWO', 'THREE', 'four']);
});

test('forward: an unselected removal becomes context, an unselected addition is dropped', () => {
  const patch = buildPartialPatch(parseOne(DIFF), TWO_PAIR, { reverse: false });
  assert.match(patch, /\n one\n/);
  assert.match(patch, /\n-two\n/);
  assert.match(patch, /\n three\n/, 'unselected removal must survive as context');
  assert.match(patch, /\n\+TWO\n/);
  assert.ok(!patch.includes('THREE'), 'unselected addition must not appear at all');
  assert.match(patch, /@@ -1,4 \+1,4 @@/);
});

test('reverse: the mirror image — unselected addition becomes context, removal is dropped', () => {
  const patch = buildPartialPatch(parseOne(DIFF), TWO_PAIR, { reverse: true });
  assert.match(patch, /\n THREE\n/, 'unselected addition must survive as context');
  assert.ok(!patch.includes('-three'), 'unselected removal must not appear at all');
  assert.match(patch, /\n-two\n/);
  assert.match(patch, /\n\+TWO\n/);
});

test('the two directions really do differ', () => {
  const file = parseOne(DIFF);
  const forward = buildPartialPatch(file, TWO_PAIR, { reverse: false });
  const reverse = buildPartialPatch(file, TWO_PAIR, { reverse: true });
  assert.notStrictEqual(forward, reverse,
    'if these match, the reverse flag is being ignored and one direction will misapply');
});

test('selecting nothing produces no patch', () => {
  assert.strictEqual(buildPartialPatch(parseOne(DIFF), new Set(), {}), '');
});

test('a patch always ends with a newline', () => {
  const patch = buildPartialPatch(parseOne(DIFF), TWO_PAIR, {});
  assert.ok(patch.endsWith('\n'));
});

test('hunkLineKeys returns only the changed lines of a hunk', () => {
  assert.deepStrictEqual(hunkLineKeys(parseOne(DIFF), 0), ['0:1', '0:2', '0:3', '0:4']);
});

test('a hunk with nothing selected is left out of the patch entirely', () => {
  const twoHunks = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-first',
    '+FIRST',
    '@@ -10,2 +10,2 @@',
    ' keep2',
    '-second',
    '+SECOND',
    ''
  ].join('\n');
  const patch = buildPartialPatch(parseOne(twoHunks), new Set(['0:1', '0:2']), {});
  assert.ok(patch.includes('FIRST'));
  assert.ok(!patch.includes('SECOND'), 'an untouched hunk adds only drift risk');
  // One hunk header, not two — counted on the line start, since "@@ -1,2 +1,2 @@" itself
  // contains the marker twice.
  assert.strictEqual(patch.match(/^@@ /gm).length, 1);
});

test('a partially selected file deletion stops being a deletion', () => {
  // Otherwise git rejects a "deleted file" patch that still leaves content behind.
  const deletion = [
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-a',
    '-b',
    '-c',
    ''
  ].join('\n');
  const file = parseOne(deletion);
  assert.strictEqual(file.isDeleted, true);

  const partial = buildPartialPatch(file, new Set(['0:0']), {});
  assert.ok(!partial.includes('deleted file mode'), 'the deletion marker must be stripped');
  assert.match(partial, /\+\+\+ b\/gone\.txt/, '+++ must point back at the real path');

  // Taking every removal is still a genuine deletion, so the marker stays.
  const whole = buildPartialPatch(file, new Set(['0:0', '0:1', '0:2']), {});
  assert.ok(whole.includes('deleted file mode'));
});

test('parseUnifiedDiff: separates multiple files and flags new and binary ones', () => {
  const multi = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/pic.png b/pic.png',
    'index 1111111..2222222 100644',
    'Binary files a/pic.png and b/pic.png differ',
    ''
  ].join('\n');
  const files = parseUnifiedDiff(multi).files;
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0].path, 'new.txt');
  assert.strictEqual(files[0].isNew, true);
  assert.strictEqual(files[1].path, 'pic.png');
  assert.strictEqual(files[1].binary, true);
});

test('parseUnifiedDiff: recovers a headerless chunk (commit previews send these)', () => {
  const headerless = ['@@ -1,1 +1,1 @@', '-old', '+new', ''].join('\n');
  const files = parseUnifiedDiff(headerless).files;
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].headerless, true);
  assert.strictEqual(files[0].hunks.length, 1);
});
