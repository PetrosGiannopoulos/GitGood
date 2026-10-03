// Smart diffs for files whose line diff says nothing: LFS pointers, and Unity YAML assets
// turned into "which objects changed, and which properties". The Unity half is the part a
// regression would make quietly wrong — a misread indent puts a property on the wrong object.
const test = require('node:test');
const assert = require('node:assert');

const { smartKind, parseLfsPointer, parseUnityYaml, flattenDocument, referencedGuids, diffUnity } = require('../src/main/lib/smart-diff');

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
