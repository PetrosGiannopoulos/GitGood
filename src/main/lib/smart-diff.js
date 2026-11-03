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
      // A double-quoted line ending in `\` escapes its line break: joined with no space.
      if (lastKey !== null) {
        const prev = props.get(lastKey);
        props.set(lastKey, /^"/.test(prev) && /(^|[^\\])(\\\\)*\\$/.test(prev) ? prev.slice(0, -1) + text : prev + ' ' + text);
      }
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
  for (const [k, v] of props) props.set(k, decodeYamlScalar(v));
  return props;
}

// Unity writes any string holding non-ASCII text (Greek, CJK, emoji…) as a double-quoted
// YAML scalar of escapes: `m_Text: "Αθήνα"`. Decode quoted scalars
// so the smart view shows the text itself, as the rest of the app does. Plain scalars and
// flow maps are returned untouched; an empty string stays visible as "".
const YAML_ESCAPES = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f',
  r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
function decodeYamlScalar(v) {
  if (typeof v !== 'string' || v.length < 2) return v;
  if (v[0] === "'" && v[v.length - 1] === "'") {
    const s = v.slice(1, -1).replace(/''/g, "'");
    return s === '' ? "''" : s;
  }
  if (v[0] !== '"' || v[v.length - 1] !== '"') return v;
  const body = v.slice(1, -1);
  if (body === '') return '""';
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\' || i === body.length - 1) { out += c; continue; }
    const e = body[++i];
    const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
    if (width) {
      const hex = body.substr(i + 1, width);
      if (hex.length === width && /^[0-9a-fA-F]+$/.test(hex)) {
        const cp = parseInt(hex, 16);
        // A lone surrogate half (\uD83D then \uDE00) still pairs up once concatenated.
        out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
        i += width;
        continue;
      }
    }
    out += Object.prototype.hasOwnProperty.call(YAML_ESCAPES, e) ? YAML_ESCAPES[e] : '\\' + e;
  }
  return out;
}

const fileIdOf = (v) => { const m = /fileID:\s*(-?\d+)/.exec(v || ''); return m && m[1] !== '0' ? m[1] : null; };
const guidOf = (v) => { const m = /guid:\s*([0-9a-f]{32})/.exec(v || ''); return m ? m[1] : null; };
const LOCAL_REF = /^\{fileID: (-?\d+)\}$/;

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

// The hierarchy node a document belongs to: its GameObject, or — for anything stripped out
// of a prefab instance (its root Transform, a GameObject a component was added to) — the
// PrefabInstance, which is the one row Unity's Hierarchy draws for it.
function hierarchyNodeOf(docs, id) {
  const d = docs.get(id);
  if (!d) return null;
  const o = (d.gameObject && docs.get(d.gameObject)) || d;
  if (o.stripped && o.prefabInstance) return o.prefabInstance;
  return d.gameObject || d.id;
}

// One side's hierarchy: node → { parent, index }, plus each node's position among its
// siblings. Parents come from Transform.m_Father, or a PrefabInstance's m_TransformParent
// (its root Transform is stripped and carries no m_Father). Sibling order is the parent's
// m_Children; roots are ordered by SceneRoots (2022+), else m_RootOrder (older Unity, and a
// prefab instance's override of it), else file order.
function hierarchyOf(docs) {
  const nodes = new Map();
  const index = new Map();
  const listIndex = (props, re, map) => {
    for (const [k, v] of props) {
      const m = re.exec(k);
      if (!m) continue;
      const n = hierarchyNodeOf(docs, fileIdOf(v));
      if (n && !map.has(n)) map.set(n, Number(m[1]));
    }
  };
  for (const d of docs.values()) {
    if (/Transform$/.test(d.type) && !d.stripped && d.gameObject) {
      const id = hierarchyNodeOf(docs, d.id);
      nodes.set(id, { parent: d.father ? hierarchyNodeOf(docs, d.father) : null });
      listIndex(d.props, /^m_Children\[(\d+)\]$/, index);
      const ro = d.props.get('m_RootOrder');
      if (!d.father && ro != null && !index.has(id)) index.set(id, Number(ro));
    } else if (d.type === 'PrefabInstance') {
      const tp = fileIdOf(d.props.get('m_Modification.m_TransformParent'));
      nodes.set(d.id, { parent: tp ? hierarchyNodeOf(docs, tp) : null });
      for (const [k, v] of d.props) {
        if (/^override m_RootOrder(\s|$)/.test(k) && !tp && !index.has(d.id)) index.set(d.id, Number(v));
      }
    }
  }
  for (const d of docs.values()) if (d.type === 'SceneRoots') {
    const roots = new Map();
    listIndex(d.props, /^m_Roots\[(\d+)\]$/, roots);
    for (const [n, i] of roots) index.set(n, i);
  }
  return { nodes, index };
}

