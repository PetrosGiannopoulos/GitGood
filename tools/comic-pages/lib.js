// Shared drawing helpers for the comic-page generator: colour maths, seeded randomness,
// paths, and the lettering (balloons, captions, sound effects). Everything returns SVG text.
'use strict';

const INK = '#17120f';
const PAPER = '#f4ecd8';

const f = (n) => Math.round(n * 10) / 10;
const hexRgb = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)); };
const rgbHex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return rgbHex(A.map((v, i) => v + (B[i] - v) * t)); };
const dark = (c, t) => mix(c, '#000000', t);
const light = (c, t) => mix(c, '#ffffff', t);

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2147483647;
}
function rng(seed) {
  let s = (seed % 2147483646) + 1;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  r.range = (a, b) => a + r() * (b - a);
  r.pick = (list) => list[Math.floor(r() * list.length)];
  r.int = (a, b) => Math.floor(a + r() * (b - a + 1));
  return r;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const pts = (list) => list.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');

// A closed smooth outline through the points (Catmull-Rom converted to cubic Béziers).
function smooth(points, closed = true, k = 1) {
  const n = points.length;
  const P = (i) => closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))];
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6 * k, p1[1] + (p2[1] - p0[1]) / 6 * k];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6 * k, p2[1] - (p3[1] - p1[1]) / 6 * k];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + (closed ? ' Z' : '');
}

// A limb: two circles of different radii joined by their outer tangents.
function capsule(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 0.01;
  if (d <= Math.abs(r1 - r2)) { const R = Math.max(r1, r2), cx = r1 > r2 ? x1 : x2, cy = r1 > r2 ? y1 : y2; return `M${f(cx - R)} ${f(cy)} a${f(R)} ${f(R)} 0 1 0 ${f(2 * R)} 0 a${f(R)} ${f(R)} 0 1 0 ${f(-2 * R)} 0 Z`; }
  const a = Math.atan2(dy, dx), al = Math.acos((r1 - r2) / d);
  const u = [Math.cos(a + al), Math.sin(a + al)], v = [Math.cos(a - al), Math.sin(a - al)];
  const A1 = [x1 + r1 * u[0], y1 + r1 * u[1]], B1 = [x2 + r2 * u[0], y2 + r2 * u[1]];
  const B2 = [x2 + r2 * v[0], y2 + r2 * v[1]], A2 = [x1 + r1 * v[0], y1 + r1 * v[1]];
  const big2 = 2 * al > Math.PI ? 1 : 0, big1 = 2 * Math.PI - 2 * al > Math.PI ? 1 : 0;
  return `M${f(A1[0])} ${f(A1[1])} L${f(B1[0])} ${f(B1[1])} A${f(r2)} ${f(r2)} 0 ${big2} 0 ${f(B2[0])} ${f(B2[1])} L${f(A2[0])} ${f(A2[1])} A${f(r1)} ${f(r1)} 0 ${big1} 0 ${f(A1[0])} ${f(A1[1])} Z`;
}

function starPts(cx, cy, R, r, n, rot = -Math.PI / 2) {
  const out = [];
  for (let i = 0; i < n * 2; i++) { const rad = i % 2 ? r : R, a = rot + i * Math.PI / n; out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); }
  return pts(out);
}
function jag(x1, y1, x2, y2, n, amp, r) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, px = -dy / len, py = dx / len;
  const out = [[x1, y1]];
  for (let i = 1; i < n; i++) { const t = i / n, o = (r() * 2 - 1) * amp; out.push([x1 + dx * t + px * o, y1 + dy * t + py * o]); }
  out.push([x2, y2]);
  return out;
}

