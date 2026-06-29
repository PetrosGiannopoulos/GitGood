// ============================================
// GRAPH LAYOUT ALGORITHM
// ============================================
// Standard "lane" commit-graph layout. Processes commits top-to-bottom (newest
// first). At every row we know which lanes are active and which commit each lane
// is currently "routing toward" (its next expected commit = the parent it follows).
//
// CRITICAL: edges only ever connect ONE row to the NEXT row. A vertical line that
// spans many rows is emitted as many short row→row+1 segments. A lane only bends
// (curves) at the single row boundary where it actually shifts columns. This is
// what keeps lines tracking their dots instead of swooping across the whole graph.
//
// Returns: { positions: Map<hash,{row,lane,colorIdx,branchLine}>, edges: [{fromLane,toLane,fromRow,toRow,colorLane,colorIdx,owner,type}], laneCount }
//
// branchLine (#lanelabel): Git stores no "which branch was this commit made on" — a branch is
// just a movable pointer, and that information is gone once the branch is deleted or
// fast-forward-merged. We approximate the *visual* branch line each commit sits on by tagging
// every lane with a name: the lane's tip ref when it's born at a branch head, or the source
// branch parsed out of a "Merge branch 'X'" message for a merged-in side line (the one place
// Git actually records a now-deleted feature branch's name).

// Pick the name that best identifies a branch LINE from a commit's refs: prefer a local branch,
// then a remote-tracking branch, then HEAD. Tags don't name a line, so they're skipped.
function pickLaneLabel(refs) {
  if (!refs || !refs.length) return null;
  const local = refs.find(r => r.type === 'local');
  if (local) return local.name;
  const remote = refs.find(r => r.type === 'remote');
  if (remote) return remote.name;
  const head = refs.find(r => r.type === 'head');
  if (head) return 'HEAD';
  return null;
}

// Extract the source branch name Git auto-records in a merge commit's message. This is the only
// trace of a feature branch's name that survives after the branch is deleted, so it's what lets
// a merged-in lane stay labelled. Returns null for messages we can't parse.
function parseMergeSource(msg) {
  if (!msg) return null;
  let m = msg.match(/^Merge branch '([^']+)'/);
  if (m) return m[1];
  m = msg.match(/^Merge remote-tracking branch '([^']+)'/);
  if (m) return m[1];
  m = msg.match(/^Merge pull request #\d+ from (\S+)/);
  if (m) { const i = m[1].indexOf('/'); return i >= 0 ? m[1].slice(i + 1) : m[1]; }
  return null;
}

function layoutGraph(commits) {
  const positions = new Map();
  const edges = [];

  // lanes[i] = hash that lane i is currently routing toward (the next commit it
  // expects to land on), or null if the lane is free.
  let lanes = [];
  let maxLaneCount = 0;

  // Per-lane color assignment (#10). Coloring by lane index alone makes lane N and lane
  // N+PALETTE share a color even when both are visible at once. Instead each lane is
  // GREEDILY given the lowest color index not currently used by another *active* lane, so
  // simultaneously-visible branches stay distinct as long as there are ≤ PALETTE of them.
  // A lane keeps its color for its whole lifetime (until freed), so a branch line is one
  // consistent color top-to-bottom. laneColorIdx[i] = color index, or -1 when lane i free.
  const PALETTE = LANE_COLORS.length;
  let laneColorIdx = [];

  // laneRef[i] = the branch-line name owning lane i (see branchLine note above), or null. It
  // travels with the lane for its whole lifetime — set when the lane is born (at a tip ref or a
  // merge's parsed source branch) and cleared when the lane is freed/reused.
  let laneRef = [];
  const assignColor = (laneIdx) => {
    const used = new Set();
    for (let i = 0; i < lanes.length; i++) {
      if (i !== laneIdx && lanes[i] !== null && laneColorIdx[i] >= 0) used.add(laneColorIdx[i]);
    }
    let ci = 0;
    while (ci < PALETTE && used.has(ci)) ci++;
    if (ci >= PALETTE) ci = laneIdx % PALETTE; // more concurrent lanes than colors — spread
    laneColorIdx[laneIdx] = ci;
    return ci;
  };

  const findLane = (hash) => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === hash) return i;
    return -1;
  };
  const allocLane = () => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
    lanes.push(null);
    laneColorIdx.push(-1);
    laneRef.push(null);
    return lanes.length - 1;
  };

  for (let row = 0; row < commits.length; row++) {
    const c = commits[row];
    const parents = c.parents || [];

    // 1. Which lane is this commit on? The lane that was routing toward it.
    let myLane = findLane(c.hash);
    if (myLane === -1) {
      // A brand-new branch tip (nothing routed to it yet) — give it a lane and a color.
      myLane = allocLane();
      lanes[myLane] = c.hash; // mark active so assignColor counts it among live lanes
      assignColor(myLane);
      // The lane is born here at a branch head, so name it after that tip's ref (if any).
      laneRef[myLane] = pickLaneLabel(c.refs);
    }
    const myColorIdx = laneColorIdx[myLane];
    positions.set(c.hash, { row, lane: myLane, colorIdx: myColorIdx, branchLine: laneRef[myLane] });

    // 2. Collect every lane currently routing toward THIS commit (besides myLane).
    //    Those lanes converge into myLane at this row (merge of branch lines).
    const convergingLanes = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== myLane && lanes[i] === c.hash) convergingLanes.push(i);
    }

    // 3. Snapshot the lane state BEFORE this commit reassigns anything. We need it
    //    to draw the segments from THIS row down to the NEXT row.
    //    First, update lane assignments for the row below:
    //    - myLane now routes toward the first parent (continues the line straight).
    //    - converging lanes are freed (they joined myLane here).
    //    - extra parents (merge) claim lanes routing toward them.

    // Free converging lanes (they merged into myLane at this row) and release their colors.
    for (const i of convergingLanes) { lanes[i] = null; laneColorIdx[i] = -1; laneRef[i] = null; }

    // Assign myLane to follow the first parent
    if (parents.length > 0) {
      lanes[myLane] = parents[0];
    } else {
      lanes[myLane] = null; // root commit; lane ends
      laneColorIdx[myLane] = -1;
      laneRef[myLane] = null;
    }

    // Extra parents (merge commits): route each toward its parent in some lane.
    const mergeParentLanes = [];
    // The merge message names the branch that was merged in (e.g. "Merge branch 'feature'");
    // it labels the first merged-in side line even after that branch is deleted.
    const mergeSource = parseMergeSource(c.message);
    for (let p = 1; p < parents.length; p++) {
      const par = parents[p];
      let pl = findLane(par);
      if (pl === -1) {
        pl = allocLane();
        lanes[pl] = par;
        assignColor(pl); // new side-branch lane → its own distinct color
        // Name the freshly-born side lane after the merge's source branch (first extra parent
        // only — multi-parent octopus messages don't reliably map names to parents).
        if (p === 1 && mergeSource) laneRef[pl] = mergeSource;
      }
      mergeParentLanes.push({ parent: par, lane: pl });
    }

    // 4. Emit edges from THIS row (row) to the NEXT row (row+1) for every lane that
    //    is active after the reassignment. Each active lane draws a segment from its
    //    position at `row` to its position at `row+1`.
    //
    //    But a lane's column at `row` may differ from its column at `row+1` only when:
    //      (a) it's myLane and it just took over (came from myLane, continues at myLane) — vertical
    //      (b) it's a converging lane — handled below as a join segment into myLane
    //      (c) it's a merge-parent lane that was newly allocated at a different column
    //
    //    The simplest correct model: for each lane active in the NEXT row, draw a
    //    segment from where that lane's line was at THIS row to where it is at row+1.
    //    A lane that existed before at column X and still exists at column X → vertical.

    // Converging lanes are freed here; their visual descent into myLane is already
    // drawn by the first-parent carry segments emitted in pass 2 (the final segment
    // of each converging branch bends into myLane's column). No separate join edge
    // is needed, which avoids double-drawing.

    // For myLane continuing to first parent: the parent may be in a different column
    // than myLane (it usually isn't until the parent is actually placed). We DON'T know
    // the parent's final column yet, so we emit a per-row vertical "carry" below in pass 2.

    // Merge-parent connections (second+ parents) are drawn entirely in Pass 2c, where
    // every commit's final row/lane is known — so we can route the line in the correct
    // direction (the parent may be above OR below this merge commit). We only needed
    // the lane bookkeeping above (mergeParentLanes) to reserve lanes for the layout.
    void mergeParentLanes;

    if (lanes.length > maxLaneCount) maxLaneCount = lanes.length;
  }

  // ----- Pass 2: carry segments -----
  // For every commit, its first-parent line descends from this commit's row to the
  // parent's row, occupying myLane's column the whole way (until the parent, which may
  // shift columns at the very last row). A long straight run is emitted as ONE multi-row
  // segment (#2) — only the final boundary, where the line may bend into the parent's
  // column, is a separate one-row segment. This keeps the SVG node count proportional to
  // the number of branch turns rather than the number of rows.
  for (let row = 0; row < commits.length; row++) {
    const c = commits[row];
    const pos = positions.get(c.hash);
    if (!pos) continue;
    const parents = c.parents || [];
    if (!parents.length) continue;

    const firstParent = parents[0];
    const fpPos = positions.get(firstParent);
    if (!fpPos) {
      // First parent is outside the loaded window. Draw the line continuing straight down
      // to the bottom edge so it reads as "history continues below". One solid run to the
      // last row, then a dashed "continue-down" stub that fades off past the bottom.
      const lastRow = commits.length - 1;
      if (lastRow > row) {
        edges.push({ fromLane: pos.lane, toLane: pos.lane, fromRow: row, toRow: lastRow, colorLane: pos.lane, colorIdx: pos.colorIdx, owner: c.hash, type: 'carry' });
      }
      edges.push({ fromLane: pos.lane, toLane: pos.lane, fromRow: lastRow, toRow: lastRow + 1, colorLane: pos.lane, colorIdx: pos.colorIdx, owner: c.hash, type: 'continue-down' });
      continue;
    }

    // Straight run from this row to just above the parent, then a final segment that bends
    // into the parent's column (a no-op vertical when the lane doesn't change).
    const bendRow = fpPos.row - 1;
    if (bendRow > row) {
      edges.push({ fromLane: pos.lane, toLane: pos.lane, fromRow: row, toRow: bendRow, colorLane: pos.lane, colorIdx: pos.colorIdx, owner: c.hash, type: 'carry' });
    }
    edges.push({ fromLane: pos.lane, toLane: fpPos.lane, fromRow: bendRow, toRow: fpPos.row, colorLane: pos.lane, colorIdx: pos.colorIdx, owner: c.hash, type: 'carry' });
  }

  // ----- Pass 2c: draw merge-parent (side branch) connections -----
  // For each merge commit, connect its dot to every extra parent (2nd, 3rd, ...).
  // The parent may sit BELOW (normal: branch merged in from history below) or ABOVE
  // (the merged-in branch tip is newer / drawn above the merge). We route per-row
  // segments in the correct direction so the side line is never cut off.
  for (let row = 0; row < commits.length; row++) {
    const c = commits[row];
    const pos = positions.get(c.hash);
    if (!pos) continue;
    const parents = c.parents || [];
    if (parents.length < 2) continue;

    for (let p = 1; p < parents.length; p++) {
      const par = parents[p];
      const pp = positions.get(par);
      if (!pp) {
        // Parent outside window — short stub down off this commit.
        edges.push({ fromLane: pos.lane, toLane: pos.lane, fromRow: row, toRow: row + 1, colorLane: pos.lane, colorIdx: pos.colorIdx, owner: c.hash, type: 'merge-out' });
        continue;
      }
      if (pp.row > pos.row) {
        // Parent is BELOW: bend out from the merge dot to the parent's lane, then run
        // straight down to the parent row as a single coalesced segment (#2).
        edges.push({ fromLane: pos.lane, toLane: pp.lane, fromRow: row, toRow: row + 1, colorLane: pp.lane, colorIdx: pp.colorIdx, owner: c.hash, type: 'merge-out' });
        if (pp.row > row + 1) {
          edges.push({ fromLane: pp.lane, toLane: pp.lane, fromRow: row + 1, toRow: pp.row, colorLane: pp.lane, colorIdx: pp.colorIdx, owner: c.hash, type: 'carry' });
        }
      } else if (pp.row < pos.row) {
        // Parent is ABOVE: run straight down the parent's lane from the parent row to just
        // above the merge, then a final segment bending into the merge dot's lane (#2).
        const bendRow = row - 1;
        if (bendRow > pp.row) {
          edges.push({ fromLane: pp.lane, toLane: pp.lane, fromRow: pp.row, toRow: bendRow, colorLane: pp.lane, colorIdx: pp.colorIdx, owner: c.hash, type: 'carry' });
        }
        edges.push({ fromLane: pp.lane, toLane: pos.lane, fromRow: bendRow, toRow: row, colorLane: pp.lane, colorIdx: pp.colorIdx, owner: c.hash, type: 'carry' });
      }
    }
  }

  return { positions, edges, laneCount: Math.max(1, maxLaneCount) };
}

// ============================================
// GRAPH RENDERING
// ============================================
const GRAPH_ROW_H = 30;     // pixels per row
const GRAPH_LANE_W = 18;    // pixels per lane
const GRAPH_LANE_X0 = 14;   // left padding
// Lane colors for the graph. Rebuilt from the active theme's palette so the graph
// never clashes with a theme (e.g. red dots on a green theme). Defaults to the
// Crusader palette; refreshThemeLaneColors() overrides per theme.
let LANE_COLORS = [
  '#d4302f', '#c8a04a', '#6b8e23', '#6db8c4',
  '#b388d3', '#e2a5a5', '#c1d9a0', '#efe6d4'
];
const laneColor = (lane) => LANE_COLORS[lane % LANE_COLORS.length];

// Resolve any CSS color expression (incl. color-mix / var) to a concrete rgb() string,
// since SVG presentation attributes (fill/stroke) don't accept color-mix().
let _colorResolverEl = null;
function resolveColor(expr) {
  try {
    if (!_colorResolverEl) {
      _colorResolverEl = document.createElement('span');
      _colorResolverEl.style.display = 'none';
      document.body.appendChild(_colorResolverEl);
    }
    _colorResolverEl.style.color = '';
    _colorResolverEl.style.color = expr;
    const c = getComputedStyle(_colorResolverEl).color;
    return c || expr;
  } catch (e) { return expr; }
}

