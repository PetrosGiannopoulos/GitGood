// "Recent Branches" in the sidebar: local branches, newest push first. The pure half —
// main.js finds the reflog files and the upstream config, this decides what they mean.
//
// The only record of *when* something was pushed is the remote-tracking ref's reflog:
// a push updates refs/remotes/<remote>/<branch> and logs it as "update by push"
// (verified). A fetch writes "fetch: …" to the same file, which must not count, or every
// background fetch would reshuffle the list.
//
// The reflog does not say which local branch was pushed, so a remote ref is matched back
// to one by its configured upstream first, then by the same name under the remote. A push
// to a different name with no upstream set (`push origin HEAD:other`) cannot be traced to
// a local branch, and is left out rather than guessed at.

// The newest "update by push" entry in one reflog file's text, or null.
// Line format: `<old> <new> <name> <email> <unix time> <tz>\t<message>`.
function lastPushFromReflog(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    if (!line.slice(tab + 1).startsWith('update by push')) continue;
    const m = /^([0-9a-f]+) ([0-9a-f]+) .* (\d+) [+-]\d{4}$/.exec(line.slice(0, tab));
    if (!m) continue;
    return { hash: m[2], time: Number(m[3]) * 1000 };
  }
  return null;
}

// pushes:    [{ ref: 'refs/remotes/origin/feature/x', hash, time }]
// upstreams: { 'refs/remotes/origin/feature/x': 'feature/x' }  (upstream ref → local branch)
// locals:    ['main', 'feature/x', …]
// remotes:   ['origin', …] — needed to split 'origin/feature/x' when a remote name has '/'
// Returns [{ branch, remoteRef: 'origin/feature/x', hash, time }], newest first, one row per
// local branch (its latest push, if it went to several remotes).
function recentPushedBranches({ pushes, upstreams, locals, remotes, limit = 8 }) {
  const localSet = new Set(locals || []);
  const remoteNames = (remotes || []).slice().sort((a, b) => b.length - a.length);
  const best = new Map();
  for (const p of pushes || []) {
    const short = p.ref.replace(/^refs\/remotes\//, '');
    if (/\/HEAD$/.test(short)) continue;
    let branch = upstreams && upstreams[p.ref];
    if (!branch) {
      const remote = remoteNames.find(r => short.startsWith(r + '/'));
      const name = remote ? short.slice(remote.length + 1) : '';
      if (name && localSet.has(name)) branch = name;
    }
    if (!branch || !localSet.has(branch)) continue;
    const prev = best.get(branch);
    if (!prev || p.time > prev.time) best.set(branch, { branch, remoteRef: short, hash: p.hash, time: p.time });
  }
  return [...best.values()].sort((a, b) => b.time - a.time).slice(0, limit);
}

// Whether a pushed branch has since been merged into some other branch, so it can leave
// the list. `containing` is every ref whose history includes the branch's tip
// (`for-each-ref --contains`). The branch's own refs don't count — itself, its upstream,
// the ref it was pushed to and its namesake on any remote — and neither does a remote's
// HEAD, which is only an alias for another ref already in the list.
function mergedElsewhere({ branch, upstream, pushedRef, remotes, containing }) {
  const own = new Set(['refs/heads/' + branch]);
  if (upstream) own.add(upstream);
  if (pushedRef) own.add('refs/remotes/' + pushedRef);
  for (const r of remotes || []) own.add(`refs/remotes/${r}/${branch}`);
  return (containing || []).some(ref => ref && !own.has(ref) && !/^refs\/remotes\/.+\/HEAD$/.test(ref));
}

module.exports = { lastPushFromReflog, recentPushedBranches, mergedElsewhere };
