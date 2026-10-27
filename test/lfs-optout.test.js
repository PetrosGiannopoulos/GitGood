// Taking single files out of LFS by overriding the tracking pattern in .gitattributes.
// The pattern must match exactly one path — a Unity path with spaces and [ ] included —
// because .gitattributes has no quoting and an unescaped "[Big]" is a character class.
const test = require('node:test');
const assert = require('node:assert');

const { lfsOptOutPattern, appendLfsOptOuts, OPT_OUT_HEADER } = require('../src/main/lib/lfs-optout');

test('lfsOptOutPattern: anchored to the root, plain path unchanged', () => {
  assert.strictEqual(lfsOptOutPattern('Assets/Scenes/A.unity'), '/Assets/Scenes/A.unity');
  assert.strictEqual(lfsOptOutPattern('Top.unity'), '/Top.unity');
});

test('lfsOptOutPattern: spaces become a class, glob characters are escaped', () => {
  assert.strictEqual(
    lfsOptOutPattern('Assets/Scenes/My [Big] Scene.unity'),
    '/Assets/Scenes/My[[:space:]]\\[Big\\][[:space:]]Scene.unity');
  assert.strictEqual(lfsOptOutPattern('a/b*c?.asset'), '/a/b\\*c\\?.asset');
});

test('lfsOptOutPattern: non-ASCII passes through; a line break is refused', () => {
  assert.strictEqual(lfsOptOutPattern('Σκηνές/Κύρια.unity'), '/Σκηνές/Κύρια.unity');
  assert.throws(() => lfsOptOutPattern('a\nb.unity'), /line break/);
  assert.throws(() => lfsOptOutPattern(''), /required/);
});

test('appendLfsOptOuts: header once, one line per path, no duplicates', () => {
  const base = '*.unity filter=lfs diff=lfs merge=lfs -text\n';
  const once = appendLfsOptOuts(base, ['A.unity', 'A.unity']);
  assert.strictEqual(once,
    base + '\n' + OPT_OUT_HEADER + '\n/A.unity !filter !diff !merge\n');
  // Running again for the same path changes nothing; a new path adds only its own line.
  assert.strictEqual(appendLfsOptOuts(once, ['A.unity']), once);
  assert.strictEqual(appendLfsOptOuts(once, ['B.unity']), once + '/B.unity !filter !diff !merge\n');
});

test('appendLfsOptOuts: keeps CRLF, terminates an unterminated last line, works from empty', () => {
  const crlf = appendLfsOptOuts('*.psd filter=lfs diff=lfs merge=lfs -text', ['x.psd']);
  assert.ok(crlf.startsWith('*.psd filter=lfs diff=lfs merge=lfs -text\n'));
  const winSrc = '*.psd filter=lfs\r\n';
  const win = appendLfsOptOuts(winSrc, ['x.psd']);
  assert.ok(!/[^\r]\n/.test(win), 'every line ends CRLF');
  assert.strictEqual(appendLfsOptOuts('', ['x.psd']), OPT_OUT_HEADER + '\n/x.psd !filter !diff !merge\n');
});