// Build a harmonious 8-lane palette around the theme's accent. Reads the resolved
// CSS variables so it works for every theme including the custom ones.
function refreshThemeLaneColors() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => {
      const x = (cs.getPropertyValue(name) || '').trim();
      return x || fb;
    };
    const html = document.documentElement;
    const themed = /theme-/.test(html.className);
    if (!themed) {
      LANE_COLORS = ['#d4302f', '#c8a04a', '#6b8e23', '#6db8c4', '#b388d3', '#e2a5a5', '#c1d9a0', '#efe6d4'];
      return;
    }
    const accentBright = v('--accent-bright', '#d4302f');
    const accent = v('--accent', '#b22222');
    const gold = v('--gold-accent', '#c8a04a');
    const added = v('--added', '#3fa34d');
    const text = v('--text', '#efe6d4');
    const dim = v('--text-dim', '#c1b89a');
    LANE_COLORS = [
      accentBright,
      gold,
      added,
      resolveColor(`color-mix(in srgb, ${accentBright} 55%, ${text})`),
      resolveColor(`color-mix(in srgb, ${accent} 65%, white)`),
      dim,
      resolveColor(`color-mix(in srgb, ${gold} 55%, ${text})`),
      text
    ].map(resolveColor);
  } catch (e) { /* keep current palette */ }
}

// ----- Branches column width (#readability) -----
// Refs (branches/tags/HEAD) render in their own column to the left of the commit message
// (GitKraken style). The column auto-grows to fit the busiest commit, so its width must be
// computed ONCE per layout (not per virtualized window) or it would jitter while scrolling.
// We estimate each commit's ref-block width cheaply via canvas measureText (no DOM/reflow):
// the pill text width plus a fixed per-pill chrome constant (padding + border + leading
// icon glyph), summed with the inter-pill gap. The result is clamped so a commit with many
// long branch names can't swallow the whole pane.
let _refMeasureCtx = null;
const REF_PILL_CHROME = 32;  // px: padding (14) + border (2) + icon glyph + gap (~16)
const REF_PILL_GAP = 5;      // px between pills
const REF_CELL_PAD = 14;     // px: cell padding + divider breathing room
function _refMeasureContext() {
  if (!_refMeasureCtx) {
    const cs = getComputedStyle(document.documentElement);
    const mono = (cs.getPropertyValue('--font-mono') || 'monospace').trim() || 'monospace';
    _refMeasureCtx = document.createElement('canvas').getContext('2d');
    _refMeasureCtx.font = `600 10px ${mono}`;
  }
  return _refMeasureCtx;
}
function measureRefBlockWidth(commit) {
  const refs = commit && commit.refs;
  if (!refs || !refs.length) return 0;
  const ctx = _refMeasureContext();
  let w = REF_CELL_PAD;
  for (let i = 0; i < refs.length; i++) {
    const label = refs[i].type === 'head' ? 'HEAD' : (refs[i].name || '');
    w += Math.ceil(ctx.measureText(label).width) + REF_PILL_CHROME;
    if (i > 0) w += REF_PILL_GAP;
  }
  return w;
}
// The widest ref block across ALL commits, clamped to a sane ceiling. 0 when no commit
// carries a ref (so the column collapses entirely on ref-less history).
function computeRefColWidth(commits, paneWidth) {
  let max = 0;
  for (const c of commits) {
    const w = measureRefBlockWidth(c);
    if (w > max) max = w;
  }
  if (max <= 0) return 0;
  const ceiling = Math.max(120, Math.min(360, Math.round((paneWidth || 800) * 0.4)));
  return Math.min(max, ceiling);
}

// Build a case-insensitive regex that matches any of the search terms, for highlighting
// filter matches (#5). Terms are escaped for HTML (so they match the escaped haystack) and
// for regex meta-chars. Returns null when there's nothing to highlight.
function buildHighlightRegex(terms) {
  if (!terms || !terms.length) return null;
  const parts = terms
    .map(t => escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean);
  if (!parts.length) return null;
  return new RegExp('(' + parts.join('|') + ')', 'gi');
}

// HTML-escape `text` and wrap matches of `re` (from buildHighlightRegex) in <mark>. The
// result is escaped HTML, safe to inject. `re` may be null (no active highlight).
function highlightSearchTerms(text, re) {
  const escaped = escapeHtml(text);
  if (!re) return escaped;
  return escaped.replace(re, '<mark class="graph-match">$1</mark>');
}

