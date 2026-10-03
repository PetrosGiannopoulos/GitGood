// Smart diffs: what to show for a file whose line diff says nothing useful.
//
// Three things in a Unity-shaped repository produce useless line diffs:
//   - LFS-tracked files, whose diff is the pointer text (version / oid / size);
//   - true binaries, whose diff is "Binary files a/x and b/x differ";
//   - Unity's own YAML assets (scenes, prefabs, materials…), whose diff is real text but
//     reads as thousands of lines of fileIDs reshuffled.
// This module is the pure half: deciding the kind from a path, reading an LFS pointer, and
// turning two versions of a Unity YAML asset into a list of objects that were added,
// removed or changed, property by property. main.js does the git and the file reads.
'use strict';

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

const EXT_KIND = {};
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif']) EXT_KIND[e] = 'image';
for (const e of ['wav', 'mp3', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']) EXT_KIND[e] = 'audio';
for (const e of ['mp4', 'webm', 'ogv', 'mov', 'm4v']) EXT_KIND[e] = 'video';
// Unity serialises these as YAML when Asset Serialization is "Force Text" (the default),
// every one a stream of `--- !u!<class> &<fileID>` documents.
for (const e of ['unity', 'prefab', 'asset', 'mat', 'anim', 'controller', 'overridecontroller', 'physicmaterial',
  'physicsmaterial2d', 'mask', 'flare', 'rendertexture', 'lighting', 'mixer', 'playable', 'signal', 'spriteatlas',
  'spriteatlasv2', 'terrainlayer', 'brush', 'guiskin', 'fontsettings', 'preset', 'shadervariants', 'cubemap',
  'giparams', 'lightingdata']) EXT_KIND[e] = 'unity';

// 'image' | 'audio' | 'video' | 'unity' | null (nothing special about the path).
function smartKind(filePath) {
  const base = String(filePath || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_KIND[base.slice(dot + 1).toLowerCase()] || null;
}

// { oid, size } from an LFS pointer's text, or null if the text is not a pointer.
function parseLfsPointer(text) {
  const s = String(text || '');
  if (!s.startsWith(LFS_POINTER_PREFIX) || s.length > 1024) return null;
  const oid = /^oid sha256:([0-9a-f]{64})\s*$/m.exec(s);
  const size = /^size (\d+)\s*$/m.exec(s);
  return oid ? { oid: oid[1], size: size ? Number(size[1]) : null } : null;
}

// ---------- Unity YAML ----------
// Unity's YAML is a narrow dialect: two-space maps, sequences written at their parent key's
// indent, flow maps on one line ({fileID: 123, guid: abc, type: 3}). Rather than a general
// YAML parser, each document is flattened into `path → scalar` pairs (`m_LocalPosition`,
// `m_Materials[0]`, `m_Modification.m_TransformParent`), which is exactly the granularity a
// reader wants to compare at.
const DOC_HEADER = /^--- !u!(\d+) &(-?\d+)( stripped)?/;

function flattenDocument(lines) {
  const props = new Map();
  const stack = [];        // { indent, key, item, count }
  let lastKey = null;
  const pathOf = () => stack.reduce((p, fr) => fr.item ? p + fr.key : (p ? p + '.' + fr.key : fr.key), '');

  const keyLine = (indent, text) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const colon = text.indexOf(': ');
    const key = colon >= 0 ? text.slice(0, colon) : (text.endsWith(':') ? text.slice(0, -1) : null);
    if (key === null) {
      // A bare scalar: the continuation of a value wrapped onto a new line.
      if (lastKey !== null) props.set(lastKey, props.get(lastKey) + ' ' + text);
      return;
    }
    const value = colon >= 0 ? text.slice(colon + 2) : '';
    if (value === '') { stack.push({ indent, key, item: false, count: 0 }); lastKey = null; return; }
    const p = pathOf();
    lastKey = p ? p + '.' + key : key;
    props.set(lastKey, value);
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (text === '-' || text.startsWith('- ')) {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.indent > indent || (top.indent === indent && top.item)) stack.pop(); else break;
      }
      const parent = stack[stack.length - 1];
      const idx = parent ? parent.count++ : 0;
      stack.push({ indent, key: `[${idx}]`, item: true, count: 0 });
      const rest = text.slice(1).trim();
      if (!rest) continue;
      // `- {x: 1, y: 2}` is one scalar (a flow map), not a key — it only looks like one.
      const flow = rest[0] === '{' || rest[0] === '[' || rest[0] === '"' || rest[0] === "'";
      if (!flow && (rest.indexOf(': ') >= 0 || rest.endsWith(':'))) keyLine(indent + 2, rest);
      else { lastKey = pathOf(); props.set(lastKey, rest); }
      continue;
    }
    keyLine(indent, text);
  }
  return props;
}

