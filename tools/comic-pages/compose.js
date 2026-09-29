// A whole comic page for one character: a landscape spread of panels on newsprint.
//
// Each layout is a set of panels tagged with a *beat* — what that panel is for in the
// page's little story. The beats run in reading order (left→right, top→bottom) and each one
// has its own composer below: an establishing shot, a close-up, the hero shot, the action
// beat with its sound effect, a quiet panel, a panel given over to the character's emblem,
// and the closing line. The dialogue is the character's own (heroes.js).
'use strict';
const L = require('./lib');
const { INK, PAPER, f, mix, dark, light, rng, hash, balloon, caption, sfx, burst, motionLines } = L;
const { figure, head, emblem } = require('./figure');
const { SETTINGS } = require('./settings');

const W = 2400, H = 1500, M = 46, G = 22;

// Unit-space layouts: [x, y, w, h, beat]. Built by rows or columns so gutters stay even.
function rows(spec) {
  const out = [];
  let y = 0;
  spec.forEach(([rh, cols]) => {
    let x = 0;
    cols.forEach(([cw, beat]) => { out.push([x, y, cw, rh, beat]); x += cw; });
    y += rh;
  });
  return out;
}
function cols(spec) {
  const out = [];
  let x = 0;
  spec.forEach(([cw, cells]) => {
    let y = 0;
    cells.forEach(([rh, beat]) => { out.push([x, y, cw, rh, beat]); y += rh; });
    x += cw;
  });
  return out;
}
const LAYOUTS = [
  rows([[0.33, [[0.62, 'establish'], [0.38, 'closeup']]], [0.37, [[0.27, 'quiet'], [0.46, 'hero'], [0.27, 'emblem']]], [0.30, [[0.52, 'action'], [0.48, 'finale']]]]),
  cols([[0.3, [[0.5, 'establish'], [0.5, 'closeup']]], [0.4, [[1, 'hero']]], [0.3, [[0.42, 'action'], [0.26, 'emblem'], [0.32, 'finale']]]]),
  rows([[0.42, [[0.36, 'hero'], [0.64, 'establish']]], [0.58, [[0.24, 'closeup'], [0.46, 'action'], [0.3, 'finale']]]]),
  cols([[0.42, [[0.36, 'establish'], [0.64, 'hero']]], [0.58, [[0.4, 'closeup'], [0.6, 'action']]]]).concat([]),
];
// The fourth layout splits its right column's lower cell for a quiet beat and the finale.
LAYOUTS[3] = [
  [0, 0, 0.42, 0.36, 'establish'], [0, 0.36, 0.42, 0.64, 'hero'],
  [0.42, 0, 0.3, 0.4, 'closeup'], [0.72, 0, 0.28, 0.4, 'emblem'],
  [0.42, 0.4, 0.58, 0.32, 'action'], [0.42, 0.72, 0.3, 0.28, 'quiet'], [0.72, 0.72, 0.28, 0.28, 'finale'],
];

function toPx([x, y, w, h, beat]) {
  const iw = W - 2 * M, ih = H - 2 * M;
  const x0 = M + x * iw + (x > 0 ? G / 2 : 0), y0 = M + y * ih + (y > 0 ? G / 2 : 0);
  const x1 = M + (x + w) * iw - (x + w < 0.999 ? G / 2 : 0), y1 = M + (y + h) * ih - (y + h < 0.999 ? G / 2 : 0);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, beat };
}

// ---------- beats ----------
// Each gets the panel size and returns its contents in panel coordinates.
function setting(hero, pw, ph, r, view) {
  const S = SETTINGS[hero.setting] || SETTINGS.city;
  return S(pw, ph, r, Object.assign({ view }, hero.settingOpts || {}));
}

// Figure height that fits a panel: `frac` of the panel height, capped by its width.
const fitH = (pw, ph, frac, aspect = 0.62) => Math.min(ph * frac, pw * 0.9 / aspect);

function placeLines(lines, pw, ph, speaker, r, { side = 'auto', fs = 26, top = 18, kind } = {}) {
  let out = '', y = top;
  const left = side === 'left' || (side === 'auto' && speaker[0] > pw / 2);
  lines.forEach((t, i) => {
    const maxChars = Math.max(10, Math.min(22, Math.floor(pw / (fs * 0.66) / 2.1)));
    const est = L.wrap(t, maxChars);
    const w = Math.max(...est.map(l => l.length)) * fs * 0.66 + fs * 2.2;
    const x = left ? 20 + i * 26 : pw - w - 20 - i * 26;
    const b = balloon(t, Math.max(12, x), y, speaker[0], speaker[1], { fs, maxChars, kind: kind || (t.endsWith('!') && t.length < 14 ? 'shout' : 'speech') });
    out += b.svg;
    y += b.h + 14;
  });
  return out;
}