function renderGraph() {
  const container = $('#graph-container');
  if (!container) return;
  const { commits, head, positions, edges, laneCount, hiddenCount, collapsedSet } = state.graph;

  if (!commits || !commits.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚔</div>
        <p>${state.graphLoading ? 'Summoning chronicle…' : 'No chronicles to display.'}</p>
      </div>
    `;
    renderGraphDetail(null);
    return;
  }

  // Build a hash → commit lookup once so click handlers don't do O(n) lookups
  const commitByHash = new Map();
  for (const c of commits) commitByHash.set(c.hash, c);

  // Width of the branches column (#readability). Computed once here so it's stable across
  // the virtualized scroll; buildRow gives every row this exact width so the message text
  // starts at the same x on every line, forming an aligned GitKraken-style ref column.
  const refColWidth = computeRefColWidth(commits, container.clientWidth);

  // Search-match highlighting (#5): when a text filter is active, mark the matched terms
  // in the message/author. Only the 'message'/'all' modes match visible text — for the
  // 'files'/'content' modes the match lives in data we don't show, so there's nothing to
  // mark inline.
  const _gq = (state.graphFilter || '').trim();
  const _gMode = state.graphFilterMode || 'message';
  const highlightRe = (_gq && (_gMode === 'message' || _gMode === 'all'))
    ? buildHighlightRegex(_gq.split(/\s+/).filter(Boolean))
    : null;

  const totalHeight = commits.length * GRAPH_ROW_H;
  const svgWidth = GRAPH_LANE_X0 + laneCount * GRAPH_LANE_W + 8;

  // Precompute each edge's vertical row span so the window filter (below) is a cheap
  // numeric compare. 'continue-down' fades off the bottom edge, so treat its span as
  // reaching the last row.
  const edgeLo = new Array(edges.length);
  const edgeHi = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    edgeLo[i] = Math.min(e.fromRow, e.toRow);
    edgeHi[i] = e.type === 'continue-down' ? commits.length : Math.max(e.fromRow, e.toRow);
  }

  // `relatedSet` (declared here, set by applyAncestryHighlight) is the lineage of the
  // selected commit; the builders below add a `rel` class to elements in it (#3).
  let relatedSet = null;

  // SVG virtualization (#OOM): the <svg> is only ever as tall as the viewport (not the full
  // history), so it never becomes a giant composited layer that exhausts GPU memory. Geometry
  // is still authored in absolute document coordinates; instead of moving every node, we PAN
  // the svg's viewBox to the current scroll offset (one cheap attribute write per frame in
  // renderWindow). The outer <svg> clips anything outside its viewBox, so off-screen buffer
  // geometry and long carry lines that overshoot the viewport cost nothing extra. Only the
  // windowed subset of dots/edges exists in the DOM, rebuilt when the row window changes.

  // Build the SVG string for one edge. A straight run is a single <line> spanning all its
  // rows (#2); a column change is a short cubic.
  const buildEdge = (e) => {
    const x1 = GRAPH_LANE_X0 + e.fromLane * GRAPH_LANE_W;
    const x2 = GRAPH_LANE_X0 + e.toLane * GRAPH_LANE_W;
    const colorKey = e.colorIdx != null ? e.colorIdx : (e.colorLane != null ? e.colorLane : e.fromLane);
    const color = laneColor(colorKey);
    const owner = e.owner ? ` data-owner="${e.owner}"` : '';
    const relCls = (relatedSet && e.owner && relatedSet.has(e.owner)) ? ' rel' : '';
    if (e.type === 'continue-down') {
      const yStart = e.fromRow * GRAPH_ROW_H + GRAPH_ROW_H / 2;
      return `<line class="graph-edge${relCls}"${owner} x1="${x1}" y1="${yStart}" x2="${x1}" y2="${totalHeight}" stroke="${color}" stroke-width="2" stroke-dasharray="3 3" opacity="0.55"/>`;
    }
    const y1 = e.fromRow * GRAPH_ROW_H + GRAPH_ROW_H / 2;
    const y2 = e.toRow * GRAPH_ROW_H + GRAPH_ROW_H / 2;
    if (x1 === x2) {
      return `<line class="graph-edge${relCls}"${owner} x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2"/>`;
    }
    const midY = y1 + (y2 - y1) / 2;
    return `<path class="graph-edge${relCls}"${owner} d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}" stroke="${color}" stroke-width="2" fill="none"/>`;
  };

  // Is `c` collapsible? (ANY parent present and sitting below it — there's a chain to fold.)
  const isCollapsibleCommit = (c, pos) => {
    if (collapsedSet && collapsedSet.has(c.hash)) return true;
    for (const ph of (c.parents || [])) {
      const pp = positions.get(ph);
      if (pp && pp.row > pos.row) return true;
    }
    return false;
  };

  // Build the SVG circle for one commit's dot.
  const buildDot = (c, pos) => {
    const cx = GRAPH_LANE_X0 + pos.lane * GRAPH_LANE_W;
    const cy = pos.row * GRAPH_ROW_H + GRAPH_ROW_H / 2;
    const color = laneColor(pos.colorIdx != null ? pos.colorIdx : pos.lane);
    const isMerge = (c.parents || []).length > 1;
    const isHead = c.hash === head;
    const isCollapsed = collapsedSet && collapsedSet.has(c.hash);
    const collapsible = isCollapsibleCommit(c, pos);
    const relCls = (relatedSet && relatedSet.has(c.hash)) ? ' rel' : '';
    const cls = 'commit-dot'
      + (isMerge ? ' merge' : '')
      + (isHead ? ' head' : '')
      + (isCollapsed ? ' collapsed' : '')
      + relCls;
    const r = isMerge ? 6 : 5;
    let dot = `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="${isHead ? '#efe6d4' : '#0a0606'}" stroke-width="${isHead ? 2 : 1.5}" data-hash="${c.hash}" data-foldable="${collapsible ? '1' : ''}">`;
    // Hover tooltip (#lanelabel): name the branch line this dot sits on, falling back to a note
    // when the line's branch is gone (deleted / outside the loaded window). Append the fold hint
    // if the dot is also collapsible, so the dot keeps a single native <title>.
    const lineLabel = pos.branchLine
      ? `Branch line: ${pos.branchLine}`
      : 'Branch line: unknown (branch deleted or outside view)';
    const foldHint = collapsible
      ? (isCollapsed ? ' — right-click to expand this branch line' : ' — right-click to collapse this branch line')
      : '';
    dot += `<title style="pointer-events:none">${escapeHtml(lineLabel + foldHint)}</title>`;
    return dot + `</circle>`;
  };

  // Build the branch-column cell for one commit. Refs live in their OWN virtualized column
  // to the LEFT of the lane graph (GitKraken style), so this is rendered separately from the
  // row. Only commits that actually carry a ref get a cell; the fixed column width keeps the
  // lane graph aligned regardless. Pills are right-aligned so their labels point at the lanes.
  const buildRefCell = (c, pos) => {
    const refs = c.refs;
    if (!refs || !refs.length) return '';
    let refPills = '';
    for (const r of refs) {
      if (r.type === 'tag') refPills += `<span class="ref-pill tag" data-ref-type="tag" data-ref-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>`;
      else if (r.type === 'local') {
        const headCls = r.isHead ? ' head' : '';
        refPills += `<span class="ref-pill local${headCls}" draggable="true" data-ref-type="local" data-ref-name="${escapeHtml(r.name)}" data-ref-hash="${escapeHtml(c.hash)}">${escapeHtml(r.name)}</span>`;
      } else if (r.type === 'remote') refPills += `<span class="ref-pill remote" data-ref-type="remote" data-ref-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>`;
      else if (r.type === 'head') refPills += `<span class="ref-pill head-only" data-ref-type="head">HEAD</span>`;
      else refPills += `<span class="ref-pill" data-ref-type="other">${escapeHtml(r.name)}</span>`;
    }
    // title lists the refs in full for when a crowded commit's pills overflow the clamped width.
    const refTitle = escapeHtml(refs.map(r => r.type === 'head' ? 'HEAD' : r.name).join('  '));
    const relCls = (relatedSet && relatedSet.has(c.hash)) ? ' rel' : '';
    // Pills go in an inner track so a crowded cell (more/longer branches than the clamped
    // column can show) can ping-pong its overflow into view on hover (see startRefMarquee).
    return `<div class="graph-ref-cell${relCls}" data-hash="${c.hash}" title="${refTitle}" style="top:${pos.row * GRAPH_ROW_H}px;height:${GRAPH_ROW_H}px"><div class="graph-ref-track">${refPills}</div></div>`;
  };

  // Build the row HTML for one commit. Rows are absolutely positioned at their row offset
  // so only the visible ones need to exist in the DOM (#1).
  const buildRow = (c, pos) => {
    const isHead = c.hash === head;
    const isCollapsed = collapsedSet && collapsedSet.has(c.hash);
    const collapsible = isCollapsibleCommit(c, pos);

    const shortHash = (c.hash || '').slice(0, 7);
    const dateStr = c.date ? relativeTime(c.date) : '';
    // Absolute timestamp shown on hover over the relative date (#6).
    const dateTitle = c.date ? new Date(c.date).toLocaleString() : '';
    const selectedCls = state.selectedGraphHash === c.hash ? ' selected' : '';
    const headCls = isHead ? ' head' : '';
    const relCls = (relatedSet && relatedSet.has(c.hash)) ? ' rel' : '';
    // The fold toggle is hidden by default and revealed on row hover/selection (CSS); the
    // spacer keeps the message indent stable for non-foldable rows.
    const foldToggle = collapsible
      ? `<button class="graph-fold-btn${isCollapsed ? ' collapsed' : ''}" data-fold="${c.hash}" title="${isCollapsed ? 'Expand branch line' : 'Collapse branch line'}" tabindex="-1">${isCollapsed ? '▸' : '▾'}</button>`
      : `<span class="graph-fold-spacer"></span>`;
    const msgHtml = highlightSearchTerms(c.message || '', highlightRe);
    const authorHtml = highlightSearchTerms(c.author_name || '', highlightRe);
    // Message hover tooltip also names the branch line (#lanelabel) so the wide row is a hover
    // target for it too, not just the small dot.
    const lineNote = pos.branchLine
      ? `\n\nBranch line: ${pos.branchLine}`
      : '\n\nBranch line: unknown (branch deleted or outside view)';
    return `<div class="graph-row${selectedCls}${headCls}${relCls}" data-hash="${c.hash}" style="top:${pos.row * GRAPH_ROW_H}px;height:${GRAPH_ROW_H}px">` +
        foldToggle +
        `<span class="graph-row-msg" title="${escapeHtml((c.message || '') + lineNote)}">${msgHtml}</span>` +
        `<span class="graph-row-author">${authorHtml}</span>` +
        `<span class="graph-row-date" title="${escapeHtml(dateTitle)}">${escapeHtml(dateStr)}</span>` +
        `<span class="graph-row-hash">${escapeHtml(shortHash)}</span>` +
      `</div>`;
  };

  // When collapsed, append a clickable summary row showing how many commits are hidden.
  const hiddenRowHtml = (hiddenCount && hiddenCount > 0)
    ? `<div class="graph-hidden-row" id="graph-hidden-row" title="Click to expand and show all commits">` +
        `<span class="graph-hidden-dots">⋯</span>` +
        `<span class="graph-hidden-label">${hiddenCount.toLocaleString()} earlier commit${hiddenCount === 1 ? '' : 's'} hidden — click to expand</span>` +
      `</div>`
    : '';

  // Skeleton. Column layout (left → right):
  //   [branches] (gap) [lane graph SVG] [message rows]
  // The branches column and message rows are virtualized lists of absolutely-positioned cells
  // (full-height spacers reserve the scroll range). The lane graph is a viewport-height SVG,
  // sticky so it stays pinned in view while the column scrolls — see the SVG virtualization
  // note above; its height/viewBox are (re)set per window in renderWindow(). When no commit
  // carries a ref the branches column (and its gap) are dropped entirely.
  const GRAPH_REF_GAP = 8; // px gap between the branches column and the lane graph
  const refsColHtml = refColWidth > 0
    ? `<div class="graph-refs-col" style="height:${totalHeight}px;width:${refColWidth}px"></div>` +
      `<div class="graph-col-gap"></div>`
    : '';
  const gridCols = refColWidth > 0
    ? `${refColWidth}px ${GRAPH_REF_GAP}px ${svgWidth}px 1fr`
    : `${svgWidth}px 1fr`;
  container.innerHTML =
    `<div class="graph-svg-wrap${refColWidth > 0 ? ' has-refs' : ''}" style="grid-template-columns: ${gridCols}">` +
      refsColHtml +
      `<div class="graph-svg-col" style="height:${totalHeight}px;width:${svgWidth}px">` +
        `<svg class="graph-svg" width="${svgWidth}" height="0" viewBox="0 0 ${svgWidth} 0" preserveAspectRatio="xMinYMin slice">` +
          `<g class="graph-edges"></g>` +
          `<g class="graph-dots"></g>` +
        `</svg>` +
      `</div>` +
      `<div class="graph-rows" style="height:${totalHeight}px"></div>` +
    `</div>` +
    hiddenRowHtml;
  container.classList.remove('graph-highlight-active');

  const edgesG = container.querySelector('.graph-edges');
  const dotsG = container.querySelector('.graph-dots');
  const rowsEl = container.querySelector('.graph-rows');
  const svgEl = container.querySelector('.graph-svg');
  const refsColEl = container.querySelector('.graph-refs-col');

  // ----- Row windowing (#1) -----
  // Render only the rows in the viewport (plus a buffer), and the dots/edges that touch
  // that row span. Called on first paint, on scroll, on resize, and whenever the highlight
  // or selection changes. Keeps the live DOM bounded no matter how many commits are loaded.
  const BUFFER_ROWS = 8;
  let winStart = -1, winEnd = -1;
  let svgViewH = -1;
  const renderWindow = (force) => {
    const viewH = container.clientHeight || 600;
    const scrollTop = container.scrollTop;

    // SVG virtualization: keep the (sticky, viewport-tall) <svg> showing exactly the scrolled
    // slice of the absolute-coordinate geometry by panning its viewBox. This runs every frame
    // — including when the row window is unchanged — so dots/edges stay glued to their rows
    // between window rebuilds. Height/width only change on resize.
    if (svgEl) {
      if (viewH !== svgViewH) { svgEl.setAttribute('height', viewH); svgViewH = viewH; }
      svgEl.setAttribute('viewBox', `0 ${scrollTop} ${svgWidth} ${viewH}`);
    }

    let start = Math.floor(scrollTop / GRAPH_ROW_H) - BUFFER_ROWS;
    let end = Math.ceil((scrollTop + viewH) / GRAPH_ROW_H) + BUFFER_ROWS;
    if (start < 0) start = 0;
    if (end > commits.length - 1) end = commits.length - 1;
    if (!force && start === winStart && end === winEnd) return;
    winStart = start; winEnd = end;

    const rowParts = [];
    const dotParts = [];
    const refParts = [];
    for (let i = start; i <= end; i++) {
      const c = commits[i];
      const pos = positions.get(c.hash);
      if (!pos) continue;
      dotParts.push(buildDot(c, pos));
      rowParts.push(buildRow(c, pos));
      if (refsColEl) refParts.push(buildRefCell(c, pos));
    }
    dotsG.innerHTML = dotParts.join('');
    rowsEl.innerHTML = rowParts.join('');
    if (refsColEl) refsColEl.innerHTML = refParts.join('');

    const edgeParts = [];
    for (let i = 0; i < edges.length; i++) {
      if (edgeHi[i] >= start && edgeLo[i] <= end) edgeParts.push(buildEdge(edges[i]));
    }
    edgesG.innerHTML = edgeParts.join('');

    container.classList.toggle('graph-highlight-active', !!relatedSet);
  };

  // ----- Event delegation ----- (one listener per kind on the container)
  // Cache for click handler — we look up commits via the map, no per-row .find()
  container._graphCommitsByHash = commitByHash;

  // Child→parent adjacency, so we can highlight a commit's full lineage (#3).
  const childrenByHash = new Map();
  for (const c of commits) {
    for (const p of (c.parents || [])) {
      let arr = childrenByHash.get(p);
      if (!arr) { arr = []; childrenByHash.set(p, arr); }
      arr.push(c.hash);
    }
  }

  // The set of commits related to `hash`: itself + every ancestor (walk parents) +
  // every descendant (walk children), restricted to commits currently laid out.
  const computeRelated = (hash) => {
    const related = new Set([hash]);
    const up = [hash];
    while (up.length) {
      const c = commitByHash.get(up.pop());
      if (!c) continue;
      for (const p of (c.parents || [])) {
        if (commitByHash.has(p) && !related.has(p)) { related.add(p); up.push(p); }
      }
    }
    const down = [hash];
    while (down.length) {
      for (const ch of (childrenByHash.get(down.pop()) || [])) {
        if (!related.has(ch)) { related.add(ch); down.push(ch); }
      }
    }
    return related;
  };

  // Ancestry highlight (#3): recompute the lineage set for `hash` (or clear it) and repaint
  // the visible window so the `rel`/dim marks apply to the virtualized rows on screen. The
  // builders read `relatedSet`, so marks are also re-applied as new rows scroll into view.
  const applyAncestryHighlight = (hash) => {
    relatedSet = (hash && commitByHash.has(hash)) ? computeRelated(hash) : null;
    renderWindow(true);
  };

  // Replace previously-attached delegated handlers (if any) to avoid stacking
  if (container._graphHandlers) {
    container.removeEventListener('click', container._graphHandlers.click);
    container.removeEventListener('dblclick', container._graphHandlers.dblclick);
    container.removeEventListener('contextmenu', container._graphHandlers.context);
    container.removeEventListener('dragstart', container._graphHandlers.dragstart);
    container.removeEventListener('dragend', container._graphHandlers.dragend);
    container.removeEventListener('dragover', container._graphHandlers.dragover);
    container.removeEventListener('dragleave', container._graphHandlers.dragleave);
    container.removeEventListener('drop', container._graphHandlers.drop);
    if (container._graphHandlers.mouseover) container.removeEventListener('mouseover', container._graphHandlers.mouseover);
    if (container._graphHandlers.mouseout) container.removeEventListener('mouseout', container._graphHandlers.mouseout);
    if (container._graphHandlers.mousedown) container.removeEventListener('mousedown', container._graphHandlers.mousedown);
    if (container._graphHandlers.keydown) container.removeEventListener('keydown', container._graphHandlers.keydown);
    if (container._graphHandlers.scroll) container.removeEventListener('scroll', container._graphHandlers.scroll);
  }
  // Tear down the previous layout's resize observer / pending scroll frame before rewiring.
  if (container._graphResizeObs) { container._graphResizeObs.disconnect(); container._graphResizeObs = null; }
  if (container._graphScrollRaf) { cancelAnimationFrame(container._graphScrollRaf); container._graphScrollRaf = 0; }

  // Bring row `idx` into view by adjusting scrollTop directly. Works even when the target
  // row isn't currently in the DOM (virtualized), unlike Element.scrollIntoView.
  const scrollRowIntoView = (idx) => {
    const top = idx * GRAPH_ROW_H;
    const bottom = top + GRAPH_ROW_H;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (top < viewTop) container.scrollTop = top;
    else if (bottom > viewBottom) container.scrollTop = bottom - container.clientHeight;
  };

  // Select a commit by hash: update state, optionally scroll it into view, then repaint the
  // window (which applies the `.selected` row class + lineage highlight) and show its diff.
  const selectCommit = (hash, opts) => {
    if (!hash) return;
    state.selectedGraphHash = hash;
    if (opts && opts.scroll) {
      const p = positions.get(hash);
      if (p) scrollRowIntoView(p.row);
    }
    applyAncestryHighlight(hash);
    const commit = container._graphCommitsByHash.get(hash);
    if (commit) renderGraphDetail(commit);
  };

  const onClick = (e) => {
    // Click on the "hidden commits" summary row expands the global collapse.
    if (e.target.closest('.graph-hidden-row')) {
      state.graphCollapsed = false;
      updateGraphCollapseButton();
      relayoutGraph();
      return;
    }
    // Click on the inline fold toggle button folds/unfolds the commit's branch line.
    const foldBtn = e.target.closest('.graph-fold-btn');
    if (foldBtn && foldBtn.dataset.fold) {
      e.preventDefault();
      e.stopPropagation();
      toggleCommitFold(foldBtn.dataset.fold);
      return;
    }
    // Left-click on a commit dot, its row, OR its branch-column cell selects the commit.
    const dot = e.target.closest('circle.commit-dot');
    const row = e.target.closest('.graph-row');
    const refCell = e.target.closest('.graph-ref-cell');
    const hash = (dot && dot.dataset.hash) || (row && row.dataset.hash) || (refCell && refCell.dataset.hash);
    if (!hash) return;
    // Focus the container (without scrolling) so arrow-key navigation works after a click.
    container.focus({ preventScroll: true });
    selectCommit(hash);
  };

  // Keyboard navigation (#8): ↑/↓ move the selection through the visible commits, Home/End
  // jump to the newest/oldest, Enter re-opens the selected commit's detail. Works when the
  // graph container has focus (it's given tabindex below).
  const onKeyDown = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(e.key)) return;
    const list = (state.graph && state.graph.commits) || [];
    if (!list.length) return;
    e.preventDefault();
    let idx = list.findIndex(c => c.hash === state.selectedGraphHash);
    if (e.key === 'ArrowDown') idx = idx < 0 ? 0 : Math.min(list.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') idx = idx < 0 ? 0 : Math.max(0, idx - 1);
    else if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = list.length - 1;
    else if (e.key === 'Enter') { if (idx < 0) idx = 0; }
    const target = list[idx];
    if (target) selectCommit(target.hash, { scroll: true });
  };

  // Double-click a commit row or dot to fold/unfold its branch line (reliable,
  // easy-to-hit alternative to right-clicking the small dot).
  const onDblClick = (e) => {
    const dot = e.target.closest('circle.commit-dot');
    const row = e.target.closest('.graph-row');
    const hash = (dot && dot.dataset.hash) || (row && row.dataset.hash);
    if (!hash) return;
    const isCollapsed = state.collapsedCommits && state.collapsedCommits.has(hash);
    if (isCollapsed || commitIsFoldable(hash)) {
      e.preventDefault();
      toggleCommitFold(hash);
    }
  };

  const onContext = (e) => {
    // Ref-pill right click — handle ref menu instead
    const pill = e.target.closest('.ref-pill');
    if (pill) {
      e.preventDefault();
      e.stopPropagation();
      showRefContextMenu(pill.dataset.refType, pill.dataset.refName, e.pageX, e.pageY);
      return;
    }
    // Right-click directly on a commit DOT toggles folding of its branch line.
    const dot = e.target.closest('circle.commit-dot');
    if (dot && dot.dataset.hash) {
      const h = dot.dataset.hash;
      const isCollapsed = state.collapsedCommits && state.collapsedCommits.has(h);
      if (isCollapsed || commitIsFoldable(h)) {
        e.preventDefault();
        e.stopPropagation();
        toggleCommitFold(h);
        return;
      }
      // Not foldable — fall through to the normal commit context menu.
    }
    // Right-click elsewhere on the row shows the commit context menu.
    const row = e.target.closest('.graph-row');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    showCommitContextMenu(row.dataset.hash, e.pageX, e.pageY);
  };

  const onDragStart = (e) => {
    const pill = e.target.closest('.ref-pill[draggable="true"]');
    if (!pill) return;
    pill.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-gitgood-branch', pill.dataset.refName);
    e.dataTransfer.setData('text/plain', pill.dataset.refName);
  };

  const onDragEnd = (e) => {
    const pill = e.target.closest('.ref-pill.dragging');
    if (pill) pill.classList.remove('dragging');
  };

  const onDragOver = (e) => {
    if (!e.dataTransfer.types.includes('application/x-gitgood-branch')) return;
    const row = e.target.closest('.graph-row');
    if (!row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Avoid setting class on every move; only set if not already set
    if (!row.classList.contains('drop-allowed')) {
      // Clear previous highlight
      const prev = container.querySelector('.graph-row.drop-allowed');
      if (prev) prev.classList.remove('drop-allowed');
      row.classList.add('drop-allowed');
    }
  };

  const onDragLeave = (e) => {
    const row = e.target.closest('.graph-row');
    if (row && !row.contains(e.relatedTarget)) row.classList.remove('drop-allowed');
  };

  const onDrop = async (e) => {
    const row = e.target.closest('.graph-row');
    if (!row) return;
    row.classList.remove('drop-allowed');
    const branch = e.dataTransfer.getData('application/x-gitgood-branch');
    const targetHash = row.dataset.hash;
    if (!branch || !targetHash) return;
    e.preventDefault();
    await handleBranchDrop(branch, targetHash);
  };

  // Row ↔ dot hover sync (#4): the text rows and the SVG dots live in separate grid
  // columns, so a plain CSS `:hover` can't reach across. Mirror the hover here by
  // toggling a class on the matching circle when the pointer enters/leaves a row.
  const dotForHash = (hash) =>
    hash ? container.querySelector(`.graph-svg circle.commit-dot[data-hash="${CSS.escape(hash)}"]`) : null;
  const refCellForHash = (hash) =>
    hash ? container.querySelector(`.graph-refs-col .graph-ref-cell[data-hash="${CSS.escape(hash)}"]`) : null;

  // Ticker for an overflowing branch column: when a commit carries more (or longer) branch
  // pills than the clamped column can show, hovering its row slowly slides the hidden pills
  // into view and back (ping-pong) like a news ticker so every branch name can be read.
  const startRefMarquee = (hash) => {
    const cell = refCellForHash(hash);
    if (!cell) return;
    const track = cell.querySelector('.graph-ref-track');
    if (!track) return;
    // How far the track overflows the clamped cell's content box. Right-aligned, so the
    // overflow is hidden off the LEFT edge; translating the track right by this amount
    // reveals it. clientWidth includes the cell's 2px×2 padding, so subtract it.
    const overflow = Math.round(track.scrollWidth - (cell.clientWidth - 4));
    if (overflow <= 2) return; // fits — nothing to scroll
    track.style.setProperty('--marquee-shift', overflow + 'px');
    // Slow, readable pace (~45px/s) with a sensible floor so tiny overflows still ease.
    track.style.setProperty('--marquee-dur', Math.max(2.5, overflow / 45).toFixed(2) + 's');
    track.classList.add('marquee');
  };
  const stopRefMarquee = (hash) => {
    const cell = refCellForHash(hash);
    const track = cell && cell.querySelector('.graph-ref-track');
    if (track) track.classList.remove('marquee');
  };

  const onMouseOver = (e) => {
    const row = e.target.closest('.graph-row');
    if (!row || !row.dataset.hash) return;
    const dot = dotForHash(row.dataset.hash);
    if (dot) dot.classList.add('row-hover');
    startRefMarquee(row.dataset.hash);
  };
  const onMouseOut = (e) => {
    const row = e.target.closest('.graph-row');
    if (!row || !row.dataset.hash) return;
    // Ignore moves between the row's own children — only clear when truly leaving it.
    if (row.contains(e.relatedTarget)) return;
    const dot = dotForHash(row.dataset.hash);
    if (dot) dot.classList.remove('row-hover');
    stopRefMarquee(row.dataset.hash);
  };

  // ----- Cherry-pick by dragging a commit onto another (#cherrypick) -----
  // SVG <circle>s don't participate in HTML5 drag-and-drop reliably in Chromium, so we run
  // our own pointer drag: press a commit's dot OR its message row, move past a threshold to
  // begin, release over another commit to replay the pressed commit onto that commit's branch
  // (see handleCherryPickDrop). A plain press-release with no movement falls through to
  // onClick (commit selection).
  let dotDrag = null;          // { hash, startX, startY, active }
  let dotDragLabel = null;     // floating chip that follows the cursor while dragging
  let lastDropTarget = null;   // row currently flagged as the hovered drop target

  const clearDropTarget = () => {
    if (lastDropTarget) { lastDropTarget.classList.remove('drop-allowed', 'drop-denied'); lastDropTarget = null; }
  };
  // The commit/row under a viewport point (a dot in the SVG column or a message row).
  const targetAtPoint = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return { hash: null, row: null };
    const dot = el.closest('circle.commit-dot');
    const row = el.closest('.graph-row');
    return { hash: (dot && dot.dataset.hash) || (row && row.dataset.hash) || null, row };
  };
  const endDotDrag = () => {
    document.removeEventListener('mousemove', onDotDragMove);
    document.removeEventListener('mouseup', onDotDragUp);
    if (dotDragLabel) { dotDragLabel.remove(); dotDragLabel = null; }
    clearDropTarget();
    container.classList.remove('dot-dragging');
    const src = container.querySelector('circle.commit-dot.drag-source');
    if (src) src.classList.remove('drag-source');
    dotDrag = null;
  };
  const onDotDragMove = (e) => {
    if (!dotDrag) return;
    if (!dotDrag.active) {
      // Don't commit to a drag until the pointer clearly moves — keeps clicks as clicks.
      if (Math.hypot(e.clientX - dotDrag.startX, e.clientY - dotDrag.startY) < 5) return;
      dotDrag.active = true;
      container.classList.add('dot-dragging');
      const src = dotForHash(dotDrag.hash);
      if (src) src.classList.add('drag-source');
      dotDragLabel = document.createElement('div');
      dotDragLabel.className = 'dot-drag-label';
      dotDragLabel.textContent = '⚒ Cherry-pick ' + dotDrag.hash.slice(0, 7);
      document.body.appendChild(dotDragLabel);
    }
    dotDragLabel.style.left = (e.clientX + 14) + 'px';
    dotDragLabel.style.top = (e.clientY + 14) + 'px';
    // Flag the hovered target: allowed only if it's a DIFFERENT commit carrying a local
    // branch (the cherry-pick lands on a branch tip).
    const { hash, row } = targetAtPoint(e.clientX, e.clientY);
    clearDropTarget();
    if (row && hash && hash !== dotDrag.hash) {
      const c = commitByHash.get(hash);
      const hasLocal = !!(c && (c.refs || []).some(r => r.type === 'local'));
      row.classList.add(hasLocal ? 'drop-allowed' : 'drop-denied');
      lastDropTarget = row;
    }
  };
  const onDotDragUp = (e) => {
    if (!dotDrag) return;
    const wasActive = dotDrag.active;
    const sourceHash = dotDrag.hash;
    const target = wasActive ? targetAtPoint(e.clientX, e.clientY) : { hash: null };
    endDotDrag();
    if (!wasActive) return;                       // a click, not a drag — leave to onClick
    if (!target.hash || target.hash === sourceHash) return;
    handleCherryPickDrop(sourceHash, target.hash);
  };
  const onDotMouseDown = (e) => {
    if (e.button !== 0) return;
    // The fold toggle and draggable ref pills have their own behaviour — don't hijack them.
    if (e.target.closest('.graph-fold-btn') || e.target.closest('.ref-pill')) return;
    // Start a cherry-pick drag from either the commit dot OR its message row (the row is the
    // bigger, more natural grab area). Pills live in a separate column, so they're excluded.
    const dot = e.target.closest('circle.commit-dot');
    const row = e.target.closest('.graph-row');
    const hash = (dot && dot.dataset.hash) || (row && row.dataset.hash);
    if (!hash) return;
    // Suppress the browser's text-selection on the row; the 5px threshold still lets a plain
    // press fall through to onClick (selection) since no click is cancelled here.
    e.preventDefault();
    dotDrag = { hash, startX: e.clientX, startY: e.clientY, active: false };
    document.addEventListener('mousemove', onDotDragMove);
    document.addEventListener('mouseup', onDotDragUp);
  };

  container.addEventListener('click', onClick);
  container.addEventListener('dblclick', onDblClick);
  container.addEventListener('contextmenu', onContext);
  container.addEventListener('dragstart', onDragStart);
  container.addEventListener('dragend', onDragEnd);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  container.addEventListener('mouseover', onMouseOver);
  container.addEventListener('mouseout', onMouseOut);
  container.addEventListener('mousedown', onDotMouseDown);
  // Make the graph focusable so it can receive arrow-key navigation (#8).
  if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
  container.addEventListener('keydown', onKeyDown);

  // Repaint the window on scroll, throttled to one paint per animation frame (#1).
  const onScroll = () => {
    if (container._graphScrollRaf) return;
    container._graphScrollRaf = requestAnimationFrame(() => {
      container._graphScrollRaf = 0;
      renderWindow(false);
    });
  };
  container.addEventListener('scroll', onScroll, { passive: true });

  container._graphHandlers = { click: onClick, dblclick: onDblClick, context: onContext, dragstart: onDragStart, dragend: onDragEnd, dragover: onDragOver, dragleave: onDragLeave, drop: onDrop, mouseover: onMouseOver, mouseout: onMouseOut, mousedown: onDotMouseDown, keydown: onKeyDown, scroll: onScroll };

  // The viewport height affects how many rows are visible — repaint when the pane resizes.
  if (typeof ResizeObserver !== 'undefined') {
    container._graphResizeObs = new ResizeObserver(() => renderWindow(true));
    container._graphResizeObs.observe(container);
  }

  // First paint of the visible window.
  renderWindow(true);

  // If selection is still valid, show its detail and re-apply its lineage highlight (which
  // repaints the window with the marks); else clear.
  if (state.selectedGraphHash) {
    const sel = commitByHash.get(state.selectedGraphHash);
    if (sel) { renderGraphDetail(sel); applyAncestryHighlight(state.selectedGraphHash); }
    else { state.selectedGraphHash = null; renderGraphDetail(null); }
  }
}

