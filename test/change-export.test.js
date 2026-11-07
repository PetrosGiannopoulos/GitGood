'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ce = require('../src/main/lib/change-export');

const MODIFIED = [
  'diff --git a/Assets/Scripts/Player Controller.cs b/Assets/Scripts/Player Controller.cs',
  'index 1111111..2222222 100644',
  '--- a/Assets/Scripts/Player Controller.cs\t',
  '+++ b/Assets/Scripts/Player Controller.cs\t',
  '@@ -40,7 +40,8 @@ public class PlayerController : MonoBehaviour',
  '     void Update()',
  '     {',
  '         if (grounded)',
  '-            speed = 5f;',
  '+            speed = runSpeed;',
  '+            animator.SetBool("Run", true);',
  '         jump();',
  '     }',
  ''
].join('\n');

const ADDED = [
  'diff --git a/Assets/New.cs b/Assets/New.cs',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/Assets/New.cs',
  '@@ -0,0 +1,3 @@',
  '+class New {',
  '+  // ```',
  '+}',
  '\\ No newline at end of file',
  ''
].join('\n');

const DELETED = [
  'diff --git a/Old.cs b/Old.cs',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/Old.cs',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-class Old {',
  '-}',
  ''
].join('\n');

const RENAMED_BINARY_LFS = [
  'diff --git a/a.png b/b.png',
  'similarity index 100%',
  'rename from a.png',
  'rename to b.png',
  'diff --git a/tex.psd b/tex.psd',
  'index 5555555..6666666 100644',
  'Binary files a/tex.psd and b/tex.psd differ',
  'diff --git a/big.fbx b/big.fbx',
  'index 7777777..8888888 100644',
  '--- a/big.fbx',
  '+++ b/big.fbx',
  '@@ -1,3 +1,3 @@',
  ' version https://git-lfs.github.com/spec/v1',
  '-oid sha256:' + 'a'.repeat(64),
  '-size 100',
  '+oid sha256:' + 'b'.repeat(64),
  '+size 200',
  ''
].join('\n');

test('parses statuses, paths with spaces, counts and hunk positions', () => {
  const files = ce.parseExportDiff(MODIFIED + ADDED + DELETED + RENAMED_BINARY_LFS);
  assert.deepStrictEqual(files.map(f => [f.path, f.status]), [
    ['Assets/Scripts/Player Controller.cs', 'modified'],
    ['Assets/New.cs', 'added'],
    ['Old.cs', 'deleted'],
    ['b.png', 'renamed'],
    ['tex.psd', 'modified'],
    ['big.fbx', 'modified']
  ]);
  const m = files[0];
  assert.strictEqual(m.adds, 2);
  assert.strictEqual(m.dels, 1);
  assert.strictEqual(m.hunks[0].func, 'public class PlayerController : MonoBehaviour');
  // The first *change* is at new line 43, not the hunk's first context line (40).
  assert.strictEqual(ce.hunkLine(m.hunks[0]), 43);
  assert.strictEqual(files[3].oldPath, 'a.png');
  assert.strictEqual(files[4].binary, true);
  assert.strictEqual(ce.isLfsPointerDiff(files[5]), true);
  assert.strictEqual(ce.isLfsPointerDiff(m), false);
});

test('decodes git C-quoted paths as UTF-8', () => {
  assert.strictEqual(ce.unquoteGitPath('"caf\\303\\251 \\"x\\".txt"'), 'café "x".txt');
  const files = ce.parseExportDiff([
    'diff --git "a/caf\\303\\251.cs" "b/caf\\303\\251.cs"',
    '--- "a/caf\\303\\251.cs"',
    '+++ "b/caf\\303\\251.cs"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    ''
  ].join('\n'));
  assert.strictEqual(files[0].path, 'café.cs');
});

test('markdown: diff blocks with method, new file as plain code, safe fences', () => {
  const exp = {
    commit: { short: 'abc1234', subject: 'Run speed', author: 'Ana', date: '2026-11-05T10:00:00+02:00' },
    files: ce.parseExportDiff(MODIFIED + ADDED + DELETED + RENAMED_BINARY_LFS),
    missing: [], truncated: false, ignoreWhitespace: true, totalInCommit: 9
  };
  const md = ce.formatMarkdown(exp);
  assert.match(md, /^## Changes from `abc1234` — Run speed/);
  assert.match(md, /\*\*Author:\*\* Ana · 2026-11-05/);
  assert.match(md, /6 of 9 in the commit/);
  assert.match(md, /Whitespace-only changes are left out/);
  assert.match(md, /\*\*Around line 43\*\* — near `public class PlayerController : MonoBehaviour`/);
  assert.match(md, /```diff\n {5}void Update\(\)\n/);
  assert.match(md, /-            speed = 5f;\n\+            speed = runSpeed;/);
  // New file: no "+" prefixes, and a fence longer than the ``` inside it.
  assert.match(md, /New file — full contents:\n\n````csharp\nclass New \{\n {2}\/\/ ```\n\}\n````/);
  assert.match(md, /Delete this file/);
  assert.match(md, /Renamed from a\.png/);
  assert.match(md, /Binary file — .*commit abc1234/);
  assert.match(md, /Stored in Git LFS/);
  assert.doesNotMatch(md, /oid sha256/);
});

test('plain text: ASCII stats, location lines, missing files listed', () => {
  const files = ce.parseExportDiff(MODIFIED);
  files[0].cut = true;
  const txt = ce.formatText({
    commit: { short: 'abc1234', subject: 'Run speed', author: 'Ana', date: '2026-11-05' },
    files, missing: ['Later.cs'], truncated: true, totalInCommit: 2
  });
  assert.match(txt, /^CHANGES FROM COMMIT abc1234 — Run speed/);
  assert.match(txt, /\[1\/1\] Assets\/Scripts\/Player Controller\.cs {2}\(modified, \+2 \/ -1\)/);
  assert.match(txt, />> Around line 43, near: public class PlayerController/);
  assert.match(txt, /cut off by the size limit/);
  assert.match(txt, /Not included \(size limit\):\n {2}- Later\.cs/);
});

test('unity YAML gets the redo-in-Editor note', () => {
  const files = ce.parseExportDiff([
    'diff --git a/Level.unity b/Level.unity',
    '--- a/Level.unity',
    '+++ b/Level.unity',
    '@@ -10 +10 @@',
    '-  m_IsActive: 1',
    '+  m_IsActive: 0',
    ''
  ].join('\n'));
  const md = ce.formatMarkdown({ commit: { short: 'x' }, files, missing: [] });
  assert.match(md, /redo the change in the Editor/);
});

test('pathspecs pair a rename with its old path, deduped, in selection order', () => {
  const ns = [{ status: 'R', oldPath: 'old/A.cs', path: 'new/A.cs' }, { status: 'M', path: 'B.cs' }];
  assert.deepStrictEqual(ce.exportPathspecs(['B.cs', 'new/A.cs', 'B.cs'], ns), ['B.cs', 'old/A.cs', 'new/A.cs']);
});
