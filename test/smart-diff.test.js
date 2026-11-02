// Smart diffs for files whose line diff says nothing: LFS pointers, and Unity YAML assets
// turned into "which objects changed, and which properties". The Unity half is the part a
// regression would make quietly wrong — a misread indent puts a property on the wrong object.
const test = require('node:test');
const assert = require('node:assert');

const { smartKind, parseLfsPointer, parseUnityYaml, flattenDocument, decodeYamlScalar, referencedGuids, changedValueGuids, diffUnity } = require('../src/main/lib/smart-diff');

const HEAD = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';
const scene = (playerX, extra = '') => HEAD + `--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 101}
  - component: {fileID: 102}
  m_Layer: 0
  m_Name: World
  m_IsActive: 1
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_Children:
  - {fileID: 201}
  m_Father: {fileID: 0}
--- !u!114 &102
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
  speed: 5
  waypoints:
  - {x: 1, y: 2}
  - {x: 3, y: 4}
--- !u!1 &200
GameObject:
  m_Component:
  - component: {fileID: 201}
  m_Name: Player
--- !u!4 &201
Transform:
  m_GameObject: {fileID: 200}
  m_LocalPosition: {x: ${playerX}, y: 1, z: 0}
  m_Father: {fileID: 101}
${extra}`;

test('smartKind: by extension, case-insensitive, Unity assets included', () => {
  assert.strictEqual(smartKind('Assets/Art/Hero.PNG'), 'image');
  assert.strictEqual(smartKind('Assets/Scenes/Main.unity'), 'unity');
  assert.strictEqual(smartKind('Assets/Prefabs/Enemy.prefab'), 'unity');
  assert.strictEqual(smartKind('Audio/hit.wav'), 'audio');
  assert.strictEqual(smartKind('Video/intro.mp4'), 'video');
  assert.strictEqual(smartKind('src/main.js'), null);
  assert.strictEqual(smartKind('Makefile'), null);
});