async function renderGraphDetail(commit) {
  const panel = $('#graph-detail');
  if (!panel) return;
  if (!commit) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚜</div>
        <p>Select a commit to inspect its deeds.</p>
      </div>
    `;
    return;
  }
  // Track the request so a slow load doesn't overwrite a newer selection
  const requestedHash = commit.hash;

  // Render metadata immediately
  panel.innerHTML = `
    <div class="detail-section">
      <div class="detail-header">⚜ Deed</div>
      <div class="detail-text">${escapeHtml(commit.message)}</div>
    </div>
    <div class="detail-section">
      <div class="detail-header">⚔ Author</div>
      <div class="detail-meta">${escapeHtml(commit.author_name || '')} <span>&lt;${escapeHtml(commit.author_email || '')}&gt;</span></div>
      <div class="detail-meta"><span>${commit.date ? new Date(commit.date).toLocaleString() : ''}</span></div>
    </div>
    <div class="detail-section">
      <div class="detail-header">⚜ Hash</div>
      <div class="detail-meta text-mono" style="word-break:break-all">${escapeHtml(commit.hash)}</div>
    </div>
    ${commit.parents && commit.parents.length > 1
      ? `<div class="detail-section"><div class="detail-header">⚒ Merge of ${commit.parents.length} parents</div><div class="detail-meta text-mono" style="word-break:break-all">${commit.parents.map(p => escapeHtml(p.slice(0,7))).join(' + ')}</div></div>`
      : ''}
    <div class="detail-section">
      <div class="detail-header detail-header-row">
        <span>⚒ Changes</span>
        ${diffModeToggleHtml()}
      </div>
      <div class="diff-content" id="graph-diff-content" style="border:1px solid var(--border);max-height:55vh"><div class="empty-state"><span class="loading"></span></div></div>
    </div>
  `;

  let details;
  try {
    details = await getCommitDetails(requestedHash);
  } catch (err) {
    const diffEl = panel.querySelector('#graph-diff-content');
    if (diffEl && state.selectedGraphHash === requestedHash) {
      diffEl.innerHTML = `<div class="empty-state"><p style="color:var(--crusader-red-bright)">⚔ Failed to load commit: ${escapeHtml(err.message || String(err))}</p></div>`;
    }
    return;
  }
  // Skip if user has selected a different commit while we were loading
  if (state.selectedGraphHash !== requestedHash) return;

  // Defer the diff render to a separate paint frame so metadata paints first.
  requestAnimationFrame(() => {
    // Re-check selection — user may have switched again during raf delay
    if (state.selectedGraphHash !== requestedHash) return;
    const diffEl = panel.querySelector('#graph-diff-content');
    if (!diffEl) return;
    renderCommitFileBrowser(diffEl, details.diff, {
      hash: requestedHash,
      diffTruncated: details.diffTruncated,
      diffBytes: details.diffBytes,
      // While a diff-content filter is active, seed the per-commit file filter with the
      // same query so the files that actually changed it surface immediately.
      fileFilter: (state.graphFilterMode === 'content' && (state.graphFilter || '').trim()) || ''
    });
  });
}

// ============================================
// CONTEXT MENUS — commits and refs
// ============================================
function showCommitContextMenu(hash, x, y) {
  const shortHash = hash.slice(0, 7);
  const isCollapsed = state.collapsedCommits && state.collapsedCommits.has(hash);
  const foldable = isCollapsed || commitIsFoldable(hash);
  const items = [
    { label: 'Copy hash', icon: '⎘', action: () => copyText(hash, 'Hash copied') },
    { label: 'Copy short hash', icon: '⎘', action: () => copyText(shortHash, 'Short hash copied') },
    'sep',
    { label: `Checkout ${shortHash}`, icon: '⑂', action: () => checkoutCommit(hash) },
    { label: 'Create branch here…', icon: '+', action: () => showCreateBranchDialog(hash) },
    { label: 'Create tag here…', icon: '✠', action: () => showCreateTagDialog(hash) },
    'sep',
    { label: 'Cherry-pick onto current', icon: '⚒', action: () => doCherryPick(hash) },
    { label: 'Revert this commit', icon: '↶', action: () => doRevert(hash) },
    'sep',
    { label: 'Reset current branch to here…', icon: '↺', action: () => showResetDialog(hash) }
  ];
  if (foldable) {
    items.push('sep');
    items.push({
      label: isCollapsed ? 'Expand branch line below' : 'Collapse branch line below',
      icon: isCollapsed ? '⊞' : '⊟',
      action: () => toggleCommitFold(hash)
    });
  }
  showContextMenu(items, x, y);
}

// Is the commit currently foldable? Foldable when ANY of its parents is present in the
// view and sits below it (there's a chain we can fold away). We check all parents — not
// just the first — so merge commits whose first parent happens to be drawn above still
// fold via their other (below) parent. Lanes are not required to match.
function commitIsFoldable(hash) {
  const g = state.graph;
  if (!g || !g.positions) return false;
  const pos = g.positions.get(hash);
  if (!pos) return false;
  const c = (g.commits || []).find(x => x.hash === hash);
  if (!c) return false;
  const parents = c.parents || [];
  for (const ph of parents) {
    const pp = g.positions.get(ph);
    if (pp && pp.row > pos.row) return true;
  }
  return false;
}

// Toggle the per-commit fold for a given hash and re-render the graph.
function toggleCommitFold(hash) {
  if (!state.collapsedCommits) state.collapsedCommits = new Set();
  if (state.collapsedCommits.has(hash)) state.collapsedCommits.delete(hash);
  else state.collapsedCommits.add(hash);
  relayoutGraph();
}

function showRefContextMenu(refType, refName, x, y) {
  if (refType === 'local') {
    const current = state.branches.local && state.branches.local.current;
    const isCurrent = refName === current;
    const items = [];
    if (!isCurrent) {
      items.push({ label: `Checkout ${refName}`, icon: '⑂', action: () => checkoutBranch(refName) });
      items.push({ label: `Merge ${refName} into current (smart)`, icon: '⚒', action: () => showSmartMergeDialog(refName) });
    }
    items.push({ label: 'Rename branch…', icon: '✎', action: () => showRenameBranchDialog(refName) });
    items.push('sep');
    items.push({ label: 'Delete branch', icon: '✗', danger: true, action: () => deleteBranch(refName, false) });
    items.push({ label: 'Force delete', icon: '⚔', danger: true, action: () => deleteBranch(refName, true) });
    showContextMenu(items, x, y);
  } else if (refType === 'remote') {
    const local = refName.replace(/^[^/]+\//, '');
    showContextMenu([
      { label: `Checkout as local "${local}"`, icon: '⑂', action: () => checkoutRemoteBranch(refName, local) },
      { label: `Merge ${refName} into current (smart)`, icon: '⚒', action: () => showSmartMergeDialog(refName) },
      'sep',
      { label: 'Copy ref name', icon: '⎘', action: () => copyText(refName, 'Copied') },
      { label: 'Delete remote branch', icon: '✗', danger: true, action: () => deleteRemoteBranch(refName) }
    ], x, y);
  } else if (refType === 'tag') {
    showContextMenu([
      { label: `Checkout ${refName}`, icon: '⑂', action: () => checkoutCommit(refName) },
      { label: 'Copy tag name', icon: '⎘', action: () => copyText(refName, 'Copied') },
      'sep',
      { label: 'Delete tag', icon: '✗', danger: true, action: () => doDeleteTag(refName) }
    ], x, y);
  }
}

async function doCherryPick(hash) {
  const r = await withLoading('Cherry-picking', () => gs.cherryPick(hash));
  if (handleResult(r, 'Cherry-picked')) await refreshAll();
}
async function doRevert(hash) {
  const confirmed = await modal.confirm({
    title: 'Revert Commit',
    message: `Revert commit ${hash.slice(0, 7)}? A new commit will be created that undoes its changes.`,
    confirmText: 'Revert'
  });
  if (!confirmed) return;
  const r = await withLoading('Reverting', () => gs.revert(hash));
  if (handleResult(r, 'Reverted')) await refreshAll();
}
async function doDeleteTag(tagName) {
  const confirmed = await modal.confirm({
    title: 'Delete Tag',
    message: `Delete tag "${tagName}"?`,
    danger: true, confirmText: 'Delete'
  });
  if (!confirmed) return;
  const r = await gs.rawCommand(['tag', '-d', tagName]);
  if (handleResult(r, 'Tag deleted')) await refreshAll();
}

function showCreateTagDialog(hash) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Tag commit <code class="text-mono text-red">${escapeHtml(hash.slice(0,7))}</code></p>
    <div class="modal-field"><label>Tag Name</label><input class="modal-input" id="new-tag-name" placeholder="v1.0.0" /></div>
    <div class="modal-field"><label>Message (optional, creates annotated tag)</label><input class="modal-input" id="new-tag-msg" placeholder="Release notes…" /></div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const createBtn = document.createElement('button');
  createBtn.className = 'btn-medieval primary'; createBtn.textContent = 'Create Tag';
  createBtn.onclick = async () => {
    const name = $('#new-tag-name').value.trim();
    const msg = $('#new-tag-msg').value.trim();
    if (!name) { showToast('Tag name required', 'error'); return; }
    modal.hide();
    const args = ['tag'];
    if (msg) args.push('-a', name, '-m', msg, hash);
    else args.push(name, hash);
    const r = await gs.rawCommand(args);
    if (handleResult(r, `Tag ${name} forged`)) await refreshAll();
  };
  modal.show({ title: 'Create Tag', body, footer: [cancelBtn, createBtn] });
}

function showRenameBranchDialog(oldName) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Rename branch <code class="text-mono text-red">${escapeHtml(oldName)}</code></p>
    <div class="modal-field"><label>New Name</label><input class="modal-input" id="rename-branch-name" value="${escapeHtml(oldName)}" /></div>
  `;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary'; okBtn.textContent = 'Rename';
  okBtn.onclick = async () => {
    const newName = $('#rename-branch-name').value.trim();
    if (!newName) { showToast('Name required', 'error'); return; }
    if (newName === oldName) { modal.hide(); return; }
    modal.hide();
    const r = await gs.rawCommand(['branch', '-m', oldName, newName]);
    if (handleResult(r, `Renamed to ${newName}`)) await refreshAll();
  };
  modal.show({ title: 'Rename Branch', body, footer: [cancelBtn, okBtn] });
}