const fileIdOf = (v) => { const m = /fileID:\s*(-?\d+)/.exec(v || ''); return m && m[1] !== '0' ? m[1] : null; };
const guidOf = (v) => { const m = /guid:\s*([0-9a-f]{32})/.exec(v || ''); return m ? m[1] : null; };

// A prefab instance's overrides are a list, so its flattened keys are positional
// (m_Modifications[7].value) and adding one override renumbers everything after it. Re-key
// each override by what it targets, which is how anyone reads them anyway.
function rekeyOverrides(props) {
  const rows = new Map();
  for (const [k, v] of props) {
    const m = /^m_Modification\.m_Modifications\[(\d+)\]\.(target|propertyPath|value|objectReference)$/.exec(k);
    if (!m) continue;
    if (!rows.has(m[1])) rows.set(m[1], {});
    rows.get(m[1])[m[2]] = v;
    props.delete(k);
  }
  for (const r of rows.values()) {
    if (!r.propertyPath) continue;
    const target = fileIdOf(r.target);
    const ref = r.objectReference && fileIdOf(r.objectReference) ? r.objectReference : null;
    props.set(`override ${r.propertyPath}${target ? ' @' + target : ''}`, ref || (r.value != null ? r.value : ''));
  }
}

// Text → Map(fileID → { classId, type, stripped, props, name, gameObject, father, scriptGuid, prefabGuid }).
function parseUnityYaml(text) {
  const docs = new Map();
  const src = String(text || '').split('\n');
  let cur = null;
  const finish = () => {
    if (!cur) return;
    const props = flattenDocument(cur.lines);
    // The first line of a document is its class name ("GameObject:"), flattened as a key with
    // no value; every real property sits under it. Strip that level.
    const type = cur.lines.length ? cur.lines[0].replace(/\r$/, '').replace(/:\s*$/, '').trim() : 'Object';
    const own = new Map();
    for (const [k, v] of props) own.set(k.startsWith(type + '.') ? k.slice(type.length + 1) : k, v);
    if (type === 'PrefabInstance') rekeyOverrides(own);
    let name = own.get('m_Name') || null;
    if (!name && type === 'PrefabInstance') for (const [k, v] of own) if (/^override m_Name(\s|$)/.test(k)) { name = v; break; }
    docs.set(cur.id, {
      id: cur.id, classId: Number(cur.classId), type, stripped: cur.stripped, props: own, name,
      gameObject: fileIdOf(own.get('m_GameObject')),
      father: fileIdOf(own.get('m_Father')),
      prefabInstance: fileIdOf(own.get('m_PrefabInstance')),
      scriptGuid: guidOf(own.get('m_Script')),
      prefabGuid: guidOf(own.get('m_SourcePrefab')),
    });
    cur = null;
  };
  for (const raw of src) {
    const h = DOC_HEADER.exec(raw);
    if (h) { finish(); cur = { classId: h[1], id: h[2], stripped: !!h[3], lines: [] }; continue; }
    if (cur) cur.lines.push(raw);
  }
  finish();
  return docs;
}

// GUIDs a reader would want resolved to asset names: scripts behind MonoBehaviours, and the
// prefabs that prefab instances come from.
function referencedGuids(...sides) {
  const out = new Set();
  for (const docs of sides) if (docs) for (const d of docs.values()) {
    if (d.scriptGuid) out.add(d.scriptGuid);
    if (d.prefabGuid) out.add(d.prefabGuid);
  }
  return Array.from(out);
}