// ---------- lettering ----------
// Comic lettering is upper case; this is the width Comic Sans Bold averages per character.
const LETTER = "'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', cursive";
const SFX_FONT = "Impact, 'Anton', 'Bebas Neue', sans-serif";
function wrap(text, maxChars) {
  const words = String(text).toUpperCase().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
const textW = (s, fs) => s.length * fs * 0.66;

function textLines(lines, cx, top, fs, anchor = 'middle', extra = '') {
  return `<text font-family="${LETTER}" font-weight="700" font-size="${fs}" fill="${INK}" text-anchor="${anchor}" ${extra}>` +
    lines.map((l, i) => `<tspan x="${f(cx)}" y="${f(top + fs * (i + 0.85) * 1.12)}">${esc(l)}</tspan>`).join('') + '</text>';
}

// A speech balloon at (x, y) (its top-left), sized to its text, with a tail to (tx, ty).
// Returns { svg, w, h } so a caller can place the next one below it.
function balloon(text, x, y, tx, ty, { fs = 25, maxChars = 18, kind = 'speech', fill = '#ffffff', ink = INK } = {}) {
  const lines = wrap(text, maxChars);
  const tw = Math.max(...lines.map(l => textW(l, fs)));
  const th = lines.length * fs * 1.12;
  const w = tw + fs * 2.2, h = th + fs * 1.5;
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  let out = '';
  if (kind === 'thought') {
    let bumps = '';
    const n = Math.max(10, Math.round((w + h) / 38));
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; bumps += `<circle cx="${f(cx + Math.cos(a) * rx * 0.93)}" cy="${f(cy + Math.sin(a) * ry * 0.9)}" r="${f(Math.min(rx, ry) * 0.36)}"/>`; }
    out += `<g fill="${fill}" stroke="${ink}" stroke-width="3.2">${bumps}</g><g fill="${fill}">${bumps.replace(/r="([\d.]+)"/g, (m, r) => `r="${f(r - 3)}"`)}<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx * 0.92)}" ry="${f(ry * 0.88)}"/></g>`;
    [0.62, 0.8, 0.93].forEach((t, i) => out += `<circle cx="${f(cx + (tx - cx) * t)}" cy="${f(cy + ry * 0.8 + (ty - cy - ry * 0.8) * t)}" r="${f(9 - i * 2.5)}" fill="${fill}" stroke="${ink}" stroke-width="2.6"/>`);
  } else {
    // Tail: a curved wedge from the balloon's edge toward the speaker, stopping short of them.
    const ang = Math.atan2(ty - cy, tx - cx);
    const ex = cx + Math.cos(ang) * rx * 0.72, ey = cy + Math.sin(ang) * ry * 0.72;
    const len = Math.hypot(tx - ex, ty - ey), reach = Math.min(len * 0.55, 90);
    const ux = (tx - ex) / (len || 1), uy = (ty - ey) / (len || 1);
    const tipx = ex + ux * (reach + Math.max(rx, ry) * 0.3), tipy = ey + uy * (reach + Math.max(rx, ry) * 0.3);
    const px = -uy, py = ux, bw = Math.min(rx, ry) * 0.36;
    const tail = `M${f(ex + px * bw)} ${f(ey + py * bw)} Q${f((ex + tipx) / 2 + px * bw * 0.2)} ${f((ey + tipy) / 2 + py * bw * 0.2)} ${f(tipx)} ${f(tipy)} Q${f((ex + tipx) / 2 - px * bw * 0.6)} ${f((ey + tipy) / 2 - py * bw * 0.6)} ${f(ex - px * bw)} ${f(ey - py * bw)} Z`;
    const shape = kind === 'shout'
      ? `<polygon points="${starPts(cx, cy, 1, 0.8, 14).split(' ').map(p => { const [a, b] = p.split(',').map(Number); return `${f(cx + (a - cx) * rx * 1.18)},${f(cy + (b - cy) * ry * 1.25)}`; }).join(' ')}"/>`
      : `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}"/>`;
    out += `<g fill="${fill}" stroke="${ink}" stroke-width="3.2" stroke-linejoin="round"><path d="${tail}"/>${shape}</g>`;
    // Cover the seam where tail meets balloon.
    out += `<g fill="${fill}"><path d="${tail}" transform="translate(0 0)" stroke="none"/>${shape.replace('<', '<').replace('/>', ' stroke="none" transform="translate(' + f(cx) + ' ' + f(cy) + ') scale(.985) translate(' + f(-cx) + ' ' + f(-cy) + ')"/>')}</g>`;
  }
  out += textLines(lines, cx, cy - th / 2 - fs * 0.1, kind === 'shout' ? f(fs * 1.08) : fs, 'middle');
  return { svg: out, w, h };
}

