// `git worktree list --porcelain` parsing. The porcelain form is used because a path with
// a space makes the human output ambiguous — so that case is the point of this file.
const test = require('node:test');
const assert = require('node:assert');

const { parseWorktreeList } = require('../src/main/lib/worktree-list');

const SAMPLE = [
  'worktree D:/repos/main repo',
  'HEAD abc1230000000000000000000000000000000000',
  'branch refs/heads/main',
  '',
  'worktree D:/repos/detached',
  'HEAD def4560000000000000000000000000000000000',
  'detached',
  '',
  'worktree D:/repos/locked',
  'HEAD 1110000000000000000000000000000000000000',
  'branch refs/heads/wip',
  'locked',
  '',
  'worktree D:/repos/gone',
  'HEAD 2220000000000000000000000000000000000000',
  'prunable gitdir file points to non-existent location',
  ''
].join('\n');

test('parseWorktreeList: keeps a path containing spaces intact', () => {
  const trees = parseWorktreeList(SAMPLE);
  assert.strictEqual(trees.length, 4);
  assert.strictEqual(trees[0].path, 'D:/repos/main repo');
});

test('parseWorktreeList: strips refs/heads/ from the branch', () => {
  assert.strictEqual(parseWorktreeList(SAMPLE)[0].branch, 'main');
});

test('parseWorktreeList: a detached tree has no branch', () => {
  const t = parseWorktreeList(SAMPLE)[1];
  assert.strictEqual(t.detached, true);
  assert.strictEqual(t.branch, '');
});

test('parseWorktreeList: locked with no reason still reads as locked', () => {
  // git writes a bare `locked` line when no reason was given — the flag must not depend
  // on the reason being present.
  const t = parseWorktreeList(SAMPLE)[2];
  assert.strictEqual(t.locked, true);
  assert.strictEqual(t.lockReason, '');
});

test('parseWorktreeList: prunable carries its reason', () => {
  const t = parseWorktreeList(SAMPLE)[3];
  assert.strictEqual(t.prunable, true);
  assert.strictEqual(t.prunableReason, 'gitdir file points to non-existent location');
});

test('parseWorktreeList: handles CRLF line endings', () => {
  const trees = parseWorktreeList(SAMPLE.replace(/\n/g, '\r\n'));
  assert.strictEqual(trees.length, 4);
  assert.strictEqual(trees[0].branch, 'main');
  assert.strictEqual(trees[3].prunableReason, 'gitdir file points to non-existent location');
});

test('parseWorktreeList: recognises a bare repository', () => {
  const trees = parseWorktreeList('worktree D:/repos/bare\nHEAD abc\nbare\n');
  assert.strictEqual(trees.length, 1);
  assert.strictEqual(trees[0].bare, true);
});

test('parseWorktreeList: a final record without a trailing blank line is not lost', () => {
  const trees = parseWorktreeList('worktree D:/a\nHEAD abc\nbranch refs/heads/x');
  assert.strictEqual(trees.length, 1);
  assert.strictEqual(trees[0].branch, 'x');
});

test('parseWorktreeList: tolerates empty and missing input', () => {
  assert.deepStrictEqual(parseWorktreeList(''), []);
  assert.deepStrictEqual(parseWorktreeList(null), []);
});
