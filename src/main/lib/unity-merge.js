// Three-way merge of Unity YAML assets (scenes, prefabs, materials…), object by object.
//
// Git merges a scene as lines of text, and a scene is the file where two people most often
// change "different things" that are neighbours in the text: two new GameObjects are both
// appended at the end, two new children both land at the end of one m_Children list, a
// position and a scale sit on adjacent lines. Git calls every one of those a conflict
// (it treats touching hunks as overlapping), and an LFS-tracked scene always conflicts,
// because what git merges is the pointer, whose oid line both sides changed.
//
// This merges at the granularity Unity actually stores:
//   - documents (`--- !u!<class> &<fileID>`) are matched by fileID, so an object added,
//     removed or changed on one side only is simply taken from that side;
//   - an object changed on both sides is merged line by line *inside that document*, where
//     a line is one property — so only a property both sides changed is a conflict;
//   - both sides appending to the same list (m_Children, m_Component, SceneRoots, prefab
//     overrides) is a union, not a conflict, unless they add the same entry differently.
//
// Pure: text in, text out. main.js does the git and the LFS reads.
'use strict';

const DOC_HEADER = /^--- !u!(\d+) &(-?\d+)( stripped)?/;

// text → { preamble: [lines], docs: [{ id, lines }], eol, finalNewline } or null when the
// text is not Unity YAML or two documents share a fileID (no safe way to match them then).
function splitUnityDocs(text) {
  const s = String(text || '');
  if (!s) return { preamble: [], docs: [], eol: '\n', finalNewline: true, empty: true };
  const eol = s.includes('\r\n') ? '\r\n' : '\n';
  const lines = s.split(/\r?\n/);
  const finalNewline = lines[lines.length - 1] === '';
  if (finalNewline) lines.pop();
  const preamble = [];
  const docs = [];
  const seen = new Set();
  let cur = null;
  for (const line of lines) {
    const h = DOC_HEADER.exec(line);
    if (h) {
      if (seen.has(h[2])) return null;
      seen.add(h[2]);
      cur = { id: h[2], lines: [line] };
      docs.push(cur);
    } else if (cur) cur.lines.push(line);
    else preamble.push(line);
  }
  if (!docs.length && !/^%YAML/.test(preamble[0] || '')) return null;
  return { preamble, docs, eol, finalNewline };
}

// ---------- line diff (Myers) ----------

// Matched index pairs [i, j] with A[i] === B[j], in order, or null when the edit distance
// exceeds maxD (the caller then treats the whole differing middle as one change).
function myersMatches(A, B, maxD) {
  const n = A.length, m = B.length, max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  const limit = Math.min(max, maxD);
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    // Only the band this step could touch: k in [-d-1, d+1], stored at index k + d + 1.
    trace.push(v.slice(off - d - 1, off + d + 2));
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const matches = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const w = trace[d - 1];
    const get = (k) => w[k + d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && get(k - 1) < get(k + 1))) ? k + 1 : k - 1;
    const prevX = get(prevK), prevY = prevX - prevK;
    const sx = prevK === k + 1 ? prevX : prevX + 1;
    const sy = sx - k;
    while (x > sx && y > sy) { x--; y--; matches.push([x, y]); }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; matches.push([x, y]); }
  return matches.reverse();
}

// Changed regions between a and b: [{ aStart, aEnd, bStart, bEnd }], half-open.
function diffHunks(a, b, maxD = 2000) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  if (s === ea && s === eb) return [];
  const A = a.slice(s, ea), B = b.slice(s, eb);
  const pairs = myersMatches(A, B, maxD);
  if (!pairs) return [{ aStart: s, aEnd: ea, bStart: s, bEnd: eb }];
  const hunks = [];
  let i = 0, j = 0;
  pairs.push([A.length, B.length]);
  for (const [mi, mj] of pairs) {
    if (mi > i || mj > j) hunks.push({ aStart: s + i, aEnd: s + mi, bStart: s + j, bEnd: s + mj });
    i = mi + 1; j = mj + 1;
  }
  return hunks;
}

// ---------- three-way line merge ----------

const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);
const indentOf = (l) => l.length - l.trimStart().length;

