// The Windows command-line cap (see src/main/lib/pathspec.js). A regression here is not a
// cosmetic failure: the operation dies in spawn with nothing done.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const {
  PATHSPEC_BUDGET, chunkPaths, pathspecFits, forEachPathChunk, withPathspecFile
} = require('../src/main/lib/pathspec');

// The real limit the budget exists to stay under.
const WINDOWS_CMDLINE_MAX = 32767;

const unityPaths = (n) => Array.from({ length: n }, (_, i) =>
  `Assets/Art Assets/Characters/Enemies/Boss ${String(i).padStart(3, '0')}/`
  + 'Materials_and_Textures_'.repeat(4) + `variant_${i}.mat`);

test('chunkPaths: empty list produces no chunks', () => {
  assert.deepStrictEqual(chunkPaths([]), []);
});

test('chunkPaths: a list that fits stays one chunk', () => {
  const paths = ['a.txt', 'b.txt', 'c.txt'];
  assert.deepStrictEqual(chunkPaths(paths), [paths]);
});

test('chunkPaths: splits on the budget, counting the per-arg overhead', () => {
  // cost per path = length + 3, so a 10-char path costs 13. A budget of 30 fits two.
  const paths = ['0123456789', '1234567890', '2345678901', '3456789012'];
  assert.deepStrictEqual(chunkPaths(paths, 30), [
    ['0123456789', '1234567890'],
    ['2345678901', '3456789012']
  ]);
});

test('chunkPaths: never drops or reorders a path', () => {
  const paths = unityPaths(500);
  assert.deepStrictEqual(chunkPaths(paths).flat(), paths);
});

test('chunkPaths: a single path larger than the whole budget still gets through', () => {
  // Refusing it would fail a file git itself handles fine.
  const huge = 'x'.repeat(PATHSPEC_BUDGET * 2);
  assert.deepStrictEqual(chunkPaths([huge], 100), [[huge]]);
});

test('chunkPaths: every chunk stays under the real OS command-line limit', () => {
  // The guarantee that actually matters. 200 chars of headroom stands in for the git
  // executable path, the subcommand and its flags.
  for (const count of [150, 220, 400, 2000]) {
    for (const chunk of chunkPaths(unityPaths(count))) {
      const argvChars = chunk.join(' ').length + 200;
      assert.ok(argvChars < WINDOWS_CMDLINE_MAX,
        `chunk of ${chunk.length} paths built ${argvChars} chars for a ${count}-file list`);
    }
  }
});

test('pathspecFits: true only while one invocation can carry the list', () => {
  assert.strictEqual(pathspecFits(['one.txt', 'two.txt']), true);
  assert.strictEqual(pathspecFits(unityPaths(20)), true);
  // 220 Unity-shaped paths is the size that produced the original ENAMETOOLONG report.
  assert.strictEqual(pathspecFits(unityPaths(220)), false);
});

test('forEachPathChunk: runs once per chunk, in order, awaiting each', async () => {
  const paths = unityPaths(400);
  const seen = [];
  await forEachPathChunk(paths, async (chunk) => {
    await new Promise(r => setImmediate(r));
    seen.push(chunk);
  });
  assert.ok(seen.length > 1, 'expected this list to need more than one pass');
  assert.deepStrictEqual(seen.flat(), paths);
});

test('withPathspecFile: hands git a NUL-separated file and cleans it up', async () => {
  const paths = ['a/one.txt', 'b/two three.txt', 'c/four\nnewline.txt'];
  let flagsSeen = null;
  let contentsDuringCall = null;
  let fileDuringCall = null;

  await withPathspecFile(paths, (flags) => {
    flagsSeen = flags;
    fileDuringCall = flags[0].replace('--pathspec-from-file=', '');
    contentsDuringCall = fs.readFileSync(fileDuringCall, 'utf8');
  });

  assert.strictEqual(flagsSeen[1], '--pathspec-file-nul');
  // NUL-separated with a trailing NUL, so even the path containing a newline survives.
  assert.strictEqual(contentsDuringCall, 'a/one.txt\0b/two three.txt\0c/four\nnewline.txt\0');
  assert.strictEqual(fs.existsSync(fileDuringCall), false, 'temp pathspec file was left behind');
});

test('withPathspecFile: removes the temp file even when the operation throws', async () => {
  let file = null;
  await assert.rejects(
    withPathspecFile(['x.txt'], (flags) => {
      file = flags[0].replace('--pathspec-from-file=', '');
      throw new Error('git failed');
    }),
    /git failed/
  );
  assert.strictEqual(fs.existsSync(file), false);
});

test('withPathspecFile: returns what the operation returned', async () => {
  const result = await withPathspecFile(['x.txt'], () => 'commit output');
  assert.strictEqual(result, 'commit output');
});