test('parseLfsPointer: reads oid and size, rejects anything else', () => {
  const oid = 'a'.repeat(64);
  assert.deepStrictEqual(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`), { oid, size: 12345 });
  assert.strictEqual(parseLfsPointer('PNG\u0000binary'), null);
  assert.strictEqual(parseLfsPointer('version https://git-lfs.github.com/spec/v1\n'), null);
});

test('flattenDocument: sequences at the parent indent, flow maps kept whole', () => {
  const props = flattenDocument([
    'MonoBehaviour:',
    '  speed: 5',
    '  waypoints:',
    '  - {x: 1, y: 2}',
    '  - {x: 3, y: 4}',
    '  m_Materials:',
    '  - first: 1',
    '    second: 2',
    '  after: yes',
  ]);
  assert.strictEqual(props.get('MonoBehaviour.speed'), '5');
  assert.strictEqual(props.get('MonoBehaviour.waypoints[0]'), '{x: 1, y: 2}');
  assert.strictEqual(props.get('MonoBehaviour.waypoints[1]'), '{x: 3, y: 4}');
  assert.strictEqual(props.get('MonoBehaviour.m_Materials[0].first'), '1');
  assert.strictEqual(props.get('MonoBehaviour.m_Materials[0].second'), '2');
  // The sibling after a sequence must not be filed under the sequence's last item.
  assert.strictEqual(props.get('MonoBehaviour.after'), 'yes');
});

test('parseUnityYaml: documents by fileID, with owner, father and script', () => {
  const docs = parseUnityYaml(scene(0).replace(/\n/g, '\r\n'));   // CRLF on a Windows checkout
  assert.strictEqual(docs.size, 5);
  assert.strictEqual(docs.get('100').name, 'World');
  assert.strictEqual(docs.get('201').gameObject, '200');
  assert.strictEqual(docs.get('201').father, '101');
  assert.strictEqual(docs.get('102').scriptGuid, 'a'.repeat(32));
  assert.strictEqual(docs.get('102').props.get('speed'), '5');
  assert.deepStrictEqual(referencedGuids(docs), ['a'.repeat(32)]);
});

test('diffUnity: a moved object is one change, filed under its GameObject with its path', () => {
  const r = diffUnity(parseUnityYaml(scene(0)), parseUnityYaml(scene(5)));
  assert.deepStrictEqual(r.counts, { added: 0, removed: 0, modified: 1, objects: 1 });
  const g = r.groups[0];
  assert.strictEqual(g.name, 'Player');
  assert.strictEqual(g.path, 'World');
  assert.strictEqual(g.components.length, 1);
  assert.strictEqual(g.components[0].type, 'Transform');
  assert.deepStrictEqual(g.components[0].changes, [{ prop: 'm_LocalPosition', before: '{x: 0, y: 1, z: 0}', after: '{x: 5, y: 1, z: 0}' }]);
});

test('diffUnity: added objects, script names from GUIDs, list bookkeeping ignored', () => {
  const extra = `--- !u!1 &300
GameObject:
  m_Component:
  - component: {fileID: 301}
  m_Name: Coin
--- !u!4 &301
Transform:
  m_GameObject: {fileID: 300}
  m_Father: {fileID: 101}
`;
  const before = parseUnityYaml(scene(0));
  // The parent's child list grows; that must not surface as a change of its own.
  const after = parseUnityYaml(scene(0, extra).replace('  - {fileID: 201}\n', '  - {fileID: 201}\n  - {fileID: 301}\n').replace('speed: 5', 'speed: 7'));
  const r = diffUnity(before, after, { guidPaths: { ['a'.repeat(32)]: 'Assets/Scripts/Mover.cs' } });
  assert.deepStrictEqual(r.counts, { added: 1, removed: 0, modified: 1, objects: 2 });
  const coin = r.groups.find(g => g.name === 'Coin');
  assert.strictEqual(coin.status, 'added');
  assert.strictEqual(coin.path, 'World');
  const world = r.groups.find(g => g.name === 'World');
  assert.deepStrictEqual(world.components.map(c => c.type), ['Mover']);
  assert.deepStrictEqual(world.components[0].changes, [{ prop: 'speed', before: '5', after: '7' }]);
});

test('diffUnity: prefab overrides keyed by target, not by list position', () => {
  const inst = (mods) => HEAD + `--- !u!1001 &500
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 0}
    m_Modifications:
${mods.map(([path, value]) => `    - target: {fileID: 42, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
      propertyPath: ${path}
      value: ${value}
      objectReference: {fileID: 0}`).join('\n')}
  m_SourcePrefab: {fileID: 100100000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
`;
  // An override inserted at the front renumbers every later one; only it may show as new.
  const before = parseUnityYaml(inst([['m_Name', 'Enemy'], ['m_LocalPosition.x', '1']]));
  const after = parseUnityYaml(inst([['m_IsActive', '0'], ['m_Name', 'Enemy'], ['m_LocalPosition.x', '1']]));
  const r = diffUnity(before, after, { guidPaths: { ['b'.repeat(32)]: 'Assets/Prefabs/Enemy.prefab' } });
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.groups[0].name, 'Enemy');
  assert.strictEqual(r.groups[0].components[0].type, 'Prefab instance of Enemy');
  assert.deepStrictEqual(r.groups[0].components[0].changes, [{ prop: 'override m_IsActive @42', before: null, after: '0' }]);
});

test('diffUnity: identical assets produce nothing', () => {
  const r = diffUnity(parseUnityYaml(scene(3)), parseUnityYaml(scene(3)));
  assert.deepStrictEqual(r.counts, { added: 0, removed: 0, modified: 0, objects: 0 });
});

// ---------- The hierarchy (what the Hierarchy pane of the smart view draws) ----------
const go = (id, name, tid, father, children = [], extra = '') => `--- !u!1 &${id}
GameObject:
  m_Component:
  - component: {fileID: ${tid}}
  m_Name: ${name}
  m_IsActive: 1
${extra}--- !u!4 &${tid}
Transform:
  m_GameObject: {fileID: ${id}}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_Children:${children.length ? '\n' + children.map(c => `  - {fileID: ${c}}`).join('\n') : ' []'}
  m_Father: {fileID: ${father}}
`;
const treeOf = (r) => {
  const by = new Map(r.tree.nodes.map(n => [n.id, n]));
  const draw = (id) => { const n = by.get(id); return n.children.length ? { [n.name]: n.children.map(draw) } : n.name; };
  return { by, shape: r.tree.roots.map(draw) };
};

test('diffUnity tree: parents, sibling order from m_Children, root order from SceneRoots, untouched nodes kept', () => {
  const text = (lampX) => HEAD +
    go(10, 'Level', 11, 0, [21, 31]) +
    go(20, 'Lamp', 21, 11).replace('x: 0', `x: ${lampX}`) +
    go(30, 'Door', 31, 11) +
    go(40, 'Camera', 41, 0) +
    `--- !u!1660057539 &9223372036854775807
SceneRoots:
  m_ObjectHideFlags: 0
  m_Roots:
  - {fileID: 41}
  - {fileID: 11}
`;
  // Lamp is listed after Door in the file but before it in m_Children: the list wins.
  const reordered = (x) => text(x).replace(/(--- !u!1 &20[\s\S]*?)(--- !u!1 &30[\s\S]*?)(--- !u!1 &40)/, '$2$1$3');
  const r = diffUnity(parseUnityYaml(text(0)), parseUnityYaml(reordered(4)));
  const { by, shape } = treeOf(r);
  assert.deepStrictEqual(shape, ['Camera', { Level: ['Lamp', 'Door'] }]);
  assert.strictEqual(by.get('20').status, 'modified');
  assert.strictEqual(by.get('30').status, null);
  assert.strictEqual(by.get('10').status, null);
  assert.strictEqual(r.tree.total, 4);
  assert.strictEqual(r.tree.pruned, false);
  // SceneRoots is not a GameObject and sits outside the hierarchy.
  assert.strictEqual(r.groups.find(g => g.name === 'Lamp').path, 'Level');
});

test('diffUnity tree: a prefab instance hangs under its m_TransformParent, named after its prefab', () => {
  const guid = 'c'.repeat(32);
  const text = (extra) => HEAD + go(10, 'Spawn', 11, 0, [600]) + `--- !u!1001 &500
PrefabInstance:
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 11}
    m_Modifications:
    - target: {fileID: 7, guid: ${guid}, type: 3}
      propertyPath: m_IsActive
      value: 0
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}
--- !u!4 &600 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 8, guid: ${guid}, type: 3}
  m_PrefabInstance: {fileID: 500}
  m_PrefabAsset: {fileID: 0}
