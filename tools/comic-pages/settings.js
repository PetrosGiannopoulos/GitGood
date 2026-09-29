// Backgrounds: where each character's page takes place. Every setting is drawn into a panel
// of pw×ph and returns { svg, floor } — `floor` is the y a figure stands on. `view` is
// 'wide' (establishing shot, more sky, smaller buildings) or 'mid' (behind a figure).
// Colours are flat or simple gradients: the halftone pass turns tone into dots later.
'use strict';
const { INK, f, mix, dark, light, pts, smooth, starPts, jag } = require('./lib');

const lin = (id, stops, x2 = 0, y2 = 1) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`;
let gid = 0;
const nid = (p) => p + (++gid);

function sky(pw, ph, top, bottom) {
  const id = nid('sk');
  return `<defs>${lin(id, [[0, top], [1, bottom]])}</defs><rect width="${pw}" height="${ph}" fill="url(#${id})"/>`;
}

// A row of buildings between y=base and base-height, with windows.
function skyline(pw, base, r, { minH, maxH, minW = 50, maxW = 150, fill, win, winOn = 0.5, inked = true, roofs = true, winSize = 1 }) {
  let b = '', x = -r() * 60;
  while (x < pw) {
    const w = minW + r() * (maxW - minW), h = minH + r() * (maxH - minH), top = base - h;
    const shade = mix(fill, '#000000', r() * 0.18);
    b += `<rect x="${f(x)}" y="${f(top)}" width="${f(w)}" height="${f(h + 4)}" fill="${shade}" ${inked ? `stroke="${INK}" stroke-width="2.4"` : ''}/>`;
    // Shadowed side face.
    if (inked) b += `<rect x="${f(x + w * 0.72)}" y="${f(top)}" width="${f(w * 0.28)}" height="${f(h + 4)}" fill="#000" opacity=".18"/>`;
    if (roofs && r() < 0.35) {
      const kind = r();
      if (kind < 0.4 && w > 70) { // water tower
        const tx = x + w * (0.25 + r() * 0.4);
        b += `<path d="M${f(tx - 14)} ${f(top)} L${f(tx - 10)} ${f(top - 22)} M${f(tx + 14)} ${f(top)} L${f(tx + 10)} ${f(top - 22)}" stroke="${INK}" stroke-width="2"/><rect x="${f(tx - 16)}" y="${f(top - 52)}" width="32" height="32" rx="3" fill="${mix(fill, '#6a4a30', 0.4)}" ${inked ? `stroke="${INK}" stroke-width="2.2"` : ''}/><path d="M${f(tx - 19)} ${f(top - 52)} L${f(tx)} ${f(top - 70)} L${f(tx + 19)} ${f(top - 52)} Z" fill="${dark(fill, 0.3)}" ${inked ? `stroke="${INK}" stroke-width="2.2"` : ''}/>`;
      } else if (kind < 0.7) { // spire
        b += `<polygon points="${pts([[x + w * 0.3, top], [x + w * 0.5, top - h * 0.25], [x + w * 0.7, top]])}" fill="${shade}" ${inked ? `stroke="${INK}" stroke-width="2"` : ''}/><path d="M${f(x + w * 0.5)} ${f(top - h * 0.25)} v-30" stroke="${INK}" stroke-width="2"/>`;
      } else { // setback
        b += `<rect x="${f(x + w * 0.2)}" y="${f(top - h * 0.12)}" width="${f(w * 0.6)}" height="${f(h * 0.12 + 2)}" fill="${shade}" ${inked ? `stroke="${INK}" stroke-width="2"` : ''}/>`;
      }
    }
    // Windows: a grid, some lit.
    const cw = 14 * winSize, chh = 18 * winSize, gx = 9 * winSize, gy = 11 * winSize;
    let wins = '';
    for (let wy = top + 14; wy < base - 20; wy += chh + gy) {
      for (let wx = x + 10; wx < x + w * 0.72 - cw; wx += cw + gx) {
        if (r() < winOn) wins += `<rect x="${f(wx)}" y="${f(wy)}" width="${f(cw)}" height="${f(chh)}"/>`;
      }
    }
    b += `<g fill="${win}">${wins}</g>`;
    x += w + (r() < 0.2 ? r() * 20 : -2);
  }
  return b;
}

// A rooftop ledge to stand on, running across the bottom.
function ledge(pw, y, fill, r) {
  let b = `<rect x="-10" y="${f(y)}" width="${pw + 20}" height="400" fill="${fill}" stroke="${INK}" stroke-width="3"/>`;
  b += `<rect x="-10" y="${f(y)}" width="${pw + 20}" height="16" fill="${light(fill, 0.25)}" stroke="${INK}" stroke-width="3"/>`;
  for (let x = r() * 60; x < pw; x += 70 + r() * 40) b += `<path d="M${f(x)} ${f(y + 16)} v400" stroke="${INK}" stroke-width="1.6" stroke-opacity=".5"/>`;
  return b;
}

function stars(pw, ph, r, n, c = '#ffffff') {
  let b = '';
  for (let i = 0; i < n; i++) {
    const x = r() * pw, y = r() * ph, s = r();
    b += s > 0.93 ? `<polygon points="${starPts(x, y, 7, 1.6, 4)}" fill="${c}"/>` : `<circle cx="${f(x)}" cy="${f(y)}" r="${f(0.8 + s * 2)}" fill="${c}"/>`;
  }
  return b;
}

function rain(pw, ph, r, c = '#dfe8f4', n = 180) {
  let d = '';
  for (let i = 0; i < n; i++) { const x = r() * (pw + 200) - 100, y = r() * ph, l = 30 + r() * 50; d += `M${f(x)} ${f(y)} l${f(-l * 0.25)} ${f(l)} `; }
  return `<path d="${d}" stroke="${c}" stroke-width="2" stroke-opacity=".75"/>`;
}

function clouds(pw, y, r, fill, n = 5, scale = 1) {
  let b = '';
  for (let i = 0; i < n; i++) {
    const cx = r() * pw, cy = y + (r() - 0.5) * 80 * scale, w = (160 + r() * 200) * scale;
    let bumps = '';
    for (let k = 0; k < 5; k++) bumps += `<circle cx="${f(cx - w / 2 + (k + 0.5) * w / 5)}" cy="${f(cy - Math.sin((k + 0.5) / 5 * Math.PI) * 28 * scale)}" r="${f((30 + r() * 26) * scale)}"/>`;
    b += `<g fill="${fill}" stroke="${INK}" stroke-width="2.4">${bumps}</g><g fill="${fill}">${bumps.replace(/r="([\d.]+)"/g, (m, v) => `r="${f(v - 2.4)}"`)}<rect x="${f(cx - w / 2)}" y="${f(cy - 10 * scale)}" width="${f(w)}" height="${f(30 * scale)}"/></g>`;
  }
  return b;
}

function flames(pw, base, r, cols, h = 180, n) {
  const count = n || Math.round(pw / 60);
  let t = '';
  for (let i = 0; i < count; i++) {
    const x = (i + r() * 0.8) * pw / count, w = pw / count * (1.2 + r()), hh = h * (0.5 + r() * 0.8), sw = (r() - 0.5) * w;
    t += `<path d="M${f(x - w / 2)} ${f(base)} C${f(x - w * 0.4)} ${f(base - hh * 0.5)} ${f(x + sw * 0.4)} ${f(base - hh * 0.7)} ${f(x + sw)} ${f(base - hh)} C${f(x + w * 0.2)} ${f(base - hh * 0.6)} ${f(x + w * 0.5)} ${f(base - hh * 0.4)} ${f(x + w / 2)} ${f(base)} Z"/>`;
  }
  return `<g fill="${cols[0]}" stroke="${INK}" stroke-width="2.6">${t}</g><g fill="${cols[1]}" transform="translate(0 ${f(base * 0.12)}) scale(1 .88)">${t}</g><rect x="0" y="${f(base)}" width="${pw}" height="600" fill="${cols[1]}"/>`;
}

function mountains(pw, base, r, fill, height, n = 6, inked = true, snow) {
  let p = [[-20, base]];
  for (let i = 0; i <= n; i++) { const x = i / n * pw; p.push([x - pw / n / 2, base - height * (0.4 + r() * 0.6)]); p.push([x, base - height * (0.15 + r() * 0.3)]); }
  p.push([pw + 20, base]);
  let b = `<polygon points="${pts(p)}" fill="${fill}" ${inked ? `stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"` : ''}/>`;
  if (snow) p.forEach(([x, y], i) => { if (i % 2 === 1 && i < p.length - 1) b += `<polygon points="${pts([[x, y], [x - 22, y + 30], [x - 6, y + 24], [x + 4, y + 36], [x + 20, y + 28]])}" fill="${snow}"/>`; });
  return b;
}

// ---------- settings ----------
const SETTINGS = {
  city(pw, ph, r, { view = 'mid', time = 'day', rainy = false } = {}) {
    const T = {
      day: { sky: ['#6fb8e8', '#d6eef6'], far: '#a8c8d8', mid: '#8a9cb0', near: '#6c7488', win: '#e8f2f8', winOn: 0.35, ledge: '#9a9488' },
      dusk: { sky: ['#e86a4a', '#f8d078'], far: '#c88a8a', mid: '#7a5a6a', near: '#4a3a4a', win: '#ffd870', winOn: 0.4, ledge: '#6a5a58' },
      night: { sky: ['#101a3a', '#3a4a7a'], far: '#2a3456', mid: '#1c2440', near: '#121828', win: '#ffd870', winOn: 0.45, ledge: '#2a2e3a' },
    }[time];
    const floor = ph * (view === 'wide' ? 0.9 : 0.84);
    let b = sky(pw, ph, T.sky[0], T.sky[1]);
    if (time === 'night') b += stars(pw, ph * 0.5, r, 50, '#ffffff') + `<circle cx="${f(pw * 0.8)}" cy="${f(ph * 0.18)}" r="${f(ph * 0.08)}" fill="#f4eecc" stroke="${INK}" stroke-width="2.4"/>`;
    if (time === 'dusk') b += `<circle cx="${f(pw * 0.3)}" cy="${f(ph * 0.62)}" r="${f(ph * 0.16)}" fill="#ffe28a"/>`;
    if (time === 'day') b += clouds(pw, ph * 0.18, r, '#ffffff', 3, 0.7);
    const s = view === 'wide' ? 0.75 : 1;
    b += skyline(pw, ph * 0.86, r, { minH: ph * 0.25, maxH: ph * 0.55 * s, fill: T.far, win: light(T.far, 0.2), winOn: 0.2, inked: false, roofs: true, minW: 40, maxW: 100, winSize: 0.6 });
    b += skyline(pw, ph * 0.9, r, { minH: ph * 0.18, maxH: ph * 0.46 * s, fill: T.mid, win: T.win, winOn: T.winOn, minW: 70, maxW: 160, winSize: 0.8 });
    if (view === 'wide') b += skyline(pw, ph + 10, r, { minH: ph * 0.08, maxH: ph * 0.2, fill: T.near, win: T.win, winOn: T.winOn, minW: 100, maxW: 220 });
    else b += ledge(pw, floor, T.ledge, r);
    if (rainy) b += rain(pw, ph, r);
    return { svg: b, floor };
  },
  space(pw, ph, r, { view = 'mid', tint = '#6a52c4', planet = '#e0a060' } = {}) {
    const id = nid('neb');
    let b = sky(pw, ph, '#0a0a24', mix('#1a1040', tint, 0.35));
    b += `<defs><radialGradient id="${id}"><stop offset="0" stop-color="${tint}" stop-opacity=".9"/><stop offset="1" stop-color="${tint}" stop-opacity="0"/></radialGradient></defs>`;
    b += `<ellipse cx="${f(pw * 0.3)}" cy="${f(ph * 0.35)}" rx="${f(pw * 0.5)}" ry="${f(ph * 0.3)}" fill="url(#${id})" opacity=".7"/>`;
    b += stars(pw, ph, r, 140);
    const pr = ph * (view === 'wide' ? 0.3 : 0.2), px = pw * (0.2 + r() * 0.6), py = ph * 0.3;
    b += `<circle cx="${f(px)}" cy="${f(py)}" r="${f(pr)}" fill="${planet}" stroke="${INK}" stroke-width="3"/>`;
    b += `<path d="M${f(px - pr)} ${f(py)} A${f(pr)} ${f(pr)} 0 0 0 ${f(px + pr)} ${f(py)} A${f(pr)} ${f(pr * 0.7)} 0 0 1 ${f(px - pr)} ${f(py)} Z" fill="#000" opacity=".3"/>`;
    b += `<ellipse cx="${f(px)}" cy="${f(py)}" rx="${f(pr * 1.7)}" ry="${f(pr * 0.3)}" fill="none" stroke="${light(planet, 0.4)}" stroke-width="5" transform="rotate(-14 ${f(px)} ${f(py)})"/>`;
    // An asteroid or ship deck to stand on.
    const floor = ph * 0.86;
    b += `<path d="${smooth([[-20, floor], [pw * 0.2, floor - 18], [pw * 0.5, floor - 8], [pw * 0.8, floor - 22], [pw + 20, floor], [pw + 20, ph + 20], [-20, ph + 20]])}" fill="#5a5060" stroke="${INK}" stroke-width="3"/>`;
    for (let i = 0; i < 8; i++) b += `<ellipse cx="${f(r() * pw)}" cy="${f(floor + 20 + r() * (ph - floor))}" rx="${f(10 + r() * 30)}" ry="${f(5 + r() * 10)}" fill="#3a3040" stroke="${INK}" stroke-width="1.6"/>`;
    return { svg: b, floor };
  },
  asgard(pw, ph, r, { view = 'mid' } = {}) {
    let b = sky(pw, ph, '#3a6ab8', '#f0d8a0');
    b += clouds(pw, ph * 0.3, r, '#fff4e0', 4, 0.9);
    const base = ph * 0.84;
    for (let i = 0; i < 9; i++) {
      const x = r() * pw, w = 30 + r() * 50, h = ph * (0.25 + r() * 0.45);
      b += `<polygon points="${pts([[x - w / 2, base], [x - w / 2, base - h], [x, base - h - w * 1.6], [x + w / 2, base - h], [x + w / 2, base]])}" fill="${mix('#e8c060', '#a07830', r())}" stroke="${INK}" stroke-width="2.4"/>`;
      b += `<path d="M${f(x)} ${f(base - h - w * 1.6)} V${f(base)}" stroke="#fff4c8" stroke-width="2" stroke-opacity=".6"/>`;
    }
    // The rainbow bridge.
    const cols = ['#e84a4a', '#f0a040', '#f0e050', '#5ad07a', '#4a9ae8', '#9a5ae0'];
    cols.forEach((c, i) => b += `<path d="M-20 ${f(ph * 0.95 - i * 7)} Q${f(pw * 0.5)} ${f(ph * 0.78 - i * 7)} ${f(pw + 20)} ${f(ph * 0.9 - i * 7)}" fill="none" stroke="${c}" stroke-width="8"/>`);
    const floor = ph * 0.88;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#8a7a60" stroke="${INK}" stroke-width="3"/>`;
    return { svg: b, floor };
  },
  mystic(pw, ph, r, { view = 'mid', glow = '#f0a850', tint = '#3a1a5a' } = {}) {
    let b = sky(pw, ph, mix(tint, '#000000', 0.3), mix(tint, '#6a3aa0', 0.5));
    // Floating shards of a folded city.
    for (let i = 0; i < 10; i++) {
      const x = r() * pw, y = r() * ph * 0.7, w = 40 + r() * 90, h = 60 + r() * 140;
      b += `<g transform="rotate(${f((r() - 0.5) * 50)} ${f(x)} ${f(y)})"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${mix(tint, '#8a6ab0', r() * 0.6)}" stroke="${INK}" stroke-width="2"/></g>`;
    }
    const cx = pw * (0.3 + r() * 0.4), cy = ph * 0.4, R0 = Math.min(pw, ph) * 0.34;
    for (let k = 0; k < 4; k++) b += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R0 * (1 - k * 0.2))}" fill="none" stroke="${glow}" stroke-width="${k ? 3 : 7}" stroke-dasharray="${k % 2 ? '14 8' : 'none'}"/>`;
    b += `<polygon points="${starPts(cx, cy, R0 * 0.62, R0 * 0.36, 8)}" fill="none" stroke="${glow}" stroke-width="3"/>`;
    for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; b += `<circle cx="${f(cx + Math.cos(a) * R0 * 0.9)}" cy="${f(cy + Math.sin(a) * R0 * 0.9)}" r="3.5" fill="${light(glow, 0.5)}"/>`; }
    const floor = ph * 0.86;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="${mix(tint, '#000000', 0.2)}" stroke="${INK}" stroke-width="3"/>`;
    b += `<ellipse cx="${f(pw / 2)}" cy="${f(floor + 30)}" rx="${f(pw * 0.4)}" ry="18" fill="none" stroke="${glow}" stroke-width="3" opacity=".7"/>`;
    return { svg: b, floor };
  },
  wakanda(pw, ph, r, { view = 'mid' } = {}) {
    let b = sky(pw, ph, '#e89a4a', '#fbe3a8');
    b += `<circle cx="${f(pw * 0.7)}" cy="${f(ph * 0.35)}" r="${f(ph * 0.14)}" fill="#fff0b0"/>`;
    b += mountains(pw, ph * 0.7, r, '#8a6a7a', ph * 0.4, 4, false);
    const base = ph * 0.82;
    for (let i = 0; i < 8; i++) {
      const x = r() * pw, w = 40 + r() * 60, h = ph * (0.2 + r() * 0.4);
      b += `<path d="M${f(x - w / 2)} ${f(base)} Q${f(x - w * 0.3)} ${f(base - h * 0.6)} ${f(x)} ${f(base - h)} Q${f(x + w * 0.3)} ${f(base - h * 0.6)} ${f(x + w / 2)} ${f(base)} Z" fill="${mix('#5a4a6a', '#3a2a4a', r())}" stroke="${INK}" stroke-width="2.4"/>`;
      b += `<path d="M${f(x)} ${f(base - h)} V${f(base)}" stroke="#b99cff" stroke-width="2"/>`;
    }
    b += mountains(pw, ph * 0.9, r, '#4a6a3a', ph * 0.12, 8, true);
    const floor = ph * 0.88;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#6a5a4a" stroke="${INK}" stroke-width="3"/>`;
    return { svg: b, floor };
  },
  castle(pw, ph, r, { view = 'mid', glow = '#78c85a' } = {}) {
    let b = sky(pw, ph, '#1a2a24', '#5a6a5a');
    b += clouds(pw, ph * 0.2, r, '#3a4a44', 5, 1);
    const bolt = jag(pw * 0.7, 0, pw * 0.6, ph * 0.5, 7, 30, r);
    b += `<polyline points="${pts(bolt)}" fill="none" stroke="${glow}" stroke-width="10" opacity=".5"/><polyline points="${pts(bolt)}" fill="none" stroke="#ffffff" stroke-width="3"/>`;
    b += mountains(pw, ph * 0.86, r, '#2a3430', ph * 0.3, 5, true);
    // The keep.
    const cx = pw * (0.25 + r() * 0.5), base = ph * 0.8, h = ph * 0.5;
    let k = `<rect x="${f(cx - 90)}" y="${f(base - h * 0.6)}" width="180" height="${f(h * 0.6)}"/>`;
    [-110, -40, 40, 110].forEach((dx, i) => { const th = h * (i % 3 ? 0.8 : 1); k += `<rect x="${f(cx + dx - 22)}" y="${f(base - th)}" width="44" height="${f(th)}"/><polygon points="${pts([[cx + dx - 28, base - th], [cx + dx, base - th - 60], [cx + dx + 28, base - th]])}"/>`; });
    b += `<g fill="#3a443e" stroke="${INK}" stroke-width="2.6">${k}</g>`;
    for (let i = 0; i < 10; i++) b += `<rect x="${f(cx - 100 + r() * 200)}" y="${f(base - h * 0.2 - r() * h * 0.6)}" width="8" height="14" fill="${glow}"/>`;
    const floor = ph * 0.88;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#4a5048" stroke="${INK}" stroke-width="3"/>`;
    for (let x = 0; x < pw; x += 60) b += `<rect x="${f(x)}" y="${f(floor - 24)}" width="36" height="26" fill="#5a6058" stroke="${INK}" stroke-width="2.4"/>`;
    return { svg: b, floor };
  },
  lab(pw, ph, r, { view = 'mid', glow = '#ff3a44' } = {}) {
    let b = `<rect width="${pw}" height="${ph}" fill="#2a2e38"/>`;
    for (let x = 0; x < pw; x += 120) b += `<rect x="${f(x + 6)}" y="0" width="108" height="${f(ph)}" fill="#343a46" stroke="${INK}" stroke-width="2"/>`;
    let c = '';
    for (let i = 0; i < 30; i++) { let x = r() * pw, y = r() * ph * 0.8; c += `M${f(x)} ${f(y)} h${f((r() - 0.5) * 200)} v${f((r() - 0.5) * 160)}`; }
    b += `<path d="${c}" fill="none" stroke="${glow}" stroke-width="3" opacity=".7"/>`;
    for (let i = 0; i < 16; i++) b += `<circle cx="${f(r() * pw)}" cy="${f(r() * ph * 0.8)}" r="5" fill="${light(glow, 0.4)}" stroke="${INK}" stroke-width="1.5"/>`;
    for (let i = 0; i < 3; i++) { const x = pw * (0.15 + i * 0.35), y = ph * 0.2; b += `<rect x="${f(x)}" y="${f(y)}" width="${f(pw * 0.2)}" height="${f(ph * 0.25)}" fill="#0e2030" stroke="${INK}" stroke-width="3"/><path d="M${f(x + 10)} ${f(y + ph * 0.18)} ${Array.from({ length: 8 }, (_, j) => `L${f(x + 10 + j * pw * 0.024)} ${f(y + ph * 0.05 + r() * ph * 0.15)}`).join(' ')}" fill="none" stroke="#5ae0ff" stroke-width="3"/>`; }
    const floor = ph * 0.86;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#1c2028" stroke="${INK}" stroke-width="3"/>`;
    for (let x = -ph; x < pw; x += 60) b += `<path d="M${f(x)} ${f(ph)} L${f(x + (ph - floor) * 1.4)} ${f(floor)}" stroke="#3a4050" stroke-width="2"/>`;
    return { svg: b, floor };
  },
  sea(pw, ph, r, { view = 'mid' } = {}) {
    let b = sky(pw, ph, '#5aa8d8', '#cdeaf0');
    b += clouds(pw, ph * 0.2, r, '#ffffff', 3, 0.8);
    const horizon = ph * 0.55;
    b += `<rect y="${f(horizon)}" width="${pw}" height="${f(ph)}" fill="#2a7a9a"/>`;
    for (let k = 0; k < 7; k++) {
      const y = horizon + k * (ph - horizon) / 6;
      let d = `M-20 ${f(y)}`;
      for (let x = -20; x < pw + 40; x += 60) d += ` q15 ${f(-10 - k * 3)} 30 0 t30 0`;
      b += `<path d="${d} V${ph + 20} H-20 Z" fill="${mix('#2a8aa8', '#0a3a5a', k / 7)}" stroke="${INK}" stroke-width="2"/>`;
    }
    const floor = ph * 0.86;
    b += `<path d="${smooth([[pw * 0.2, ph + 20], [pw * 0.3, floor - 10], [pw * 0.5, floor - 26], [pw * 0.7, floor - 8], [pw * 0.8, ph + 20]])}" fill="#6a6a5a" stroke="${INK}" stroke-width="3"/>`;
    return { svg: b, floor };
  },
  hell(pw, ph, r, { view = 'mid' } = {}) {
    let b = sky(pw, ph, '#1a0604', '#8a2a0a');
    b += mountains(pw, ph * 0.72, r, '#2a0a06', ph * 0.3, 6, true);
    b += flames(pw, ph * 0.9, r, ['#ff7a2a', '#ffd060'], ph * 0.35);
    const floor = ph * 0.9;
    // A road to ride on.
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#2a1a18" stroke="${INK}" stroke-width="3"/>`;
    for (let x = 0; x < pw; x += 110) b += `<rect x="${f(x)}" y="${f(floor + 20)}" width="60" height="8" fill="#e8c050"/>`;
    return { svg: b, floor };
  },
  storm(pw, ph, r, { view = 'mid', glow = '#9fc4ff' } = {}) {
    let b = sky(pw, ph, '#2a3448', '#8090a8');
    b += clouds(pw, ph * 0.12, r, '#4a5468', 6, 1.2) + clouds(pw, ph * 0.3, r, '#6a7488', 4, 0.9);
    for (let i = 0; i < 2; i++) {
      const x = pw * (0.2 + r() * 0.6);
      const bolt = jag(x, ph * 0.2, x + (r() - 0.5) * 200, ph * 0.8, 8, 30, r);
      b += `<polyline points="${pts(bolt)}" fill="none" stroke="${glow}" stroke-width="12" opacity=".5"/><polyline points="${pts(bolt)}" fill="none" stroke="#ffffff" stroke-width="3.5"/>`;
    }
    b += skyline(pw, ph * 0.92, r, { minH: ph * 0.1, maxH: ph * 0.3, fill: '#3a4050', win: '#ffe0a0', winOn: 0.25, minW: 60, maxW: 140, winSize: 0.7 });
    b += rain(pw, ph, r, '#e0e8f8', 120);
    const floor = ph * 0.9;
    b += ledge(pw, floor, '#4a4e58', r);
    return { svg: b, floor };
  },
  ice(pw, ph, r, { view = 'mid' } = {}) {
    let b = sky(pw, ph, '#8ac8f0', '#f0faff');
    b += mountains(pw, ph * 0.75, r, '#b8d8ec', ph * 0.4, 5, true, '#ffffff');
    for (let i = 0; i < 7; i++) { const x = r() * pw, h = ph * (0.15 + r() * 0.3), w = 30 + r() * 40; b += `<polygon points="${pts([[x - w, ph * 0.9], [x - w * 0.2, ph * 0.9 - h], [x + w * 0.1, ph * 0.9 - h * 0.7], [x + w, ph * 0.9]])}" fill="#dff4ff" stroke="${INK}" stroke-width="2.4"/><path d="M${f(x - w * 0.2)} ${f(ph * 0.9 - h)} L${f(x)} ${f(ph * 0.9)}" stroke="#7cc4e4" stroke-width="2"/>`; }
    for (let i = 0; i < 60; i++) b += `<circle cx="${f(r() * pw)}" cy="${f(r() * ph)}" r="${f(1.5 + r() * 3)}" fill="#ffffff"/>`;
    const floor = ph * 0.88;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#e8f6ff" stroke="${INK}" stroke-width="3"/>`;
    return { svg: b, floor };
  },
  forest(pw, ph, r, { view = 'mid' } = {}) {
    let b = sky(pw, ph, '#8ad0a0', '#f0f4c0');
    for (let layer = 0; layer < 3; layer++) {
      const c = mix('#9ac080', '#2a5a2a', layer / 2), base = ph * (0.7 + layer * 0.1);
      for (let x = -40; x < pw + 40; x += 50 + r() * 60) {
        const h = ph * (0.3 + r() * 0.3) * (1 - layer * 0.15), w = 50 + r() * 50;
        b += `<rect x="${f(x - 6)}" y="${f(base - h * 0.4)}" width="12" height="${f(h * 0.4)}" fill="#5a3a2a" stroke="${INK}" stroke-width="${layer ? 2 : 0}"/>`;
        b += `<path d="${smooth([[x - w, base - h * 0.35], [x - w * 0.6, base - h * 0.9], [x, base - h], [x + w * 0.6, base - h * 0.85], [x + w, base - h * 0.35], [x, base - h * 0.25]])}" fill="${c}" stroke="${INK}" stroke-width="${layer ? 2.4 : 0}"/>`;
      }
    }
    const floor = ph * 0.9;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#4a6a2a" stroke="${INK}" stroke-width="3"/>`;
    return { svg: b, floor };
  },
  canyon(pw, ph, r, { view = 'mid' } = {}) {
    let b = sky(pw, ph, '#e8904a', '#fbe0a0');
    b += mountains(pw, ph * 0.6, r, '#c88a6a', ph * 0.3, 4, false);
    b += mountains(pw, ph * 0.8, r, '#a0583a', ph * 0.35, 5, true);
    const floor = ph * 0.88;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#8a4a2a" stroke="${INK}" stroke-width="3"/>`;
    for (let i = 0; i < 6; i++) { const x = r() * pw; b += `<polyline points="${pts(jag(x, floor, x + (r() - 0.5) * 200, ph, 5, 12, r))}" fill="none" stroke="${INK}" stroke-width="2"/>`; }
    return { svg: b, floor };
  },
  temple(pw, ph, r, { view = 'mid' } = {}) {
    let b = sky(pw, ph, '#e0708a', '#fbe0c0');
    b += mountains(pw, ph * 0.7, r, '#a0708a', ph * 0.35, 5, false);
    const base = ph * 0.84;
    for (let i = 0; i < 3; i++) {
      const cx = pw * (0.2 + i * 0.3 + r() * 0.1), w = 120 - i * 10, lv = 3 + (i % 2);
      for (let k = 0; k < lv; k++) {
        const y = base - k * 70, ww = w * (1 - k * 0.18);
        b += `<rect x="${f(cx - ww * 0.35)}" y="${f(y - 50)}" width="${f(ww * 0.7)}" height="50" fill="#b83a3a" stroke="${INK}" stroke-width="2.4"/>`;
        b += `<path d="M${f(cx - ww * 0.75)} ${f(y - 44)} Q${f(cx)} ${f(y - 70)} ${f(cx + ww * 0.75)} ${f(y - 44)} L${f(cx + ww * 0.5)} ${f(y - 60)} L${f(cx - ww * 0.5)} ${f(y - 60)} Z" fill="#2a4a3a" stroke="${INK}" stroke-width="2.4"/>`;
      }
    }
    for (let i = 0; i < 12; i++) b += `<circle cx="${f(r() * pw)}" cy="${f(r() * ph * 0.6)}" r="4" fill="#ffffff" opacity=".8"/>`;
    const floor = ph * 0.88;
    b += `<rect x="-10" y="${f(floor)}" width="${pw + 20}" height="300" fill="#8a7a6a" stroke="${INK}" stroke-width="3"/>`;
    return { svg: b, floor };
  },
};

module.exports = { SETTINGS, rain, clouds, flames, stars };
