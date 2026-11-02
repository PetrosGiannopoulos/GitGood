'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ansiToHtml } = require('../src/renderer/js/23-debug-toolkit.js');

test('git colour codes become spans, and the text is escaped', () => {
  const html = ansiToHtml('\x1b[1;31m-a < b\x1b[m\n\x1b[32m+a > "b"\x1b[m');
  assert.strictEqual(html, '<span class="ansi-fg-1 ansi-b">-a &lt; b</span>\n<span class="ansi-fg-2">+a &gt; &quot;b&quot;</span>');
});

test('only yellow hex runs (git hashes) become clickable', () => {
  const html = ansiToHtml('\x1b[33mabc1234\x1b[m deadbeef', { linkHashes: true });
  assert.ok(html.includes('data-hash="abc1234"'));
  assert.ok(!html.includes('data-hash="deadbeef"'));
});

test('carriage returns and non-colour escapes are dropped; 256-colour args are consumed', () => {
  assert.strictEqual(ansiToHtml('a\r\n\x1b[Kb'), 'a\nb');
  assert.strictEqual(ansiToHtml('\x1b[38;5;196mx\x1b[0m'), 'x');
  assert.strictEqual(ansiToHtml('\x1b[38;5;2mx'), '<span class="ansi-fg-2">x</span>');
});