// A list of whole YAML sequence items at one indent, or null. `- target: …` followed by its
// more-indented continuation lines is one item.
function sequenceItems(lines) {
  if (!lines.length || !/^\s*- /.test(lines[0]) && !/^\s*-$/.test(lines[0])) return null;
  const ind = indentOf(lines[0]);
  const items = [];
  for (const l of lines) {
    const li = indentOf(l);
    if (li === ind && /^\s*-( |$)/.test(l)) items.push([l]);
    else if (li > ind && items.length) items[items.length - 1].push(l);
    else return null;
  }
  return { indent: ind, items };
}

// What identifies an item for the purpose of "did both sides add the same thing": its first
// line, plus the propertyPath line for a prefab override (one target has many overrides).
const itemKey = (it) => it[0] + (it.length > 1 && /^\s*propertyPath:/.test(it[1]) ? '\n' + it[1] : '');

// Both sides inserted at the same point. If both insertions are list items at the same
// indent, keep both (ours first) — unless they add the same entry with different content,
// which is a real disagreement.
function unionInsert(o, t) {
  const so = sequenceItems(o), st = sequenceItems(t);
  if (!so || !st || so.indent !== st.indent) return null;
  const byKey = new Map(so.items.map(it => [itemKey(it), it]));
  const out = so.items.map(it => it.slice());
  for (const it of st.items) {
    const twin = byKey.get(itemKey(it));
    if (twin) { if (sameLines(twin, it)) continue; return null; }
    out.push(it);
  }
  return out.flat();
}

// Both sides replaced the same lines with a shared head and tail around list items — the
// shape of `m_Children: []` becoming a block list on each side when both added a first
// child. Union the items, but only when the base had no items there: otherwise one side
// removing an item and the other keeping it would read as "keep", losing the removal.
function unionReplace(b, o, t) {
  let p = 0;
  while (p < o.length && p < t.length && o[p] === t[p]) p++;
  let s = 0;
  while (s < o.length - p && s < t.length - p && o[o.length - 1 - s] === t[t.length - 1 - s]) s++;
  const mo = o.slice(p, o.length - s), mt = t.slice(p, t.length - s);
  if (!mo.length || !mt.length) return null;
  const so = sequenceItems(mo);
  if (!so || b.some(l => indentOf(l) === so.indent && /^\s*-( |$)/.test(l))) return null;
  const u = unionInsert(mo, mt);
  return u ? [...o.slice(0, p), ...u, ...o.slice(o.length - s)] : null;
}

