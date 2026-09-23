// Replaying only *part* of a commit (pure helpers extracted from main.js).
//
// The commit being copied is normally one that is already pushed — a colleague's — so
// dropping the unwanted file out of that commit is not on the table. The only honest
// answer is a NEW commit on the current branch carrying the chosen subset, and these are
// the pieces of it that need no git.

// git's own `-x` note. Matched so the message can be re-generated without stacking a
// second note on a message that already carries one (the dialog hands back whatever is in
// the box, which on a second attempt is a message we wrote).
const CHERRY_NOTE = /^\(cherry picked from commit [0-9a-f]{4,40}\)$/;
const PARTIAL_NOTE = /^Partial-cherry-pick: /;
// A trailer block ("Signed-off-by: …"). A note appended after one belongs in the same
// block, not behind a blank line that would break the block in two.
const TRAILER = /^[A-Za-z][A-Za-z0-9-]*: \S/;

// The message for the new commit: the original's, plus the provenance git itself would
// write, plus — only when files were actually left out — a trailer saying so. Without
// that second line the commit claims to be the whole of a commit it is a slice of.
function partialPickMessage(original, opts) {
  const o = opts || {};
  const hash = String(o.hash || '');
  const included = Number(o.included) || 0;
  const total = Number(o.total) || 0;

  const lines = String(original == null ? '' : original).replace(/\s+$/, '').split('\n');
  // Drop any note we (or git) wrote last time, so re-picking is idempotent rather than
  // additive.
  while (lines.length && (CHERRY_NOTE.test(lines[lines.length - 1]) || PARTIAL_NOTE.test(lines[lines.length - 1]))) {
    lines.pop();
  }
  const body = lines.join('\n').replace(/\s+$/, '');

  const note = [];
  if (hash) note.push(`(cherry picked from commit ${hash})`);
  if (total && included && included < total) note.push(`Partial-cherry-pick: ${included} of ${total} files`);
  if (!note.length) return body;
  if (!body) return note.join('\n');

  const last = body.split('\n').pop();
  const sep = (TRAILER.test(last) || CHERRY_NOTE.test(last)) ? '\n' : '\n\n';
  return body + sep + note.join('\n');
}

// `git apply` reports in git's vocabulary and names the flag it wants, not the situation
// the user is in. These are the failures a partial pick actually produces.
function applyFailureHelp(errorText) {
  const t = String(errorText || '');
  if (/does not match index|does not exist in index|already exists/i.test(t)) {
    return 'Those files changed underneath the operation. Refresh and try again.';
  }
  if (/patch (failed|does not apply)|with conflicts|corrupt patch/i.test(t)) {
    return 'Those changes conflict with your branch and cannot be replayed on their own. '
      + 'Cherry-pick the whole commit instead, resolve the conflict, then discard the file you did not want.';
  }
  return null;
}

// The other half of the dialog: instead of a new commit, *replace* the commit in the
// current branch's history with one that never carried the excluded files, replay what
// came after it, and (optionally) force the remote to match. Whether that is allowed is a
// pure decision over facts main has already gathered, so it lives here.
//
// facts:
//   branch        current branch name, or '' when HEAD is detached
//   busy          a merge/rebase/cherry-pick/revert is in progress
//   onBranch      the commit is an ancestor of (or is) HEAD
//   parents       the commit's parent count
//   mergesAfter   merge commits between the commit and HEAD
//   dirty         tracked files with uncommitted changes
//   upstream      the branch's upstream ('origin/main'), or ''
//   onUpstream    the commit is reachable from the upstream — i.e. it was pushed
//   behind        commits the upstream has that HEAD does not
//
// A force-push is only offered when it would remove exactly the rewritten history: if the
// remote has commits this branch has not pulled, forcing would silently delete them too.
function rewritePlan(facts) {
  const f = facts || {};
  let reason = null;
  if (f.busy) reason = 'A merge, rebase, cherry-pick or revert is already in progress. Finish or abort it first.';
  else if (!f.branch) reason = 'You are not on a branch (detached HEAD). Check out the branch that holds this commit first.';
  else if (!f.onBranch) reason = `This commit is not part of ${f.branch}. Check out a branch that contains it to rewrite it.`;
  else if ((f.parents || 0) > 1) reason = 'This is a merge commit. Only an ordinary commit can be replaced here.';
  else if ((f.mergesAfter || 0) > 0) reason = `${f.mergesAfter} merge commit(s) come after it on ${f.branch}, and replaying them would flatten the merges. Use an interactive rebase instead.`;
  else if ((f.dirty || 0) > 0) reason = 'You have uncommitted changes. Commit, discard or stash them first — rewriting replays the branch through the working tree.';

  let pushReason = null;
  if (!f.upstream) pushReason = `${f.branch || 'This branch'} has no upstream, so there is no remote copy to replace.`;
  else if (!f.onUpstream) pushReason = `The commit is not on ${f.upstream} yet, so the remote never saw it — no force-push is needed.`;
  else if ((f.behind || 0) > 0) pushReason = `${f.upstream} has ${f.behind} commit(s) you have not pulled. Forcing would delete them — pull first.`;

  return { canRewrite: !reason, reason, canPush: !reason && !pushReason, pushReason };
}

module.exports = { partialPickMessage, applyFailureHelp, rewritePlan };
