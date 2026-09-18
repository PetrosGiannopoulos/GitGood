// `git worktree list --porcelain` parsing (pure, extracted from main.js).
//
// A record per worktree, blank-line separated:
//   worktree D:/path/to/tree
//   HEAD deadbeef…
//   branch refs/heads/main        (absent when detached, replaced by a bare `detached` line)
//   locked <reason>               (only when locked; reason may be empty)
//   prunable <reason>             (only when the tree is gone from disk)
//
// The porcelain form is parsed rather than the human one because paths with spaces make
// the default output ambiguous.
function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) { if (cur) { out.push(cur); cur = null; } continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: value, head: '', branch: '', detached: false, bare: false, locked: false, lockReason: '', prunable: false, prunableReason: '' };
    } else if (!cur) {
      continue;
    } else if (key === 'HEAD') {
      cur.head = value;
    } else if (key === 'branch') {
      cur.branch = value.replace(/^refs\/heads\//, '');
    } else if (key === 'detached') {
      cur.detached = true;
    } else if (key === 'bare') {
      cur.bare = true;
    } else if (key === 'locked') {
      cur.locked = true; cur.lockReason = value;
    } else if (key === 'prunable') {
      cur.prunable = true; cur.prunableReason = value;
    }
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { parseWorktreeList };
