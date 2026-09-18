// `git push --porcelain` parsing. The flag characters are the only way GitGood can tell
// "pushed" from "already there", since plain push writes its summary to discarded stderr.
const test = require('node:test');
const assert = require('node:assert');

const { parsePushPorcelain } = require('../src/main/lib/push-porcelain');

test('parsePushPorcelain: reads every flag character', () => {
  const out = [
    'To github.com:me/repo.git',
    '*\trefs/heads/new:refs/heads/new\t[new branch]',
    ' \trefs/heads/main:refs/heads/main\t1234567..89abcde',
    '+\trefs/heads/fix:refs/heads/fix\t1234567...89abcde (forced update)',
    '=\trefs/heads/old:refs/heads/old\t[up to date]',
    '!\trefs/heads/bad:refs/heads/bad\t[rejected] (non-fast-forward)',
    '-\t:refs/heads/dead\t[deleted]',
    'Done'
  ].join('\n');

  assert.deepStrictEqual(parsePushPorcelain(out).map(r => r.result), [
    'new', 'pushed', 'force-pushed', 'up-to-date', 'rejected', 'deleted'
  ]);
});

test('parsePushPorcelain: splits refspec from summary', () => {
  const refs = parsePushPorcelain('*\trefs/heads/x:refs/heads/x\t[new branch]');
  assert.deepStrictEqual(refs, [{
    flag: '*',
    result: 'new',
    refspec: 'refs/heads/x:refs/heads/x',
    summary: '[new branch]'
  }]);
});

test('parsePushPorcelain: the flag is followed by a TAB, not the refspec', () => {
  // Captured verbatim from `git push --porcelain` (tabs shown here as \t):
  //   To ../remote.git
  //   *\tHEAD:refs/heads/feature\t[new branch]
  //   Done
  // Slicing off only the flag character leaves an empty first field — which is what made
  // refspec come back '' and summary hold the refspec.
  const refs = parsePushPorcelain(
    'To ../remote.git\n*\tHEAD:refs/heads/feature\t[new branch]\nDone');
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].refspec, 'HEAD:refs/heads/feature');
  assert.strictEqual(refs[0].summary, '[new branch]');
});

test('parsePushPorcelain: skips the To/Done frame and unknown lines', () => {
  const out = [
    'To github.com:me/repo.git',
    'error: failed to push some refs',
    'hint: try pulling first',
    'Done'
  ].join('\n');
  assert.deepStrictEqual(parsePushPorcelain(out), []);
});

test('parsePushPorcelain: tolerates empty and missing input', () => {
  assert.deepStrictEqual(parsePushPorcelain(''), []);
  assert.deepStrictEqual(parsePushPorcelain(null), []);
  assert.deepStrictEqual(parsePushPorcelain(undefined), []);
});

test('parsePushPorcelain: a deleted ref that was never there is still reported', () => {
  // repo:deleteRemoteTag checks ls-remote first precisely because git exits 0 here.
  const refs = parsePushPorcelain('-\t:refs/tags/v1\t[deleted]');
  assert.strictEqual(refs[0].result, 'deleted');
  assert.strictEqual(refs[0].refspec, ':refs/tags/v1');
});