// Keys whose changes are bookkeeping rather than content: the component and child lists are
// positional and only restate what the added/removed objects already say.
const NOISE = /^(m_Component|m_Children)(\[|\.|$)|^serializedVersion$/;

const baseName = (p) => String(p || '').split('/').pop().replace(/\.[^.]+$/, '');

// Diff two parsed assets. `guidPaths` maps a GUID to its asset path, when known.
// Returns { groups, counts, truncated } — one group per GameObject (or per free-standing
// object, e.g. a material or an animation clip), each with the components that changed.
function diffUnity(before, after, { guidPaths = {}, maxGroups = 400, maxChanges = 80 } = {}) {
  before = before || new Map();
  after = after || new Map();

  const label = (d) => {
    if (d.type === 'MonoBehaviour' && d.scriptGuid) {
      const p = guidPaths[d.scriptGuid];
      return p ? baseName(p) : `MonoBehaviour (script ${d.scriptGuid.slice(0, 8)}…)`;
    }
    if (d.type === 'PrefabInstance') {
      const p = d.prefabGuid && guidPaths[d.prefabGuid];
      return p ? `Prefab instance of ${baseName(p)}` : 'Prefab instance';
    }
    return d.type;
  };

  // Which group a document belongs to: its GameObject, or the prefab instance it was
  // stripped from, or itself.
  const ownerOf = (d) => d.gameObject || (d.stripped && d.prefabInstance) || d.id;

  const lookup = (id) => after.get(id) || before.get(id) || null;
  const nameOf = (id) => {
    const d = lookup(id);
    if (!d) return null;
    if (d.name) return d.name;
    if (d.stripped && d.prefabInstance) { const p = lookup(d.prefabInstance); if (p && p.name) return p.name; }
    return null;
  };
  // Hierarchy path through the Transforms: find the GameObject's transform, climb m_Father.
  const transformOf = (docs, goId) => { for (const d of docs.values()) if (d.gameObject === goId && /Transform$/.test(d.type)) return d; return null; };
  const pathOf = (goId) => {
    const parts = [];
    for (const docs of [after, before]) {
      let t = transformOf(docs, goId), guard = 0;
      if (!t) continue;
      while (t && t.father && guard++ < 64) {
        const parent = docs.get(t.father);
        if (!parent) break;
        const owner = parent.gameObject || (parent.stripped && parent.prefabInstance);
        parts.unshift(nameOf(owner) || '?');
        t = parent;
      }
      break;
    }
    return parts.join('/');
  };

  const groups = new Map();
  const groupFor = (id) => {
    if (!groups.has(id)) groups.set(id, { id, name: null, path: '', status: 'modified', kind: null, components: [] });
    return groups.get(id);
  };

  const compareProps = (a, b) => {
    const changes = [];
    let total = 0;
    const keys = new Set([...a.keys(), ...b.keys()]);
    for (const k of keys) {
      if (NOISE.test(k)) continue;
      const va = a.has(k) ? a.get(k) : null, vb = b.has(k) ? b.get(k) : null;
      if (va === vb) continue;
      total++;
      if (changes.length < maxChanges) changes.push({ prop: k, before: va, after: vb });
    }
    return { changes, total };
  };

  const ids = new Set([...before.keys(), ...after.keys()]);
  const counts = { added: 0, removed: 0, modified: 0, objects: 0 };
  for (const id of ids) {
    const a = before.get(id), b = after.get(id);
    const d = b || a;
    let status, changes = [], total = 0;
    if (!a) status = 'added';
    else if (!b) status = 'removed';
    else {
      ({ changes, total } = compareProps(a.props, b.props));
      if (!total) continue;
      status = 'modified';
    }
    if (status !== 'modified') {
      // An added or removed object is described by what it holds, not by a diff.
      const { changes: c, total: t } = compareProps(status === 'added' ? new Map() : d.props, status === 'added' ? d.props : new Map());
      changes = c; total = t;
    }
    const owner = ownerOf(d);
    const g = groupFor(owner);
    if (id === owner) { g.status = status; g.kind = d.type; }
    g.components.push({ id, type: label(d), classId: d.classId, status, changes, totalChanges: total, self: id === owner });
  }

  const list = [];
  for (const g of groups.values()) {
    const ownerDoc = lookup(g.id);
    g.name = nameOf(g.id) || (ownerDoc ? label(ownerDoc) : `Object ${g.id}`);
    g.kind = g.kind || (ownerDoc ? ownerDoc.type : null);
    g.path = ownerDoc && (ownerDoc.type === 'GameObject' || ownerDoc.type === 'PrefabInstance' || ownerDoc.stripped) ? pathOf(g.id) : '';
    // The GameObject's own document first, then its components in a stable order.
    g.components.sort((x, y) => (y.self - x.self) || x.type.localeCompare(y.type));
    counts[g.status]++;
    counts.objects++;
    list.push(g);
  }
  const rank = { added: 0, removed: 1, modified: 2 };
  list.sort((x, y) => (rank[x.status] - rank[y.status]) || (x.path + '/' + x.name).localeCompare(y.path + '/' + y.name));
  return { groups: list.slice(0, maxGroups), counts, truncated: list.length > maxGroups };
}

module.exports = { LFS_POINTER_PREFIX, smartKind, parseLfsPointer, parseUnityYaml, flattenDocument, referencedGuids, diffUnity };