--- !u!1 &700 stripped
GameObject:
  m_CorrespondingSourceObject: {fileID: 7, guid: ${guid}, type: 3}
  m_PrefabInstance: {fileID: 500}
  m_PrefabAsset: {fileID: 0}
${extra}`;
  // A component added to the instance belongs to the instance's row, not to a stripped stub.
  const added = `--- !u!114 &800
MonoBehaviour:
  m_GameObject: {fileID: 700}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: ${'d'.repeat(32)}, type: 3}
`;
  const r = diffUnity(parseUnityYaml(text('')), parseUnityYaml(text(added)), { guidPaths: { [guid]: 'Assets/Prefabs/Enemy.prefab' } });
  const { by, shape } = treeOf(r);
  assert.deepStrictEqual(shape, [{ Spawn: ['Enemy'] }]);
  const inst = by.get('500');
  assert.strictEqual(inst.prefab, true);
  assert.strictEqual(inst.inactive, true);
  assert.strictEqual(inst.status, 'modified');
  assert.deepStrictEqual(r.groups.map(g => g.id), ['500']);
  assert.strictEqual(r.groups[0].path, 'Spawn');
});

test('diffUnity tree: a reparented object sits under its new parent and remembers the old one', () => {
  const before = HEAD + go(10, 'A', 11, 0, [21]) + go(20, 'Child', 21, 11) + go(30, 'B', 31, 0);
  const after = HEAD + go(10, 'A', 11, 0) + go(20, 'Child', 21, 31) + go(30, 'B', 31, 0, [21]);
  const r = diffUnity(parseUnityYaml(before), parseUnityYaml(after));
  const { by, shape } = treeOf(r);
  assert.deepStrictEqual(shape, ['A', { B: ['Child'] }]);
  assert.strictEqual(by.get('20').movedFrom, 'A');
  assert.strictEqual(by.get('20').status, 'modified');
});

test('diffUnity tree: a removed subtree stays in place; past maxTreeNodes only the changed path is kept', () => {
  const before = HEAD + go(10, 'Root', 11, 0, [21, 31]) + go(20, 'Keep', 21, 11) + go(30, 'Gone', 31, 11, [41]) + go(40, 'GoneChild', 41, 31);
  const after = HEAD + go(10, 'Root', 11, 0, [21]) + go(20, 'Keep', 21, 11) + go(50, 'Other', 51, 0);
  const r = diffUnity(parseUnityYaml(before), parseUnityYaml(after));
  const { by, shape } = treeOf(r);
  assert.deepStrictEqual(shape, [{ Root: ['Keep', { Gone: ['GoneChild'] }] }, 'Other']);
  assert.strictEqual(by.get('30').status, 'removed');
  assert.strictEqual(by.get('40').status, 'removed');

  const p = diffUnity(parseUnityYaml(before), parseUnityYaml(after), { maxTreeNodes: 3 });
  assert.strictEqual(p.tree.pruned, true);
  assert.strictEqual(p.tree.total, 5);
  assert.deepStrictEqual(treeOf(p).shape, [{ Root: [{ Gone: ['GoneChild'] }] }, 'Other']);
});

test('diffUnity tree: an asset without Transforms has no hierarchy', () => {
  const mat = (c) => HEAD + `--- !u!21 &2100000