function showResetDialog(hash) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Reset the current branch to <code class="text-mono text-red">${escapeHtml(hash.slice(0,7))}</code>.</p>
    <div class="merge-strategies">
      <label class="merge-strategy selected">
        <input type="radio" name="reset-mode" value="mixed" checked />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Mixed (default)</div>
          <div class="merge-strategy-desc">Move HEAD to this commit. Keep working tree changes but unstage them. <strong>Safe.</strong></div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="reset-mode" value="soft" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Soft</div>
          <div class="merge-strategy-desc">Move HEAD only. Keep everything staged and in the working tree. <strong>Safest.</strong></div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="reset-mode" value="hard" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Hard ⚠</div>
          <div class="merge-strategy-desc">Move HEAD and <strong>discard all uncommitted changes and staged files</strong>. Cannot be undone.</div>
        </div>
      </label>
    </div>
  `;
  // Radio selection visuals
  body.querySelectorAll('.merge-strategy').forEach(card => {
    card.onclick = (e) => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
      body.querySelectorAll('.merge-strategy').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    };
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval danger'; okBtn.textContent = 'Reset';
  okBtn.onclick = async () => {
    const mode = body.querySelector('input[name="reset-mode"]:checked').value;
    modal.hide();
    if (mode === 'hard') {
      const sure = await modal.confirm({
        title: 'Confirm Hard Reset',
        message: 'This will permanently discard uncommitted changes. Continue?',
        danger: true, confirmText: 'Yes, reset hard'
      });
      if (!sure) return;
    }
    const r = await withLoading('Resetting', () => gs.reset({ hash, mode }));
    if (handleResult(r, `Reset (${mode}) complete`)) await refreshAll();
  };
  modal.show({ title: 'Reset Current Branch', body, footer: [cancelBtn, okBtn] });
}

// ============================================
// BRANCH DROP — drag a branch pill onto a commit row
// ============================================
async function handleBranchDrop(branch, targetHash) {
  // Confirm — if it's the current branch, this triggers a reset-hard via moveBranch
  const isCurrent = state.branches.local && state.branches.local.current === branch;
  const message = isCurrent
    ? `Move the CURRENT branch "${branch}" to commit ${targetHash.slice(0,7)}? This performs a hard reset and discards uncommitted changes.`
    : `Move branch "${branch}" to commit ${targetHash.slice(0,7)}? (Uses git branch -f)`;
  const confirmed = await modal.confirm({
    title: isCurrent ? 'Move Current Branch (Hard Reset)' : 'Move Branch',
    message,
    danger: isCurrent,
    confirmText: 'Move'
  });
  if (!confirmed) return;
  const r = await withLoading('Moving branch', () => gs.moveBranch({ branch, hash: targetHash }));
  if (handleResult(r, `Moved ${branch}`)) await refreshAll();
}

// ============================================
// CHERRY-PICK DROP — drag a commit dot onto another commit to replay it there
// ============================================
// Cherry-pick replays the SOURCE commit's changes as a NEW commit on top of a branch tip.
// The DESTINATION is the dropped-on commit, which must carry at least one LOCAL branch (that
// branch is what the new commit lands on, and it's checked out first if it isn't current).
// If several local branches sit on the destination, the user picks which one.
async function handleCherryPickDrop(sourceHash, targetHash) {
  const commits = (state.graph && state.graph.commits) || [];
  const source = commits.find(c => c.hash === sourceHash);
  const target = commits.find(c => c.hash === targetHash);
  if (!source || !target) return;
  const locals = (target.refs || []).filter(r => r.type === 'local').map(r => r.name);
  if (!locals.length) {
    showToast('Drop onto a commit that has a local branch — that’s where the cherry-pick lands.', 'error', 6000);
    return;
  }
  const srcShort = sourceHash.slice(0, 7);
  const srcMsg = (source.message || '').length > 60 ? source.message.slice(0, 60) + '…' : (source.message || '');
  if (locals.length === 1) {
    const current = (state.branches.local && state.branches.local.current) || '';
    const note = locals[0] === current ? '' : ` "${locals[0]}" will be checked out first.`;
    const confirmed = await modal.confirm({
      title: 'Cherry-pick Commit',
      message: `Replay ${srcShort}${srcMsg ? ` "${srcMsg}"` : ''} as a new commit on branch "${locals[0]}".${note}`,
      confirmText: 'Cherry-pick'
    });
    if (!confirmed) return;
    await runCherryPickOnto(sourceHash, locals[0]);
  } else {
    showCherryPickBranchDialog(sourceHash, srcShort, srcMsg, locals);
  }
}

// Destination commit carries several local branches — let the user choose which one the
// cherry-picked commit lands on (the chosen branch is checked out if it isn't current).
function showCherryPickBranchDialog(sourceHash, srcShort, srcMsg, locals) {
  const current = (state.branches.local && state.branches.local.current) || '';
  const body = document.createElement('div');
  const rows = locals.map((b, i) => `
    <label class="cp-branch-row">
      <input type="radio" name="cp-branch" value="${escapeHtml(b)}" ${i === 0 ? 'checked' : ''} />
      <span class="ref-pill local${b === current ? ' head' : ''}" style="cursor:default">${escapeHtml(b)}</span>
      <span class="text-muted" style="font-size:11px">${b === current ? 'current' : 'will be checked out'}</span>
    </label>`).join('');
  body.innerHTML = `
    <p class="modal-text">Replay <code class="text-mono text-red">${escapeHtml(srcShort)}</code>${srcMsg ? ` "${escapeHtml(srcMsg)}"` : ''} as a new commit on a branch.</p>
    <p class="modal-text text-muted" style="font-size:12px">The target commit has several local branches — choose which one the cherry-pick should land on:</p>
    <div class="cp-branch-list">${rows}</div>`;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary'; okBtn.textContent = 'Cherry-pick';
  okBtn.onclick = async () => {
    const sel = body.querySelector('input[name="cp-branch"]:checked');
    if (!sel) { showToast('Select a branch', 'error'); return; }
    modal.hide();
    await runCherryPickOnto(sourceHash, sel.value);
  };
  modal.show({ title: 'Cherry-pick onto Branch', body, footer: [cancelBtn, okBtn] });
}

// Check out `destBranch` (if not already current), then cherry-pick `sourceHash` onto it.
// Always refreshes afterwards so a conflicting cherry-pick surfaces the conflict resolver.
async function runCherryPickOnto(sourceHash, destBranch) {
  const current = (state.branches.local && state.branches.local.current) || '';
  if (destBranch !== current) {
    const co = await withLoading(`Checking out ${destBranch}`, () => gs.checkoutSafe({ branch: destBranch }));
    if (!co.ok) { showToast('Checkout failed: ' + co.error, 'error', 6000); return; }
    if (!(co.data && co.data.switched)) {
      showToast(`Couldn’t switch to ${destBranch} — commit or stash your changes first.`, 'error', 6000);
      return;
    }
  }
  const r = await withLoading('Cherry-picking', () => gs.cherryPick(sourceHash));
  if (r.ok) showToast(`Cherry-picked ${sourceHash.slice(0, 7)} onto ${destBranch}`, 'success');
  else showToast('Cherry-pick: ' + r.error, 'error', 7000);
  await refreshAll();
}

// ============================================
// SMART MERGE MODAL
// ============================================
async function showSmartMergeDialog(branch) {
  if (!branch) return;
  // Fetch a preview from main
  const previewResult = await withLoading(`Analyzing merge of ${branch}`, () => gs.mergePreview(branch));
  if (!previewResult.ok) {
    showToast('Preview failed: ' + previewResult.error, 'error', 6000);
    return;
  }
  const preview = previewResult.data;
  const current = (state.branches.local && state.branches.local.current) || 'current branch';

  const incomingHtml = (preview.incoming || []).slice(0, 30).map(c => `
    <div class="merge-incoming-row">
      <span class="text-red text-mono">${escapeHtml(c.hash || '')}</span>
      <span>${escapeHtml(c.message || '')}</span>
      <span class="text-muted text-mono">${escapeHtml(c.author || '')}</span>
    </div>
  `).join('');

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Merge <strong class="text-red">${escapeHtml(branch)}</strong> into <strong>${escapeHtml(current)}</strong></p>

    <div class="merge-preview">
      <div class="merge-preview-row">
        <span>Incoming commits</span>
        <strong>${preview.behind || 0}</strong>
      </div>
      <div class="merge-preview-row">
        <span>Local-only commits</span>
        <strong>${preview.ahead || 0}</strong>
      </div>
      <div class="merge-preview-row">
        <span>Fast-forward possible</span>
        ${preview.canFastForward
          ? '<span class="merge-preview-ok">✓ Yes</span>'
          : '<span class="merge-preview-warn">✗ Diverged — merge commit needed</span>'}
      </div>
    </div>

    ${(preview.incoming && preview.incoming.length)
      ? `<label class="branches-label" style="display:block;margin-bottom:6px">⚒ Incoming Commits</label>
         <div class="merge-incoming">${incomingHtml}${preview.incoming.length > 30 ? `<div class="merge-incoming-row text-muted" style="grid-template-columns:1fr"><span>…and ${(preview.behind || 0) - 30} more</span></div>` : ''}</div>`
      : ''}

    <label class="branches-label" style="display:block;margin-bottom:6px">⚜ Strategy</label>
    <div class="merge-strategies" id="merge-strategy-cards">
      <label class="merge-strategy${!preview.canFastForward ? ' disabled' : ''}">
        <input type="radio" name="merge-strategy" value="ff-only" ${!preview.canFastForward ? 'disabled' : ''} />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Fast-forward (clean)</div>
          <div class="merge-strategy-desc">Just move the current branch pointer forward — no merge happens, so no conflicts can ever appear. ${preview.canFastForward ? 'Available because branches have not diverged.' : 'Not available — branches have diverged.'}</div>
        </div>
      </label>
      <label class="merge-strategy selected">
        <input type="radio" name="merge-strategy" value="auto" checked />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Default (auto, recommended)</div>
          <div class="merge-strategy-desc">Fast-forward when possible, otherwise create a merge commit. Conflicts surface here if histories disagree.</div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="merge-strategy" value="no-ff" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Always create merge commit</div>
          <div class="merge-strategy-desc">Force a merge commit even when fast-forward is possible. Preserves branch history visually.</div>
        </div>
      </label>
      <label class="merge-strategy">
        <input type="radio" name="merge-strategy" value="squash" />
        <div class="merge-strategy-body">
          <div class="merge-strategy-title">Squash</div>
          <div class="merge-strategy-desc">Combine all incoming commits into a single new commit on the current branch.</div>
        </div>
      </label>
    </div>

    <div class="modal-field" id="merge-msg-field" style="display:none">
      <label>Merge Commit Message</label>
      <input class="modal-input" id="merge-msg" placeholder="${escapeHtml(`Merge branch '${branch}' into ${current}`)}" />
    </div>
  `;

  // Radio interaction — toggle visual selection and show/hide message field
  const cards = body.querySelectorAll('.merge-strategy');
  const msgField = body.querySelector('#merge-msg-field');
  function syncSelectionUI() {
    const sel = body.querySelector('input[name="merge-strategy"]:checked');
    const val = sel ? sel.value : 'auto';
    cards.forEach(c => {
      const r = c.querySelector('input[type="radio"]');
      c.classList.toggle('selected', r && r.checked);
    });
    msgField.style.display = (val === 'no-ff' || val === 'squash') ? 'block' : 'none';
  }
  cards.forEach(card => {
    card.onclick = (e) => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio && !radio.disabled) {
        radio.checked = true;
        syncSelectionUI();
      }
    };
  });
  syncSelectionUI();

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn-medieval primary'; okBtn.innerHTML = '<span class="btn-icon">⚒</span> Merge';
  okBtn.onclick = async () => {
    const strategy = body.querySelector('input[name="merge-strategy"]:checked').value;
    const messageInput = body.querySelector('#merge-msg');
    const message = (messageInput && messageInput.value.trim()) || undefined;
    modal.hide();
    await runMerge(branch, strategy, message);
  };
  modal.show({ title: 'Smart Merge', body, footer: [cancelBtn, okBtn] });
}

