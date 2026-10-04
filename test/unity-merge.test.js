// Object-level merge of Unity YAML. The cases are the ones git's line merge gets wrong on a
// shared scene: edits on neighbouring lines, two people adding objects or children at the
// same spot, and — the part that must never regress — a property both sides changed staying
// a conflict instead of one side silently winning.
const test = require('node:test');
const assert = require('node:assert');

const { mergeUnityYaml, diffHunks, merge3, splitUnityDocs } = require('../src/main/lib/unity-merge');

const HEAD = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';

const go = (id, name, comps) => `--- !u!1 &${id}
GameObject:
  m_Component:
${comps.map(c => `  - component: {fileID: ${c}}`).join('\n')}
  m_Name: ${name}
  m_IsActive: 1
`;
const tr = (id, goId, { pos = '{x: 0, y: 0, z: 0}', scale = '{x: 1, y: 1, z: 1}', children = [], father = 0 } = {}) => `--- !u!4 &${id}
Transform:
  m_GameObject: {fileID: ${goId}}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: ${pos}
  m_LocalScale: ${scale}
  m_Children:${children.length ? '\n' + children.map(c => `  - {fileID: ${c}}`).join('\n') : ' []'}
  m_Father: {fileID: ${father}}
`;

const base = HEAD + go(100, 'Player', [101]) + tr(101, 100);

