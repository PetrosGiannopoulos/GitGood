// The message a partial cherry-pick writes. A commit that carries only part of another
// commit has to say so — and the dialog hands its own text back on a second attempt, so
// re-picking must not stack a second note on top of the first.
const test = require('node:test');
const assert = require('node:assert');

const { partialPickMessage, applyFailureHelp, rewritePlan } = require('../src/main/lib/partial-pick');

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('partialPickMessage: git\'s own note, then the one about the files left out', () => {
  assert.strictEqual(
    partialPickMessage('Fix the thing', { hash: HASH, included: 2, total: 5 }),
    `Fix the thing\n\n(cherry picked from commit ${HASH})\nPartial-cherry-pick: 2 of 5 files`
  );
});

test('partialPickMessage: nothing left out means no partial line', () => {
  assert.strictEqual(
    partialPickMessage('Fix the thing', { hash: HASH, included: 5, total: 5 }),
    `Fix the thing\n\n(cherry picked from commit ${HASH})`
  );
});

test('partialPickMessage: body and subject are kept apart by their blank line', () => {
  const out = partialPickMessage('Subject\n\nA paragraph explaining it.', { hash: HASH, included: 1, total: 2 });
  assert.match(out, /^Subject\n\nA paragraph explaining it\.\n\n\(cherry picked/);
});

test('partialPickMessage: the note joins an existing trailer block, not a new paragraph', () => {
  // A blank line here would split "Signed-off-by" off into a paragraph of its own and
  // stop git reading either line as a trailer.
  const out = partialPickMessage('Fix it\n\nSigned-off-by: A <a@b.c>', { hash: HASH, included: 1, total: 3 });
  assert.strictEqual(out, `Fix it\n\nSigned-off-by: A <a@b.c>\n(cherry picked from commit ${HASH})\nPartial-cherry-pick: 1 of 3 files`);
});

test('partialPickMessage: re-picking replaces the previous note instead of stacking one', () => {
  // The dialog prefills the box, the user edits nothing, and main gets its own output
  // back. Two notes would each claim a different file count.
  const once = partialPickMessage('Fix it', { hash: HASH, included: 2, total: 5 });
  const twice = partialPickMessage(once, { hash: HASH, included: 3, total: 5 });
  assert.strictEqual(twice, `Fix it\n\n(cherry picked from commit ${HASH})\nPartial-cherry-pick: 3 of 5 files`);
  assert.strictEqual((twice.match(/cherry picked from/g) || []).length, 1);
});

test('partialPickMessage: an empty message is the note alone, with no leading blank lines', () => {
  assert.strictEqual(
    partialPickMessage('', { hash: HASH, included: 1, total: 2 }),
    `(cherry picked from commit ${HASH})\nPartial-cherry-pick: 1 of 2 files`
  );
});

test('applyFailureHelp: a conflict is explained as one, and names the way out', () => {
  const help = applyFailureHelp("error: patch failed: Assets/Scene.unity:1\nerror: Assets/Scene.unity: patch does not apply");
  assert.match(help, /conflict/i);
  assert.match(help, /whole commit/i);
});

test('applyFailureHelp: a moved working tree is a different answer', () => {
  assert.match(applyFailureHelp('error: foo.txt: does not match index'), /Refresh/);
});

test('applyFailureHelp: an unrecognised failure is not dressed up as one of those two', () => {
  assert.strictEqual(applyFailureHelp('error: something else entirely'), null);
});

// Replacing the commit in history instead. The push half is the dangerous one: forcing a
// branch that is behind its upstream deletes whatever the remote had that we never pulled.
const OK_FACTS = {
  branch: 'main', busy: false, onBranch: true, parents: 1, mergesAfter: 0, dirty: 0,
  upstream: 'origin/main', onUpstream: true, behind: 0
};

test('rewritePlan: a pushed commit on the current branch can be replaced and force-pushed', () => {
  const p = rewritePlan(OK_FACTS);
  assert.strictEqual(p.canRewrite, true);
  assert.strictEqual(p.canPush, true);
});

test('rewritePlan: never offers a force-push that would drop commits not yet pulled', () => {
  const p = rewritePlan({ ...OK_FACTS, behind: 2 });
  assert.strictEqual(p.canRewrite, true);
  assert.strictEqual(p.canPush, false);
  assert.match(p.pushReason, /2 commit\(s\) you have not pulled/);
});

test('rewritePlan: a commit the remote never saw needs no push', () => {
  const p = rewritePlan({ ...OK_FACTS, onUpstream: false });
  assert.strictEqual(p.canRewrite, true);
  assert.strictEqual(p.canPush, false);
});

test('rewritePlan: refuses what a linear replay cannot do honestly', () => {
  for (const [facts, re] of [
    [{ branch: '' }, /detached/],
    [{ onBranch: false }, /not part of main/],
    [{ parents: 2 }, /merge commit/],
    [{ mergesAfter: 1 }, /flatten/],
    [{ dirty: 3 }, /uncommitted/],
    [{ busy: true }, /in progress/]
  ]) {
    const p = rewritePlan({ ...OK_FACTS, ...facts });
    assert.strictEqual(p.canRewrite, false);
    assert.strictEqual(p.canPush, false, 'no push without a rewrite');
    assert.match(p.reason, re);
  }
});