// Diff two parsed assets. `guidPaths` maps a GUID to its asset path, when known.
// Returns { groups, counts, truncated, tree } — one group per GameObject (or per
// free-standing object, e.g. a material or an animation clip), each with the components
// that changed — and, for a scene or prefab, the hierarchy both sides make together.
//
// `pending` (document ids) marks the hierarchy nodes those documents belong to: the merge
// preview's unresolved conflicts, which must stay visible even where nothing changed.
function diffUnity(before, after, { guidPaths = {}, maxGroups = 400, maxChanges = 80, maxTreeNodes = 20000, pending = [] } = {}) {
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

  // Which group a document belongs to: its hierarchy node (GameObject or prefab instance),
  // or itself.
  const ownerOf = (d) => hierarchyNodeOf(after.has(d.id) ? after : before, d.id) || d.id;

  const lookup = (id) => after.get(id) || before.get(id) || null;
  const nameOf = (id) => {
    const d = lookup(id);
    if (!d) return null;
    if (d.name) return d.name;
    if (d.stripped && d.prefabInstance) { const p = lookup(d.prefabInstance); if (p && p.name) return p.name; }
    // A prefab instance that never overrode its name shows the prefab's, as Unity does.
    if (d.type === 'PrefabInstance' && d.prefabGuid && guidPaths[d.prefabGuid]) return baseName(guidPaths[d.prefabGuid]);
    return null;
  };

  // Both sides' hierarchies, merged: a node takes its parent from the side it still exists
  // on (after, unless it was removed). One that changed parent remembers where it was.
  const ha = hierarchyOf(after), hb = hierarchyOf(before);
  const treeIds = new Set([...hb.nodes.keys(), ...ha.nodes.keys()]);
  const parentOf = (id) => {
    const n = ha.nodes.get(id) || hb.nodes.get(id);
    const p = n && n.parent;
    return p && p !== id && treeIds.has(p) ? p : null;
  };
  const pathOf = (id, parent = parentOf) => {
    const parts = [];
    let p = parent(id), guard = 0;
    while (p && guard++ < 256) { parts.unshift(nameOf(p) || '?'); p = parent(p); }
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
    const comp = { id, type: label(d), classId: d.classId, status, changes, totalChanges: total, self: id === owner };
    // A label still built from a bare GUID (a package script, say) is renamed by the
    // renderer once main has looked further.
    const labelGuid = d.type === 'MonoBehaviour' ? d.scriptGuid : (d.type === 'PrefabInstance' ? d.prefabGuid : null);
    if (labelGuid && !guidPaths[labelGuid]) { comp.labelGuid = labelGuid; comp.labelKind = d.type; }
    g.components.push(comp);
  }

  const list = [];
  for (const g of groups.values()) {
    const ownerDoc = lookup(g.id);
    g.name = nameOf(g.id) || (ownerDoc ? label(ownerDoc) : `Object ${g.id}`);
    g.kind = g.kind || (ownerDoc ? ownerDoc.type : null);
    g.path = treeIds.has(g.id) ? pathOf(g.id) : '';
    // The GameObject's own document first, then its components in a stable order.
    g.components.sort((x, y) => (y.self - x.self) || x.type.localeCompare(y.type));
    counts[g.status]++;
    counts.objects++;
    list.push(g);
  }
  const rank = { added: 0, removed: 1, modified: 2 };
  list.sort((x, y) => (rank[x.status] - rank[y.status]) || (x.path + '/' + x.name).localeCompare(y.path + '/' + y.name));
  const shown = list.slice(0, maxGroups);
  return { groups: shown, counts, truncated: list.length > maxGroups,
    tree: buildTree(), objectNames: objectNames(shown) };

  // Names for the in-file references ({fileID: N}) the shown changes mention: a GameObject by
  // its name, a component as "Owner (Type)", so the inspector never shows a bare fileID it
  // could have named. Asset references (with a guid) are main.js's job — see changedValueGuids.
  function objectNames(gs) {
    const out = {};
    for (const g of gs) for (const c of g.components) for (const ch of c.changes) {
      for (const v of [ch.before, ch.after]) {
        const m = LOCAL_REF.exec(v || '');
        if (!m || m[1] === '0' || m[1] in out) continue;
        const d = lookup(m[1]);
        if (!d) continue;
        const owner = ownerOf(d);
        const ownerName = nameOf(owner);
        out[m[1]] = owner !== d.id && ownerName ? `${ownerName} (${label(d)})` : (nameOf(d.id) || label(d));
      }
    }
    return out;
  }

  // The hierarchy as Unity's Hierarchy window would draw it, every node marked with its own
  // status (null = untouched). Statuses come from the full group list, not the truncated
  // one, so the tree never under-reports. A scene past `maxTreeNodes` keeps only the changed
  // nodes and their ancestors (`pruned`) — the renderer then cannot offer the whole scene.
  function buildTree() {
    if (!treeIds.size) return null;
    const status = new Map();
    for (const g of groups.values()) if (treeIds.has(g.id)) status.set(g.id, g.status);
    const pendingNodes = new Set();
    for (const id of pending) {
      const d = lookup(id);
      const n = d ? ownerOf(d) : null;
      if (n && treeIds.has(n)) pendingNodes.add(n);
    }
    let keep = treeIds;
    const pruned = treeIds.size > maxTreeNodes;
    if (pruned) {
      keep = new Set();
      for (const id of [...status.keys(), ...pendingNodes]) {
        let p = id, guard = 0;
        while (p && !keep.has(p) && guard++ < 256) { keep.add(p); p = parentOf(p); }
      }
    }
    // File order breaks ties (and orders nodes no list mentions); a removed node sorts by
    // its old position among the survivors.
    const seq = new Map();
    for (const id of [...ha.nodes.keys(), ...hb.nodes.keys()]) if (!seq.has(id)) seq.set(id, seq.size);
    const pos = (id) => {
      const i = ha.nodes.has(id) ? ha.index.get(id) : hb.index.get(id);
      return i == null ? Infinity : i;
    };
    const kids = new Map();
    const roots = [];
    for (const id of keep) {
      const p = parentOf(id);
      if (p && keep.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(id); } else roots.push(id);
    }
    const order = (a, b) => (pos(a) - pos(b)) || (seq.get(a) - seq.get(b));
    const nodes = [];
    for (const id of keep) {
      const d = lookup(id) || { type: 'GameObject', props: new Map() };
      const prefab = d.type === 'PrefabInstance';
      let active = d.props.get('m_IsActive');
      if (prefab) for (const [k, v] of d.props) if (/^override m_IsActive(\s|$)/.test(k)) { active = v; break; }
      const node = {
        id, name: nameOf(id) || (prefab ? label(d) : `Object ${id}`), prefab,
        status: status.get(id) || null, inactive: active === '0',
        children: (kids.get(id) || []).sort(order),
      };
      if (pendingNodes.has(id)) node.pending = true;
      const pb = hb.nodes.get(id), pa = ha.nodes.get(id);
      if (pb && pa && (pb.parent || null) !== (pa.parent || null)) {
        const from = pb.parent ? pathOf(pb.parent, (x) => { const n = hb.nodes.get(x); return n && n.parent; }) : '';
        node.movedFrom = pb.parent ? (from ? from + '/' : '') + (nameOf(pb.parent) || '?') : '(root)';
      }
      nodes.push(node);
    }
    // Unresolved documents with no place in the hierarchy (RenderSettings, an embedded
    // mesh): named, so the preview can say they are still open.
    const pendingOther = [];
    for (const id of new Set(pending)) {
      const d = lookup(id);
      if (d && !treeIds.has(ownerOf(d)) && pendingOther.length < 20) pendingOther.push(nameOf(ownerOf(d)) || label(d));
    }
    return { roots: roots.sort(order), nodes, total: treeIds.size, pruned, pendingOther: [...new Set(pendingOther)] };
  }
}

// The GUIDs named by the values of a diff's changes (a material slot, a sprite, an override's
// objectReference) — what main.js resolves to asset paths so the inspector can name them.
function changedValueGuids(result) {
  const out = new Set();
  for (const g of (result && result.groups) || []) for (const c of g.components) for (const ch of c.changes) {
    for (const v of [ch.before, ch.after]) { const guid = guidOf(v); if (guid) out.add(guid); }
  }
  return Array.from(out);
}

module.exports = { LFS_POINTER_PREFIX, smartKind, parseLfsPointer, parseUnityYaml, flattenDocument, decodeYamlScalar, referencedGuids, changedValueGuids, diffUnity };