Material:
  m_Name: Rock
  m_Color: ${c}
`;
  const r = diffUnity(parseUnityYaml(mat('red')), parseUnityYaml(mat('blue')));
  assert.strictEqual(r.tree, null);
  assert.strictEqual(r.groups.length, 1);
});

test('diffUnity: references in changed values are nameable — in-file ones by object, assets by guid', () => {
  const mat = 'e'.repeat(32), script = 'f'.repeat(32);
  const text = (target, material) => HEAD + go(10, 'Door', 11, 0) + go(20, 'Key', 21, 0) + `--- !u!114 &30
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_Script: {fileID: 11500000, guid: ${script}, type: 3}
  target: {fileID: ${target}}
  look: {fileID: 2100000, guid: ${material}, type: 2}
`;
  const r = diffUnity(parseUnityYaml(text(0, '0'.repeat(32))), parseUnityYaml(text(21, mat)));
  const comp = r.groups[0].components[0];
  // A GameObject's Transform is named after its owner; the unresolved script is flagged.
  assert.strictEqual(r.objectNames['21'], 'Key (Transform)');
  assert.strictEqual(comp.labelGuid, script);
  assert.strictEqual(comp.labelKind, 'MonoBehaviour');
  assert.deepStrictEqual(changedValueGuids(r).sort(), ['0'.repeat(32), mat].sort());

  const named = diffUnity(parseUnityYaml(text(0, mat)), parseUnityYaml(text(11, mat)), { guidPaths: { [script]: 'Assets/Door.cs' } });
  assert.strictEqual(named.objectNames['11'], 'Door (Transform)');
  assert.strictEqual(named.groups[0].components[0].type, 'Door');
  assert.strictEqual(named.groups[0].components[0].labelGuid, undefined);
});

test('quoted scalars are decoded: Unity escapes non-ASCII text', () => {
  const r = String.raw;
  assert.equal(decodeYamlScalar(r`"\u0391\u03B8\u03AE\u03BD\u03B1"`), 'Αθήνα');
  assert.equal(decodeYamlScalar(r`"\uD83D\uDE00 \U0001F600"`), '😀 😀');
  assert.equal(decodeYamlScalar(r`"say \"hi\"\n"`), 'say "hi"\n');
  assert.equal(decodeYamlScalar("'it''s'"), "it's");
  assert.equal(decodeYamlScalar('""'), '""');
  assert.equal(decodeYamlScalar('{fileID: 0}'), '{fileID: 0}');
  assert.equal(decodeYamlScalar('plain'), 'plain');
  // A long string wrapped onto continuation lines, one of them with an escaped line break.
  const props = flattenDocument([
    'MonoBehaviour:',
    r`  m_text: "\u0393\u03B5\u03B9\u03AC`,
    r`    \u03C3\u03BF\u03C5 \u03BA\u03CC` + '\\',
    r`    \u03C3\u03BC\u03B5"`,
    r`  m_Name: "\u0399\u03C0\u03C0\u03CC\u03C4\u03B7\u03C2"`,
  ]);
  assert.equal(props.get('MonoBehaviour.m_text'), 'Γειά σου κόσμε');
  assert.equal(props.get('MonoBehaviour.m_Name'), 'Ιππότης');
});
