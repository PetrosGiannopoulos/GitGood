// Commit-message suggestions: the diff budget and the lenient reading of a small model's
// reply. A regression in either is silent — the button still "works", it just describes
// one file out of twenty, or fails on a reply that was perfectly usable.
const test = require('node:test');
const assert = require('node:assert');

const { trimDiffForPrompt, buildCommitSuggestPrompt, parseCommitSuggestion } = require('../src/main/lib/commit-suggest');

const fileDiff = (name, lines) =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n` +
  Array.from({ length: lines }, (_, i) => `+line ${i} of ${name}`).join('\n') + '\n';

test('trimDiffForPrompt: a small diff passes through untouched', () => {
  const d = fileDiff('a.js', 3);
  assert.strictEqual(trimDiffForPrompt(d, 9000), d);
});

test('trimDiffForPrompt: one huge file cannot crowd out the others', () => {
  const d = fileDiff('huge.unity', 5000) + fileDiff('small.cs', 3);
  const out = trimDiffForPrompt(d, 9000);
  assert.ok(out.length <= 9000 + 200, 'stays near the budget');
  assert.ok(out.includes('+line 2 of small.cs'), 'the small file is still shown whole');
  assert.ok(out.includes('omitted'), 'the cut is marked');
});

test('trimDiffForPrompt: files past the budget are named, not dropped', () => {
  const d = Array.from({ length: 30 }, (_, i) => fileDiff(`f${i}.js`, 200)).join('');
  const out = trimDiffForPrompt(d, 6000);
  assert.match(out, /diffs omitted for \d+ more file\(s\): .*f29\.js/);
});

test('buildCommitSuggestPrompt: says when it is an amend or the working tree', () => {
  const p = buildCommitSuggestPrompt({ stat: 'a.js | 1 +', diff: '', amend: true, previousMessage: 'Old msg', source: 'staged' });
  assert.match(p, /previous commit, which was:\nOld msg/);
  const u = buildCommitSuggestPrompt({ stat: 'a.js | 1 +', diff: 'x', source: 'unstaged' });
  assert.match(u, /nothing is staged/);
});

test('parseCommitSuggestion: plain JSON', () => {
  const r = parseCommitSuggestion('{"summary":"Add login form","description":"- New view\\n- Validation"}');
  assert.deepStrictEqual(r, { summary: 'Add login form', description: '- New view\n- Validation' });
});

test('parseCommitSuggestion: fenced JSON with prose, trailing period, array description', () => {
  const r = parseCommitSuggestion('Here you go:\n```json\n{"summary": "Fix crash on empty repo.", "description": ["Guard HEAD lookup", "- Add test"]}\n```');
  assert.strictEqual(r.summary, 'Fix crash on empty repo');
  assert.strictEqual(r.description, '- Guard HEAD lookup\n- Add test');
});

test('parseCommitSuggestion: falls back to plain text', () => {
  const r = parseCommitSuggestion('Summary: Rename helper\n\n- moved to lib');
  assert.strictEqual(r.summary, 'Rename helper');
  assert.strictEqual(r.description, '- moved to lib');
});

test('parseCommitSuggestion: an over-long summary is cut at a word, within the field cap', () => {
  const r = parseCommitSuggestion(JSON.stringify({ summary: 'word '.repeat(40), description: '' }));
  assert.ok(r.summary.length <= 80);
  assert.ok(!r.summary.endsWith(' '));
});

test('parseCommitSuggestion: an empty reply is an error', () => {
  assert.throws(() => parseCommitSuggestion('   '));
});