// A narration box: square, cream or yellow, text left-aligned.
function caption(text, x, y, { fs = 23, maxChars = 30, fill = '#f7e38a' } = {}) {
  const lines = wrap(text, maxChars);
  const tw = Math.max(...lines.map(l => textW(l, fs)));
  const w = tw + fs * 1.2, h = lines.length * fs * 1.12 + fs * 0.9;
  return {
    svg: `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}" stroke="${INK}" stroke-width="3"/>` + textLines(lines, x + fs * 0.6, y + fs * 0.3, fs, 'start'),
    w, h,
  };
}

// A sound effect: big, slanted, outlined twice (ink then a coloured rim), with a drop shadow.
function sfx(text, x, y, size, { fill = '#ffe14a', rim = '#d8282e', rot = -8, skew = -10 } = {}) {
  const chars = [...text];
  let spans = '';
  chars.forEach((ch, i) => { const s = 1 + Math.sin(i * 1.7) * 0.08; spans += `<tspan font-size="${f(size * s)}" dy="${i ? f(Math.sin(i * 2.1) * size * 0.04) : 0}">${esc(ch)}</tspan>`; });
  const base = `font-family="${SFX_FONT}" font-weight="900" letter-spacing="${f(size * 0.02)}" text-anchor="middle"`;
  const tr = `transform="translate(${f(x)} ${f(y)}) rotate(${rot}) skewX(${skew})"`;
  return `<g ${tr}>` +
    `<text ${base} x="${f(size * 0.06)}" y="${f(size * 0.08)}" fill="${INK}" stroke="${INK}" stroke-width="${f(size * 0.2)}" stroke-linejoin="round">${spans}</text>` +
    `<text ${base} fill="${rim}" stroke="${INK}" stroke-width="${f(size * 0.16)}" stroke-linejoin="round" paint-order="stroke">${spans}</text>` +
    `<text ${base} fill="${fill}" stroke="${rim}" stroke-width="${f(size * 0.05)}" stroke-linejoin="round" paint-order="stroke">${spans}</text></g>`;
}

// Radiating speed lines behind an action beat: thin ink wedges from a focus point.
function burst(pw, ph, cx, cy, r, { color = INK, count = 90, inner = 0.18, opacity = 0.9 } = {}) {
  const R = Math.hypot(pw, ph);
  let d = '';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + r() * 0.05, w = 0.004 + r() * 0.012, start = R * (inner + r() * 0.2);
    const p1 = [cx + Math.cos(a - w) * R, cy + Math.sin(a - w) * R], p2 = [cx + Math.cos(a + w) * R, cy + Math.sin(a + w) * R];
    const p0 = [cx + Math.cos(a) * start, cy + Math.sin(a) * start];
    d += `M${f(p0[0])} ${f(p0[1])} L${f(p1[0])} ${f(p1[1])} L${f(p2[0])} ${f(p2[1])} Z `;
  }
  return `<path d="${d}" fill="${color}" opacity="${opacity}"/>`;
}
// Parallel motion lines (horizontal-ish), for a flying or lunging figure.
function motionLines(pw, ph, r, ang, color = INK, count = 60, opacity = 0.7) {
  let d = '';
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let i = 0; i < count; i++) {
    const cx = r() * pw, cy = r() * ph, len = 80 + r() * 260, w = 0.8 + r() * 2.4;
    d += `M${f(cx - ca * len / 2 - sa * w)} ${f(cy - sa * len / 2 + ca * w)} L${f(cx + ca * len / 2)} ${f(cy + sa * len / 2)} L${f(cx - ca * len / 2 + sa * w)} ${f(cy - sa * len / 2 - ca * w)} Z `;
  }
  return `<path d="${d}" fill="${color}" opacity="${opacity}"/>`;
}

module.exports = { INK, PAPER, f, hexRgb, rgbHex, mix, dark, light, hash, rng, esc, pts, smooth, capsule, starPts, jag, wrap, balloon, caption, sfx, burst, motionLines, LETTER, SFX_FONT };