// A conflict occurred — take the user straight into resolution. Switches to the Changes
// tab (which shows the conflict banner + per-file resolve controls, including modify/
// delete handling) and opens the 3-way resolver on the first text conflict if present.
function openMergeResolution(branch) {
  const conflicts = (state.conflicts && state.conflicts.files) || [];
  // Make sure the Changes tab is visible so the conflict section + banner are in view.
  const tab = document.querySelector('.tab[data-tab="changes"]');
  if (tab) tab.click();

  const firstText = conflicts.find(f => {
    const c = /U/.test(f.indexStatus || '') || /U/.test(f.workingDir || '');
    return c && !f.isBinary && !f.deletedInOurs && !f.deletedInTheirs;
  });
  if (firstText) {
    // Open the 3-way resolver on the first editable conflict.
    setTimeout(() => openConflictResolver(firstText.path), 60);
  } else if (conflicts.length) {
    // Only non-text conflicts (modify/delete, binary). The Changes-tab conflict section
    // shows Keep/Delete/Use-ours/Use-theirs controls for these.
    showToast(`Merge produced ${conflicts.length} conflict(s) needing a choice — resolve them in the Changes tab.`, 'info', 7000);
  } else {
    showToast('Merge conflict detected — see the Changes tab.', 'info', 6000);
  }
}