// diff3 over lines. Returns { lines, conflicts: [{ ours, theirs, base, at }] } where `at`
// indexes the conflict's opening marker in `lines` (markers are written into the output).
//
// Unlike git, hunks that merely *touch* are not a conflict: in Unity YAML each line is its
// own property, so a change on line 5 and another on line 6 are independent edits. Two
// insertions at the same point, or overlapping changes, still are.
function merge3(base, ours, theirs, labels) {
  const all = [
    ...diffHunks(base, ours).map(h => Object.assign(h, { side: 'ours' })),
    ...diffHunks(base, theirs).map(h => Object.assign(h, { side: 'theirs' })),
  ].sort((p, q) => (p.aStart - q.aStart) || (p.aEnd - q.aEnd));

  // A property edit rewrites values in place: same line count, every line keeping its key.
  // Two of those touching are independent; anything structural touching anything else
  // (an insertion beside a list that the other side emptied, say) is judged together.
  const keyOf = (l) => { const m = /^(\s*[^\s:-][^:]*):( |$)/.exec(l); return m ? m[1] : null; };
  const propEdit = (h) => {
    const n = h.aEnd - h.aStart;
    if (!n || n !== h.bEnd - h.bStart) return false;
    const lines = h.side === 'ours' ? ours : theirs;
    for (let i = 0; i < n; i++) { const k = keyOf(base[h.aStart + i]); if (!k || k !== keyOf(lines[h.bStart + i])) return false; }
    return true;
  };
  const groups = [];
  for (const h of all) {
    const g = groups[groups.length - 1];
    const pe = propEdit(h);
    const joins = g && (h.aStart < g.end || (h.aStart === g.end && !(pe && g.propEdit)));
    if (joins) { g.hunks.push(h); g.end = Math.max(g.end, h.aEnd); g.propEdit = g.propEdit && pe; }
    else groups.push({ start: h.aStart, end: h.aEnd, hunks: [h], propEdit: pe });
  }

  const sideText = (g, side, lines) => {
    const res = [];
    let p = g.start;
    for (const h of g.hunks) {
      if (h.side !== side) continue;
      for (let i = p; i < h.aStart; i++) res.push(base[i]);
      for (let i = h.bStart; i < h.bEnd; i++) res.push(lines[i]);
      p = h.aEnd;
    }
    for (let i = p; i < g.end; i++) res.push(base[i]);
    return res;
  };

  const out = [];
  const conflicts = [];
  let pos = 0;
  const push = (arr) => { for (const l of arr) out.push(l); };
  for (const g of groups) {
    for (let i = pos; i < g.start; i++) out.push(base[i]);
    const hasO = g.hunks.some(h => h.side === 'ours'), hasT = g.hunks.some(h => h.side === 'theirs');
    if (!hasT) push(sideText(g, 'ours', ours));
    else if (!hasO) push(sideText(g, 'theirs', theirs));
    else {
      const o = sideText(g, 'ours', ours), t = sideText(g, 'theirs', theirs);
      const u = sameLines(o, t) ? o : (g.start === g.end ? unionInsert(o, t) : unionReplace(base.slice(g.start, g.end), o, t));
      if (u) push(u);
      else {
        conflicts.push({ ours: o, theirs: t, base: base.slice(g.start, g.end), at: out.length });
        out.push('<<<<<<< ' + labels.ours); push(o); out.push('======='); push(t); out.push('>>>>>>> ' + labels.theirs);
      }
    }
    pos = g.end;
  }
  for (let i = pos; i < base.length; i++) out.push(base[i]);
  return { lines: out, conflicts };
}

// ---------- describing a conflict ----------

const docType = (d) => (d && d.lines[1] ? d.lines[1].replace(/:\s*$/, '').trim() : 'Object');
function docField(d, re) {
  if (!d) return null;
  for (let i = 1; i < d.lines.length; i++) { const m = re.exec(d.lines[i]); if (m) return m[1]; }
  return null;
}