const BEATS = {
  establish(hero, pw, ph, r) {
    const bg = setting(hero, pw, ph, r, 'wide');
    const fh = fitH(pw, ph, 0.3);
    const fx = pw * (0.62 + r() * 0.2);
    const pose = hero.poses.establish || 'stand';
    let out = bg.svg;
    out += `<g transform="translate(${f(fx)} ${f(pose === 'fly' || pose === 'swing' ? ph * 0.5 : bg.floor)})">${figure(hero, pose, { size: fh, facing: -1 })}</g>`;
    out += caption(hero.lines.caption, 18, 18, { fs: 24, maxChars: Math.min(40, Math.floor(pw / 30)) }).svg;
    return out;
  },
  closeup(hero, pw, ph, r) {
    const c = hero.accent;
    let out = `<rect width="${pw}" height="${ph}" fill="${light(c, 0.55)}"/>`;
    out += burst(pw, ph, pw * 0.62, ph * 0.62, r, { color: light(c, 0.2), count: 70, inner: 0.05, opacity: 0.9 });
    const hr = Math.min(ph * 0.3, pw * 0.22);
    out += `<g transform="translate(${f(pw * 0.64)} ${f(ph * 0.66)})">` +
      `<ellipse cx="0" cy="${f(hr * 2.1)}" rx="${f(hr * 2)}" ry="${f(hr * 1.3)}" fill="${hero.suit.torso}" stroke="${INK}" stroke-width="4"/>` +
      (hero.suit.cape ? `<path d="M${f(-hr * 2.2)} ${f(hr * 1.6)} Q0 ${f(hr * 0.7)} ${f(hr * 2.2)} ${f(hr * 1.6)} L${f(hr * 2.4)} ${f(hr * 3)} L${f(-hr * 2.4)} ${f(hr * 3)} Z" fill="${hero.suit.cape}" stroke="${INK}" stroke-width="4"/>` : '') +
      `<defs><clipPath id="cu${hash(hero.id)}"><circle r="${f(hr * 1.05)}" cy="${f(-hr * 0.05)}"/></clipPath></defs>` +
      `<g stroke-linejoin="round">${head(hero.suit, hr, -1, 'cu' + hash(hero.id))}</g></g>`;
    out += placeLines([hero.lines.closeup], pw, ph, [pw * 0.5, ph * 0.6], r, { side: 'left', fs: 25 });
    return out;
  },
  hero(hero, pw, ph, r) {
    const bg = setting(hero, pw, ph, r, 'mid');
    const pose = hero.poses.hero || 'stand';
    // A flying figure is lying down: its height in the pose is its length on the page.
    const fh = pose === 'fly' ? Math.min(ph * 0.9, pw * 0.8) / 1.25 : fitH(pw, ph, pose === 'crouch' ? 0.5 : 0.72);
    const fx = pose === 'fly' ? pw * 0.46 : pw * 0.5;
    const fy = pose === 'fly' ? ph * 0.6 : pose === 'swing' || pose === 'leap' ? ph * 0.92 : bg.floor + 6;
    let out = bg.svg;
    out += `<g transform="translate(${f(fx)} ${f(fy)})">${figure(hero, pose, { size: fh, facing: hero.facing || 1 })}</g>`;
    out += placeLines(hero.lines.hero, pw, ph, [fx, fy - fh * 0.85], r, { side: 'auto', fs: 26 });
    return out;
  },
  action(hero, pw, ph, r) {
    const c = hero.accent, g = hero.secondary;
    let out = `<rect width="${pw}" height="${ph}" fill="${light(g, 0.35)}"/>`;
    out += burst(pw, ph, pw * 0.4, ph * 0.55, r, { color: '#ffffff', count: 60, inner: 0.02, opacity: 0.75 });
    out += motionLines(pw, ph, r, Math.PI + 0.08, dark(g, 0.35), 40, 0.45);
    const pose = hero.poses.action || 'punch';
    const fh = fitH(pw, ph, pose === 'fly' ? 0.55 : 0.74);
    const fy = pose === 'fly' ? ph * 0.62 : ph * 0.95;
    // Impact star where the blow lands.
    const sx = pw * 0.68, sy = ph * 0.34;
    out += `<polygon points="${L.starPts(sx, sy, Math.min(ph * 0.46, pw * 0.3), Math.min(ph * 0.26, pw * 0.17), 13)}" fill="#ffffff" stroke="${INK}" stroke-width="4"/>`;
    out += `<polygon points="${L.starPts(sx, sy, Math.min(ph * 0.3, pw * 0.2), Math.min(ph * 0.16, pw * 0.1), 11)}" fill="${light(c, 0.25)}"/>`;
    out += `<g transform="translate(${f(pw * 0.34)} ${f(fy)})">${figure(hero, pose, { size: fh, facing: 1 })}</g>`;
    // Impact runs about 0.6em a letter once outlined; keep the word inside the right 60%.
    const size = Math.min(ph * 0.36, pw * 0.6 / (hero.lines.sfx.length * 0.6));
    out += sfx(hero.lines.sfx, sx, sy + size * 0.36, size, { fill: hero.sfxFill || '#ffe14a', rim: hero.sfxRim || c });
    return out;
  },
  quiet(hero, pw, ph, r) {
    const bg = setting(hero, pw, ph, r, 'mid');
    let out = bg.svg + `<rect width="${pw}" height="${ph}" fill="${dark(hero.bg || '#101020', 0.2)}" opacity=".35"/>`;
    const fh = fitH(pw, ph, 0.42);
    out += `<g transform="translate(${f(pw * 0.55)} ${f(bg.floor + 4)})">${figure(hero, hero.poses.quiet || 'crouch', { size: fh, facing: -1 })}</g>`;
    out += caption(hero.lines.quiet, 14, 14, { fs: 22, maxChars: Math.max(12, Math.floor(pw / 26)), fill: '#fbf3dc' }).svg;
    return out;
  },
  emblem(hero, pw, ph, r) {
    const c = hero.accent;
    let out = `<rect width="${pw}" height="${ph}" fill="${hero.secondary}"/>`;
    out += burst(pw, ph, pw / 2, ph / 2, r, { color: light(hero.secondary, 0.3), count: 44, inner: 0.0, opacity: 0.8 });
    const R0 = Math.min(pw, ph) * 0.3;
    out += `<circle cx="${f(pw / 2)}" cy="${f(ph / 2)}" r="${f(R0 * 1.25)}" fill="${c}" stroke="${INK}" stroke-width="5"/>`;
    out += emblem(hero.symbol || hero.suit.emblem || 'star', [pw / 2, ph / 2], R0 * 0.8, hero.symbolColor || '#ffffff', 5, 0);
    if (hero.lines.emblem) out += sfx(hero.lines.emblem, pw / 2, ph * 0.9, Math.min(ph * 0.16, pw * 0.86 / (hero.lines.emblem.length * 0.6)), { fill: '#ffffff', rim: INK, rot: -4, skew: -6 });
    return out;
  },
  finale(hero, pw, ph, r) {
    const bg = setting(hero, pw, ph, r, 'mid');
    const pose = hero.poses.finale || 'hips';
    const fh = fitH(pw, ph, 0.62);
    const fx = pw * 0.68;
    let out = bg.svg;
    out += `<g transform="translate(${f(fx)} ${f(bg.floor + 6)})">${figure(hero, pose, { size: fh, facing: -1 })}</g>`;
    out += placeLines([hero.lines.finale], pw, ph, [fx - fh * 0.1, bg.floor - fh * 0.85], r, { side: 'left', fs: 26 });
    return out;
  },
};