// Run a merge, handling (a) genuine conflicts → resolver, and (b) a dirty working tree
// that blocks the merge (uncommitted or untracked changes) → offer to stash & retry.
async function runMerge(branch, strategy, message) {
  // The branch being merged may have uncommitted work that the app auto-stashed when you
  // last left it. Git merges only COMMITTED history, so that stashed work will NOT be
  // included — warn instead of silently producing an "Already up to date" no-op.
  try {
    const bare = String(branch).replace(/^[^/]+\//, ''); // strip remote prefix if any
    let asr = await gs.stashFindByPrefix(autoStashMarkerFor(branch));
    let hidden = (asr.ok && asr.data) ? asr.data : [];
    if (!hidden.length && bare !== branch) {
      asr = await gs.stashFindByPrefix(autoStashMarkerFor(bare));
      hidden = (asr.ok && asr.data) ? asr.data : [];
    }
    if (hidden.length) {
      const proceed = await new Promise((resolve) => {
        const cancel = document.createElement('button');
        cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
        cancel.onclick = () => { modal.hide(); resolve(false); };
        const go = document.createElement('button');
        go.className = 'btn-medieval primary'; go.textContent = 'Merge Committed Work Anyway';
        go.onclick = () => { modal.hide(); resolve(true); };
        modal.show({
          title: 'Branch Has Uncommitted Work',
          body: `<p class="modal-text"><strong>${escapeHtml(branch)}</strong> has uncommitted changes that were auto-stashed when you switched away from it.</p>
                 <p class="modal-text text-muted" style="font-size:12px;margin-top:8px">A merge only includes <strong>committed</strong> history — those stashed changes won't be merged in. To merge that work, first switch to <strong>${escapeHtml(branch)}</strong>, restore its stash, commit, then merge. Continue merging only what's committed?</p>`,
          footer: [cancel, go]
        });
      });
      if (!proceed) return;
    }
  } catch (e) { /* non-fatal — proceed with the merge */ }

  const r = await withLoading(`Merging ${branch}`, () => gs.merge({ branch, strategy, message }));
  if (r.ok) {
    showToast(`Merged ${branch}`, 'success');
    await refreshAll();
    return;
  }

  const err = r.error || '';

  // Genuine merge conflict → open the resolver immediately.
  if (/conflict/i.test(err) || /CONFLICT/.test(err)) {
    await refreshAll();
    openMergeResolution(branch);
    return;
  }

  // Fast-forward-only was requested but the branches have diverged, so git refuses. This
  // is correct git behavior — but ff-only can never produce a conflict either, so the user
  // probably wanted a real merge. Offer to retry with a strategy that actually merges.
  const ffNotPossible = /Not possible to fast-forward|fast-forward.*not possible|Diverging branches can't be fast-forwarded|Already up to date|can't be fast-forwarded/i.test(err) ||
    (strategy === 'ff-only' && /aborting|refusing/i.test(err));
  if (strategy === 'ff-only' && ffNotPossible) {
    const cancel = document.createElement('button');
    cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
    cancel.onclick = () => modal.hide();
    const auto = document.createElement('button');
    auto.className = 'btn-medieval'; auto.textContent = 'Use Default (auto)';
    auto.onclick = async () => { modal.hide(); await runMerge(branch, 'auto', message); };
    const noff = document.createElement('button');
    noff.className = 'btn-medieval primary'; noff.innerHTML = '<span class="btn-icon">⚒</span> Create Merge Commit';
    noff.onclick = async () => { modal.hide(); await runMerge(branch, 'no-ff', message || `Merge ${branch}`); };
    modal.show({
      title: 'Fast-forward Not Possible',
      body: `<p class="modal-text">Your branch and <strong>${escapeHtml(branch)}</strong> have diverged — both have new commits — so git can't fast-forward.</p>
             <p class="modal-text text-muted" style="font-size:12px;margin-top:8px">Fast-forward only moves the branch pointer; it can never merge or produce conflicts. To combine the histories (and surface any conflicts), use a real merge strategy.</p>`,
      footer: [cancel, auto, noff]
    });
    return;
  }

  // Git refused to start the merge because the working tree has uncommitted or untracked
  // changes that the merge would overwrite. Show the relevant files in a scrollable,
  // multi-select list and let the user commit or stash the selected ones, then retry.
  const dirtyBlocked = /local changes to the following files would be overwritten|untracked working tree files would be overwritten|commit your changes or stash|Please commit your changes|cannot merge.*uncommitted|overwritten by merge/i.test(err);
  if (dirtyBlocked) {
    // Parse the exact blocking files from git's message (tab-indented lines).
    const blocking = err.split('\n').map(l => l.trim()).filter(l =>
      l && !/would be overwritten|please|aborting|commit your changes|move or remove|error:|^merge|^updating/i.test(l));
    await showPreMergeFilesDialog(branch, strategy, message, blocking);
    return;
  }

  // Any other error.
  showToast(err, 'error', 8000);
}

// Pre-merge dialog: lists the uncommitted files that block the merge, with a scrollable
// multi-select list (+ select-all). The user commits or stashes the SELECTED files, then
// the merge is retried automatically. If unhandled blocking files remain, it reappears.
async function showPreMergeFilesDialog(branch, strategy, message, blockingFiles) {
  // Build the candidate file list. Prefer git's reported blocking files; fall back to the
  // full set of working-tree changes from status.
  let files = (blockingFiles || []).filter(Boolean);
  const st = await gs.status();
  const allDirty = (st.ok && st.data && st.data.files) ? st.data.files.map(f => f.path) : [];
  if (!files.length) files = allDirty;
  files = [...new Set(files)];
  if (!files.length) { showToast('No uncommitted changes detected.', 'info'); return; }

  // Map a path → status letter for the chip.
  const statusByPath = {};
  if (st.ok && st.data && st.data.files) {
    st.data.files.forEach(f => { statusByPath[f.path] = (f.index && f.index.trim()) || (f.working_dir && f.working_dir.trim()) || f.status || 'M'; });
  }
  const untrackedSet = new Set((st.ok && st.data && st.data.not_added) ? st.data.not_added : []);
  const letterFor = (p) => untrackedSet.has(p) ? 'U' : (statusByPath[p] || 'M');

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Git won't merge <strong>${escapeHtml(branch)}</strong> yet — these uncommitted changes would be overwritten. Select the files, then <strong>commit</strong> or <strong>stash</strong> them. The merge runs automatically afterwards.</p>
    <div class="premerge-toolbar">
      <label class="premerge-selectall"><input type="checkbox" id="premerge-all" checked /> Select all</label>
      <span class="premerge-count" id="premerge-count"></span>
    </div>
    <ul class="premerge-list" id="premerge-list"></ul>
    <div class="modal-field" id="premerge-msg-wrap" style="margin-top:12px">
      <label>Commit message <span class="text-muted" style="font-weight:400">(only needed for “Commit selected”)</span></label>
      <textarea id="premerge-msg" rows="2" style="width:100%;font-family:var(--font-mono);font-size:13px;resize:vertical" placeholder="Changes before merging ${escapeHtml(branch)}"></textarea>
    </div>
  `;

  const listEl = body.querySelector('#premerge-list');
  files.forEach(path => {
    const li = document.createElement('li');
    li.className = 'premerge-item';
    li.innerHTML = `
      <label class="premerge-row">
        <input type="checkbox" class="premerge-cb" value="${escapeHtml(path)}" checked />
        <span class="premerge-status s-${letterFor(path)}">${letterFor(path)}</span>
        <span class="premerge-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
      </label>`;
    listEl.appendChild(li);
  });

  const allCb = body.querySelector('#premerge-all');
  const countEl = body.querySelector('#premerge-count');
  const cbs = () => Array.from(body.querySelectorAll('.premerge-cb'));
  const selected = () => cbs().filter(c => c.checked).map(c => c.value);
  const updateCount = () => {
    const n = selected().length, total = cbs().length;
    countEl.textContent = `${n} of ${total} selected`;
    allCb.checked = n === total;
    allCb.indeterminate = n > 0 && n < total;
  };
  allCb.onclick = () => { cbs().forEach(c => { c.checked = allCb.checked; }); updateCount(); };
  cbs().forEach(c => c.onchange = updateCount);
  updateCount();

  const cancel = document.createElement('button');
  cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
  cancel.onclick = () => modal.hide();

  const stashBtn = document.createElement('button');
  stashBtn.className = 'btn-medieval';
  stashBtn.innerHTML = '<span class="btn-icon">⚿</span> Stash selected';
  stashBtn.onclick = async () => {
    const paths = selected();
    if (!paths.length) { showToast('Select at least one file', 'error'); return; }
    modal.hide();
    const sr = await withLoading('Stashing selected', () =>
      gs.stash({ paths, includeUntracked: true, message: `[GitGood] before merging ${branch}` }));
    if (!sr.ok) { showToast('Stash failed: ' + sr.error, 'error', 7000); return; }
    await refreshAll();
    await runMerge(branch, strategy, message);
  };

  const commitBtn = document.createElement('button');
  commitBtn.className = 'btn-medieval primary';
  commitBtn.innerHTML = '<span class="btn-icon">✓</span> Commit selected';
  commitBtn.onclick = async () => {
    const paths = selected();
    if (!paths.length) { showToast('Select at least one file', 'error'); return; }
    const msg = (body.querySelector('#premerge-msg').value || '').trim();
    if (!msg) { showToast('Enter a commit message to commit', 'error'); body.querySelector('#premerge-msg').focus(); return; }
    modal.hide();
    const cr = await withLoading('Committing selected', () => gs.commitPaths({ message: msg, paths }));
    if (!cr.ok) { showToast('Commit failed: ' + cr.error, 'error', 7000); return; }
    await refreshAll();
    await runMerge(branch, strategy, message);
  };

  modal.show({ title: 'Resolve Uncommitted Changes', body, footer: [cancel, stashBtn, commitBtn] });
}

// ============================================
// CUSTOM SELECT DROPDOWN COMPONENT
// ============================================
// Used for the checkout / merge branch pickers in the Branches tab.
// Builds a styled dropdown with a search field, grouped by Local / Remote.
function setupCustomSelect({ triggerId, dropdownId, placeholder, onSelect, getCurrentValue }) {
  const trigger = document.getElementById(triggerId);
  const dropdown = document.getElementById(dropdownId);
  if (!trigger || !dropdown) return null;
  const container = trigger.parentElement;
  let currentSearch = '';
  let currentValue = null;

  function setLabel(value) {
    currentValue = value;
    const span = trigger.querySelector('.cs-text');
    if (!span) return;
    if (value) {
      span.textContent = value;
      span.classList.remove('placeholder');
    } else {
      span.textContent = placeholder || 'Select…';
      span.classList.add('placeholder');
    }
  }

  function close() {
    container.classList.remove('open');
    currentSearch = '';
  }

  function open() {
    // Close any other open dropdowns
    document.querySelectorAll('.custom-select.open').forEach(el => { if (el !== container) el.classList.remove('open'); });
    container.classList.add('open');
    rebuildOptions();
    setTimeout(() => {
      const s = dropdown.querySelector('.cs-search');
      if (s) s.focus();
    }, 50);
  }

  function rebuildOptions() {
    const { local, remotes } = state.branches || {};
    const localAll = (local && local.all) || [];
    const remoteAll = (remotes && remotes.all) || [];
    const currentBranch = (local && local.current) || '';
    const filter = currentSearch.trim().toLowerCase();

    const filteredLocal = localAll.filter(b => !filter || b.toLowerCase().includes(filter));
    const filteredRemote = remoteAll.filter(b => !filter || b.toLowerCase().includes(filter));

    const parts = [`
      <div class="cs-search-wrap">
        <input type="text" class="cs-search" placeholder="Filter branches…" value="${escapeHtml(currentSearch)}" />
      </div>
    `];

    if (filteredLocal.length) {
      parts.push(`<div class="cs-group-label">Local</div>`);
      for (const b of filteredLocal) {
        const isCurrent = b === currentBranch;
        const isSelected = currentValue === b;
        const meta = isCurrent ? '<span class="cs-option-meta">current</span>' : '';
        parts.push(`
          <div class="cs-option${isSelected ? ' selected' : ''}${isCurrent ? ' disabled' : ''}" data-value="${escapeHtml(b)}" data-is-current="${isCurrent}">
            <span class="cs-option-icon">⑂</span>
            <span>${escapeHtml(b)}</span>
            ${meta}
          </div>
        `);
      }
    }
    if (filteredRemote.length) {
      parts.push(`<div class="cs-group-label">Remote</div>`);
      for (const b of filteredRemote) {
        const isSelected = currentValue === b;
        parts.push(`
          <div class="cs-option${isSelected ? ' selected' : ''}" data-value="${escapeHtml(b)}">
            <span class="cs-option-icon" style="color:#6b8e23">⟁</span>
            <span>${escapeHtml(b)}</span>
          </div>
        `);
      }
    }
    if (!filteredLocal.length && !filteredRemote.length) {
      parts.push(`<div class="cs-empty">${filter ? 'No matches' : 'No branches'}</div>`);
    }

    dropdown.innerHTML = parts.join('');

    const searchInput = dropdown.querySelector('.cs-search');
    if (searchInput) {
      searchInput.oninput = () => {
        currentSearch = searchInput.value;
        rebuildOptions();
      };
      searchInput.onkeydown = (e) => {
        if (e.key === 'Escape') { close(); trigger.focus(); }
      };
    }
    dropdown.querySelectorAll('.cs-option').forEach(opt => {
      opt.onclick = () => {
        if (opt.classList.contains('disabled')) return;
        const val = opt.dataset.value;
        setLabel(val);
        close();
        if (onSelect) onSelect(val);
      };
    });
  }

  trigger.onclick = (e) => {
    e.stopPropagation();
    if (container.classList.contains('open')) close();
    else open();
  };
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) close();
  });

  // Initial label
  setLabel(getCurrentValue ? getCurrentValue() : null);

  return { setLabel, open, close, rebuild: rebuildOptions };
}

// ============================================
// BRANCHES TAB
// ============================================
let checkoutSelectCtl = null;
let mergeSelectCtl = null;

function renderBranchesTab() {
  // Update current banner card
  const card = $('#branches-current-card');
  if (card) {
    const current = (state.branches.local && state.branches.local.current) || '';
    card.textContent = current ? '⑂ ' + current : '— no branch —';
  }

  // Lazy-init the custom selects on first render
  if (!checkoutSelectCtl) {
    checkoutSelectCtl = setupCustomSelect({
      triggerId: 'checkout-trigger',
      dropdownId: 'checkout-dropdown',
      placeholder: 'Select a branch…',
      onSelect: (val) => { state.checkoutTarget = val; }
    });
  } else {
    checkoutSelectCtl.rebuild();
  }
  if (!mergeSelectCtl) {
    mergeSelectCtl = setupCustomSelect({
      triggerId: 'merge-trigger',
      dropdownId: 'merge-dropdown',
      placeholder: 'Select a branch to merge…',
      onSelect: (val) => { state.mergeTarget = val; }
    });
  } else {
    mergeSelectCtl.rebuild();
  }

  // Render the full branches list
  renderBranchesFullList();
}

function renderBranchesFullList() {
  const list = $('#branches-full-list');
  if (!list) return;
  const { local, remotes } = state.branches || {};
  const localAll = (local && local.all) || [];
  const remoteAll = (remotes && remotes.all) || [];
  const currentBranch = (local && local.current) || '';
  const filter = (state.branchesFilter || '').trim().toLowerCase();
  const matches = (b) => !filter || b.toLowerCase().includes(filter);

  const filteredLocal = localAll.filter(matches);
  const filteredRemote = remoteAll.filter(matches);

  const rows = [];

  filteredLocal.forEach(b => {
    const isCurrent = b === currentBranch;
    rows.push(`
      <li class="branch-row${isCurrent ? ' is-current' : ''}" data-branch="${escapeHtml(b)}" data-kind="local">
        <span class="branch-icon">⑂</span>
        <span class="branch-name">${escapeHtml(b)}</span>
        <span class="branch-type-pill">${isCurrent ? 'Current' : 'Local'}</span>
        <span class="branch-actions">
          ${!isCurrent ? `<button class="mini-btn" data-action="checkout">Checkout</button>` : ''}
          ${!isCurrent ? `<button class="mini-btn" data-action="merge">Merge</button>` : ''}
          ${!isCurrent ? `<button class="mini-btn" data-action="delete">Delete</button>` : ''}
        </span>
      </li>
    `);
  });
  filteredRemote.forEach(b => {
    rows.push(`
      <li class="branch-row is-remote" data-branch="${escapeHtml(b)}" data-kind="remote">
        <span class="branch-icon">⟁</span>
        <span class="branch-name">${escapeHtml(b)}</span>
        <span class="branch-type-pill">Remote</span>
        <span class="branch-actions">
          <button class="mini-btn" data-action="checkout-remote">Checkout</button>
          <button class="mini-btn" data-action="merge">Merge</button>
          <button class="mini-btn danger" data-action="delete-remote">Delete</button>
        </span>
      </li>
    `);
  });

  if (!rows.length) {
    list.innerHTML = `<li class="file-empty">${filter ? 'No matches' : 'No branches'}</li>`;
    return;
  }
  list.innerHTML = rows.join('');

  list.querySelectorAll('.branch-row').forEach(row => {
    const branch = row.dataset.branch;
    const kind = row.dataset.kind;
    row.oncontextmenu = (e) => {
      e.preventDefault();
      if (kind === 'local') showRefContextMenu('local', branch, e.pageX, e.pageY);
      else showRefContextMenu('remote', branch, e.pageX, e.pageY);
    };
    row.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const a = btn.dataset.action;
        if (a === 'checkout') checkoutBranch(branch);
        else if (a === 'checkout-remote') {
          const local = branch.replace(/^[^/]+\//, '');
          checkoutRemoteBranch(branch, local);
        }
        else if (a === 'merge') showSmartMergeDialog(branch);
        else if (a === 'delete') deleteBranch(branch, false);
        else if (a === 'delete-remote') deleteRemoteBranch(branch);
      };
    });
  });
}

// Wire up branches tab buttons (once)
function wireBranchesTab() {
  const filter = $('#branches-filter');
  if (filter) {
    filter.oninput = () => { state.branchesFilter = filter.value; renderBranchesFullList(); };
  }
  const checkoutBtn = $('#checkout-btn');
  if (checkoutBtn) {
    checkoutBtn.onclick = () => {
      if (!state.checkoutTarget) { showToast('Select a branch first', 'error'); return; }
      const target = state.checkoutTarget;
      const remotes = (state.branches.remotes && state.branches.remotes.all) || [];
      if (remotes.includes(target)) {
        const local = target.replace(/^[^/]+\//, '');
        checkoutRemoteBranch(target, local);
      } else {
        checkoutBranch(target);
      }
    };
  }
  const mergeBtn = $('#merge-btn');
  if (mergeBtn) {
    mergeBtn.onclick = () => {
      if (!state.mergeTarget) { showToast('Select a branch first', 'error'); return; }
      showSmartMergeDialog(state.mergeTarget);
    };
  }
  const newBranchBtn = $('#new-branch-btn');
  if (newBranchBtn) {
    newBranchBtn.onclick = async () => {
      const name = $('#new-branch-input').value.trim();
      const checkout = $('#new-branch-checkout').checked;
      if (!name) { showToast('Branch name required', 'error'); return; }
      const r = await gs.createBranch({ name, checkout });
      if (handleResult(r, `Branch ${name} forged`)) {
        $('#new-branch-input').value = '';
        await refreshAll();
      }
    };
  }
  const newInput = $('#new-branch-input');
  if (newInput) {
    newInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#new-branch-btn').click();
    });
  }
}

// Wire up graph tab controls (once)
function wireGraphTab() {
  const limit = $('#graph-limit');
  if (limit) {
    limit.onchange = async () => {
      let v = parseInt(limit.value, 10);
      if (isNaN(v) || v < 50) return;
      // Hard cap — beyond this the renderer becomes unresponsive without virtual scrolling.
      const HARD_CAP = 5000;
      if (v > HARD_CAP) {
        const ok = await modal.confirm({
          title: 'Large Chronicle',
          message: `Rendering more than ${HARD_CAP.toLocaleString()} commits may slow the app or cause it to lock up. Continue with ${v.toLocaleString()}? (Recommended: keep at ${HARD_CAP.toLocaleString()} or below.)`,
          danger: true,
          confirmText: 'Continue'
        });
        if (!ok) {
          v = HARD_CAP;
          limit.value = v;
        }
      }
      state.graphLimit = v;
      refreshGraph();
    };
  }
  const refresh = $('#graph-refresh');
  if (refresh) refresh.onclick = () => refreshGraph();

  // Load more (#9): bump the limit by a page and refetch. graphLog uses `--all --topo-order`
  // (a global ordering), so true offset-pagination isn't well-defined — refetching a larger
  // window is the correct, simple approach and reuses the existing layout pipeline.
  const loadMore = $('#graph-load-more');
  if (loadMore) loadMore.onclick = async () => {
    if (state.graphAtEnd) return;
    const STEP = 300;
    const HARD_CAP = 5000;
    let v = (state.graphLimit || 300) + STEP;
    if (v > HARD_CAP) {
      const ok = await modal.confirm({
        title: 'Large Chronicle',
        message: `Loading more than ${HARD_CAP.toLocaleString()} commits may slow the app or cause it to lock up. Continue?`,
        danger: true,
        confirmText: 'Continue'
      });
      if (!ok) return;
    }
    state.graphLimit = v;
    const limitInput = $('#graph-limit');
    if (limitInput) limitInput.value = v;
    refreshGraph();
  };

  const collapseBtn = $('#graph-collapse-toggle');
  if (collapseBtn) collapseBtn.onclick = () => {
    state.graphCollapsed = !state.graphCollapsed;
    updateGraphCollapseButton();
    relayoutGraph();
  };
  updateGraphCollapseButton();

  // Graph search/filter (debounced so typing stays smooth on large graphs)
  const graphSearch = $('#graph-search');
  const graphMode = $('#graph-search-mode');
  if (graphSearch) {
    let t = null;
    graphSearch.value = state.graphFilter || '';
    if (graphMode) graphMode.value = state.graphFilterMode || 'message';
    const applyGraph = async () => {
      state.graphFilter = graphSearch.value;
      // If filtering by files, make sure the commit→files map is loaded first; if filtering
      // by diff content, make sure the pickaxe match set for this query is loaded first.
      if ((state.graphFilterMode === 'files' || state.graphFilterMode === 'all') && state.graphFilter.trim()) {
        await ensureCommitFilesMap();
      } else if (state.graphFilterMode === 'content' && state.graphFilter.trim()) {
        await ensureContentMatches(state.graphFilter);
      }
      relayoutGraph();
    };
    graphSearch.oninput = () => { clearTimeout(t); t = setTimeout(applyGraph, 180); };
    graphSearch.onkeydown = (e) => {
      if (e.key === 'Escape') { graphSearch.value = ''; state.graphFilter = ''; relayoutGraph(); }
    };
    if (graphMode) graphMode.onchange = () => {
      state.graphFilterMode = graphMode.value;
      applyGraph();
    };
  }

  // History search/filter
  const historySearch = $('#history-search');
  const historyMode = $('#history-search-mode');
  if (historySearch) {
    let t2 = null;
    historySearch.value = state.historyFilter || '';
    if (historyMode) historyMode.value = state.historyFilterMode || 'message';
    const applyHistory = async () => {
      state.historyFilter = historySearch.value;
      if ((state.historyFilterMode === 'files' || state.historyFilterMode === 'all') && state.historyFilter.trim()) {
        await ensureCommitFilesMap();
      } else if (state.historyFilterMode === 'content' && state.historyFilter.trim()) {
        await ensureContentMatches(state.historyFilter);
      }
      renderHistory();
    };
    historySearch.oninput = () => { clearTimeout(t2); t2 = setTimeout(applyHistory, 180); };
    historySearch.onkeydown = (e) => {
      if (e.key === 'Escape') { historySearch.value = ''; state.historyFilter = ''; renderHistory(); }
    };
    if (historyMode) historyMode.onchange = () => {
      state.historyFilterMode = historyMode.value;
      applyHistory();
    };
  }
}

// Reflect the collapse state on the toolbar button.
function updateGraphCollapseButton() {
  const btn = document.getElementById('graph-collapse-toggle');
  if (!btn) return;
  if (state.graphCollapsed) {
    btn.innerHTML = '⊞ Expand';
    btn.title = 'Show all commits';
    btn.classList.add('active');
  } else {
    btn.innerHTML = '⊟ Collapse';
    btn.title = `Collapse the middle of long history, showing only the newest ${GRAPH_COLLAPSE_VISIBLE} commits`;
    btn.classList.remove('active');
  }
}

// Reflect whether more history can be loaded on the "Load more" button (#9). When the last
// fetch returned fewer commits than requested, the whole history is loaded — disable it.
function updateLoadMoreButton() {
  const btn = document.getElementById('graph-load-more');
  if (!btn) return;
  if (state.graphAtEnd) {
    btn.disabled = true;
    btn.innerHTML = '↧ All loaded';
    btn.title = 'The entire history is already loaded';
  } else {
    btn.disabled = false;
    btn.innerHTML = '↧ Load more';
    btn.title = 'Load another batch of older commits';
  }
}

// Call wiring on load (idempotent since onclick reassigns)
wireBranchesTab();
wireGraphTab();

// Detached-HEAD banner buttons
(() => {
  const ret = document.getElementById('detached-banner-return');
  if (ret) ret.onclick = () => returnToBranch();
  const nb = document.getElementById('detached-banner-newbranch');
  if (nb) nb.onclick = () => {
    const head = (state.status && state.status.headHash) || 'HEAD';
    showCreateBranchDialog(head);
  };
})();

// ============================================
// OPERATION PROGRESS (clone/pull/push/fetch/lfs) — feeds real % into opProgress
// ============================================
(() => {
  if (!gs.onOpProgress) return;

  // Human-friendly labels for simple-git's stage names
  const STAGE_LABELS = {
    'receiving': 'Receiving',
    'counting': 'Counting',
    'compressing': 'Compressing',
    'writing': 'Writing',
    'resolving': 'Resolving',
    'remote:': 'Remote'
  };

  gs.onOpProgress((p) => {
    if (p.done || p.active === false) {
      // The withLoading wrapper around the operation will call end(); but if a
      // transfer finished without that wrapper, make sure we settle the bar.
      // We only force-complete the bar's fill here; hiding is handled by end().
      opProgress.setPercent(100);
      return;
    }

    // Build label: "Method · Stage"
    const method = (p.method || '').toString();
    const stageRaw = (p.stage || '').toString().toLowerCase();
    const stage = STAGE_LABELS[stageRaw] || (p.stage || '');
    const label = [method, stage].filter(Boolean).join(' · ') || 'Working';

    const hasPct = typeof p.progress === 'number' && !isNaN(p.progress) && p.progress > 0;
    if (hasPct) {
      opProgress.setPercent(p.progress, label);
    } else {
      // No percentage yet — keep an indeterminate bar with the label (without
      // touching the active-operation counter that begin()/end() manage).
      opProgress.indeterminate(label);
    }
  });
})();


gs.onMenu('menu-open-repo', () => openRepoDialog());
gs.onMenu('menu-clone-repo', () => showCloneDialog());
gs.onMenu('menu-about', () => {
  modal.show({
    title: 'About GitGood',
    body: `
      <div style="text-align:center;padding:20px">
        <div style="font-family:var(--font-display);font-size:32px;color:var(--bone-white);letter-spacing:0.15em;margin-bottom:8px">GitGood</div>
        <div style="font-family:var(--font-ornament);color:var(--parchment-dim);margin-bottom:16px">⚜ Version 1.0.0 ⚜</div>
        <p class="modal-text">A medieval-themed Git GUI client forged in the fires of the crusade.</p>
        <p class="modal-text" style="font-size:12px;color:var(--muted-text)">Built with Electron and simple-git.</p>
      </div>
    `,
    footer: (() => {
      const b = document.createElement('button');
      b.className = 'btn-medieval primary';
      b.textContent = 'Close';
      b.onclick = () => modal.hide();
      return b;
    })()
  });
});

// ============================================
// DISK MANAGEMENT
// ============================================
const _diskState = { loaded: false, lastData: null, stale: false };
let _diskScanGen = 0;  // increments each refreshDiskUsage call; stale calls bail out

// Show a subtle hint that the disk figures may be out of date (repo changed since
// the last scan). We don't rescan automatically — the user clicks Refresh to update.
function markDiskStale() {
  const refreshBtn = document.getElementById('disk-refresh');
  if (refreshBtn && _diskState.loaded) {
    refreshBtn.classList.add('stale');
    refreshBtn.title = 'Figures may be out of date — click to recalculate';
  }
}
function clearDiskStale() {
  _diskState.stale = false;
  const refreshBtn = document.getElementById('disk-refresh');
  if (refreshBtn) {
    refreshBtn.classList.remove('stale');
    refreshBtn.title = 'Recalculate disk usage';
  }
}

function fmtBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Subscription handle for disk progress; we unsubscribe between scans.
let _diskProgressUnsub = null;

async function refreshDiskUsage() {
  // Each call gets a generation id. If a newer call starts while this one is still
  // awaiting the backend, this (stale) call must not touch the UI when it resolves —
  // otherwise a just-cancelled scan's continuation can clobber the fresh scan's UI
  // (e.g. show "Cancelled" over a running retry).
  const myGen = ++_diskScanGen;
  const isStale = () => myGen !== _diskScanGen;

  const loading = $('#disk-loading');
  const summary = $('#disk-summary');
  const progress = $('#disk-progress');

  // Drop any previous progress subscription so its events don't bleed into this scan.
  if (_diskProgressUnsub) { try { _diskProgressUnsub(); } catch (e) {} _diskProgressUnsub = null; }

  // Subscribe to streaming progress for the upcoming scan. The backend automatically
  // cancels any in-flight scan when a new diskUsage() call arrives (token bump),
  // so we don't need a manual cancel here.
  _diskProgressUnsub = gs.onDiskProgress((payload) => {
    if (isStale() || !progress) return;
    if (payload.done) {
      progress.classList.add('hidden');
      return;
    }
    progress.classList.remove('hidden');
    const label = payload.label || payload.phase || 'Scanning';
    const bytes = payload.bytes ? fmtBytes(payload.bytes) : '';
    const files = payload.files ? payload.files.toLocaleString() + ' files' : '';
    const detail = [bytes, files].filter(Boolean).join(' · ');
    const labelEl = progress.querySelector('.disk-progress-label');
    const detailEl = progress.querySelector('.disk-progress-detail');
    if (labelEl) labelEl.textContent = label + '…';
    if (detailEl) detailEl.textContent = detail;
  });

  // Show progress UI
  if (loading) loading.style.display = 'none';
  if (progress) progress.classList.remove('hidden');
  if (summary) summary.style.display = 'flex';

  let r;
  try {
    r = await gs.diskUsage();
  } finally {
    // Only the most recent scan cleans up the shared progress UI/subscription.
    if (!isStale()) {
      if (_diskProgressUnsub) { try { _diskProgressUnsub(); } catch (e) {} _diskProgressUnsub = null; }
      if (progress) progress.classList.add('hidden');
    }
  }

  // A newer scan superseded this one — leave the UI entirely to that newer call.
  if (isStale()) return;

  if (!r.ok) {
    if (loading) { loading.style.display = ''; loading.textContent = 'Failed: ' + r.error; }
    if (summary) summary.style.display = 'none';
    return;
  }
  if (r.data && r.data.cancelled) {
    if (loading) { loading.style.display = ''; loading.textContent = 'Cancelled — click to retry'; }
    return;
  }
  _diskState.lastData = r.data;
  _diskState.loaded = true;
  clearDiskStale();
  if (loading) loading.style.display = 'none';
  if (summary) summary.style.display = 'flex';

  const { sizes, counts, lfs } = r.data;
  const total = sizes.workingTree + sizes.gitTotal;

  $('#disk-grand-total').textContent = fmtBytes(total);
  $('#disk-total-pill').textContent = fmtBytes(total);
  $('#disk-working').textContent = fmtBytes(sizes.workingTree);
  $('#disk-gitdir').textContent = fmtBytes(sizes.gitTotal);
  $('#disk-packed').textContent = fmtBytes(sizes.objectsPacked);
  $('#disk-loose').textContent = fmtBytes(sizes.objectsLoose);
  $('#disk-logs').textContent = fmtBytes(sizes.logs);

  if (lfs.installed) {
    $('#disk-lfs-row').style.display = '';
    $('#disk-lfs').textContent = lfs.objectSize ? `${fmtBytes(lfs.objectSize)} (${lfs.objectCount} files)` : 'installed (no cache yet)';
    $('#disk-lfs-prune').style.display = '';
  } else {
    $('#disk-lfs-row').style.display = 'none';
    $('#disk-lfs-prune').style.display = 'none';
  }

  // Stacked bar
  const fill = $('#disk-bar-fill');
  const segs = [
    { cls: 'working', value: sizes.workingTree, label: 'Working' },
    { cls: 'packed',  value: sizes.objectsPacked, label: 'Packed' },
    { cls: 'loose',   value: sizes.objectsLoose,  label: 'Loose' },
    { cls: 'logs',    value: sizes.logs,          label: 'Logs' }
  ];
  if (lfs.installed && lfs.objectSize) {
    segs.push({ cls: 'lfs', value: lfs.objectSize, label: 'LFS' });
  }
  // "Other" = gitTotal - packed - loose - logs - lfs
  const accountedGit = sizes.objectsPacked + sizes.objectsLoose + sizes.logs + (lfs.installed ? lfs.objectSize : 0);
  const otherGit = Math.max(0, sizes.gitTotal - accountedGit);
  if (otherGit > 0) segs.push({ cls: 'other', value: otherGit, label: 'Other' });

  const sum = segs.reduce((a, s) => a + s.value, 0) || 1;
  fill.innerHTML = segs.filter(s => s.value > 0)
    .map(s => `<div class="disk-bar-seg ${s.cls}" style="width:${(s.value / sum * 100).toFixed(2)}%" title="${s.label}: ${fmtBytes(s.value)}"></div>`)
    .join('');

  // Legend (only segments with > 1% share)
  $('#disk-legend').innerHTML = segs.filter(s => s.value > 0)
    .map(s => `<span><span class="swatch" style="background:${segColor(s.cls)}"></span>${s.label}</span>`)
    .join('');

  // Counts
  $('#disk-c-local').textContent = counts.localBranches;
  $('#disk-c-remote').textContent = counts.remoteBranches;
  $('#disk-c-tags').textContent = counts.tags;
  $('#disk-c-stash').textContent = counts.stashes;
  $('#disk-c-reflog').textContent = counts.reflogEntries;
}

function segColor(cls) {
  return {
    working: '#6b8e23',
    packed: 'var(--crusader-red)',
    loose: 'var(--gold-accent)',
    logs: '#6db8c4',
    lfs: '#b388d3',
    other: 'var(--border-bright)'
  }[cls] || '#888';
}

// Wire up the disk management section
(() => {
  // Collapsible sidebar sections: clicking a section header toggles its collapsed state.
  // (Current Banner, Local/Remote Branches, Disk Management, Stashes, Remotes.)
  document.querySelectorAll('.sidebar-section.collapsible > .sidebar-header.clickable').forEach(header => {
    header.addEventListener('click', () => {
      const section = header.closest('.sidebar-section');
      if (section) section.classList.toggle('collapsed');
    });
  });

  // Clicking the header loads data the first time
  const section = document.getElementById('section-disk');
  if (section) {
    const header = section.querySelector('.sidebar-header');
    if (header) {
      header.addEventListener('click', () => {
        // After the collapse toggle (handled elsewhere), if expanded and not yet loaded, load
        setTimeout(() => {
          if (!section.classList.contains('collapsed') && !_diskState.loaded && state.repo) {
            refreshDiskUsage();
          }
        }, 50);
      });
    }
  }

  // Loading placeholder click also triggers load
  const loading = $('#disk-loading');
  if (loading) loading.onclick = () => {
    if (state.repo) refreshDiskUsage();
    else showToast('Open a repository first', 'error');
  };

  // Action buttons
  const wire = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.onclick = handler;
  };

  wire('disk-refresh', () => refreshDiskUsage());
  wire('disk-progress-cancel', async () => {
    try { await gs.diskUsageCancel(); } catch (e) {}
  });

  wire('disk-gc', async () => {
    const ok = await modal.confirm({
      title: 'Run Git Garbage Collection',
      message: 'Pack loose objects and remove unreachable ones older than 2 weeks. This is the standard cleanup operation.',
      confirmText: 'Run GC'
    });
    if (!ok) return;
    const r = await withLoading('Running gc', () => gs.gc({}));
    if (handleResult(r, 'GC complete')) await refreshDiskUsage();
  });

  wire('disk-gc-aggressive', async () => {
    const ok = await modal.confirm({
      title: 'Aggressive Garbage Collection',
      message: 'Slower but achieves maximum compression by repacking everything. Use sparingly — may take minutes on large repos.',
      confirmText: 'Run Aggressive GC'
    });
    if (!ok) return;
    const r = await withLoading('Aggressive gc — this may take a while', () => gs.gc({ aggressive: true, prune: true, pruneSpec: 'now' }));
    if (handleResult(r, 'Aggressive GC complete')) await refreshDiskUsage();
  });

  wire('disk-prune', async () => {
    const ok = await modal.confirm({
      title: 'Prune Unreachable Objects',
      message: 'Permanently delete loose objects that aren\'t reachable from any branch, tag, or reflog. Anything in the reflog (within its expiry window) is preserved.',
      danger: true,
      confirmText: 'Prune'
    });
    if (!ok) return;
    const r = await withLoading('Pruning', () => gs.prune());
    if (handleResult(r, 'Prune complete')) await refreshDiskUsage();
  });

  wire('disk-repack', async () => {
    const ok = await modal.confirm({
      title: 'Repack Objects',
      message: 'Repack all objects into a single pack file. Useful after large pulls or merges.',
      confirmText: 'Repack'
    });
    if (!ok) return;
    const r = await withLoading('Repacking', () => gs.repack());
    if (handleResult(r, 'Repack complete')) await refreshDiskUsage();
  });

  wire('disk-reflog', async () => {
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="modal-text">Expire reflog entries to free disk space. The reflog records every HEAD update and grows over time.</p>
      <div class="merge-strategies">
        <label class="merge-strategy selected">
          <input type="radio" name="reflog-mode" value="all" checked />
          <div class="merge-strategy-body">
            <div class="merge-strategy-title">Expire All Now</div>
            <div class="merge-strategy-desc">Drop every reflog entry. <strong>You lose the ability to recover lost commits via the reflog.</strong></div>
          </div>
        </label>
        <label class="merge-strategy">
          <input type="radio" name="reflog-mode" value="unreachable" />
          <div class="merge-strategy-body">
            <div class="merge-strategy-title">Expire Unreachable</div>
            <div class="merge-strategy-desc">Drop only entries pointing to commits no longer reachable from refs. Safer.</div>
          </div>
        </label>
      </div>
    `;
    body.querySelectorAll('.merge-strategy').forEach(card => {
      card.onclick = () => {
        const radio = card.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
        body.querySelectorAll('.merge-strategy').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
      };
    });
    const cancel = document.createElement('button');
    cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
    cancel.onclick = () => modal.hide();
    const ok = document.createElement('button');
    ok.className = 'btn-medieval danger'; ok.textContent = 'Expire';
    ok.onclick = async () => {
      const mode = body.querySelector('input[name="reflog-mode"]:checked').value;
      modal.hide();
      const r = await withLoading('Expiring reflog', () => gs.reflogExpire(
        mode === 'all' ? { expire: 'now', expireUnreachable: 'now' } : { expire: 'never', expireUnreachable: 'now' }
      ));
      if (handleResult(r, 'Reflog expired')) await refreshDiskUsage();
    };
    modal.show({ title: 'Expire Reflog', body, footer: [cancel, ok] });
  });

  wire('disk-merged', async () => {
    const r = await withLoading('Listing branches', () => gs.mergedBranches());
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
    showBranchCleanupDialog(r.data);
  });

  wire('disk-largest', async () => {
    const r = await withLoading('Finding largest objects', () => gs.largestObjects(50));
    if (!r.ok) { showToast(r.error, 'error', 6000); return; }
    showLargestObjectsDialog(r.data.objects);
  });

  wire('disk-lfs-prune', async () => {
    const ok = await modal.confirm({
      title: 'Prune Git LFS Objects',
      message: 'Remove LFS objects no longer referenced by any commit reachable from the current branch.',
      confirmText: 'Prune LFS'
    });
    if (!ok) return;
    const r = await withLoading('Pruning LFS', () => gs.lfsPrune());
    if (handleResult(r, 'LFS pruned')) await refreshDiskUsage();
  });

  wire('disk-lfs-manage', () => showLfsManager());
})();

// ============================================
