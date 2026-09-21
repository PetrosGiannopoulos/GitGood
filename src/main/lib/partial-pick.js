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

module.exports = { partialPickMessage, applyFailureHelp };
