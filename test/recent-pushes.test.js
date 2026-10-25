// "Recent Branches": push times read from remote-tracking reflogs. A fetch must not count
// as a push, and a remote ref must map back to the right local branch.
const test = require('node:test');
const assert = require('node:assert');

const { lastPushFromReflog, recentPushedBranches, mergedElsewhere } = require('../src/main/lib/recent-pushes');

const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const line = (o, n, t, msg) => `${o} ${n} Some One / Alias <me@example.com> ${t} +0300\t${msg}`;

test('lastPushFromReflog: takes the newest push and ignores later fetches', () => {
  const text = [
    line(Z, A, 100, 'update by push'),
    line(A, B, 200, 'update by push'),
    line(B, C, 300, 'fetch: fast-forward'),
    ''
  ].join('\n');
  assert.deepStrictEqual(lastPushFromReflog(text), { hash: B, time: 200000 });
});

test('lastPushFromReflog: a ref only ever fetched has no push', () => {
  assert.strictEqual(lastPushFromReflog(line(Z, A, 100, 'fetch: storing head')), null);
  assert.strictEqual(lastPushFromReflog(''), null);
});

test('lastPushFromReflog: survives a partial first line from a tail read', () => {
  const text = 'e0 Some One <x> 50 +0000\tupd\n' + line(Z, A, 100, 'update by push');
  assert.deepStrictEqual(lastPushFromReflog(text), { hash: A, time: 100000 });
});

test('recentPushedBranches: upstream first, then same name; newest first', () => {
  const r = recentPushedBranches({
    pushes: [
      { ref: 'refs/remotes/origin/main', hash: A, time: 100 },
      { ref: 'refs/remotes/origin/renamed-upstream', hash: B, time: 300 },
      { ref: 'refs/remotes/origin/feature/x', hash: C, time: 200 },
      { ref: 'refs/remotes/origin/HEAD:other', hash: C, time: 999 },  // no local, no upstream
      { ref: 'refs/remotes/origin/gone', hash: C, time: 500 }         // local branch deleted
    ],
    upstreams: { 'refs/remotes/origin/renamed-upstream': 'local-name' },
    locals: ['main', 'feature/x', 'local-name'],
    remotes: ['origin']
  });
  assert.deepStrictEqual(r.map(x => x.branch), ['local-name', 'feature/x', 'main']);
  assert.strictEqual(r[1].remoteRef, 'origin/feature/x');
});

test('recentPushedBranches: one row per branch, its latest push; remote names with a slash', () => {
  const r = recentPushedBranches({
    pushes: [
      { ref: 'refs/remotes/origin/dev', hash: A, time: 100 },
      { ref: 'refs/remotes/team/backup/dev', hash: B, time: 400 }
    ],
    upstreams: {},
    locals: ['dev'],
    remotes: ['origin', 'team/backup']
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].remoteRef, 'team/backup/dev');
});

test('recentPushedBranches: respects the limit', () => {
  const pushes = Array.from({ length: 20 }, (_, i) => ({ ref: `refs/remotes/origin/b${i}`, hash: A, time: i }));
  const locals = pushes.map((_, i) => `b${i}`);
  const r = recentPushedBranches({ pushes, upstreams: {}, locals, remotes: ['origin'], limit: 5 });
  assert.deepStrictEqual(r.map(x => x.branch), ['b19', 'b18', 'b17', 'b16', 'b15']);
});

test('mergedElsewhere: the branch\'s own refs and remote HEADs do not count as a merge', () => {
  assert.strictEqual(mergedElsewhere({
    branch: 'feature/x',
    upstream: 'refs/remotes/origin/feature/x',
    pushedRef: 'origin/feature/x',
    remotes: ['origin', 'backup'],
    containing: [
      'refs/heads/feature/x',
      'refs/remotes/origin/feature/x',
      'refs/remotes/backup/feature/x',
      'refs/remotes/origin/HEAD'
    ]
  }), false);
});

test('mergedElsewhere: any other branch, local or remote, holding the tip is a merge', () => {
  const base = { branch: 'feature/x', upstream: 'refs/remotes/origin/feature/x', pushedRef: 'origin/feature/x', remotes: ['origin'] };
  assert.strictEqual(mergedElsewhere({ ...base, containing: ['refs/heads/feature/x', 'refs/heads/devel'] }), true);
  assert.strictEqual(mergedElsewhere({ ...base, containing: ['refs/remotes/origin/feature/x', 'refs/remotes/origin/main'] }), true);
});

test('mergedElsewhere: pushed under another name, that remote ref is still its own', () => {
  assert.strictEqual(mergedElsewhere({
    branch: 'local-name',
    upstream: 'refs/remotes/origin/renamed-upstream',
    pushedRef: 'origin/renamed-upstream',
    remotes: ['origin'],
    containing: ['refs/heads/local-name', 'refs/remotes/origin/renamed-upstream']
  }), false);
});
