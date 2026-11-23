'use strict';
// "Load more" on a cut diff (04-diff.js): a diff over the line cap, or cut at a byte budget,
// ends in buttons that can draw more — and an uncut diff is left exactly as it was.
const test = require('node:test');
const assert = require('node:assert');

global.document = { addEventListener() {}, createElement() { return {}; }, getElementById() { return null; } };
global.window = {};
global.state = { diffMode: 'unified' };
global.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const { renderDiff, untrackedAsDiff, parseUnifiedDiff, DIFF_LINE_CAP } = require('../src/renderer/js/04-diff.js');

const bigFile = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const count = (html, re) => (html.match(re) || []).length;
// The cap counts drawn rows: one file of N lines is N + 2 (its file row and its hunk row).
const rows = (n) => n + 2;
const fmt = (n) => n.toLocaleString();

test('an uncut diff has no tail and no wrapper', () => {
  const html = renderDiff(untrackedAsDiff('a.txt', bigFile(10)), { filePath: 'a.txt', noSmart: true });
  assert.ok(!html.includes('data-diff-more'));
  assert.ok(!html.includes('data-diff-render'));
});

test('past the line cap: the first cap lines, then "more" and "all" buttons', () => {
  const total = DIFF_LINE_CAP * 2 + 5000;
  const html = renderDiff(untrackedAsDiff('big.txt', bigFile(total)), { filePath: 'big.txt', noSmart: true });
  assert.ok(html.includes('data-diff-render'));
  assert.ok(html.includes(`data-diff-cap="${DIFF_LINE_CAP * 2}"`), 'next step is one more cap');
  assert.ok(html.includes(`data-diff-cap="${rows(total)}"`), 'show all jumps to the end');
  assert.ok(count(html, /class="diff-line add/g) <= DIFF_LINE_CAP);
});

test('a raised cap draws more lines; the last step offers only what is left', () => {
  const total = DIFF_LINE_CAP + 1234;
  const text = untrackedAsDiff('c.txt', bigFile(total));
  const html = renderDiff(text, { filePath: 'c.txt', noSmart: true });
  assert.ok(html.includes(`Show ${fmt(rows(total) - DIFF_LINE_CAP)} more lines`));
  assert.ok(!html.includes('Show all'), 'one step covers it, so no separate show-all');
  const all = renderDiff(text, { filePath: 'c.txt', noSmart: true, lineCap: rows(total) });
  assert.ok(!all.includes('data-diff-more'));
  assert.strictEqual(count(all, /class="diff-line add/g), total);
});

test('cut at a byte budget: offers to load more only when there is a loader', () => {
  const text = untrackedAsDiff('d.txt', bigFile(50));
  const withLoader = renderDiff(text, { filePath: 'd.txt', noSmart: true, diffTruncated: true,
    diffBytes: 9 * 1024 * 1024, loadMoreBytes: async () => ({}) });
  assert.ok(withLoader.includes('data-diff-bytes="1"'));
  assert.ok(withLoader.includes('MB diff'));
  const without = renderDiff(text, { filePath: 'd.txt', noSmart: true, diffTruncated: true, diffBytes: 9 * 1024 * 1024 });
  assert.ok(!without.includes('data-diff-more'), 'nothing to click when nobody can fetch more');
  assert.ok(without.includes('diff-notice'), 'but it still says the diff is incomplete');
});

test('the split view gets the same tail', () => {
  global.state.diffMode = 'split';
  try {
    const html = renderDiff(untrackedAsDiff('e.txt', bigFile(DIFF_LINE_CAP + 10)), { filePath: 'e.txt', noSmart: true });
    assert.ok(html.includes('dsplit'));
    assert.ok(html.includes(`Show ${fmt(12)} more lines`));
  } finally { global.state.diffMode = 'unified'; }
});

test('untrackedAsDiff: one added hunk with every line, trailing newline or not', () => {
  for (const text of ['a\nb\nc\n', 'a\nb\nc']) {
    const f = parseUnifiedDiff(untrackedAsDiff('dir/x y.cs', text)).files[0];
    assert.strictEqual(f.hunks.length, 1);
    assert.deepStrictEqual(f.hunks[0].lines.map(l => l.type + l.text), ['+a', '+b', '+c']);
  }
});