// ---------- the page ----------
function page(hero) {
  const r = rng(hash(hero.id));
  const layout = LAYOUTS[hero.layout != null ? hero.layout : hash(hero.id + 'L') % LAYOUTS.length];
  let body = '';
  layout.map(toPx).forEach((p, i) => {
    const pr = rng(hash(hero.id) + i * 7919);
    const inner = BEATS[p.beat](hero, p.w, p.h, pr);
    body += `<svg x="${f(p.x)}" y="${f(p.y)}" width="${f(p.w)}" height="${f(p.h)}" viewBox="0 0 ${f(p.w)} ${f(p.h)}" overflow="hidden">${inner}</svg>`;
    body += `<rect x="${f(p.x)}" y="${f(p.y)}" width="${f(p.w)}" height="${f(p.h)}" fill="none" stroke="${INK}" stroke-width="6"/>`;
  });
  // Page furniture: a folio and the title strip in the bottom margin.
  body += `<text x="${W - M}" y="${H - 14}" font-family="${L.LETTER}" font-weight="700" font-size="17" fill="${INK}" text-anchor="end" letter-spacing="2">${L.esc(hero.name.toUpperCase())} · ${hash(hero.id) % 30 + 2}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${PAPER}"/>${body}</svg>`;
}

module.exports = { page, W, H, LAYOUTS };
