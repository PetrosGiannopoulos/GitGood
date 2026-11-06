// The commit preview's file list. A commit's diff is cut at 2 MB in main, and the list used
// to be built from the cut text alone, so every file below the cut silently vanished from
// the preview — and with it from Restore, Cherry-pick and the context menu.
const test = require('node:test');
const assert = require('node:assert');

// 04-diff.js is a renderer script; it registers one document-level listener at load.
global.document = { addEventListener() {}, createElement() { return {}; }, getElementById() { return null; } };
global.window = {};

const { splitDiffByFile, unquoteGitPath, commitBrowserFiles } = require('../src/renderer/js/04-diff.js');

// Header shapes as `git show` (2.47) printed them for a commit touching a non-ASCII path,
// a pure rename, and an added path with a space (git appends a tab to that +++ line).
const DIFF = [
  'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
  'index 1111111..2222222 100644',
  '--- "a/caf\\303\\251.txt"',
  '+++ "b/caf\\303\\251.txt"',
  '@@ -1 +1 @@',
  '-q',
  '+q2',
  'diff --git a/r.txt b/moved.txt',
  'similarity index 100%',
  'rename from r.txt',
  'rename to moved.txt',
  'diff --git a/sp ace.txt b/sp ace.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/sp ace.txt\t',
  '@@ -0,0 +1 @@',
  '+n'
].join('\n');

test('git-quoted paths are decoded to the real name', () => {
  assert.strictEqual(unquoteGitPath('"caf\\303\\251.txt"'), 'café.txt');
  assert.strictEqual(unquoteGitPath('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
  assert.strictEqual(unquoteGitPath('plain.txt'), 'plain.txt');
});

test('splitDiffByFile names quoted, renamed and spaced paths as git stores them', () => {
  const files = splitDiffByFile(DIFF);
  assert.deepStrictEqual(files.map(f => [f.path, f.status]), [
    ['café.txt', 'modified'],
    ['moved.txt', 'renamed'],
    ['sp ace.txt', 'added']
  ]);
});

test('a binary file with a quoted name takes its path from the diff --git line', () => {
  const files = splitDiffByFile([
    'diff --git "a/\\303\\251.png" "b/\\303\\251.png"',
    'index 1111111..2222222 100644',
    'Binary files "a/\\303\\251.png" and "b/\\303\\251.png" differ'
  ].join('\n'));
  assert.deepStrictEqual(files.map(f => [f.path, f.binary]), [['é.png', true]]);
});

test('a diff that was not cut is listed as it is, with nothing lazy', () => {
  const chunks = splitDiffByFile(DIFF);
  const out = commitBrowserFiles(chunks, [{ status: 'M', path: 'other.txt' }], false);
  assert.strictEqual(out, chunks);
});

test('a cut diff lists every file: the cut one and the rest load on demand', () => {
  // The cut fell inside the second file; the third and fourth are not in the text at all.
  const cut = DIFF.split('\n').slice(0, 9).join('\n');
  const fileList = [
    { status: 'M', path: 'café.txt' },
    { status: 'R', oldPath: 'r.txt', path: 'moved.txt' },
    { status: 'A', path: 'sp ace.txt' },
    { status: 'D', path: 'gone.txt' }
  ];
  const out = commitBrowserFiles(splitDiffByFile(cut), fileList, true);
  assert.deepStrictEqual(out.map(f => [f.path, f.status, !!f.lazy]), [
    ['café.txt', 'modified', false],
    ['moved.txt', 'renamed', true],
    ['sp ace.txt', 'added', true],
    ['gone.txt', 'deleted', true]
  ]);
  // A rename is fetched by both paths, or git reports it as an added file.
  assert.strictEqual(out[1].oldPath, 'r.txt');
});

test('files are matched by path, not position — -w leaves whitespace-only files out of the diff', () => {
  // w.txt changed only in whitespace: present in name-status, absent from the -w diff.
  const cut = DIFF.split('\n').slice(0, 7).join('\n');
  const fileList = [
    { status: 'M', path: 'café.txt' },
    { status: 'M', path: 'w.txt' },
    { status: 'A', path: 'z.txt' }
  ];
  const out = commitBrowserFiles(splitDiffByFile(cut), fileList, true);
  assert.deepStrictEqual(out.map(f => f.path), ['café.txt', 'w.txt', 'z.txt']);
});

test('without a file list a cut diff still marks its last file for a full fetch', () => {
  const out = commitBrowserFiles(splitDiffByFile(DIFF), null, true);
  assert.deepStrictEqual(out.map(f => !!f.lazy), [false, false, true]);
});