// "m_LocalPosition" for the line at idx, prefixed with its parents ("m_Modification.m_Modifications").
function propertyAt(lines, idx) {
  const keyOf = (l) => { const t = l.trim().replace(/^-\s*/, ''); if (/^[{["']/.test(t)) return null; const c = t.indexOf(':'); return c > 0 ? t.slice(0, c) : null; };
  let i = Math.max(0, Math.min(idx, lines.length - 1));
  while (i > 0 && (!lines[i] || !keyOf(lines[i]) || /^(<{7}|={7}|>{7})/.test(lines[i]))) i--;
  if (!lines[i]) return null;
  const parts = [];
  let ind = indentOf(lines[i]) + 1;
  for (let j = i; j >= 1; j--) {
    const l = lines[j];
    if (!l.trim() || /^(<{7}|={7}|>{7})/.test(l)) continue;
    const li = indentOf(l);
    if (li < ind) { const k = keyOf(l); if (k) parts.unshift(k); ind = li; }
    if (li <= 2) break;   // the document's own class line sits at indent 0
  }
  return parts.join('.') || null;
}

// ---------- the merge ----------

// mergeUnityYaml(base, ours, theirs) → {
//   ok: false, reason }                                         — not something this can merge
//   ok: true, clean, text, conflicts: [{ id, type, object, property, kind }], stats }
// `text` is always set: when not clean it holds conflict markers around the parts in
// dispute and everything else merged, so the hunk editor sees only real conflicts.
function mergeUnityYaml(baseText, oursText, theirsText, opts = {}) {
  const labels = { ours: opts.oursLabel || 'ours', theirs: opts.theirsLabel || 'theirs' };
  const B = splitUnityDocs(baseText), O = splitUnityDocs(oursText), T = splitUnityDocs(theirsText);
  if (!O || !T || !B) return { ok: false, reason: 'not-unity-yaml' };
  if (O.empty || T.empty) return { ok: false, reason: 'deleted' };

  const bMap = new Map(B.docs.map(d => [d.id, d]));
  const oMap = new Map(O.docs.map(d => [d.id, d]));
  const tMap = new Map(T.docs.map(d => [d.id, d]));
  const eq = (a, b) => sameLines(a.lines, b.lines);

  const stats = { fromOurs: 0, fromTheirs: 0, merged: 0, objects: 0 };
  const conflicts = [];
  const lookup = (id) => oMap.get(id) || tMap.get(id) || bMap.get(id) || null;
  const describe = (id, kind, property) => {
    const d = lookup(id);
    const type = docType(d);
    const goId = docField(d, /^\s{2}m_GameObject: \{fileID: (-?\d+)\}/);
    const go = goId && goId !== '0' ? lookup(goId) : null;
    const object = docField(go || d, /^\s{2}m_Name: (.*)$/) || null;
    conflicts.push({ id, type, object, property: property || null, kind });
  };
  const wholeConflict = (id, o, t, kind) => {
    describe(id, kind, null);
    return ['<<<<<<< ' + labels.ours, ...(o ? o.lines : []), '=======', ...(t ? t.lines : []), '>>>>>>> ' + labels.theirs];
  };

  // Resolve each document present anywhere. Result: id → lines (null = dropped).
  const resolved = new Map();
  for (const id of new Set([...bMap.keys(), ...oMap.keys(), ...tMap.keys()])) {
    const b = bMap.get(id), o = oMap.get(id), t = tMap.get(id);
    let lines = null;
    if (!b) {
      if (o && t) lines = eq(o, t) ? o.lines : wholeConflict(id, o, t, 'added-both');
      else if (o) { lines = o.lines; stats.fromOurs++; }
      else { lines = t.lines; stats.fromTheirs++; }
    } else if (!o && !t) lines = null;
    else if (!o) { if (eq(t, b)) lines = null; else lines = wholeConflict(id, null, t, 'deleted-ours'); if (!lines) stats.fromOurs++; }
    else if (!t) { if (eq(o, b)) lines = null; else lines = wholeConflict(id, o, null, 'deleted-theirs'); if (!lines) stats.fromTheirs++; }
    else if (eq(o, t)) lines = o.lines;
    else if (eq(o, b)) { lines = t.lines; stats.fromTheirs++; }
    else if (eq(t, b)) { lines = o.lines; stats.fromOurs++; }
    else {
      const m = merge3(b.lines, o.lines, t.lines, labels);
      lines = m.lines;
      stats.merged++;
      for (const c of m.conflicts) describe(id, 'property', propertyAt(m.lines, c.at + 1) || propertyAt(b.lines, 1));
    }
    resolved.set(id, lines);
  }

  // Order: ours' document order, with documents only theirs has placed after the document
  // that precedes them in theirs (Unity re-sorts on save; this just keeps neighbours close).
  // Anchors are always documents ours has, so a run of new documents stays in its order.
  const followers = new Map();   // anchor id ('' = start) → [id]
  let anchor = '';
  for (const d of T.docs) {
    if (oMap.has(d.id)) { anchor = d.id; continue; }
    if (!followers.has(anchor)) followers.set(anchor, []);
    followers.get(anchor).push(d.id);
  }
  const order = [...(followers.get('') || [])];
  for (const d of O.docs) { order.push(d.id); for (const f of followers.get(d.id) || []) order.push(f); }

  // Preamble: %YAML / %TAG lines; take whichever side changed it.
  const preamble = sameLines(O.preamble, B.preamble) ? T.preamble : O.preamble;
  const out = preamble.slice();
  for (const id of order) {
    const lines = resolved.get(id);
    if (lines) { for (const l of lines) out.push(l); stats.objects++; }
  }
  const text = out.join(O.eol) + (O.finalNewline ? O.eol : '');
  return { ok: true, clean: conflicts.length === 0, text, conflicts, stats };
}

module.exports = { splitUnityDocs, diffHunks, merge3, mergeUnityYaml, propertyAt };
