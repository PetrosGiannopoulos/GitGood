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

test('regex recognition: unambiguous regex is recognised, plain C# is not', () => {
  const { looksLikeRegex } = require('../src/renderer/js/23-debug-toolkit.js');
  const yes = [String.raw`Debug\.LogError\b`, String.raw`x\d+`, String.raw`\bvoid\s+Start`, 'Get(Component|Components)',
    String.raw`[A-Z]\w*Manager`, 'foo.*bar', '^using ', String.raw`health\s*-=`, 'Log(Error|Warning)'];
  const no = ['Debug.LogError(', 'health -=', 'GetComponent<Rigidbody>()', 'TODO', 'a.b', 'x == null ? 1 : 2',
    'if (a || b)', 'list[0]', 'arr[i-1]', ''];
  yes.forEach(t => assert.ok(looksLikeRegex(t), `should be a regex: ${t}`));
  no.forEach(t => assert.ok(!looksLikeRegex(t), `should be plain text: ${t}`));
});