test('edits to different objects merge cleanly', () => {
  const ours = HEAD + go(100, 'Hero', [101]) + tr(101, 100);
  const theirs = HEAD + go(100, 'Player', [101]) + tr(101, 100, { pos: '{x: 5, y: 0, z: 0}' });
  const r = mergeUnityYaml(base, ours, theirs);
  assert.ok(r.ok && r.clean);
  assert.match(r.text, /m_Name: Hero/);
  assert.match(r.text, /m_LocalPosition: \{x: 5/);
});

test('edits on adjacent lines of one object merge (git would conflict)', () => {
  const ours = HEAD + go(100, 'Player', [101]) + tr(101, 100, { pos: '{x: 5, y: 0, z: 0}' });
  const theirs = HEAD + go(100, 'Player', [101]) + tr(101, 100, { scale: '{x: 2, y: 2, z: 2}' });
  const r = mergeUnityYaml(base, ours, theirs);
  assert.ok(r.clean, JSON.stringify(r.conflicts));
  assert.match(r.text, /m_LocalPosition: \{x: 5/);
  assert.match(r.text, /m_LocalScale: \{x: 2/);
  assert.strictEqual(r.stats.merged, 1);
});

test('the same property changed differently is a conflict, named by object and property', () => {
  const ours = HEAD + go(100, 'Player', [101]) + tr(101, 100, { pos: '{x: 5, y: 0, z: 0}' });
  const theirs = HEAD + go(100, 'Player', [101]) + tr(101, 100, { pos: '{x: 9, y: 0, z: 0}' });
  const r = mergeUnityYaml(base, ours, theirs);
  assert.ok(r.ok && !r.clean);
  assert.strictEqual(r.conflicts.length, 1);
  assert.deepStrictEqual(
    { type: r.conflicts[0].type, object: r.conflicts[0].object, property: r.conflicts[0].property },
    { type: 'Transform', object: 'Player', property: 'm_LocalPosition' });
  // Only that line is in dispute; the markers wrap it and nothing else.
  assert.match(r.text, /<<<<<<< ours\n  m_LocalPosition: \{x: 5, y: 0, z: 0\}\n=======\n  m_LocalPosition: \{x: 9, y: 0, z: 0\}\n>>>>>>> theirs\n/);
});

test('the same change on both sides is not a conflict', () => {
  const both = HEAD + go(100, 'Player', [101]) + tr(101, 100, { pos: '{x: 5, y: 0, z: 0}' });
  const r = mergeUnityYaml(base, both, both);
  assert.ok(r.clean);
  assert.strictEqual(r.text, both);
});

test('both sides adding objects and children: all kept, lists unioned', () => {
  const ours = HEAD + go(100, 'Player', [101]) + tr(101, 100, { children: [201] }) + go(200, 'Sword', [201]) + tr(201, 200, { father: 101 });
  const theirs = HEAD + go(100, 'Player', [101]) + tr(101, 100, { children: [301] }) + go(300, 'Shield', [301]) + tr(301, 300, { father: 101 });
  const r = mergeUnityYaml(base, ours, theirs);
  assert.ok(r.clean, JSON.stringify(r.conflicts));
  for (const id of [200, 201, 300, 301]) assert.match(r.text, new RegExp(`&${id}\\n`));
  // `m_Children: []` became a block list on both sides: both first children survive.
  assert.match(r.text, /m_Children:\n  - \{fileID: 201\}\n  - \{fileID: 301\}\n/);
});

test('one side emptying a list the other appended to is a conflict, not a silent keep', () => {
  const b = HEAD + tr(101, 100, { children: [11] });
  const o = HEAD + tr(101, 100);                       // removed the only child
  const t = HEAD + tr(101, 100, { children: [11, 33] });
  assert.ok(!mergeUnityYaml(b, o, t).clean);
});

test('appending to an existing list on both sides is a union', () => {
  const b = HEAD + tr(101, 100, { children: [11] });
  const o = HEAD + tr(101, 100, { children: [11, 22] });
  const t = HEAD + tr(101, 100, { children: [11, 33] });
  const r = mergeUnityYaml(b, o, t);
  assert.ok(r.clean, JSON.stringify(r.conflicts));
  assert.match(r.text, /- \{fileID: 11\}\n  - \{fileID: 22\}\n  - \{fileID: 33\}\n/);
});

test('both adding an override for the same property with different values conflicts', () => {
  const pi = (mods) => HEAD + `--- !u!1001 &500
PrefabInstance:
  m_Modification:
    m_Modifications:
${mods.map(([p, v]) => `    - target: {fileID: 7, guid: abc, type: 3}
      propertyPath: ${p}
      value: ${v}
      objectReference: {fileID: 0}`).join('\n')}
`;
  const b = pi([['m_Name', 'Door']]);
  const clean = mergeUnityYaml(b, pi([['m_Name', 'Door'], ['m_IsActive', '0']]), pi([['m_Name', 'Door'], ['m_Layer', '5']]));
  assert.ok(clean.clean, JSON.stringify(clean.conflicts));
  assert.match(clean.text, /m_IsActive[\s\S]*m_Layer/);

  const clash = mergeUnityYaml(b, pi([['m_Name', 'Door'], ['m_Layer', '3']]), pi([['m_Name', 'Door'], ['m_Layer', '5']]));
  assert.ok(!clash.clean);
});

test('deleting an object the other side changed is a conflict; deleting an untouched one is not', () => {
  const withSword = HEAD + go(100, 'Player', [101]) + tr(101, 100) + go(200, 'Sword', []);
  const swordGone = HEAD + go(100, 'Player', [101]) + tr(101, 100);
  const swordRenamed = HEAD + go(100, 'Player', [101]) + tr(101, 100) + go(200, 'Blade', []);
  const playerMoved = HEAD + go(100, 'Player', [101]) + tr(101, 100, { pos: '{x: 1, y: 0, z: 0}' }) + go(200, 'Sword', []);

  const ok = mergeUnityYaml(withSword, swordGone, playerMoved);
  assert.ok(ok.clean);
  assert.doesNotMatch(ok.text, /Sword/);
  assert.match(ok.text, /\{x: 1,/);

  const bad = mergeUnityYaml(withSword, swordGone, swordRenamed);
  assert.ok(!bad.clean);
  assert.strictEqual(bad.conflicts[0].kind, 'deleted-ours');
});

test('a new object from theirs lands next to its neighbour, not at the end', () => {
  const o = HEAD + go(100, 'A', []) + go(900, 'Z', []);
  const b = o;
  const t = HEAD + go(100, 'A', []) + go(150, 'New', []) + go(900, 'Z', []);
  const r = mergeUnityYaml(b, o, t);
  assert.strictEqual(r.text, t);
});

test('CRLF and the final newline follow ours', () => {
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const ours = crlf(HEAD + go(100, 'Hero', [101]) + tr(101, 100));
  const theirs = HEAD + go(100, 'Player', [101]) + tr(101, 100, { pos: '{x: 5, y: 0, z: 0}' });
  const r = mergeUnityYaml(base, ours, theirs);
  assert.ok(r.clean);
  assert.ok(r.text.endsWith('\r\n'));
  assert.doesNotMatch(r.text.replace(/\r\n/g, ''), /\n/);
});

test('refuses what it cannot match safely', () => {
  assert.strictEqual(mergeUnityYaml(base, 'just some text', base).ok, false);
  const dup = HEAD + go(100, 'A', []) + go(100, 'B', []);
  assert.strictEqual(splitUnityDocs(dup), null);
  assert.strictEqual(mergeUnityYaml(base, dup, base).ok, false);
});

test('diffHunks finds separate hunks and survives a large input', () => {
  assert.deepStrictEqual(diffHunks(['a', 'b', 'c', 'd'], ['a', 'X', 'c', 'Y']),
    [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }, { aStart: 3, aEnd: 4, bStart: 3, bEnd: 4 }]);
  const big = Array.from({ length: 50000 }, (_, i) => 'line ' + i);
  const edited = big.slice(); edited[100] = 'x'; edited[40000] = 'y';
  assert.strictEqual(diffHunks(big, edited).length, 2);
  // Past the edit-distance cap it degrades to one hunk instead of hanging.
  const shuffled = big.map((l, i) => (i % 2 ? l : 'z' + i));
  const h = diffHunks(big, shuffled, 50);
  assert.strictEqual(h.length, 1);
});

test('merge3 still conflicts on two different insertions at one point that are not list items', () => {
  const r = merge3(['a', 'b'], ['a', 'x: 1', 'b'], ['a', 'y: 2', 'b'], { ours: 'o', theirs: 't' });
  assert.strictEqual(r.conflicts.length, 1);
});
