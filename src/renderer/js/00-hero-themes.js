// Hero themes: Marvel heroes, anti-heroes and villains, each a palette plus an "aura".
//
// Same `vars` shape as the Alacritty palettes (00-alacritty-themes.js), so applyTheme in
// 08-lfs-settings.js injects them the same way. What's extra is the aura: two fixed overlay
// layers drawn by the html.theme-hero rules in 04-themes.css, fed through --hero-aura /
// --hero-mask (layer 1, body::after) and --hero-aura-2 / --hero-mask-2 (layer 2,
// .screen::after). The first six themes set those in 04-themes.css by hand; everything built
// with heroFrom() carries them in its vars, composed from the motif library below.
//
// Two rules keep "epic" from turning into "hard to read":
//   - Palettes are calm. Text is a soft off-white, accents sit a notch below full
//     saturation and borders stay low-contrast (derivePalette). The drama is the aura's job.
//   - Auras live at the edges. Every motif keeps its light to a corner, the top or bottom
//     edge, or behind a mask that clears the middle of the window, where the diffs are.
//     Both layers blend with `screen`, so a motif can only ever lighten what is under it.
(function () {
  // ---------- colour helpers ----------
  const hexRgb = (h) => {
    const s = h.replace('#', '');
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
  };
  const rgbHex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return rgbHex(A.map((v, i) => v + (B[i] - v) * t)); };
  const rgba = (hex, a) => `rgba(${hexRgb(hex).join(', ')}, ${a})`;
  const luminance = (hex) => {
    const [r, g, b] = hexRgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  // An SVG as a CSS image. encodeURIComponent also escapes `;` `{` `}` and `#`, which is
  // what lets the result sit inside the injected `html.theme-alacritty{...}` rule untouched.
  const svg = (w, h, body) =>
    `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`)}")`;
  const blur = (id, s) => `<filter id='${id}' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='${s}'/></filter>`;
  const f1 = (n) => Math.round(n * 10) / 10;

  // Deterministic scatter for star fields and embers, so a theme looks the same every launch.
  function scatter(seed, count, w, h) {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const out = [];
    for (let i = 0; i < count; i++) out.push([f1(rnd() * w), f1(rnd() * h), rnd()]);
    return out;
  }

  // Where a corner-anchored image sits: [css position, svg transform that points it there].
  // Motif art is drawn for the top-left corner; the transform mirrors it into the others.
  const CORNERS = {
    tl: { at: '0% 0%', pos: 'left top', flip: (w, h) => '' },
    tr: { at: '100% 0%', pos: 'right top', flip: (w, h) => `translate(${w} 0) scale(-1 1)` },
    bl: { at: '0% 100%', pos: 'left bottom', flip: (w, h) => `translate(0 ${h}) scale(1 -1)` },
    br: { at: '100% 100%', pos: 'right bottom', flip: (w, h) => `translate(${w} ${h}) scale(-1 -1)` },
  };

  // ---------- motif library ----------
  // Each motif returns { bg, mask? }: `bg` is a comma-separated list of background layers
  // (full shorthand, so an image can carry its own position / size / repeat) and `mask` the
  // optional mask confining it. A theme uses one motif per layer.
  const M = {
    // Soft light pooled at a few points. [colour, where, ellipse size, alpha]
    glows(spots) {
      return { bg: spots.map(([c, at, size, a]) => `radial-gradient(ellipse ${size || '50% 55%'} at ${at}, ${rgba(c, a || 0.16)}, transparent 70%)`).join(', ') };
    },

    // Arc reactor at the top edge: glowing core, segmented rings, the triangle of the later
    // suits. Half of it rises above the window, so it crowns the toolbar.
    reactor(core, ring, rim) {
      const tri = [0, 1, 2].map(i => { const a = -Math.PI / 2 + i * 2 * Math.PI / 3; return `${f1(200 + 44 * Math.cos(a))},${f1(200 + 44 * Math.sin(a))}`; }).join(' ');
      const art = (sw) =>
        `<circle cx='200' cy='200' r='56' fill='none' stroke='${core}' stroke-opacity='.5' stroke-width='${3 * sw}'/>` +
        `<circle cx='200' cy='200' r='80' fill='none' stroke='${core}' stroke-opacity='.3' stroke-width='${8 * sw}' stroke-dasharray='14 7'/>` +
        `<circle cx='200' cy='200' r='106' fill='none' stroke='${ring}' stroke-opacity='.22' stroke-width='${1.5 * sw}'/>` +
        `<circle cx='200' cy='200' r='134' fill='none' stroke='${ring}' stroke-opacity='.14' stroke-width='${1.2 * sw}' stroke-dasharray='2 6'/>` +
        `<polygon points='${tri}' fill='${core}' fill-opacity='.07' stroke='${core}' stroke-opacity='.45' stroke-width='${2.5 * sw}'/>`;
      const img = svg(400, 400,
        `<defs>${blur('b', 4)}<radialGradient id='g'><stop offset='0' stop-color='${core}' stop-opacity='.6'/><stop offset='.2' stop-color='${core}' stop-opacity='.26'/><stop offset='.55' stop-color='${core}' stop-opacity='.07'/><stop offset='1' stop-color='${core}' stop-opacity='0'/></radialGradient></defs>` +
        `<circle cx='200' cy='200' r='200' fill='url(#g)'/><g filter='url(#b)'>${art(2)}</g>${art(1)}` +
        `<circle cx='200' cy='200' r='9' fill='#ffffff' fill-opacity='.55'/>`);
      return { bg: `${img} 50% -190px / 400px 400px no-repeat, radial-gradient(ellipse 60% 40% at 50% 0%, ${rgba(rim, 0.12)}, transparent 70%)` };
    },

    // Concentric rings with a star at the centre, rising out of the bottom-right corner.
    shield(ring, inner, star) {
      const pts = [];
      for (let i = 0; i < 10; i++) { const r = i % 2 ? 32 : 78, a = -Math.PI / 2 + i * Math.PI / 5; pts.push(`${f1(200 + r * Math.cos(a))},${f1(200 + r * Math.sin(a))}`); }
      const img = svg(400, 400,
        `<defs>${blur('b', 5)}</defs>` +
        `<circle cx='200' cy='200' r='178' fill='none' stroke='${ring}' stroke-opacity='.16' stroke-width='30'/>` +
        `<circle cx='200' cy='200' r='145' fill='none' stroke='${star}' stroke-opacity='.08' stroke-width='28'/>` +
        `<circle cx='200' cy='200' r='112' fill='none' stroke='${ring}' stroke-opacity='.16' stroke-width='28'/>` +
        `<circle cx='200' cy='200' r='96' fill='${inner}' fill-opacity='.2'/>` +
        `<polygon points='${pts.join(' ')}' fill='${star}' fill-opacity='.28' filter='url(#b)'/>` +
        `<polygon points='${pts.join(' ')}' fill='${star}' fill-opacity='.22'/>`);
      return { bg: `${img} right -130px bottom -130px / 400px 400px no-repeat, radial-gradient(circle at 100% 100%, ${rgba(inner, 0.14)}, transparent 40%)` };
    },

    // Radiation pulsing up from the floor.
    gamma(c) {
      return {
        bg: `repeating-radial-gradient(circle at 50% 118%, transparent 0 34px, ${rgba(c, 0.09)} 36px 38px), ` +
          `radial-gradient(ellipse 90% 55% at 50% 115%, ${rgba(c, 0.26)}, transparent 70%)`,
        mask: 'radial-gradient(ellipse 95% 75% at 50% 112%, #000 25%, transparent 80%)',
      };
    },

    // A large faint sigil in a corner, drawn in a 100-unit box.
    emblem(shape, fill, stroke, corner = 'br') {
      const SHAPES = {
        hourglass: { d: 'M22 12 H78 L50 50 Z M50 50 L78 88 H22 Z' },
        skull: {
          d: 'M50 6 C27 6 13 22 13 43 C13 55 19 63 27 67 V76 H73 V67 C81 63 87 55 87 43 C87 22 73 6 50 6 Z ' +
            'M24 40 C24 31 42 31 42 42 C42 50 28 52 24 40 Z M76 40 C76 31 58 31 58 42 C58 50 72 52 76 40 Z M50 50 L45 62 H55 Z',
          extra: `<path d='M30 76 V95 M40 76 V97 M50 76 V98 M60 76 V97 M70 76 V95' stroke='${stroke}' stroke-opacity='.32' stroke-width='3.2' stroke-linecap='round'/>`,
        },
      };
      const S = SHAPES[shape];
      const body = `<path d='${S.d}' fill='${fill}' fill-opacity='.08' fill-rule='evenodd' stroke='${stroke}' stroke-opacity='.3' stroke-width='1.2'/>${S.extra || ''}`;
      const img = svg(100, 100, `<defs>${blur('b', 1.6)}</defs><g filter='url(#b)' opacity='.9'>${body}</g>${body}`);
      const C = CORNERS[corner];
      const off = corner[0] === 't' ? 'top -30px' : 'bottom -40px';
      const side = corner[1] === 'l' ? 'left -30px' : 'right -30px';
      return { bg: `${img} ${side} ${off} / 340px 340px no-repeat, radial-gradient(circle at ${C.at}, ${rgba(stroke, 0.12)}, transparent 42%)` };
    },

    // Arrows in flight across the top-right, each trailing light.
    arrows(shaft, trail) {
      const d = [-0.94, 0.34], n = [0.34, 0.94], len = 280;
      let body = `<defs>${blur('b', 3)}</defs>`;
      [[640, 30], [660, 104], [620, 176]].forEach(([tx, ty], i) => {
        const hx = tx + d[0] * len, hy = ty + d[1] * len;
        body += `<linearGradient id='t${i}' gradientUnits='userSpaceOnUse' x1='${tx}' y1='${ty}' x2='${f1(hx)}' y2='${f1(hy)}'><stop offset='0' stop-color='${trail}' stop-opacity='0'/><stop offset='1' stop-color='${trail}' stop-opacity='.55'/></linearGradient>`;
        body += `<line x1='${tx}' y1='${ty}' x2='${f1(hx)}' y2='${f1(hy)}' stroke='url(#t${i})' stroke-width='7' filter='url(#b)'/>`;
        body += `<line x1='${tx}' y1='${ty}' x2='${f1(hx)}' y2='${f1(hy)}' stroke='url(#t${i})' stroke-width='1.6'/>`;
        const bx = hx - d[0] * 16, by = hy - d[1] * 16;
        body += `<polygon points='${f1(hx + d[0] * 4)},${f1(hy + d[1] * 4)} ${f1(bx + n[0] * 7)},${f1(by + n[1] * 7)} ${f1(bx - n[0] * 7)},${f1(by - n[1] * 7)}' fill='${shaft}' fill-opacity='.6'/>`;
      });
      return { bg: `${svg(680, 300, body)} right top / 680px 300px no-repeat, radial-gradient(circle at 100% 0%, ${rgba(trail, 0.12)}, transparent 38%)` };
    },

    // Two long blades crossed in the bottom-right corner.
    katanas(color, glow) {
      let body = `<defs>${blur('b', 5)}`;
      const L = [[60, 40, 440, 420], [440, 50, 70, 430]];
      L.forEach(([x1, y1, x2, y2], i) => {
        body += `<linearGradient id='k${i}' gradientUnits='userSpaceOnUse' x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}'><stop offset='0' stop-color='${color}' stop-opacity='0'/><stop offset='.25' stop-color='${color}' stop-opacity='.55'/><stop offset='.8' stop-color='${color}' stop-opacity='.36'/><stop offset='1' stop-color='${color}' stop-opacity='0'/></linearGradient>`;
      });
      body += '</defs>';
      L.forEach(([x1, y1, x2, y2], i) => {
        body += `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}' stroke='${glow}' stroke-opacity='.26' stroke-width='12' filter='url(#b)'/>`;
        body += `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}' stroke='url(#k${i})' stroke-width='3'/>`;
      });
      return { bg: `${svg(500, 470, body)} right -110px bottom -110px / 440px 414px no-repeat, radial-gradient(circle at 100% 100%, ${rgba(glow, 0.14)}, transparent 42%)` };
    },

    // Beams fanning out from a blazing point.
    rays(color, core, at = '50% -4%', { step = 9, width = 1.2, alpha = 0.1, reach = '50% 60%' } = {}) {
      return {
        bg: `radial-gradient(circle at ${at}, ${rgba(core, 0.32)} 0 1.2%, ${rgba(core, 0.18)} 3%, transparent 14%), ` +
          `repeating-conic-gradient(from 0deg at ${at}, ${rgba(color, alpha)} 0 ${width}deg, transparent ${width}deg ${step}deg)`,
        mask: `radial-gradient(ellipse ${reach} at ${at}, #000 8%, transparent 100%)`,
      };
    },

    // A honeycomb lattice, faded out from one corner.
    hex(color, corner = 'tl', glow) {
      const C = CORNERS[corner];
      const w = 20.78;
      const tile = svg(w, 36,
        `<path d='M${f1(w / 2)} 6 L${w} 12 L${w} 24 L${f1(w / 2)} 30 L0 24 L0 12 Z M${f1(w / 2)} 0 L${f1(w / 2)} 6 M${f1(w / 2)} 30 L${f1(w / 2)} 36' fill='none' stroke='${color}' stroke-opacity='.2' stroke-width='.8'/>`);
      return {
        bg: `${tile} 0 0 / ${w}px 36px repeat, radial-gradient(circle at ${C.at}, ${rgba(glow || color, 0.2)}, transparent 45%)`,
        mask: `radial-gradient(circle at ${C.at}, #000 0%, transparent 46%)`,
      };
    },

    // Deep space: a star field and nebulae, cleared out of the middle of the window.
    cosmic(neb1, neb2, starColor = '#ffffff') {
      const stars = scatter(1234, 22, 240, 240).map(([x, y, r]) =>
        r > 0.9
          ? `<path d='M${x} ${f1(y - 3.5)} L${f1(x + 0.8)} ${f1(y - 0.8)} L${f1(x + 3.5)} ${y} L${f1(x + 0.8)} ${f1(y + 0.8)} L${x} ${f1(y + 3.5)} L${f1(x - 0.8)} ${f1(y + 0.8)} L${f1(x - 3.5)} ${y} L${f1(x - 0.8)} ${f1(y - 0.8)} Z' fill='${starColor}' fill-opacity='.7'/>`
          : `<circle cx='${x}' cy='${y}' r='${f1(0.4 + r * 0.8)}' fill='${starColor}' fill-opacity='${f1(0.3 + r * 0.5)}'/>`).join('');
      return {
        bg: `${svg(240, 240, stars)} 0 0 / 240px 240px repeat, ` +
          `radial-gradient(ellipse 55% 60% at 0% 0%, ${rgba(neb1, 0.2)}, transparent 70%), ` +
          `radial-gradient(ellipse 55% 60% at 100% 100%, ${rgba(neb2, 0.18)}, transparent 70%), ` +
          `radial-gradient(ellipse 35% 40% at 100% 0%, ${rgba(neb2, 0.1)}, transparent 70%)`,
        mask: 'radial-gradient(ellipse 70% 70% at 50% 50%, transparent 35%, #000 95%)',
      };
    },

    // Radar sweeping out from a corner: rings, fading with distance.
    sonar(color, corner = 'br') {
      const C = CORNERS[corner];
      return {
        bg: `repeating-radial-gradient(circle at ${C.at}, transparent 0 56px, ${rgba(color, 0.14)} 58px 59px), radial-gradient(circle at ${C.at}, ${rgba(color, 0.2)}, transparent 40%)`,
        mask: `radial-gradient(circle at ${C.at}, #000 0%, transparent 62%)`,
      };
    },

    // A crescent moon hanging in the top-left corner.
    moon(color, glow) {
      const moon = `<circle cx='200' cy='200' r='118' fill='${color}' mask='url(#m)'/>`;
      const img = svg(400, 400,
        `<defs>${blur('b', 10)}<mask id='m'><rect width='400' height='400' fill='white'/><circle cx='246' cy='172' r='106' fill='black'/></mask>` +
        `<radialGradient id='g'><stop offset='0' stop-color='${glow}' stop-opacity='.22'/><stop offset='1' stop-color='${glow}' stop-opacity='0'/></radialGradient></defs>` +
        `<circle cx='200' cy='200' r='200' fill='url(#g)'/><g opacity='.5' filter='url(#b)'>${moon}</g><g opacity='.3'>${moon}</g>`);
      return { bg: `${img} left -70px top -80px / 400px 400px no-repeat` };
    },

    // A blast running along the bottom edge of the toolbar.
    beam(color, core) {
      const img = svg(1600, 112,
        `<defs>${blur('b', 9)}${blur('c', 2)}</defs>` +
        `<ellipse cx='800' cy='56' rx='800' ry='14' fill='${color}' fill-opacity='.5' filter='url(#b)'/>` +
        `<ellipse cx='800' cy='56' rx='760' ry='2.4' fill='${core}' fill-opacity='.7' filter='url(#c)'/>`);
      return { bg: `${img} 50% 0 / 100% 112px no-repeat, radial-gradient(ellipse 70% 30% at 50% 0%, ${rgba(color, 0.12)}, transparent 70%)` };
    },

    // Fire rising from the bottom edge.
    flames(base, tip) {
      // [x, height, width, sway]: overlapping, uneven, each tip bent a little sideways.
      const tongues = [[-14, 96, 46, 10], [18, 150, 40, -12], [44, 104, 34, 8], [70, 176, 46, 14], [104, 120, 38, -10],
        [128, 160, 44, -16], [162, 98, 36, 10], [184, 140, 42, 12], [214, 112, 40, -8], [240, 150, 44, -14]];
      const tongue = ([x, h, w, s], k, fill) => {
        h *= k; const y = 220;
        return `<path d='M${f1(x)} ${y} C${f1(x - w * 0.12)} ${f1(y - h * 0.5)} ${f1(x + w * 0.4 - s * 0.5)} ${f1(y - h * 0.62)} ${f1(x + w * 0.5 + s)} ${f1(y - h)} ` +
          `C${f1(x + w * 0.6)} ${f1(y - h * 0.55)} ${f1(x + w * 1.12)} ${f1(y - h * 0.42)} ${f1(x + w)} ${y} Z' fill='${fill}'/>`;
      };
      const img = svg(260, 220,
        `<defs>${blur('b', 2.5)}` +
        `<linearGradient id='f' x1='0' y1='1' x2='0' y2='0'><stop offset='0' stop-color='${base}' stop-opacity='.42'/><stop offset='.55' stop-color='${base}' stop-opacity='.2'/><stop offset='1' stop-color='${tip}' stop-opacity='0'/></linearGradient>` +
        `<linearGradient id='c' x1='0' y1='1' x2='0' y2='0'><stop offset='0' stop-color='${tip}' stop-opacity='.45'/><stop offset='.6' stop-color='${tip}' stop-opacity='.12'/><stop offset='1' stop-color='${tip}' stop-opacity='0'/></linearGradient></defs>` +
        `<g filter='url(#b)'>${tongues.map(t => tongue(t, 1, 'url(#f)')).join('')}${tongues.map(([x, h, w, s]) => tongue([x + w * 0.22, h, w * 0.56, s * 0.7], 0.55, 'url(#c)')).join('')}</g>`);
      return { bg: `${img} 0 100% / 260px 220px repeat-x, radial-gradient(ellipse 90% 40% at 50% 110%, ${rgba(base, 0.24)}, transparent 70%)` };
    },

    // Ice shards spreading from the top-left and bottom-right corners.
    frost(color, glow) {
      let shards = '';
      [[8, 300], [22, 220], [38, 340], [52, 200], [68, 260], [82, 180]].forEach(([deg, len]) => {
        const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca;
        const pt = (t, off) => `${f1(len * t * ca + px * off)},${f1(len * t * sa + py * off)}`;
        shards += `<polygon points='${pt(0, -7)} ${pt(1, 0)} ${pt(0, 7)}' fill='${color}' fill-opacity='.1' stroke='${color}' stroke-opacity='.34' stroke-width='1'/>`;
        const m = 0.45 + (deg % 3) * 0.1, bl = len * 0.28, b2 = a + 0.6;
        const mx = len * m * ca, my = len * m * sa;
        shards += `<line x1='${f1(mx)}' y1='${f1(my)}' x2='${f1(mx + bl * Math.cos(b2))}' y2='${f1(my + bl * Math.sin(b2))}' stroke='${color}' stroke-opacity='.3' stroke-width='1.2'/>`;
      });
      const draw = (t) => svg(360, 360, `<defs>${blur('b', 3)}</defs><g transform='${t}'><g filter='url(#b)'>${shards}</g>${shards}</g>`);
      return {
        bg: `${draw('')} left top / 360px 360px no-repeat, ${draw('translate(360 360) scale(-1 -1)')} right bottom / 300px 300px no-repeat, ` +
          `radial-gradient(circle at 0% 0%, ${rgba(glow, 0.18)}, transparent 38%), radial-gradient(circle at 100% 100%, ${rgba(glow, 0.12)}, transparent 32%)`,
      };
    },

    // Particles drifting up from the bottom edge.
    embers(color, color2, size = 1) {
      const dots = scatter(99, 30, 240, 240).map(([x, y, r], i) =>
        `<circle cx='${x}' cy='${y}' r='${f1((0.8 + r * 1.8) * size)}' fill='${i % 3 ? color : color2}' fill-opacity='${f1(0.35 + r * 0.4)}'/>`).join('');
      return {
        bg: `${svg(240, 240, `<defs>${blur('b', 1.2)}</defs><g filter='url(#b)'>${dots}</g>`)} 0 0 / 240px 240px repeat`,
        mask: 'linear-gradient(0deg, #000 0, rgba(0,0,0,.5) 18%, transparent 42%)',
      };
    },

    // Ten glowing rings hanging in an arc in the bottom-right corner.
    tenrings(color, glow) {
      let body = `<defs>${blur('b', 5)}</defs>`;
      for (let i = 0; i < 10; i++) {
        const a = Math.PI * (1.03 + i * 0.05), cx = f1(440 + 290 * Math.cos(a)), cy = f1(430 + 290 * Math.sin(a));
        body += `<ellipse cx='${cx}' cy='${cy}' rx='24' ry='9' fill='none' stroke='${glow}' stroke-opacity='.5' stroke-width='7' filter='url(#b)'/>`;
        body += `<ellipse cx='${cx}' cy='${cy}' rx='24' ry='9' fill='none' stroke='${color}' stroke-opacity='.7' stroke-width='2.4'/>`;
      }
      return { bg: `${svg(520, 420, body)} right -40px bottom -20px / 520px 420px no-repeat, radial-gradient(circle at 100% 100%, ${rgba(glow, 0.16)}, transparent 42%)` };
    },

    // Waves rolling along the bottom edge.
    waves(color, glow) {
      const wave = (y, amp, op, w) => `<path d='M0 ${y} C75 ${y - amp} 75 ${y + amp} 150 ${y} S225 ${y - amp} 300 ${y}' fill='none' stroke='${color}' stroke-opacity='${op}' stroke-width='${w}'/>`;
      const art = wave(40, 18, 0.14, 1.2) + wave(78, 22, 0.2, 1.6) + wave(114, 26, 0.26, 2) + wave(146, 20, 0.3, 2.4);
      return { bg: `${svg(300, 160, `<defs>${blur('b', 3)}</defs><g filter='url(#b)'>${art}</g>${art}`)} 0 100% / 300px 160px repeat-x, radial-gradient(ellipse 90% 45% at 50% 110%, ${rgba(glow, 0.22)}, transparent 70%)` };
    },

    // Pinstripes down both edges and a diamond's glint.
    pinstripe(color, glint) {
      return {
        bg: `repeating-linear-gradient(90deg, ${rgba(color, 0.11)} 0 1px, transparent 1px 16px), ` +
          `radial-gradient(circle at 92% 8%, ${rgba(glint, 0.7)} 0 2px, ${rgba(glint, 0.2)} 7px, transparent 90px), ` +
          `linear-gradient(90deg, ${rgba(glint, 0.06)}, transparent 20%, transparent 80%, ${rgba(glint, 0.06)})`,
        mask: 'linear-gradient(90deg, #000 0, transparent 20%, transparent 80%, #000 100%)',
      };
    },

    // Smoke banked in the lower corners.
    smoke(color, color2) {
      const blobs = [[4, 98, '30% 22%', color, 0.18], [18, 104, '26% 18%', color2, 0.14], [30, 100, '22% 16%', color, 0.1],
        [96, 100, '30% 22%', color, 0.16], [82, 104, '24% 18%', color2, 0.12], [70, 102, '20% 14%', color, 0.08], [0, 70, '14% 20%', color2, 0.08]];
      return { bg: blobs.map(([x, y, s, c, a]) => `radial-gradient(ellipse ${s} at ${x}% ${y}%, ${rgba(c, a)}, transparent 70%)`).join(', ') };
    },

    // Circuit traces running in from both lower corners.
    circuit(color, glow) {
      const traces = [
        'M0 300 H60 L90 270 H180 L210 240 V160', 'M0 330 H110 L140 300 H250', 'M0 360 H40 L70 390 H200 L230 360 H320',
        'M30 420 V380 L60 350 H90', 'M140 420 V340 L170 310 H230 L260 280 V200', 'M250 420 V390 L280 360 H360',
      ];
      const nodes = [[210, 160], [250, 300], [320, 360], [90, 350], [260, 200], [360, 360]];
      const art = traces.map(d => `<path d='${d}' fill='none' stroke='${color}' stroke-opacity='.2' stroke-width='1.4'/>`).join('') +
        nodes.map(([x, y]) => `<circle cx='${x}' cy='${y}' r='3.4' fill='none' stroke='${color}' stroke-opacity='.34' stroke-width='1.4'/>`).join('');
      const draw = (t) => svg(380, 420, `<defs>${blur('b', 3)}</defs><g transform='${t}'><g filter='url(#b)' opacity='.9'>${art}</g>${art}</g>`);
      return {
        bg: `${draw('')} left bottom / 290px 320px no-repeat, ${draw('translate(380 0) scale(-1 1)')} right bottom / 290px 320px no-repeat, ` +
          `radial-gradient(ellipse 60% 40% at 50% 115%, ${rgba(glow, 0.16)}, transparent 70%)`,
      };
    },

    // Magnetic field lines looping out from both sides of the window.
    field(color, color2) {
      const loops = (c) => [1, 2, 3, 4, 5, 6].map(i =>
        `<ellipse cx='0' cy='300' rx='${i * 58}' ry='${i * 44}' fill='none' stroke='${c}' stroke-opacity='${f1(0.34 - i * 0.04)}' stroke-width='1.4'/>`).join('');
      const L = svg(380, 600, `<defs>${blur('b', 3)}</defs><g filter='url(#b)'>${loops(color)}</g>${loops(color)}`);
      const R = svg(380, 600, `<defs>${blur('b', 3)}</defs><g transform='translate(380 0) scale(-1 1)'><g filter='url(#b)'>${loops(color2)}</g>${loops(color2)}</g>`);
      return { bg: `${L} left center / 380px 600px no-repeat, ${R} right center / 380px 600px no-repeat` };
    },

    // Blades fanning down from the top edge like a crown of swords.
    blades(color, glow) {
      let body = `<defs>${blur('b', 4)}<linearGradient id='f' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${color}' stop-opacity='.4'/><stop offset='1' stop-color='${color}' stop-opacity='0'/></linearGradient></defs><g>`;
      for (let i = -6; i <= 6; i++) {
        const a = Math.PI / 2 + i * 0.16, len = 250 + (6 - Math.abs(i)) * 16;
        const ox = 400, oy = -110, tx = ox + len * Math.cos(a), ty = oy + len * Math.sin(a);
        const px = -Math.sin(a) * 6, py = Math.cos(a) * 6;
        const pts = `${f1(ox + px)},${f1(oy + py)} ${f1(tx)},${f1(ty)} ${f1(ox - px)},${f1(oy - py)}`;
        body += `<polygon points='${pts}' fill='${glow}' fill-opacity='.18' filter='url(#b)'/><polygon points='${pts}' fill='url(#f)' stroke='${color}' stroke-opacity='.25' stroke-width='.8'/>`;
      }
      return { bg: `${svg(800, 440, body + '</g>')} 50% 0 / 800px 440px no-repeat` };
    },

    // Brushed metal across the top and a sheen raked over it.
    brushed(color) {
      return {
        bg: `linear-gradient(118deg, transparent 30%, ${rgba(color, 0.08)} 45%, transparent 60%), repeating-linear-gradient(0deg, ${rgba(color, 0.04)} 0 1px, transparent 1px 3px)`,
        mask: 'linear-gradient(180deg, #000 0, #000 56px, rgba(0, 0, 0, .2) 140px, transparent 60%)',
      };
    },
  };

  // ---------- signatures ----------
  // One piece of art per character, belonging to nobody else: Thor's hammer, Loki's horns,
  // Ultron's eyes. The shared motifs above only ever supply ambience (a glow, a star field)
  // next to a signature, never stand in for one. Every piece is drawn twice, blurred then
  // crisp (`lit`), which is what makes it read as light rather than as a drawing.
  const rng = (seed) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); };
  const lit = (body) => `<g filter='url(#b)'>${body}</g>${body}`;
  const art = (w, h, body, s = 4, defs = '') => svg(w, h, `<defs>${blur('b', s)}${defs}</defs>${body}`);
  const put = (img, pos, w, h) => `${img} ${pos} / ${w}px ${h}px no-repeat`;
  const rg = (c, where, size, a) => `radial-gradient(ellipse ${size} at ${where}, ${rgba(c, a)}, transparent 70%)`;
  const layer = (parts, mask) => ({ bg: parts.filter(Boolean).join(', '), mask });
  const plus = (m, ...extra) => ({ bg: [m.bg, ...extra].join(', '), mask: m.mask });
  const pts = (list) => list.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ');
  // A jagged line from one point to another: cracks, arcs, bolts.
  function jag(x1, y1, x2, y2, n, amp, rnd) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, px = -dy / len, py = dx / len;
    const out = [[x1, y1]];
    for (let i = 1; i < n; i++) { const t = i / n, o = (rnd() * 2 - 1) * amp; out.push([x1 + dx * t + px * o, y1 + dy * t + py * o]); }
    out.push([x2, y2]);
    return pts(out);
  }
  const line = (x1, y1, x2, y2, c, o, w, extra = '') => `<line x1='${f1(x1)}' y1='${f1(y1)}' x2='${f1(x2)}' y2='${f1(y2)}' stroke='${c}' stroke-opacity='${o}' stroke-width='${w}' ${extra}/>`;
  const poly = (p, c, o, w, fill = 'none', fo = 0) => `<polyline points='${p}' fill='${fill}' fill-opacity='${fo}' stroke='${c}' stroke-opacity='${o}' stroke-width='${w}' stroke-linejoin='round' stroke-linecap='round'/>`;
  function starPts(cx, cy, R, r, n, rot = -Math.PI / 2) {
    const out = [];
    for (let i = 0; i < n * 2; i++) { const rad = i % 2 ? r : R, a = rot + i * Math.PI / n; out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); }
    return pts(out);
  }
  // A logarithmic spiral arm, for storms and vortices.
  function spiral(cx, cy, r0, grow, turns, rot, squash = 1) {
    const out = [];
    for (let t = 0; t <= turns * Math.PI * 2; t += 0.18) { const r = r0 * Math.exp(grow * t); out.push([cx + r * Math.cos(t + rot), cy + r * Math.sin(t + rot) * squash]); }
    return pts(out);
  }

  const SIG = {
    // Arc reactor crowning the toolbar, HUD brackets framing the four corners.
    ironmanHud(c) {
      let b = `<path d='M14 84 V14 H84' fill='none' stroke='${c}' stroke-opacity='.5' stroke-width='2'/>` +
        `<path d='M26 58 V26 H58' fill='none' stroke='${c}' stroke-opacity='.28' stroke-width='1'/>` +
        `<path d='M34 196 A162 162 0 0 1 196 34' fill='none' stroke='${c}' stroke-opacity='.26' stroke-width='1.5' stroke-dasharray='14 5 3 5'/>` +
        `<path d='M52 150 A98 98 0 0 1 150 52' fill='none' stroke='${c}' stroke-opacity='.16' stroke-width='6' stroke-dasharray='3 9'/>` +
        `<circle cx='112' cy='112' r='6' fill='none' stroke='${c}' stroke-opacity='.4'/>` +
        `<rect x='98' y='18' width='46' height='3' fill='${c}' fill-opacity='.35'/><rect x='98' y='25' width='28' height='2' fill='${c}' fill-opacity='.25'/>` +
        `<rect x='18' y='98' width='3' height='38' fill='${c}' fill-opacity='.3'/>`;
      for (let i = 0; i < 7; i++) b += line(14 + i * 10, 6, 14 + i * 10, i % 3 ? 10 : 3, c, 0.35, 1);
      const img = (t) => art(220, 220, `<g transform='${t}'>${lit(b)}</g>`, 2.5);
      return layer([
        put(img(''), 'left 8px top 62px', 220, 220), put(img('translate(220 0) scale(-1 1)'), 'right 8px top 62px', 220, 220),
        put(img('translate(0 220) scale(1 -1)'), 'left 8px bottom 8px', 220, 220), put(img('translate(220 220) scale(-1 -1)'), 'right 8px bottom 8px', 220, 220),
      ]);
    },

    // A field of stars over the top-left, red-and-white stripes fading from the bottom-left.
    starsStripes(red, white) {
      let stars = '';
      for (let r = 0; r < 4; r++) for (let k = 0; k < 6; k++) stars += `<polygon points='${starPts(22 + k * 40 + (r % 2) * 20, 20 + r * 34, 8, 3.3, 5)}' fill='${white}' fill-opacity='.3'/>`;
      let stripes = `<mask id='m'><rect width='420' height='300' fill='url(#fade)'/></mask>`;
      let bands = '';
      for (let i = 0; i < 10; i++) bands += `<rect x='0' y='${i * 30}' width='420' height='15' fill='${i % 2 ? white : red}' fill-opacity='${i % 2 ? 0.05 : 0.16}'/>`;
      const fade = `<radialGradient id='fade' cx='0' cy='1' r='1'><stop offset='0' stop-color='white'/><stop offset='1' stop-color='black'/></radialGradient>`;
      return layer([
        put(art(260, 140, lit(stars), 2), 'left 10px top 64px', 260, 140),
        put(svg(420, 300, `<defs>${fade}</defs>${stripes}<g mask='url(#m)'>${bands}</g>`), 'left bottom', 420, 300),
      ]);
    },

    // Mjolnir in the top-right, lightning crackling off its head.
    mjolnir(steel, bolt, glow) {
      const r = rng(11);
      let h = `<g transform='rotate(-35 260 102)'>` +
        `<rect x='190' y='60' width='140' height='84' rx='8' fill='${steel}' fill-opacity='.12' stroke='${steel}' stroke-opacity='.6' stroke-width='2'/>` +
        `<rect x='203' y='73' width='114' height='58' rx='4' fill='none' stroke='${steel}' stroke-opacity='.3'/>` +
        `<rect x='178' y='68' width='12' height='68' rx='3' fill='${steel}' fill-opacity='.1' stroke='${steel}' stroke-opacity='.45'/>` +
        `<rect x='330' y='68' width='12' height='68' rx='3' fill='${steel}' fill-opacity='.1' stroke='${steel}' stroke-opacity='.45'/>` +
        `<rect x='250' y='144' width='20' height='190' rx='5' fill='#b08a5a' fill-opacity='.16' stroke='#d8b88a' stroke-opacity='.4'/>`;
      for (let i = 0; i < 9; i++) h += line(250, 156 + i * 19, 270, 164 + i * 19, '#d8b88a', 0.32, 1.4);
      h += `<rect x='246' y='332' width='28' height='16' rx='4' fill='${steel}' fill-opacity='.14' stroke='${steel}' stroke-opacity='.5'/>` +
        `<path d='M260 348 C236 392 284 392 260 348' fill='none' stroke='#d8b88a' stroke-opacity='.4' stroke-width='2'/></g>`;
      let bolts = '';
      [[40, 40], [30, 230], [120, 400], [360, 300], [200, 10]].forEach(([x, y], i) => {
        const p = jag(250, 110, x, y, 7, 16, r);
        bolts += poly(p, glow, 0.5, 9) + poly(p, bolt, 0.6, 2.2) + poly(p, '#ffffff', 0.5, 0.9);
      });
      return layer([put(art(400, 440, `<g filter='url(#b)'>${bolts}</g>${bolts}${lit(h)}`, 5), 'right -20px top -10px', 400, 440), rg(glow, '100% 0%', '45% 50%', 0.18)]);
    },

    // The Bifrost: a rainbow road rising out of the bottom-left corner.
    bifrost() {
      const cols = ['#ff5a5a', '#ffb04a', '#ffe46a', '#6ae08a', '#5ab0ff', '#a07aff'];
      let bands = '';
      cols.forEach((c, i) => { const o = (i - 2.5) * 7; bands += line(0 + o, 560 + o, 560 + o, 0 + o, c, 0.3, 6); });
      const defs = `<radialGradient id='f' gradientUnits='userSpaceOnUse' cx='0' cy='560' r='560'><stop offset='0' stop-color='white'/><stop offset='1' stop-color='black'/></radialGradient><mask id='m'><rect width='560' height='560' fill='url(#f)'/></mask>`;
      return layer([put(art(560, 560, `<g mask='url(#m)'>${lit(bands)}</g>`, 5, defs), 'left bottom', 560, 560)]);
    },

    // The smash: the floor split open from a point of impact at the bottom edge.
    smash(glow, core) {
      const r = rng(42);
      let cracks = '';
      for (let k = 0; k < 11; k++) {
        const a = Math.PI + (k + 0.5) / 11 * Math.PI, len = 140 + r() * 200;
        const x2 = 500 + Math.cos(a) * len, y2 = 330 + Math.sin(a) * len;
        cracks += poly(jag(500, 330, x2, y2, 7, 14, r), glow, 0.34, 5);
        const mx = 500 + Math.cos(a) * len * 0.5, my = 330 + Math.sin(a) * len * 0.5, b = a + (r() - 0.5) * 1.2;
        cracks += poly(jag(mx, my, mx + Math.cos(b) * len * 0.35, my + Math.sin(b) * len * 0.35, 4, 8, r), glow, 0.26, 3);
      }
      const coreLines = cracks.replace(new RegExp(`stroke='${glow}'`, 'g'), `stroke='${core}'`).replace(/stroke-width='[35]'/g, "stroke-width='1.1'").replace(/stroke-opacity='0\.(34|26)'/g, "stroke-opacity='0.4'");
      return layer([put(art(1000, 330, `<g filter='url(#b)'>${cracks}</g>${coreLines}`, 4), '50% 100%', 1000, 330), rg(glow, '50% 108%', '70% 40%', 0.22)]);
    },

    // Widow's Bites: two discs crackling with blue current, bottom-left.
    widowBites(c) {
      const r = rng(5);
      let b = '';
      [[80, 150], [175, 172]].forEach(([x, y]) => {
        b += `<circle cx='${x}' cy='${y}' r='12' fill='${c}' fill-opacity='.22' stroke='${c}' stroke-opacity='.7' stroke-width='1.5'/>`;
        const ring = [];
        for (let i = 0; i <= 26; i++) { const a = i / 26 * Math.PI * 2, rr = 20 + r() * 12; ring.push([x + rr * Math.cos(a), y + rr * Math.sin(a)]); }
        b += poly(pts(ring), '#dff0ff', 0.55, 1.2);
      });
      return layer([put(art(300, 230, lit(b), 3), 'left 14px bottom 14px', 300, 230), rg(c, '0% 100%', '30% 35%', 0.14)]);
    },

    // An archery target in the bottom-left with an arrow buried in the gold.
    target(a, b) {
      const rings = [[170, a, 0.14], [128, b, 0.12], [86, a, 0.16], [44, b, 0.16]].map(([r, c, o]) => `<circle cx='180' cy='180' r='${r}' fill='none' stroke='${c}' stroke-opacity='${o}' stroke-width='28'/>`).join('');
      const arrow = line(180, 180, 310, 50, b, 0.6, 2.2) + line(300, 60, 320, 30, a, 0.6, 3) + line(300, 60, 330, 58, a, 0.6, 3) + line(292, 68, 312, 38, a, 0.4, 2) + line(292, 68, 322, 66, a, 0.4, 2);
      return layer([put(art(360, 360, rings + `<circle cx='180' cy='180' r='12' fill='${a}' fill-opacity='.35'/>` + lit(arrow), 3), 'left -110px bottom -110px', 360, 360)]);
    },

    // Kinetic energy released: a shockwave of vibranium purple bursting from the floor.
    kinetic(c, spark) {
      const r = rng(21);
      let b = '';
      [[200, 110, 0.55, 3], [330, 175, 0.32, 2], [460, 240, 0.18, 1.5]].forEach(([rx, ry, o, w]) => { b += `<ellipse cx='500' cy='420' rx='${rx}' ry='${ry}' fill='none' stroke='${c}' stroke-opacity='${o}' stroke-width='${w}'/>`; });
      for (let i = 0; i < 26; i++) {
        const a = Math.PI + 0.12 + (i / 25) * (Math.PI - 0.24), r1 = 1.05 + r() * 0.2, r2 = r1 + 0.15 + r() * 0.35;
        b += line(500 + Math.cos(a) * 200 * r1, 420 + Math.sin(a) * 110 * r1, 500 + Math.cos(a) * 200 * r2 * 1.4, 420 + Math.sin(a) * 110 * r2 * 1.4, spark, 0.45, 1.2);
      }
      return layer([put(art(1000, 380, lit(b), 4), '50% 100%', 1000, 380), rg(c, '50% 110%', '60% 35%', 0.22)]);
    },
    // Wakandan triangle lattice across both top corners.
    wakanda(c) {
      const tile = svg(24, 41.57, `<path d='M0 0 H24 M0 20.78 H24 M0 0 L24 41.57 M24 0 L0 41.57' fill='none' stroke='${c}' stroke-opacity='.16' stroke-width='.7'/>`);
      return layer([`${tile} 0 0 / 24px 41.57px repeat`], 'radial-gradient(circle at 0 0, #000, transparent 32%), radial-gradient(circle at 100% 0, #000, transparent 32%)');
    },

    // A lens flare burning at the top of the window, its ghosts falling away to the right.
    photonFlare(core, gold, red, blue) {
      const spike = (L, w, rot) => `<polygon points='${pts([[350 - L, 40], [350, 40 - w], [350 + L, 40], [350, 40 + w]])}' fill='${core}' fill-opacity='.5' transform='rotate(${rot} 350 40)'/>`;
      const star = spike(330, 3, 0) + spike(200, 3, 90) + spike(90, 2, 45) + spike(90, 2, -45);
      const ghosts = `<circle cx='430' cy='118' r='14' fill='${gold}' fill-opacity='.18'/>` +
        `<circle cx='482' cy='168' r='26' fill='none' stroke='${red}' stroke-opacity='.18' stroke-width='3'/>` +
        `<polygon points='${starPts(524, 212, 12, 12, 3, 0)}' fill='${blue}' fill-opacity='.2'/>` +
        `<circle cx='570' cy='256' r='40' fill='none' stroke='${gold}' stroke-opacity='.1' stroke-width='6'/>`;
      const g = `<radialGradient id='g'><stop offset='0' stop-color='#ffffff' stop-opacity='.8'/><stop offset='.25' stop-color='${core}' stop-opacity='.35'/><stop offset='1' stop-color='${core}' stop-opacity='0'/></radialGradient>`;
      return layer([put(art(700, 320, `<circle cx='350' cy='40' r='90' fill='url(#g)'/>${lit(star)}${ghosts}`, 3, g), '50% 0', 700, 320)]);
    },

    // Wanda's crown glowing at the top edge.
    tiara(fill, glow) {
      const d = 'M60 120 C110 110 140 80 160 40 L180 90 L200 8 L220 90 L240 40 C260 80 290 110 340 120 C280 100 240 104 200 118 C160 104 120 100 60 120 Z';
      return layer([put(art(400, 140, lit(`<path d='${d}' fill='${fill}' fill-opacity='.22' stroke='${glow}' stroke-opacity='.65' stroke-width='1.6'/>`), 5), '50% 2px', 400, 140), rg(glow, '50% 0%', '40% 25%', 0.14)]);
    },
    // Chaos magic: spirals of red light curling up from both lower corners.
    chaos(c, c2) {
      const r = rng(9);
      let b = '';
      for (let k = 0; k < 5; k++) {
        const cx = 60 + r() * 260, cy = 260 + r() * 180;
        b += poly(spiral(cx, cy, 3, 0.2, 2.2 + r(), r() * 6), k % 2 ? c2 : c, 0.3, 1.4);
      }
      b += `<path d='M20 460 C80 380 60 300 140 240 S260 160 240 60' fill='none' stroke='${c}' stroke-opacity='.2' stroke-width='2'/>`;
      const img = (t) => art(460, 460, `<g transform='${t}'>${lit(b)}</g>`, 4);
      return layer([put(img(''), 'left bottom', 460, 460), put(img('translate(460 0) scale(-1 1)'), 'right bottom', 460, 460), rg(c, '50% 110%', '70% 35%', 0.14)]);
    },

    // The Quantum Realm: a tunnel of turning hexagons in the top-right.
    quantum(cols) {
      let b = '';
      for (let i = 0; i < 10; i++) {
        const s = 12 + i * 20, rot = i * 7;
        b += `<polygon points='${starPts(380, 150, s, s, 3, rot * Math.PI / 180)}' fill='none' stroke='${cols[i % cols.length]}' stroke-opacity='${f1(0.55 - i * 0.04)}' stroke-width='1.4'/>`;
      }
      const g = `<radialGradient id='g'><stop offset='0' stop-color='#ffffff' stop-opacity='.5'/><stop offset='1' stop-color='${cols[0]}' stop-opacity='0'/></radialGradient>`;
      return layer([put(art(540, 520, `<circle cx='380' cy='150' r='60' fill='url(#g)'/>${lit(b)}`, 3, g), 'right -60px top -40px', 540, 520)]);
    },
    // A line of ants marching along the bottom edge.
    ants(c) {
      const ant = (x, y) => `<ellipse cx='${x}' cy='${y}' rx='2.4' ry='2.2' fill='${c}'/><ellipse cx='${x + 5}' cy='${y}' rx='2.8' ry='2'/><ellipse cx='${x + 11}' cy='${y}' rx='4.4' ry='3.2' fill='${c}'/>` +
        [-1, 1].map(s => [0, 1, 2].map(k => line(x + 3 + k * 2.4, y, x + 1 + k * 3.4, y + s * 5, c, 0.8, 0.7)).join('')).join('');
      const tile = svg(180, 30, `<g fill='${c}' fill-opacity='.5'>${ant(30, 18)}${ant(112, 20)}</g>`);
      return layer([`${tile} 0 100% / 180px 30px repeat-x`, rg(c, '50% 110%', '60% 25%', 0.1)]);
    },

    // Wings spread from the top-left corner; stinger blasts flying out of the bottom-right.
    waspWings(c, vein, blast) {
      const wing = (a, len, w) => {
        const d = `M0 0 C${len * 0.25} ${-w} ${len * 0.75} ${-w * 1.05} ${len} ${-w * 0.1} C${len * 0.8} ${w * 0.55} ${len * 0.3} ${w * 0.5} 0 0 Z`;
        return `<g transform='translate(40 40) rotate(${a})'><path d='${d}' fill='${c}' fill-opacity='.08' stroke='${vein}' stroke-opacity='.5' stroke-width='1.2'/>` +
          line(0, 0, len * 0.9, -w * 0.3, vein, 0.28, 0.8) + line(0, 0, len * 0.7, w * 0.1, vein, 0.24, 0.8) + line(len * 0.3, -w * 0.4, len * 0.55, w * 0.2, vein, 0.2, 0.8) + '</g>';
      };
      const wings = wing(16, 330, 70) + wing(38, 280, 56) + wing(62, 200, 44) + wing(80, 150, 34);
      let blasts = '';
      [[60, 60], [150, 110], [90, 170], [220, 190], [250, 80]].forEach(([x, y]) => {
        blasts += line(x - 60, y - 30, x, y, blast, 0.25, 3) + `<ellipse cx='${x}' cy='${y}' rx='14' ry='4' fill='${blast}' fill-opacity='.75' transform='rotate(26 ${x} ${y})'/>`;
      });
      return layer([put(art(440, 330, lit(wings), 3), 'left -10px top 40px', 440, 330), put(art(320, 240, lit(blasts), 3), 'right 20px bottom 20px', 320, 240)]);
    },

    // Mechanical wings fanned from the top-left; Redwing flying a red trail across the top-right.
    falconWings(steel, red) {
      let f = '';
      for (let i = 0; i < 10; i++) {
        const a = 6 + i * 8.5, len = 230 + i * 12;
        f += `<g transform='rotate(${a})'><rect x='30' y='-9' width='${len}' height='18' rx='9' fill='${steel}' fill-opacity='.05' stroke='${steel}' stroke-opacity='.3' stroke-width='1.1'/>` +
          line(40, 0, len + 10, 0, steel, 0.22, 0.8) + line(len - 4, -5, len + 20, -5, red, 0.6, 2) + '</g>';
      }
      const tr = `<linearGradient id='t' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='${red}' stop-opacity='0'/><stop offset='1' stop-color='${red}' stop-opacity='.6'/></linearGradient>`;
      const drone = `<path d='M20 190 C160 160 300 70 456 76' fill='none' stroke='url(#t)' stroke-width='3'/>` +
        `<polygon points='${pts([[486, 74], [450, 60], [458, 76], [450, 92]])}' fill='${red}' fill-opacity='.5' stroke='${red}' stroke-opacity='.8'/><circle cx='470' cy='76' r='3' fill='#ffffff' fill-opacity='.9'/>`;
      return layer([put(art(480, 480, lit(f), 3), 'left -10px top 30px', 480, 480), put(art(520, 220, lit(drone), 4, tr), 'right 10px top 70px', 520, 220)]);
    },

    // An equaliser dancing along the bottom edge, the Awesome Mix in the corner.
    mixtape(orange, gold) {
      const r = rng(77);
      let bars = '';
      for (let i = 0; i < 16; i++) {
        const h = 24 + Math.abs(Math.sin(i * 1.7) * 70) + r() * 50;
        bars += `<rect x='${i * 15 + 2}' y='${f1(150 - h)}' width='10' height='${f1(h)}' rx='2' fill='url(#q)'/><rect x='${i * 15 + 2}' y='${f1(144 - h)}' width='10' height='2.5' fill='${gold}' fill-opacity='.45'/>`;
      }
      const q = `<linearGradient id='q' x1='0' y1='1' x2='0' y2='0'><stop offset='0' stop-color='${orange}' stop-opacity='.3'/><stop offset='1' stop-color='${gold}' stop-opacity='.04'/></linearGradient>`;
      let reel = (cx) => `<circle cx='${cx}' cy='70' r='18' fill='none' stroke='${gold}' stroke-opacity='.5' stroke-width='2'/>` +
        [0, 1, 2, 3, 4, 5].map(k => line(cx, 70, cx + 12 * Math.cos(k * Math.PI / 3), 70 + 12 * Math.sin(k * Math.PI / 3), gold, 0.4, 1.4)).join('');
      const tape = `<rect x='10' y='10' width='220' height='130' rx='10' fill='${orange}' fill-opacity='.06' stroke='${orange}' stroke-opacity='.5' stroke-width='2'/>` +
        `<rect x='30' y='24' width='180' height='26' rx='3' fill='none' stroke='${gold}' stroke-opacity='.35'/>` +
        `<rect x='60' y='54' width='120' height='34' rx='6' fill='none' stroke='${orange}' stroke-opacity='.4'/>${reel(84)}${reel(156)}` +
        `<path d='M60 140 L76 110 H164 L180 140' fill='none' stroke='${orange}' stroke-opacity='.4' stroke-width='1.5'/>`;
      return layer([`${art(240, 150, lit(bars), 2.5, q)} 0 100% / 240px 150px repeat-x`, put(art(240, 150, lit(tape), 3), 'right 24px bottom 24px', 240, 150)]);
    },

    // The Godslayer: a long blade drawn across the top-right, green light along its edge.
    godslayer(steel, glow) {
      const s = `<g transform='translate(470 50) rotate(135)'>` +
        `<polygon points='0,-7 360,-5 410,0 360,5 0,7' fill='${steel}' fill-opacity='.14' stroke='${glow}' stroke-opacity='.65' stroke-width='1.3'/>` +
        line(10, 0, 340, 0, steel, 0.4, 0.8) +
        `<path d='M-6 -30 C4 -20 4 20 -6 30 L2 30 C10 16 10 -16 2 -30 Z' fill='${steel}' fill-opacity='.2' stroke='${steel}' stroke-opacity='.55'/>` +
        `<rect x='-70' y='-5' width='64' height='10' rx='3' fill='${glow}' fill-opacity='.12' stroke='${steel}' stroke-opacity='.45'/><circle cx='-78' cy='0' r='7' fill='none' stroke='${steel}' stroke-opacity='.55' stroke-width='1.5'/></g>`;
      return layer([put(art(520, 520, lit(s), 4), 'right -10px top -10px', 520, 520), rg(glow, '100% 0%', '40% 45%', 0.14)]);
    },
    // The silver markings on Gamora's cheekbones, as dotted arcs down the left edge.
    zenMarks(c) {
      let d = '';
      for (let row = 0; row < 3; row++) for (let i = 0; i < 18; i++) {
        const y = 40 + i * 30, x = 20 + row * 16 + Math.sin(i * 0.35) * 22;
        d += `<circle cx='${f1(x)}' cy='${y}' r='${row === 1 ? 2.2 : 1.6}' fill='${c}' fill-opacity='.45'/>`;
      }
      return layer([put(art(120, 600, lit(d), 1.5), 'left 4px center', 120, 600)]);
    },

    // Branches growing in from both lower corners, leaves at their tips.
    branches(bark, leaf) {
      const r = rng(3);
      let b = '';
      const grow = (x, y, a, len, depth) => {
        const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
        b += line(x, y, x2, y2, bark, 0.3 + depth * 0.03, Math.max(1, depth * 1.4), "stroke-linecap='round'");
        if (depth === 0) { b += `<ellipse cx='${f1(x2)}' cy='${f1(y2)}' rx='7' ry='3.4' fill='${leaf}' fill-opacity='.4' transform='rotate(${f1(a * 180 / Math.PI)} ${f1(x2)} ${f1(y2)})'/>`; return; }
        grow(x2, y2, a - 0.35 - r() * 0.3, len * (0.68 + r() * 0.12), depth - 1);
        grow(x2, y2, a + 0.3 + r() * 0.3, len * (0.62 + r() * 0.12), depth - 1);
      };
      grow(0, 560, -1.0, 130, 6);
      grow(40, 600, -1.35, 110, 5);
      const img = (t) => art(560, 600, `<g transform='${t}'>${lit(b)}</g>`, 3);
      return layer([put(img(''), 'left bottom', 560, 600), put(img('translate(560 0) scale(-1 1)'), 'right bottom', 460, 493)]);
    },

    // A weapon blueprint on a drafting grid in the bottom-left.
    blueprint(c, white) {
      const g = `<rect x='40' y='90' width='240' height='56' rx='6' fill='none' stroke='${white}' stroke-opacity='.5' stroke-width='1.5'/>` +
        `<rect x='280' y='104' width='120' height='16' fill='none' stroke='${white}' stroke-opacity='.5' stroke-width='1.5'/><rect x='280' y='124' width='96' height='10' fill='none' stroke='${white}' stroke-opacity='.4'/>` +
        `<circle cx='170' cy='70' r='18' fill='none' stroke='${white}' stroke-opacity='.5' stroke-width='1.5'/>` + line(152, 70, 188, 70, white, 0.4, 1) + line(170, 52, 170, 88, white, 0.4, 1) +
        `<path d='M90 146 L70 210 H108 L130 146' fill='none' stroke='${white}' stroke-opacity='.45' stroke-width='1.5'/>` +
        line(40, 170 + 60, 400, 230, c, 0.5, 1) + line(40, 222, 40, 238, c, 0.5, 1) + line(400, 222, 400, 238, c, 0.5, 1) +
        line(420, 90, 420, 146, c, 0.5, 1) + `<rect x='190' y='226' width='40' height='8' fill='${c}' fill-opacity='.3'/>`;
      return layer([
        `linear-gradient(${rgba(c, 0.09)} 1px, transparent 1px) 0 0 / 24px 24px, linear-gradient(90deg, ${rgba(c, 0.09)} 1px, transparent 1px) 0 0 / 24px 24px`,
        put(art(440, 260, lit(g), 2), 'left 16px bottom 16px', 440, 260), rg(c, '0% 100%', '45% 50%', 0.14),
      ], 'radial-gradient(ellipse 48% 58% at 0% 100%, #000 35%, transparent 100%)');
    },
    // A targeting reticle locked on in the top-right.
    reticle(c) {
      let b = `<circle cx='140' cy='140' r='110' fill='none' stroke='${c}' stroke-opacity='.4' stroke-width='1.5' stroke-dasharray='30 10'/>` +
        `<circle cx='140' cy='140' r='96' fill='none' stroke='${c}' stroke-opacity='.3' stroke-width='8' stroke-dasharray='1.5 7'/>` +
        `<circle cx='140' cy='140' r='60' fill='none' stroke='${c}' stroke-opacity='.5' stroke-width='1.5'/><circle cx='140' cy='140' r='4' fill='${c}' fill-opacity='.7'/>` +
        line(140, 10, 140, 110, c, 0.5, 1.2) + line(140, 170, 140, 270, c, 0.5, 1.2) + line(10, 140, 110, 140, c, 0.5, 1.2) + line(170, 140, 270, 140, c, 0.5, 1.2);
      [[140, 22], [258, 140], [140, 258], [22, 140]].forEach(([x, y], i) => { b += `<polygon points='${starPts(x, y, 6, 6, 3, i * Math.PI / 2 + Math.PI / 2)}' fill='${c}' fill-opacity='.55'/>`; });
      return layer([put(art(280, 280, lit(b), 3), 'right -40px top 50px', 280, 280), rg(c, '100% 0%', '35% 40%', 0.12)]);
    },

    // The board, streaking in from the top-right with a comet's tail.
    surfboard(silver, trail) {
      const t = `<linearGradient id='t' gradientUnits='userSpaceOnUse' x1='30' y1='310' x2='610' y2='90'><stop offset='0' stop-color='${trail}' stop-opacity='0'/><stop offset='1' stop-color='${trail}' stop-opacity='.55'/></linearGradient>`;
      const b = `<polygon points='30,310 604,80 616,104' fill='url(#t)'/>` +
        `<g transform='translate(630 92) rotate(-21)'><path d='M-74 0 C-40 -15 44 -15 86 0 C44 15 -40 15 -74 0 Z' fill='${silver}' fill-opacity='.35' stroke='#ffffff' stroke-opacity='.7' stroke-width='1.4'/>` +
        line(-50, -4, 60, -5, '#ffffff', 0.6, 1.4) + '</g>';
      return layer([put(art(760, 330, lit(b), 5, t), 'right -20px top 20px', 760, 330), rg(trail, '100% 0%', '40% 40%', 0.14)]);
    },
    // Warp: stars stretched into streaks around the edges of the window.
    warp(c) {
      return layer([`repeating-conic-gradient(from 0deg at 50% 50%, ${rgba(c, 0.09)} 0 0.25deg, transparent 0.25deg 3.7deg)`],
        'radial-gradient(ellipse 72% 72% at 50% 50%, transparent 48%, #000 100%)');
    },

    // DD, stamped in the bottom-right where the radar sense rings out.
    ddEmblem(c) {
      const d = (x) => `<path d='M${x} 20 H${x + 40} C${x + 88} 20 ${x + 88} 116 ${x + 40} 116 H${x} Z' fill='none' stroke='${c}' stroke-opacity='.55' stroke-width='6'/>`;
      return put(art(220, 140, lit(d(20) + d(66)), 3), 'right 40px bottom 40px', 220, 140);
    },
    // Rain lit red by the city, falling around the edges.
    rain(c) {
      const r = rng(8);
      let s = '';
      for (let i = 0; i < 22; i++) { const x = r() * 160, y = r() * 160; s += line(x, y, x + 5, y + 24, c, f1(0.15 + r() * 0.2), 1); }
      return layer([`${svg(160, 160, s)} 0 0 / 160px 160px repeat`], 'radial-gradient(ellipse 70% 70% at 50% 50%, transparent 40%, #000 95%)');
    },

    // A storm's vortex over the top-left corner, lightning dropping out of its eye.
    vortex(cloud, bolt) {
      const r = rng(14);
      let arms = '';
      for (let k = 0; k < 5; k++) { const p = spiral(160, 150, 14, 0.2, 1.6, k * Math.PI * 2 / 5, 0.8); arms += poly(p, cloud, 0.1, 14) + poly(p, cloud, 0.42, 1.6); }
      const bolts = [jag(200, 210, 330, 520, 9, 16, r), jag(260, 350, 190, 470, 5, 10, r)].map(p => poly(p, bolt, 0.4, 8) + poly(p, '#ffffff', 0.6, 1.6)).join('');
      const g = `<radialGradient id='g'><stop offset='0' stop-color='#ffffff' stop-opacity='.3'/><stop offset='1' stop-color='${cloud}' stop-opacity='0'/></radialGradient>`;
      return layer([put(art(560, 560, `<circle cx='160' cy='150' r='34' fill='url(#g)'/><g filter='url(#b)'>${arms}${bolts}</g>${arms}${bolts}`, 5, g), 'left -40px top -30px', 560, 560)]);
    },
    // Gusts of wind sweeping along the bottom edge.
    wind(c) {
      let b = '';
      [[150, 120, 190, 0.18], [120, 90, 160, 0.12], [175, 150, 200, 0.14], [96, 70, 130, 0.1]].forEach(([y, a, z, o]) => {
        b += `<path d='M0 ${y} C300 ${a} 500 ${z} 800 ${y} S1200 ${a} 1400 ${y - 10}' fill='none' stroke='${c}' stroke-opacity='${o}' stroke-width='1.4' stroke-dasharray='180 40 60 30'/>`;
      });
      return layer([put(art(1400, 220, lit(b), 2), '50% 100%', 1400, 220)]);
    },

    // The X in its circle, bottom-right.
    xEmblem(ring, x) {
      const b = `<circle cx='110' cy='110' r='88' fill='none' stroke='${ring}' stroke-opacity='.45' stroke-width='10'/>` +
        `<rect x='97' y='12' width='26' height='196' rx='5' fill='${x}' fill-opacity='.22' stroke='${x}' stroke-opacity='.55' transform='rotate(45 110 110)'/>` +
        `<rect x='97' y='12' width='26' height='196' rx='5' fill='${x}' fill-opacity='.22' stroke='${x}' stroke-opacity='.55' transform='rotate(-45 110 110)'/>`;
      return put(art(220, 220, lit(b), 4), 'right 30px bottom 30px', 220, 220);
    },

    // The Phoenix Force: a firebird with its wings spread across the top of the window.
    firebird(flame, gold) {
      let b = '';
      for (const s of [-1, 1]) for (let i = 0; i < 7; i++) {
        const tx = 450 + s * (140 + i * 44), ty = 30 + i * 24, cx = 450 + s * (60 + i * 22), cy = 150 - i * 4;
        b += `<path d='M${450 + s * 14} 140 Q${cx} ${cy} ${tx} ${ty}' fill='none' stroke='${flame}' stroke-opacity='.45' stroke-width='${f1(9 - i)}' stroke-linecap='round'/>`;
        b += `<path d='M${tx} ${ty} q${s * 18} -6 ${s * 10} -22' fill='none' stroke='${gold}' stroke-opacity='.45' stroke-width='2'/>`;
      }
      b += `<ellipse cx='450' cy='150' rx='16' ry='34' fill='${flame}' fill-opacity='.35'/><circle cx='450' cy='104' r='11' fill='${gold}' fill-opacity='.5'/>` +
        `<polygon points='450,86 444,98 456,98' fill='${gold}' fill-opacity='.7'/>`;
      [[-40, 330], [0, 360], [40, 330]].forEach(([dx, y]) => { b += `<path d='M450 180 C${450 + dx * 0.2} 240 ${450 + dx * 1.4} 280 ${450 + dx} ${y}' fill='none' stroke='${flame}' stroke-opacity='.4' stroke-width='5' stroke-linecap='round'/>`; });
      return layer([put(art(900, 380, lit(b), 6), '50% -10px', 900, 380), rg(gold, '50% 0%', '45% 30%', 0.16)]);
    },

    // Snowflakes drifting across the top edge.
    snowflakes(c) {
      const flake = (x, y, s) => {
        let f = '';
        for (let k = 0; k < 6; k++) {
          const a = k * Math.PI / 3, ex = x + Math.cos(a) * s, ey = y + Math.sin(a) * s, mx = x + Math.cos(a) * s * 0.6, my = y + Math.sin(a) * s * 0.6;
          f += line(x, y, ex, ey, c, 0.45, 1) + line(mx, my, mx + Math.cos(a + 0.6) * s * 0.3, my + Math.sin(a + 0.6) * s * 0.3, c, 0.4, 1) + line(mx, my, mx + Math.cos(a - 0.6) * s * 0.3, my + Math.sin(a - 0.6) * s * 0.3, c, 0.4, 1);
        }
        return f;
      };
      const t = flake(50, 60, 16) + flake(190, 40, 10) + flake(260, 160, 20) + flake(110, 220, 8) + flake(230, 270, 12);
      return layer([`${art(320, 320, lit(t), 1.5)} 0 0 / 320px 320px repeat`], 'linear-gradient(180deg, #000 0, rgba(0,0,0,.4) 22%, transparent 42%)');
    },

    // Flame on: a comet of fire arcing across the top, trailing sparks.
    flameComet(flame, gold) {
      const r = rng(31);
      const t = `<linearGradient id='t' gradientUnits='userSpaceOnUse' x1='40' y1='0' x2='1300' y2='0'><stop offset='0' stop-color='${flame}' stop-opacity='0'/><stop offset='.6' stop-color='${flame}' stop-opacity='.4'/><stop offset='1' stop-color='${gold}' stop-opacity='.7'/></linearGradient>`;
      const d = 'M40 200 C400 60 900 20 1300 70';
      let b = `<path d='${d}' fill='none' stroke='url(#t)' stroke-width='22' stroke-linecap='round' filter='url(#b)'/>` +
        `<path d='${d}' fill='none' stroke='url(#t)' stroke-width='7' stroke-linecap='round'/><path d='${d}' fill='none' stroke='#fff6d8' stroke-opacity='.4' stroke-width='1.5'/>` +
        `<circle cx='1300' cy='70' r='30' fill='${gold}' fill-opacity='.6' filter='url(#b)'/><circle cx='1300' cy='70' r='10' fill='#ffffff' fill-opacity='.85'/>`;
      for (let i = 0; i < 40; i++) { const x = 200 + r() * 1080, y = 200 - (x - 40) * 0.1 + (r() - 0.5) * 70; b += `<circle cx='${f1(x)}' cy='${f1(y)}' r='${f1(0.8 + r() * 1.6)}' fill='${gold}' fill-opacity='${f1(0.3 + r() * 0.5)}'/>`; }
      return layer([put(art(1400, 260, b, 8, t), '50% 0', 1400, 260)]);
    },
    // The 4 in its ring, bottom-right.
    fourEmblem(ring, glow) {
      const b = `<circle cx='100' cy='100' r='78' fill='none' stroke='${ring}' stroke-opacity='.5' stroke-width='8'/>` +
        `<path d='M114 48 L62 120 H138 M114 48 V156' fill='none' stroke='${ring}' stroke-opacity='.6' stroke-width='14' stroke-linecap='square' stroke-linejoin='miter'/>`;
      return layer([put(art(200, 200, lit(b), 4), 'right 30px bottom 30px', 200, 200), rg(glow, '50% 110%', '70% 35%', 0.18)]);
    },

    // The Great Protector's scales rising from the floor.
    dragonScales(c, gold) {
      const tile = svg(40, 22, `<path d='M0 22 A20 20 0 0 1 40 22 M-20 11 A20 20 0 0 1 20 11 M20 11 A20 20 0 0 1 60 11' fill='none' stroke='${c}' stroke-opacity='.22' stroke-width='1'/>`);
      return layer([`${tile} 0 100% / 40px 22px repeat`, rg(c, '50% 110%', '70% 40%', 0.18), rg(gold, '0% 0%', '40% 45%', 0.12)],
        'linear-gradient(0deg, #000 0, rgba(0,0,0,.5) 18%, transparent 36%)');
    },

    // Spider-Verse: halftone dots and a web printed twice, a few pixels out of register.
    verse(red, cyan) {
      const web = (c, at) => `repeating-radial-gradient(circle at ${at}, transparent 0 46px, ${rgba(c, 0.13)} 47px 48px), repeating-conic-gradient(from 0deg at ${at}, ${rgba(c, 0.13)} 0 0.35deg, transparent 0.35deg 11.25deg)`;
      return layer([
        web(red, '100% 0'), web(cyan, 'calc(100% - 6px) 5px'),
        `radial-gradient(circle, ${rgba(red, 0.24)} 1.3px, transparent 1.8px) 0 0 / 9px 9px`, rg(red, '100% 0%', '40% 40%', 0.14),
      ], 'radial-gradient(circle at 100% 0, #000 0%, transparent 50%)');
    },
    // A burst of spray paint in the bottom-left, dripping, with venom sparks beside it.
    spray(c, c2, spark) {
      const r = rng(12);
      const blob = [];
      for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, rr = 58 + (r() - 0.5) * 34; blob.push([120 + rr * Math.cos(a), 220 + rr * Math.sin(a)]); }
      let b = `<polygon points='${pts(blob)}' fill='${c}' fill-opacity='.25' stroke='${c}' stroke-opacity='.4'/>`;
      for (let i = 0; i < 16; i++) { const a = r() * Math.PI * 2, d = 80 + r() * 90; b += `<circle cx='${f1(120 + d * Math.cos(a))}' cy='${f1(220 + d * Math.sin(a))}' r='${f1(1.5 + r() * 5)}' fill='${i % 3 ? c : c2}' fill-opacity='.35'/>`; }
      [70, 110, 150].forEach((x, i) => { const h = 50 + i * 26; b += `<rect x='${x - 3}' y='250' width='6' height='${h}' rx='3' fill='${c}' fill-opacity='.28'/><circle cx='${x}' cy='${250 + h}' r='5' fill='${c}' fill-opacity='.3'/>`; });
      const arcs = [jag(230, 120, 300, 60, 6, 8, r), jag(240, 170, 320, 150, 6, 8, r)].map(p => poly(p, spark, 0.6, 1.4)).join('');
      return layer([put(art(340, 360, lit(b) + lit(arcs), 3), 'left -20px bottom -40px', 340, 360)]);
    },

    // Watercolour blooms in the corners and a spider on a thread.
    watercolor(pink, teal, purple) {
      const thread = line(30, 0, 30, 250, '#ffffff', 0.35, 1) + `<ellipse cx='30' cy='262' rx='5' ry='7' fill='#ffffff' fill-opacity='.5'/><circle cx='30' cy='252' r='3' fill='#ffffff' fill-opacity='.55'/>` +
        [-1, 1].map(s => [0, 1, 2, 3].map(k => `<path d='M30 ${258 + k * 3} q${s * 8} ${-6 + k * 3} ${s * 13} ${2 + k * 3}' fill='none' stroke='#ffffff' stroke-opacity='.45'/>`).join('')).join('');
      return layer([
        put(art(60, 290, lit(thread), 2), 'right 150px top 0', 60, 290),
        rg(pink, '4% 96%', '28% 24%', 0.2), rg(teal, '16% 104%', '22% 20%', 0.16), rg(purple, '0% 70%', '14% 22%', 0.12),
        rg(teal, '96% 4%', '26% 22%', 0.14), rg(pink, '86% -4%', '20% 18%', 0.12), rg(purple, '100% 96%', '24% 24%', 0.12),
      ]);
    },
    // Stage lights cutting down from the top: pink, teal, purple.
    stageLights(cols) {
      let b = '';
      cols.forEach((c, i) => {
        const x = 300 + i * 300;
        b += `<linearGradient id='l${i}' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${c}' stop-opacity='.13'/><stop offset='1' stop-color='${c}' stop-opacity='0'/></linearGradient>` +
          `<polygon points='${x - 14},0 ${x + 14},0 ${x + 150 - i * 60},500 ${x - 150 - i * 60 + 120},500' fill='url(#l${i})'/>`;
      });
      return layer([put(svg(1200, 500, b), '50% 0', 1200, 500)]);
    },

    // Crossed katanas behind the shoulder, and the mask's two white eyes beside them.
    deadpoolMask(red, white) {
      const b = `<path d='M84 12 A78 78 0 0 0 84 168 Z' fill='${red}' fill-opacity='.2' stroke='${red}' stroke-opacity='.55' stroke-width='3'/>` +
        `<path d='M96 12 A78 78 0 0 1 96 168 Z' fill='${red}' fill-opacity='.2' stroke='${red}' stroke-opacity='.55' stroke-width='3'/>` +
        `<path d='M34 76 C48 62 66 66 76 80 C62 90 44 88 34 76 Z' fill='${white}' fill-opacity='.55'/>` +
        `<path d='M146 76 C132 62 114 66 104 80 C118 90 136 88 146 76 Z' fill='${white}' fill-opacity='.55'/>`;
      return put(art(180, 180, lit(b), 3), 'left 30px bottom 30px', 180, 180);
    },
    // A speech bubble, because he would.
    bubble(c) {
      const b = `<path d='M16 12 H204 A12 12 0 0 1 216 24 V84 A12 12 0 0 1 204 96 H70 L40 122 L46 96 H16 A12 12 0 0 1 4 84 V24 A12 12 0 0 1 16 12 Z' fill='${c}' fill-opacity='.05' stroke='${c}' stroke-opacity='.4' stroke-width='2'/>` +
        [80, 110, 140].map(x => `<circle cx='${x}' cy='54' r='6' fill='${c}' fill-opacity='.5'/>`).join('');
      return layer([put(art(220, 130, lit(b), 2), 'right 40px top 72px', 220, 130), rg('#c22c2c', '0% 0%', '40% 45%', 0.14)]);
    },

    // Symbiote dripping from the top edge, lit only by its own gloss.
    goo(sheen) {
      let b = `<rect x='0' y='-2' width='320' height='16' fill='none' stroke='${sheen}' stroke-opacity='.12'/>`;
      [[24, 60, 7], [70, 120, 9], [120, 44, 6], [168, 150, 10], [214, 80, 7], [262, 110, 8], [300, 36, 5]].forEach(([x, len, w]) => {
        b += `<path d='M${x - w} 12 V${len} C${x - w} ${len + w * 1.6} ${x + w} ${len + w * 1.6} ${x + w} ${len} V12' fill='none' stroke='${sheen}' stroke-opacity='.24' stroke-width='1.2'/>` +
          line(x - w * 0.4, 16, x - w * 0.4, len - 4, '#ffffff', 0.22, 1.6, "stroke-linecap='round'");
      });
      return layer([`${art(320, 180, lit(b), 2)} 0 0 / 320px 180px repeat-x`, rg(sheen, '50% 0%', '70% 20%', 0.06)]);
    },
    // The white spider, legs sweeping round from the bottom of the window.
    venomSpider(c, tongue) {
      let b = `<ellipse cx='350' cy='232' rx='16' ry='22' fill='${c}' fill-opacity='.16' stroke='${c}' stroke-opacity='.5' stroke-width='2'/>` +
        `<ellipse cx='350' cy='290' rx='28' ry='44' fill='${c}' fill-opacity='.14' stroke='${c}' stroke-opacity='.5' stroke-width='2'/>`;
      for (const s of [-1, 1]) {
        [[250, 130, 150, 40], [230, 190, 100, 150], [240, 280, 110, 330], [260, 320, 180, 400]].forEach(([mx, my, ex, ey], i) => {
          const x0 = 350 + s * 16, y0 = 230 + i * 18;
          b += `<path d='M${x0} ${y0} Q${350 + s * (350 - mx)} ${my} ${350 + s * (350 - ex)} ${ey}' fill='none' stroke='${c}' stroke-opacity='.26' stroke-width='${5 - i * 0.6}' stroke-linecap='round'/>`;
        });
      }
      return layer([put(art(700, 400, lit(b), 5), '50% calc(100% + 30px)', 700, 400), rg(tongue, '50% 115%', '50% 30%', 0.16)]);
    },

    // Bullet holes in the glass, top-left.
    bulletHoles(c) {
      const r = rng(4);
      let b = '';
      [[60, 70], [150, 40], [96, 180], [250, 110]].forEach(([x, y]) => {
        b += `<circle cx='${x}' cy='${y}' r='5' fill='${c}' fill-opacity='.25' stroke='${c}' stroke-opacity='.6' stroke-width='1.5'/>`;
        for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2 + r() * 0.4, l = 18 + r() * 34; b += poly(jag(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 3, 3, r), c, 0.32, 0.8); }
        b += `<circle cx='${x}' cy='${y}' r='${f1(14 + r() * 6)}' fill='none' stroke='${c}' stroke-opacity='.18' stroke-dasharray='6 5'/>`;
      });
      return layer([put(art(320, 240, lit(b), 1.5), 'left 0 top 66px', 320, 240), rg('#9a2a2a', '0% 0%', '40% 45%', 0.14)]);
    },

    // The Hell Cycle's burning wheel, bottom-right.
    burningWheel(fire, bone) {
      let b = `<circle cx='130' cy='130' r='100' fill='none' stroke='${fire}' stroke-opacity='.45' stroke-width='16'/>` +
        `<circle cx='130' cy='130' r='110' fill='none' stroke='${bone}' stroke-opacity='.3' stroke-width='6' stroke-dasharray='6 8'/>` +
        `<circle cx='130' cy='130' r='16' fill='none' stroke='${bone}' stroke-opacity='.5' stroke-width='3'/>`;
      for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6; b += line(130 + 16 * Math.cos(a), 130 + 16 * Math.sin(a), 130 + 92 * Math.cos(a), 130 + 92 * Math.sin(a), bone, 0.3, 1.4); }
      for (let k = 0; k < 11; k++) {
        const a = Math.PI + 0.1 + k / 10 * (Math.PI - 0.2), x = 130 + 112 * Math.cos(a), y = 130 + 112 * Math.sin(a), ox = Math.cos(a), oy = Math.sin(a);
        b += `<path d='M${f1(x - oy * 8)} ${f1(y + ox * 8)} Q${f1(x + ox * 30 + 6)} ${f1(y + oy * 30 - 10)} ${f1(x + ox * 40)} ${f1(y + oy * 40 - 14)} Q${f1(x + ox * 18)} ${f1(y + oy * 18)} ${f1(x + oy * 8)} ${f1(y - ox * 8)} Z' fill='${fire}' fill-opacity='.35'/>`;
      }
      return put(art(260, 260, lit(b), 4), 'right -60px bottom -60px', 260, 260);
    },
    // A chain hung across the top of the window, glowing with hellfire.
    hellChain(steel, fire) {
      const Y = (x) => 22 + 96 * (1 - Math.pow((x - 700) / 700, 2));
      let b = `<path d='${(() => { let d = ''; for (let x = 0; x <= 1400; x += 20) d += (x ? 'L' : 'M') + x + ' ' + f1(Y(x)); return d; })()}' fill='none' stroke='${fire}' stroke-opacity='.3' stroke-width='16' filter='url(#b)'/>`;
      for (let x = 10, i = 0; x < 1400; x += 22, i++) {
        const a = Math.atan2(Y(x + 1) - Y(x), 1) * 180 / Math.PI;
        b += `<ellipse cx='${x}' cy='${f1(Y(x))}' rx='13' ry='${i % 2 ? 2.2 : 7}' fill='none' stroke='${steel}' stroke-opacity='.45' stroke-width='2.4' transform='rotate(${f1(a)} ${x} ${f1(Y(x))})'/>`;
      }
      return layer([put(art(1400, 170, b, 6), '50% 0', 1400, 170)]);
    },

    // Loki's horned helm at the top edge.
    horns(gold) {
      const horn = (m) => {
        const X = (x) => m ? 520 - x : x;
        return `<path d='M${X(222)} 150 C${X(170)} 110 ${X(120)} 40 ${X(56)} 8 C${X(112)} 52 ${X(158)} 112 ${X(202)} 162 Z' fill='${gold}' fill-opacity='.2' stroke='${gold}' stroke-opacity='.65' stroke-width='1.6'/>`;
      };
      const b = horn(false) + horn(true) + `<path d='M186 176 Q260 130 334 176' fill='none' stroke='${gold}' stroke-opacity='.55' stroke-width='6' stroke-linecap='round'/>`;
      return layer([put(art(520, 200, lit(b), 5), '50% -6px', 520, 200), rg(gold, '50% 0%', '40% 22%', 0.12)]);
    },
    // The sceptre, its gem burning blue, bottom-right.
    sceptre(gold, gem, magic) {
      const b = line(330, 350, 130, 150, gold, 0.5, 5, "stroke-linecap='round'") +
        `<path d='M130 150 C92 150 76 118 88 86 C98 110 116 122 138 122' fill='none' stroke='${gold}' stroke-opacity='.6' stroke-width='3'/>` +
        `<path d='M130 150 C130 112 162 96 194 108 C170 118 158 136 158 158' fill='none' stroke='${gold}' stroke-opacity='.6' stroke-width='3'/>` +
        `<circle cx='124' cy='128' r='26' fill='${gem}' fill-opacity='.5' filter='url(#b)'/><circle cx='124' cy='128' r='10' fill='${gem}' fill-opacity='.85'/>`;
      return layer([put(art(360, 360, lit(b), 6), 'right 10px bottom 10px', 360, 360), rg(magic, '0% 100%', '45% 50%', 0.16), rg(magic, '100% 0%', '30% 35%', 0.1)]);
    },

    // Two sais crossed in the bottom-right corner.
    sais(steel, glow) {
      const sai = (t) => `<g transform='${t}'><polygon points='0,-4 250,0 0,4' fill='${steel}' fill-opacity='.3' stroke='${steel}' stroke-opacity='.65'/>` +
        `<path d='M16 0 C26 -30 48 -36 70 -30' fill='none' stroke='${steel}' stroke-opacity='.6' stroke-width='3' stroke-linecap='round'/>` +
        `<path d='M16 0 C26 30 48 36 70 30' fill='none' stroke='${steel}' stroke-opacity='.6' stroke-width='3' stroke-linecap='round'/>` +
        `<rect x='-80' y='-5' width='80' height='10' rx='3' fill='${glow}' fill-opacity='.25' stroke='${glow}' stroke-opacity='.5'/><circle cx='-88' cy='0' r='7' fill='none' stroke='${steel}' stroke-opacity='.6' stroke-width='2'/></g>`;
      const b = sai('translate(380 400) rotate(-128)') + sai('translate(120 400) rotate(-52)');
      return layer([put(art(500, 440, lit(b), 4), 'right -30px bottom -30px', 500, 440), rg(glow, '100% 100%', '40% 45%', 0.14)]);
    },
    // A red sash flowing up the left side.
    ribbon(c) {
      const d = 'M0 380 C120 300 180 360 260 280 S420 180 520 220 L520 246 C420 206 300 312 260 306 S120 336 0 404 Z';
      return layer([put(art(520, 420, lit(`<path d='${d}' fill='${c}' fill-opacity='.2' stroke='${c}' stroke-opacity='.45' stroke-width='1.4'/>`), 5), 'left bottom', 520, 420)]);
    },

    // The glaive, spinning in the bottom-right.
    glaive(steel, blood) {
      let b = `<circle cx='150' cy='150' r='120' fill='none' stroke='${steel}' stroke-opacity='.14' stroke-width='10' stroke-dasharray='120 60'/>` +
        `<circle cx='150' cy='150' r='18' fill='${blood}' fill-opacity='.3' stroke='${steel}' stroke-opacity='.6' stroke-width='2'/>`;
      for (let k = 0; k < 3; k++) b += `<path d='M150 150 C190 120 240 110 272 58 C232 90 192 100 162 138 Z' fill='${steel}' fill-opacity='.22' stroke='${steel}' stroke-opacity='.65' stroke-width='1.2' transform='rotate(${k * 120} 150 150)'/>`;
      return put(art(300, 300, lit(b), 4), 'right 20px bottom 20px', 300, 300);
    },
    // Blood falling like rain from the top edge.
    bloodRain(c) {
      const r = rng(19);
      let b = '';
      for (let i = 0; i < 16; i++) { const x = r() * 200, y = r() * 220, s = 0.6 + r() * 0.9; b += `<path d='M${f1(x)} ${f1(y)} c${f1(-3 * s)} ${f1(6 * s)} ${f1(-3 * s)} ${f1(10 * s)} 0 ${f1(11 * s)} c${f1(3 * s)} ${f1(-1 * s)} ${f1(3 * s)} ${f1(-5 * s)} 0 ${f1(-11 * s)} Z' fill='${c}' fill-opacity='${f1(0.3 + r() * 0.35)}'/>`; }
      return layer([`${svg(200, 220, b)} 0 0 / 200px 220px repeat`, rg(c, '50% 0%', '70% 25%', 0.12)], 'linear-gradient(180deg, #000 0, rgba(0,0,0,.5) 20%, transparent 42%)');
    },

    // Khonshu's glyphs carved along the bottom edge.
    glyphs(c) {
      const b = `<path d='M0 6 H360 M0 66 H360' stroke='${c}' stroke-opacity='.22' stroke-width='1'/>` +
        `<path d='M30 20 C20 20 20 36 30 36 C40 36 40 20 30 20 Z M30 36 V60 M18 44 H42' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.6'/>` +
        `<path d='M80 38 C90 28 110 28 122 38 C110 46 90 46 80 38 Z M100 44 L96 60 M112 44 C118 52 126 52 128 46' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.6'/><circle cx='101' cy='38' r='3.4' fill='${c}' fill-opacity='.5'/>` +
        `<path d='M182 20 A18 18 0 1 0 182 56 A13 13 0 1 1 182 20 Z' fill='${c}' fill-opacity='.3' stroke='${c}' stroke-opacity='.45'/>` +
        `<path d='M240 62 C234 44 236 28 246 14 C250 30 250 48 242 62 Z M242 60 L245 20' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.4'/>` +
        `<ellipse cx='312' cy='44' rx='12' ry='15' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.6'/><circle cx='312' cy='20' r='7' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.4'/>` +
        [-1, 1].map(s => line(312 + s * 10, 38, 312 + s * 20, 32, c, 0.4, 1.2) + line(312 + s * 11, 50, 312 + s * 20, 58, c, 0.4, 1.2)).join('');
      return layer([`${art(360, 72, lit(b), 1.5)} 0 calc(100% - 4px) / 360px 72px repeat-x`, rg(c, '50% 110%', '70% 25%', 0.1)]);
    },

    // A trident standing in the bottom-right, bubbles rising beside it.
    trident(gold, sea) {
      const r = rng(23);
      let b = line(130, 420, 130, 70, gold, 0.55, 5, "stroke-linecap='round'") + `<polygon points='130,20 120,62 140,62' fill='${gold}' fill-opacity='.6'/>`;
      for (const s of [-1, 1]) b += `<path d='M130 140 C${130 + s * 44} 132 ${130 + s * 50} 100 ${130 + s * 48} 52' fill='none' stroke='${gold}' stroke-opacity='.55' stroke-width='4' stroke-linecap='round'/><polygon points='${130 + s * 48},34 ${130 + s * 40},62 ${130 + s * 56},62' fill='${gold}' fill-opacity='.55'/>`;
      for (let i = 0; i < 14; i++) b += `<circle cx='${f1(20 + r() * 90)}' cy='${f1(80 + r() * 330)}' r='${f1(2 + r() * 6)}' fill='none' stroke='${sea}' stroke-opacity='.45'/>`;
      return layer([put(art(260, 430, lit(b), 3), 'right 20px bottom 6px', 260, 430)]);
    },

    // The metal arm's plates down the left edge, the red star on the shoulder.
    metalArm(steel, red) {
      let b = '';
      for (let i = 0; i < 10; i++) {
        const y = 20 + i * 58;
        b += `<path d='M0 ${y} C60 ${y - 10} 120 ${y - 4} 170 ${y + 10} L170 ${y + 54} C120 ${y + 44} 60 ${y + 50} 0 ${y + 60} Z' fill='${steel}' fill-opacity='.05' stroke='${steel}' stroke-opacity='.32' stroke-width='1.2'/>` +
          line(20, y + 30, 150, y + 34, steel, 0.12, 1);
      }
      b += `<polygon points='${starPts(84, 112, 34, 14, 5)}' fill='${red}' fill-opacity='.35' stroke='${red}' stroke-opacity='.7' stroke-width='1.5'/>`;
      return layer([put(art(200, 620, lit(b), 3), 'left -24px top 60%', 200, 620)]);
    },

    // The Infinity Gauntlet: a gold hand, a stone in every socket.
    gauntletHand(gold) {
      let hand = `<rect x='90' y='180' width='190' height='170' rx='30' fill='${gold}' fill-opacity='.07' stroke='${gold}' stroke-opacity='.45' stroke-width='2'/>`;
      [0, 1, 2, 3].forEach(i => { const y = i === 1 || i === 2 ? 50 : 70; hand += `<rect x='${94 + i * 47}' y='${y}' width='40' height='${190 - y}' rx='16' fill='${gold}' fill-opacity='.06' stroke='${gold}' stroke-opacity='.4' stroke-width='1.8'/>` + line(98 + i * 47, y + 50, 130 + i * 47, y + 50, gold, 0.3, 1.2); });
      hand += `<rect x='40' y='200' width='40' height='110' rx='16' fill='${gold}' fill-opacity='.06' stroke='${gold}' stroke-opacity='.4' stroke-width='1.8' transform='rotate(-35 60 255)'/>`;
      const stones = [[114, 192, '#9a4fe0'], [161, 192, '#4f8cff'], [208, 192, '#e0303a'], [255, 192, '#f08a2a'], [62, 238, '#3fd07a'], [185, 270, '#f2d541']];
      let s = '';
      stones.forEach(([x, y, c], i) => { const R = i === 5 ? 16 : 10; s += `<circle cx='${x}' cy='${y}' r='${R * 2}' fill='${c}' fill-opacity='.5' filter='url(#b)'/><circle cx='${x}' cy='${y}' r='${R}' fill='${c}' fill-opacity='.85'/><circle cx='${x - 2}' cy='${y - 2}' r='${R / 3}' fill='#ffffff' fill-opacity='.8'/>`; });
      return layer([put(art(360, 380, lit(hand) + s, 6), 'right 0 bottom -30px', 360, 380), rg(gold, '100% 100%', '40% 45%', 0.2)]);
    },
    // The snap: the left edge turning to dust and drifting away.
    snapDust(a, b) {
      const r = rng(55);
      let d = '';
      for (let i = 0; i < 140; i++) {
        const x = Math.pow(r(), 1.8) * 700, y = 40 + r() * 420, w = 1.5 + r() * 4, o = f1(0.55 * (1 - x / 760));
        d += `<rect x='${f1(x)}' y='${f1(y)}' width='${f1(w)}' height='${f1(w * 0.5)}' fill='${i % 3 ? a : b}' fill-opacity='${o}' transform='rotate(${f1(r() * 40 - 20)} ${f1(x)} ${f1(y)})'/>`;
      }
      return layer([put(svg(700, 500, d), 'left 0 top 70%', 700, 500)]);
    },

    // Magneto's helm at the top edge, shards of metal hanging in the field around it.
    magnetoHelm(c, steel) {
      const r = rng(66);
      let b = `<path d='M130 190 C130 60 290 60 290 190' fill='${c}' fill-opacity='.08' stroke='${c}' stroke-opacity='.55' stroke-width='2'/>` +
        `<path d='M210 60 L196 110 L210 190 L224 110 Z' fill='${c}' fill-opacity='.14' stroke='${c}' stroke-opacity='.5'/>` +
        `<path d='M130 150 L104 210 L150 190 M290 150 L316 210 L270 190' fill='none' stroke='${c}' stroke-opacity='.5' stroke-width='2'/>` +
        `<path d='M150 170 H270' stroke='${c}' stroke-opacity='.3'/>`;
      let shards = '';
      for (let i = 0; i < 12; i++) { const x = r() < 0.5 ? r() * 90 : 330 + r() * 90, y = 30 + r() * 160, s = 5 + r() * 9, a = r() * 6; shards += `<polygon points='${pts([[x, y - s], [x + s * 0.6, y + s * 0.4], [x - s * 0.5, y + s * 0.6]])}' fill='${steel}' fill-opacity='.25' stroke='${steel}' stroke-opacity='.5' transform='rotate(${f1(a * 57)} ${f1(x)} ${f1(y)})'/>`; }
      return layer([put(art(420, 220, lit(b) + lit(shards), 4), '50% -24px', 420, 220), rg(c, '50% 0%', '45% 28%', 0.12)]);
    },

    // Ultron's eyes, burning at the top of the window.
    ultronEyes(red) {
      const eye = (m) => { const X = (x) => m ? 700 - x : x; return `<polygon points='${pts([[X(236), 104], [X(320), 90], [X(330), 114], [X(246), 122]])}' fill='${red}' fill-opacity='.6'/>`; };
      const b = eye(false) + eye(true) + `<path d='M160 36 C200 230 500 230 540 36' fill='none' stroke='${red}' stroke-opacity='.18' stroke-width='2'/>` +
        line(300, 196, 400, 196, red, 0.4, 3, "stroke-linecap='round'") + line(250, 110, 316, 102, '#ffffff', 0.6, 1.2) + line(450, 110, 384, 102, '#ffffff', 0.6, 1.2);
      return layer([put(art(700, 240, `<g filter='url(#b)'>${b}${b}</g>${b}`, 7), '50% 24px', 700, 240), rg(red, '50% 0%', '45% 30%', 0.14)]);
    },

    // Pumpkin bombs, their carved faces lit from inside.
    pumpkins(shell, lit_) {
      let b = '';
      [[250, 200, 50], [132, 238, 34], [300, 88, 26]].forEach(([x, y, R]) => {
        b += `<circle cx='${x}' cy='${y}' r='${R}' fill='${shell}' fill-opacity='.12' stroke='${shell}' stroke-opacity='.45' stroke-width='1.6'/>` +
          `<ellipse cx='${x}' cy='${y}' rx='${R * 0.5}' ry='${R}' fill='none' stroke='${shell}' stroke-opacity='.25'/>` +
          `<rect x='${x - 3}' y='${y - R - 8}' width='6' height='10' fill='${shell}' fill-opacity='.4'/>`;
        const e = R * 0.28;
        b += `<g fill='${lit_}' fill-opacity='.75'><polygon points='${pts([[x - R * 0.45, y - R * 0.05], [x - R * 0.2, y - R * 0.05], [x - R * 0.32, y - R * 0.05 - e]])}'/>` +
          `<polygon points='${pts([[x + R * 0.45, y - R * 0.05], [x + R * 0.2, y - R * 0.05], [x + R * 0.32, y - R * 0.05 - e]])}'/>` +
          `<polygon points='${pts([[x - R * 0.5, y + R * 0.25], [x - R * 0.3, y + R * 0.45], [x - R * 0.1, y + R * 0.3], [x + R * 0.1, y + R * 0.48], [x + R * 0.3, y + R * 0.3], [x + R * 0.5, y + R * 0.25], [x, y + R * 0.62]])}'/></g>`;
      });
      return layer([put(art(360, 300, lit(b), 5), 'right 10px bottom 10px', 360, 300), rg(lit_, '100% 100%', '40% 45%', 0.18)]);
    },
    // The goblin glider, jets burning, over the top-left.
    glider(c, jet) {
      const d = 'M210 60 L60 40 C80 70 70 90 90 100 C110 88 120 96 130 110 C150 96 170 100 180 116 L210 100 L240 116 C250 100 270 96 290 110 C300 96 310 88 330 100 C350 90 340 70 360 40 Z';
      const b = `<path d='${d}' fill='${c}' fill-opacity='.14' stroke='${c}' stroke-opacity='.6' stroke-width='1.6'/>` +
        `<ellipse cx='180' cy='124' rx='6' ry='14' fill='${jet}' fill-opacity='.7' filter='url(#b)'/><ellipse cx='240' cy='124' rx='6' ry='14' fill='${jet}' fill-opacity='.7' filter='url(#b)'/>` +
        `<path d='M180 140 C150 190 90 210 20 214 M240 140 C220 200 150 230 60 240' fill='none' stroke='${jet}' stroke-opacity='.2' stroke-width='6' filter='url(#b)'/>`;
      return layer([put(art(420, 260, lit(b), 4), 'left 20px top 60px', 420, 260), rg(c, '0% 0%', '40% 40%', 0.14), rg(c, '50% 110%', '70% 30%', 0.12)]);
    },

    // Four mechanical arms rising from the bottom-left, pincers open, a red light in each.
    ockArms(steel, light) {
      let b = '';
      const arms = [[[0, 560], [120, 360], [60, 200], [230, 120]], [[0, 560], [200, 420], [260, 300], [400, 250]],
        [[0, 560], [60, 420], [-20, 300], [80, 160]], [[0, 560], [240, 520], [360, 480], [520, 420]]];
      arms.forEach(([p0, p1, p2, p3]) => {
        const at = (t) => { const u = 1 - t; return [0, 1].map(k => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]); };
        for (let i = 0; i <= 18; i++) { const [x, y] = at(i / 18); b += `<circle cx='${f1(x)}' cy='${f1(y)}' r='${f1(10 - i * 0.3)}' fill='${steel}' fill-opacity='.07' stroke='${steel}' stroke-opacity='.4' stroke-width='1.2'/>`; }
        const [ex, ey] = at(1), [bx, by] = at(0.94), a = Math.atan2(ey - by, ex - bx);
        [-0.6, 0, 0.6].forEach(o => { b += `<path d='M${f1(ex)} ${f1(ey)} q${f1(Math.cos(a + o) * 22)} ${f1(Math.sin(a + o) * 22)} ${f1(Math.cos(a + o * 1.8) * 34)} ${f1(Math.sin(a + o * 1.8) * 34)}' fill='none' stroke='${steel}' stroke-opacity='.6' stroke-width='3' stroke-linecap='round'/>`; });
        b += `<circle cx='${f1(ex)}' cy='${f1(ey)}' r='5' fill='${light}' fill-opacity='.85'/>`;
      });
      return layer([put(art(620, 580, lit(b), 3), 'left -20px bottom -20px', 620, 580)]);
    },
    // A captive fusion sun burning in the top-right.
    fusionSun(core, flare) {
      const r = rng(47);
      const ring = [];
      for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2, rr = 64 + (r() - 0.5) * 12; ring.push([150 + rr * Math.cos(a), 150 + rr * Math.sin(a)]); }
      const g = `<radialGradient id='g'><stop offset='0' stop-color='#ffffff' stop-opacity='.9'/><stop offset='.45' stop-color='${core}' stop-opacity='.6'/><stop offset='1' stop-color='${flare}' stop-opacity='0'/></radialGradient>`;
      const arcs = `<path d='M100 110 C60 40 150 30 170 90' fill='none' stroke='${flare}' stroke-opacity='.45' stroke-width='3'/><path d='M200 170 C270 190 250 260 190 206' fill='none' stroke='${flare}' stroke-opacity='.4' stroke-width='3'/>`;
      return layer([put(art(300, 300, `<circle cx='150' cy='150' r='60' fill='url(#g)'/>${lit(poly(pts(ring), core, 0.45, 2) + arcs)}`, 5, g), 'right 30px top 60px', 300, 300), rg(flare, '100% 0%', '40% 40%', 0.16)]);
    },

    // The Tesseract, bottom-right, its beam reaching for the sky.
    tesseract(blue, red) {
      const cube = (s, ox, oy, o, w) => {
        const f = [[150 - s, 170 - s], [150 + s, 170 - s], [150 + s, 170 + s], [150 - s, 170 + s]], k = f.map(([x, y]) => [x + ox, y + oy]);
        let e = `<polygon points='${pts(f)}' fill='none' stroke='${blue}' stroke-opacity='${o}' stroke-width='${w}'/><polygon points='${pts(k)}' fill='none' stroke='${blue}' stroke-opacity='${o}' stroke-width='${w}'/>`;
        f.forEach((p, i) => { e += line(p[0], p[1], k[i][0], k[i][1], blue, o, w); });
        return e;
      };
      const g = `<radialGradient id='g'><stop offset='0' stop-color='#ffffff' stop-opacity='.9'/><stop offset='.4' stop-color='${blue}' stop-opacity='.5'/><stop offset='1' stop-color='${blue}' stop-opacity='0'/></radialGradient>`;
      const b = `<circle cx='165' cy='155' r='60' fill='url(#g)'/>` + lit(cube(62, 30, -30, 0.6, 2) + cube(28, 14, -14, 0.5, 1.2));
      return layer([
        put(art(300, 300, b, 4, g), 'right 30px bottom 30px', 300, 300),
        `linear-gradient(90deg, transparent, ${rgba(blue, 0.12)} 40%, ${rgba('#ffffff', 0.2)} 50%, ${rgba(blue, 0.12)} 60%, transparent) right 150px top 0 / 70px 100% no-repeat`,
        rg(red, '0% 0%', '45% 50%', 0.16),
      ]);
    },

    // Necroswords raining down in both top corners.
    necroswords(c, glow) {
      let b = '';
      [[40, 40], [120, 110], [70, 210], [200, 60], [180, 190], [260, 150], [30, 300]].forEach(([x, y], i) => {
        const L = 90 + (i % 3) * 30;
        b += `<g transform='translate(${x} ${y}) rotate(62)'><polygon points='0,-3 ${L},0 0,3' fill='${c}' fill-opacity='.35' stroke='${c}' stroke-opacity='.6' stroke-width='.8'/>` +
          line(-2, -9, -2, 9, c, 0.6, 2.4) + line(-22, 0, -2, 0, c, 0.5, 2.2) + line(-80, 0, -30, 0, glow, 0.2, 5) + '</g>';
      });
      const img = (t) => art(320, 380, `<g transform='${t}'>${lit(b)}</g>`, 3);
      return layer([put(img(''), 'left 0 top 60px', 320, 380), put(img('translate(320 0) scale(-1 1)'), 'right 0 top 60px', 320, 380)]);
    },

    // Dormammu's face: two eyes burning in a crown of flame at the top of the window.
    dormammuFace(fire, core) {
      const r = rng(61);
      let flames = '';
      for (let i = 0; i < 15; i++) {
        const w = 34 + r() * 26, x = 20 + i * 44 + (r() - 0.5) * 16, h = 90 + r() * 110, s = (r() - 0.5) * 30, y = 250;
        flames += `<path d='M${f1(x)} ${y} C${f1(x - w * 0.1)} ${f1(y - h * 0.5)} ${f1(x + w * 0.4 - s * 0.5)} ${f1(y - h * 0.62)} ${f1(x + w * 0.5 + s)} ${f1(y - h)} ` +
          `C${f1(x + w * 0.6)} ${f1(y - h * 0.55)} ${f1(x + w * 1.1)} ${f1(y - h * 0.42)} ${f1(x + w)} ${y} Z' fill='url(#f)'/>`;
      }
      const eye = (x) => `<path d='M${x - 52} 172 C${x - 26} 140 ${x + 26} 140 ${x + 52} 172 C${x + 26} 188 ${x - 26} 188 ${x - 52} 172 Z' fill='${core}' fill-opacity='.45'/>`;
      const eyes = eye(262) + eye(438);
      // The fire fades out towards both ends and towards its base, so the crown has no edges.
      const defs = `<linearGradient id='f' x1='0' y1='1' x2='0' y2='0'><stop offset='0' stop-color='${fire}' stop-opacity='0'/><stop offset='.22' stop-color='${fire}' stop-opacity='.34'/><stop offset='.6' stop-color='${fire}' stop-opacity='.16'/><stop offset='1' stop-color='${core}' stop-opacity='0'/></linearGradient>` +
        `<radialGradient id='e' cx='.5' cy='.62' r='.62'><stop offset='.55' stop-color='white'/><stop offset='1' stop-color='black'/></radialGradient><mask id='m'><rect width='700' height='260' fill='url(#e)'/></mask>`;
      return layer([put(art(700, 260, `<g mask='url(#m)'>${lit(flames)}</g><g filter='url(#b)'>${eyes}${eyes}</g>${eyes}`, 3, defs), '50% -150px', 700, 260), rg(fire, '50% 0%', '55% 30%', 0.18)]);
    },
    // The Dark Dimension turning beneath everything.
    darkVortex(c) {
      let arms = '';
      for (let k = 0; k < 6; k++) { const p = spiral(400, 560, 20, 0.16, 1.9, k * Math.PI / 3, 0.55); arms += poly(p, c, 0.22, 10) + poly(p, c, 0.4, 1.4); }
      return layer([put(art(800, 520, `<g filter='url(#b)'>${arms}</g>${arms}`, 5), '50% 100%', 800, 520), rg(c, '50% 110%', '60% 35%', 0.16)]);
    },

    // Galactus's helm, looming over the top of the window.
    galactusHelm(c, deep) {
      let b = `<path d='M280 300 C280 150 520 150 520 300' fill='${deep}' fill-opacity='.1' stroke='${c}' stroke-opacity='.55' stroke-width='2'/>` +
        `<path d='M340 300 V232 H460 V300' fill='none' stroke='${c}' stroke-opacity='.4' stroke-width='2'/>` +
        `<polyline points='350,190 375,228 400,198 425,228 450,190' fill='none' stroke='${c}' stroke-opacity='.6' stroke-width='3'/>`;
      for (const m of [false, true]) { const X = (x) => m ? 800 - x : x; b += `<polygon points='${pts([[X(300), 212], [X(222), 22], [X(262), 24], [X(334), 186]])}' fill='${deep}' fill-opacity='.14' stroke='${c}' stroke-opacity='.55' stroke-width='1.8'/>`; }
      return layer([put(art(800, 300, lit(b), 5), '50% -40px', 800, 300), rg(c, '50% 0%', '45% 30%', 0.14)]);
    },
    // A world being eaten: a planet in the bottom-right, its energy streaming away.
    devouredPlanet(c, planet) {
      const g = `<radialGradient id='p' cx='.35' cy='.3'><stop offset='0' stop-color='${planet}' stop-opacity='.45'/><stop offset='1' stop-color='${planet}' stop-opacity='.05'/></radialGradient>`;
      let b = `<circle cx='300' cy='320' r='120' fill='url(#p)' stroke='${planet}' stroke-opacity='.4' stroke-width='1.5'/>` +
        `<circle cx='300' cy='320' r='132' fill='none' stroke='${c}' stroke-opacity='.3' stroke-width='10' filter='url(#b)'/>`;
      [[220, 230, 60, 20], [260, 206, 140, -10], [300, 200, 230, 10], [200, 280, 10, 120]].forEach(([x, y, ex, ey]) => {
        b += `<path d='M${x} ${y} C${x - 40} ${y - 80} ${ex + 60} ${ey + 40} ${ex} ${ey}' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='2.5'/>`;
      });
      return layer([put(art(440, 460, lit(b), 5, g), 'right -40px bottom -80px', 440, 460)]);
    },

    // Spikes exploding out of two corners.
    spikes(c) {
      const r = rng(71);
      let b = '';
      for (let i = 0; i < 16; i++) {
        const a = -0.15 - r() * 1.3, L = 120 + r() * 300, w = 5 + r() * 8, x2 = Math.cos(a) * L, y2 = 560 + Math.sin(a) * L;
        b += `<polygon points='${pts([[-Math.sin(a) * w, 560 + Math.cos(a) * w], [x2, y2], [Math.sin(a) * w, 560 - Math.cos(a) * w]])}' fill='${c}' fill-opacity='.12' stroke='${c}' stroke-opacity='.34' stroke-width='1'/>`;
      }
      const img = (t) => art(560, 560, `<g transform='${t}'>${lit(b)}</g>`, 3);
      return layer([put(img(''), 'left bottom', 560, 560), put(img('translate(560 560) scale(-1 -1)'), 'right top', 460, 460)]);
    },
    // Splatter, thrown into the corners.
    splatter(c, c2) {
      const r = rng(88);
      const splat = (cx, cy, R) => {
        const p = [];
        for (let i = 0; i < 18; i++) { const a = i / 18 * Math.PI * 2, rr = R * (0.7 + r() * 0.6); p.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
        let s = `<polygon points='${pts(p)}' fill='${c}' fill-opacity='.3'/>`;
        for (let i = 0; i < 9; i++) { const a = r() * Math.PI * 2, d = R * (1.3 + r() * 1.4); s += `<circle cx='${f1(cx + d * Math.cos(a))}' cy='${f1(cy + d * Math.sin(a))}' r='${f1(1.5 + r() * R * 0.18)}' fill='${i % 2 ? c : c2}' fill-opacity='.35'/>`; }
        return s;
      };
      const img = art(300, 300, lit(splat(150, 150, 34) + splat(70, 230, 14) + splat(240, 70, 18)), 2);
      return layer([put(img, 'right -40px bottom -40px', 300, 300), put(img, 'left 20px top 70px', 200, 200)]);
    },

    // Hell's Kitchen at night along the bottom edge.
    skyline(c, windows) {
      const r = rng(13);
      let b = '', x = 0;
      while (x < 640) {
        const w = 30 + Math.floor(r() * 50), h = 60 + Math.floor(r() * 120);
        b += `<rect x='${x}' y='${190 - h}' width='${w}' height='${h}' fill='${c}' fill-opacity='.03' stroke='${c}' stroke-opacity='.18'/>`;
        for (let wy = 190 - h + 10; wy < 180; wy += 12) for (let wx = x + 6; wx < x + w - 6; wx += 9) if (r() < 0.28) b += `<rect x='${wx}' y='${wy}' width='3' height='5' fill='${windows}' fill-opacity='.5'/>`;
        x += w + 4;
      }
      return layer([`${svg(640, 190, b)} 0 100% / 640px 190px repeat-x`, rg(windows, '50% 110%', '70% 25%', 0.1)]);
    },

    // The fishbowl helm hanging in the top-right, smoke swirling inside it.
    fishbowl(glass, smoke) {
      const g = `<radialGradient id='g' cx='.4' cy='.35'><stop offset='0' stop-color='${glass}' stop-opacity='.14'/><stop offset='1' stop-color='${glass}' stop-opacity='.02'/></radialGradient>`;
      const b = `<circle cx='180' cy='150' r='120' fill='url(#g)' stroke='${glass}' stroke-opacity='.45' stroke-width='2'/>` +
        `<path d='M100 92 A100 100 0 0 1 170 50' fill='none' stroke='#ffffff' stroke-opacity='.55' stroke-width='5' stroke-linecap='round'/>` +
        `<circle cx='250' cy='90' r='6' fill='#ffffff' fill-opacity='.5'/>` +
        poly(spiral(180, 160, 8, 0.22, 1.8, 0.4), smoke, 0.4, 5) + poly(spiral(170, 150, 6, 0.24, 1.4, 3), smoke, 0.3, 3) +
        `<ellipse cx='180' cy='266' rx='92' ry='14' fill='none' stroke='${glass}' stroke-opacity='.45' stroke-width='3'/>`;
      return layer([put(art(340, 300, lit(b), 4, g), 'right -30px top 40px', 340, 300)]);
    },

    // Electro's starburst mask over the top-left corner.
    starburst(c, glow) {
      const r = rng(29);
      const p = [];
      for (let i = 0; i < 10; i++) {
        const a0 = -Math.PI / 2 + i * Math.PI / 5, a1 = a0 + Math.PI / 10;
        p.push([130 + 150 * Math.cos(a0), 130 + 150 * Math.sin(a0)]);
        p.push([130 + 95 * Math.cos(a0 + 0.12), 130 + 95 * Math.sin(a0 + 0.12)]);
        p.push([130 + 110 * Math.cos(a0 + 0.2), 130 + 110 * Math.sin(a0 + 0.2)]);
        p.push([130 + 50 * Math.cos(a1), 130 + 50 * Math.sin(a1)]);
      }
      const b = `<polygon points='${pts(p)}' fill='${c}' fill-opacity='.1' stroke='${c}' stroke-opacity='.6' stroke-width='1.6'/><circle cx='130' cy='130' r='40' fill='none' stroke='${c}' stroke-opacity='.4'/>`;
      return layer([put(art(300, 300, `<g filter='url(#b)'><polygon points='${pts(p)}' fill='none' stroke='${glow}' stroke-opacity='.5' stroke-width='6'/></g>${b}`, 5), 'left -60px top -40px', 300, 300), rg(glow, '0% 0%', '40% 45%', 0.16)]);
    },
    // Current arcing between nodes down the right edge.
    arcs(c, glow) {
      const r = rng(37);
      const nodes = [[250, 80], [200, 260], [262, 420], [212, 620]];
      let b = '';
      for (let i = 0; i < nodes.length - 1; i++) for (let k = 0; k < 3; k++) {
        const p = jag(nodes[i][0], nodes[i][1], nodes[i + 1][0], nodes[i + 1][1], 14, 16, r);
        b += poly(p, glow, 0.35, 6) + poly(p, c, 0.55, 1);
      }
      nodes.forEach(([x, y]) => { b += `<circle cx='${x}' cy='${y}' r='6' fill='${c}' fill-opacity='.8'/><circle cx='${x}' cy='${y}' r='18' fill='${glow}' fill-opacity='.25'/>`; });
      return layer([put(art(300, 700, `<g filter='url(#b)'>${b}</g>${b}`, 4), 'right 0 center', 300, 700)]);
    },

    // A gold fang necklace hung across the top of the window.
    fangNecklace(gold, pale) {
      let b = `<path d='M0 10 Q500 190 1000 10' fill='none' stroke='${gold}' stroke-opacity='.4' stroke-width='2.5'/>`;
      for (let t = 0.14; t <= 0.861; t += 0.04) {
        const x = t * 1000, y = 10 + 2 * t * (1 - t) * 180, dx = 1000, dy = 2 * (1 - 2 * t) * 180, l = Math.hypot(dx, dy), nx = -dy / l, ny = dx / l;
        const L = 22 + (1 - Math.abs(t - 0.5) * 2) * 22, w = 6;
        b += `<polygon points='${pts([[x - dx / l * w, y - dy / l * w], [x + nx * L, y + ny * L], [x + dx / l * w, y + dy / l * w]])}' fill='${gold}' fill-opacity='.16' stroke='${pale}' stroke-opacity='.55' stroke-width='1'/>`;
      }
      return layer([put(art(1000, 200, lit(b), 4), '50% 0', 1000, 200), rg(gold, '50% 0%', '50% 25%', 0.1)]);
    },
    // Scars in rows of raised dots, bottom-left.
    scars(c) {
      let b = '';
      for (let k = 0; k < 9; k++) for (let x = 20; x <= 250; x += 12) {
        const y = 36 + k * 26 - Math.abs(x - 135) * 0.22;
        b += `<circle cx='${x}' cy='${f1(y)}' r='2.2' fill='${c}' fill-opacity='.45'/>`;
      }
      return layer([put(art(280, 300, lit(b), 1.5), 'left 12px bottom 12px', 280, 300), rg(c, '0% 100%', '35% 40%', 0.12)]);
    },
  };

  // ---------- palettes ----------
  // Everything a theme needs from three colours: the dark suit colour the surfaces are tinted
  // with, the suit's main colour (the accent) and its secondary. Text defaults to a soft
  // off-white warmed a touch toward the accent.
  function derivePalette({ bg, accent, gold, text }) {
    text = text || mix('#ebe7df', accent, 0.05);
    return {
      bg,
      shadow: mix(bg, '#000000', 0.32),
      panel: mix(mix(bg, '#ffffff', 0.025), accent, 0.025),
      raised: mix(mix(bg, '#ffffff', 0.06), accent, 0.04),
      border: mix(mix(bg, '#ffffff', 0.13), accent, 0.06),
      borderStrong: mix(mix(bg, '#ffffff', 0.1), accent, 0.38),
      text, dim: mix(text, bg, 0.32), muted: mix(text, bg, 0.52),
      accent, bright: mix(accent, '#ffffff', 0.16), deep: mix(accent, '#000000', 0.3), blood: mix(accent, '#000000', 0.52),
      gold,
      added: '#6cbf86', addedBg: mix(bg, '#6cbf86', 0.13),
      removed: '#e07a6e', removedBg: mix(bg, '#e07a6e', 0.13),
      pillText: luminance(accent) > 0.38 ? '#14110c' : '#ffffff',
    };
  }

  function heroTheme(id, name, group, p, layers) {
    const vars = {
      '--ink-black': p.bg, '--shadow-black': p.shadow, '--panel-black': p.panel, '--raised-black': p.raised,
      '--border-iron': p.border, '--border-bright': p.borderStrong,
      '--bone-white': p.text, '--parchment': p.text, '--parchment-dim': p.dim, '--muted-text': p.muted,
      '--crusader-red': p.accent, '--crusader-red-bright': p.bright, '--crusader-red-deep': p.deep,
      '--blood': p.blood, '--gold-accent': p.gold,
      '--bg': p.bg, '--bg-panel': p.panel, '--bg-raised': p.raised,
      '--text': p.text, '--text-dim': p.dim, '--text-muted': p.muted,
      '--border': p.border, '--border-strong': p.borderStrong,
      '--accent': p.accent, '--accent-bright': p.bright,
      '--added': p.added, '--added-bg': p.addedBg, '--removed': p.removed, '--removed-bg': p.removedBg,
      '--head-pill-text': p.pillText || '#0a0606',
    };
    if (layers) {
      const [one, two] = layers;
      vars['--hero-aura'] = one.bg;
      vars['--hero-mask'] = one.mask || 'none';
      vars['--hero-aura-2'] = two ? two.bg : 'none';
      vars['--hero-mask-2'] = (two && two.mask) || 'none';
    }
    return { id, name, group, dark: true, swatches: [p.bg, p.accent, p.gold, p.text], vars };
  }
  const heroFrom = (id, name, group, colours, layers) => heroTheme(id, name, group, derivePalette(colours), layers);

  // ---------- the roster ----------
  // The first six are hand-tuned palettes whose auras live in 04-themes.css.
  const HERO_THEMES = [
    // Iron mask, forest-green cloak, gold clasp.
    heroTheme('hero-doom', 'Doctor Doom', 'villain', {
      bg: '#121715', shadow: '#0c100e', panel: '#171d1a', raised: '#1f2723', border: '#2e3833', borderStrong: '#4a574f',
      text: '#d6dbd4', dim: '#9aa59e', muted: '#6c7770',
      accent: '#5f8f4a', bright: '#79a862', deep: '#3f6630', blood: '#2a4520', gold: '#c2a24a',
      added: '#8dbf73', addedBg: '#1b2c1b', removed: '#c9695f', removedBg: '#33201d',
    }),
    // Indigo tunic, crimson Cloak of Levitation, the Eye's amber glow.
    heroTheme('hero-strange', 'Doctor Strange', 'hero', {
      bg: '#0f1224', shadow: '#0a0c19', panel: '#141934', raised: '#1b2143', border: '#2a3160', borderStrong: '#5a3350',
      text: '#e6e0d2', dim: '#a8abc6', muted: '#737a9a',
      accent: '#b8364a', bright: '#cf5064', deep: '#8a2436', blood: '#5c1826', gold: '#e0a458',
      added: '#62b98f', addedBg: '#16302d', removed: '#e07a6e', removedBg: '#351a28', pillText: '#ffffff',
    }),
    // Suit red over suit blue, silver webbing.
    heroTheme('hero-spider', 'Spider-Man', 'hero', {
      bg: '#0e1224', shadow: '#090c19', panel: '#131a33', raised: '#1a2245', border: '#283466', borderStrong: '#3d5294',
      text: '#e8ebf4', dim: '#a7b0d0', muted: '#707a9e',
      accent: '#c73a44', bright: '#dc5560', deep: '#962a33', blood: '#621b22', gold: '#6f95e8',
      added: '#5bbf82', addedBg: '#14302c', removed: '#e8806f', removedBg: '#351a26', pillText: '#ffffff',
    }),
    // The same suit with its colours swapped: blue leads, red is the secondary, and the
    // surfaces take the red's dark tint where the classic suit has navy.
    heroTheme('hero-spider-rev', 'Spider-Man Reversed', 'hero', {
      bg: '#1a0f14', shadow: '#12090d', panel: '#21121a', raised: '#2b1822', border: '#48263a', borderStrong: '#8a3a4c',
      text: '#f1e9ec', dim: '#cfb0b8', muted: '#9a7480',
      accent: '#3f6fd1', bright: '#5a88e6', deep: '#2b4f9e', blood: '#1c3470', gold: '#dc5560',
      added: '#5bbf82', addedBg: '#1a2c24', removed: '#e8806f', removedBg: '#3a1a22', pillText: '#ffffff',
    }),
    // Mustard yellow and blue, adamantium steel.
    heroTheme('hero-wolverine', 'Wolverine', 'antihero', {
      bg: '#11141b', shadow: '#0b0d12', panel: '#161a24', raised: '#1e2331', border: '#2d3547', borderStrong: '#6e6230',
      text: '#e8e9ec', dim: '#a8afbe', muted: '#717a8c',
      accent: '#e0b43a', bright: '#efc75a', deep: '#a8841f', blood: '#6e5614', gold: '#5a7fd0',
      added: '#6cbd7a', addedBg: '#182c20', removed: '#d9705a', removedBg: '#33201c', pillText: '#1a1407',
    }),
    // Crimson synthezoid skin, green suit, the Mind Stone's yellow.
    heroTheme('hero-vision', 'Vision', 'hero', {
      bg: '#0f1813', shadow: '#0a110d', panel: '#142019', raised: '#1b2a21', border: '#2a3d31', borderStrong: '#466b52',
      text: '#e6ede3', dim: '#a4b6a8', muted: '#6e8274',
      accent: '#c24b56', bright: '#d8646e', deep: '#8e3540', blood: '#5e2229', gold: '#e8cc5a',
      added: '#6cc394', addedBg: '#163026', removed: '#e68a64', removedBg: '#33221b', pillText: '#ffffff',
    }),

    // ----- Heroes -----
    heroFrom('hero-ironman', 'Iron Man', 'hero', { bg: '#170d0d', accent: '#b8352e', gold: '#d8a94a' },
      [M.reactor('#8fe3ff', '#d8a94a', '#b8352e'), SIG.ironmanHud('#8fe3ff')]),
    heroFrom('hero-cap', 'Captain America', 'hero', { bg: '#0e1426', accent: '#3f64b8', gold: '#c0414a' },
      [M.shield('#c0414a', '#3f64b8', '#e8ecf4'), SIG.starsStripes('#c0414a', '#e8ecf4')]),
    heroFrom('hero-thor', 'Thor', 'hero', { bg: '#0e121c', accent: '#6f9ee0', gold: '#b8403a' },
      [SIG.mjolnir('#c8d0dc', '#dfe9ff', '#6f9ee0'), SIG.bifrost()]),
    heroFrom('hero-hulk', 'Hulk', 'hero', { bg: '#0f160f', accent: '#5f9f4a', gold: '#7d58a8' },
      [SIG.smash('#7fd05a', '#e0ffd0'), M.gamma('#7fd05a')]),
    heroFrom('hero-widow', 'Black Widow', 'hero', { bg: '#0f0d10', accent: '#c0343c', gold: '#8e96a4' },
      [M.emblem('hourglass', '#c0343c', '#ff5a64', 'br'), SIG.widowBites('#6fb0ff')]),
    heroFrom('hero-hawkeye', 'Hawkeye', 'hero', { bg: '#130f1a', accent: '#8651bf', gold: '#d0a24a' },
      [M.arrows('#d0a24a', '#c9a3f0'), SIG.target('#8651bf', '#d0a24a')]),
    heroFrom('hero-panther', 'Black Panther', 'hero', { bg: '#0c0b12', accent: '#8d62e8', gold: '#c3c6d4' },
      [SIG.kinetic('#b99cff', '#e0d4ff'), SIG.wakanda('#c3c6d4')]),
    heroFrom('hero-marvel', 'Captain Marvel', 'hero', { bg: '#0f1428', accent: '#c43a48', gold: '#e2bd4c' },
      [SIG.photonFlare('#fff1c4', '#e2bd4c', '#c43a48', '#6f95e8'), M.rays('#ffd98a', '#fff1c4', '50% -4%', { alpha: 0.09 })]),
    heroFrom('hero-wanda', 'Scarlet Witch', 'hero', { bg: '#160a10', accent: '#c43250', gold: '#e0648e' },
      [SIG.tiara('#c43250', '#ff4f7a'), SIG.chaos('#ff4f7a', '#e0648e')]),
    heroFrom('hero-antman', 'Ant-Man', 'hero', { bg: '#130d0e', accent: '#bd3a33', gold: '#8f9aa8' },
      [SIG.quantum(['#7ad0ff', '#ff5ad0', '#ffb04a']), SIG.ants('#e0605a')]),
    heroFrom('hero-wasp', 'The Wasp', 'hero', { bg: '#12100a', accent: '#d9ad3c', gold: '#c24a3a' },
      [SIG.waspWings('#ffd76a', '#ffe9a8', '#fff2a0'), M.hex('#ffd76a', 'tr', '#d9ad3c')]),
    heroFrom('hero-falcon', 'Falcon', 'hero', { bg: '#10141c', accent: '#c03e3e', gold: '#98a6ba' },
      [SIG.falconWings('#c8d4e6', '#e04848'), M.glows([['#c03e3e', '100% 100%', '50% 55%', 0.14], ['#98a6ba', '0% 0%', '35% 40%', 0.1]])]),
    heroFrom('hero-starlord', 'Star-Lord', 'hero', { bg: '#150e0c', accent: '#c35a31', gold: '#6fb3de' },
      [SIG.mixtape('#e07a3a', '#ffc27a'), M.cosmic('#c35a31', '#6fb3de')]),
    heroFrom('hero-gamora', 'Gamora', 'hero', { bg: '#0c140f', accent: '#4aa874', gold: '#c4508c' },
      [SIG.godslayer('#e0f0e8', '#4fd08a'), SIG.zenMarks('#dfe8e4')]),
    heroFrom('hero-groot', 'Groot', 'hero', { bg: '#120f0a', accent: '#7c9b4c', gold: '#a8763e' },
      [SIG.branches('#b08a5a', '#b8e07a'), M.embers('#d8f0a0', '#f2d58a')]),
    heroFrom('hero-rocket', 'Rocket', 'hero', { bg: '#14100c', accent: '#cf8a3c', gold: '#5a8ac2' },
      [SIG.blueprint('#5ab0e8', '#dff0ff'), SIG.reticle('#ffa040')]),
    heroFrom('hero-surfer', 'Silver Surfer', 'hero', { bg: '#0b0f18', accent: '#b4c1d6', gold: '#6f9fe0' },
      [SIG.surfboard('#dfe8f5', '#9fc4ff'), SIG.warp('#dfe8ff')]),
    heroFrom('hero-daredevil', 'Daredevil', 'hero', { bg: '#140808', accent: '#b0272f', gold: '#d45c3c' },
      [plus(M.sonar('#ff4b4b', 'br'), SIG.ddEmblem('#ff5a5a')), SIG.rain('#f0c8c8')]),
    heroFrom('hero-storm', 'Storm', 'hero', { bg: '#0f1320', accent: '#cfd6e4', gold: '#6f9fe0' },
      [SIG.vortex('#cfd6e4', '#9fc4ff'), SIG.wind('#e8f0ff')]),
    heroFrom('hero-cyclops', 'Cyclops', 'hero', { bg: '#0f1220', accent: '#d43a40', gold: '#e0b44a' },
      [M.beam('#ff4a55', '#ffd0d4'), plus(M.glows([['#3f64b8', '0% 100%', '45% 50%', 0.14]]), SIG.xEmblem('#e0b44a', '#d43a40'))]),
    heroFrom('hero-phoenix', 'Phoenix', 'hero', { bg: '#160c08', accent: '#de5c2c', gold: '#eec048' },
      [SIG.firebird('#ff8a3a', '#ffd060'), M.embers('#ffb04a', '#fff0a0')]),
    heroFrom('hero-iceman', 'Iceman', 'hero', { bg: '#0b141a', accent: '#7cc4e4', gold: '#e0f2ff' },
      [M.frost('#bfeaff', '#7cc4e4'), SIG.snowflakes('#e8f8ff')]),
    heroFrom('hero-torch', 'Human Torch', 'hero', { bg: '#160c06', accent: '#e6732c', gold: '#f0c048' },
      [SIG.flameComet('#ff7a2a', '#ffd060'), SIG.fourEmblem('#9fc4ff', '#e6732c')]),
    heroFrom('hero-shangchi', 'Shang-Chi', 'hero', { bg: '#140c0c', accent: '#c4363c', gold: '#dcb048' },
      [M.tenrings('#9fd0ff', '#5aa8ff'), SIG.dragonScales('#4fd0c0', '#dcb048')]),
    heroFrom('hero-miles', 'Miles Morales', 'hero', { bg: '#0c0c10', accent: '#d02e3e', gold: '#cfd4de' },
      [SIG.verse('#e0303e', '#5ae0ff'), SIG.spray('#e0303e', '#9a4fe0', '#7fd8ff')]),
    heroFrom('hero-gwen', 'Spider-Gwen', 'hero', { bg: '#0f0f15', accent: '#e05c9c', gold: '#5ad0d6' },
      [SIG.watercolor('#ff6fb0', '#5ad0d6', '#a07aff'), SIG.stageLights(['#ff6fb0', '#5ad0d6', '#a07aff'])]),

    // ----- Anti-heroes -----
    heroFrom('hero-deadpool', 'Deadpool', 'antihero', { bg: '#140909', accent: '#c22c2c', gold: '#d8d8de' },
      [plus(M.katanas('#e8ecf4', '#ff5555'), SIG.deadpoolMask('#e03a3a', '#ffffff')), SIG.bubble('#f0f0f4')]),
    heroFrom('hero-venom', 'Venom', 'antihero', { bg: '#08090c', accent: '#d6dbe4', gold: '#c0343c' },
      [SIG.goo('#e8ecf4'), SIG.venomSpider('#f0f2f6', '#c0343c')]),
    heroFrom('hero-punisher', 'Punisher', 'antihero', { bg: '#0c0c0e', accent: '#dcdde3', gold: '#9a2a2a' },
      [M.emblem('skull', '#ffffff', '#ffffff', 'br'), SIG.bulletHoles('#e8e8ee')]),
    heroFrom('hero-ghostrider', 'Ghost Rider', 'antihero', { bg: '#120806', accent: '#ec7a2c', gold: '#d6cebe' },
      [plus(M.flames('#ec7a2c', '#ffcf6a'), SIG.burningWheel('#ff8a3a', '#e8dcc8')), SIG.hellChain('#d6cebe', '#ff7a2a')]),
    heroFrom('hero-loki', 'Loki', 'antihero', { bg: '#0c1410', accent: '#3f9a5a', gold: '#d2ae40' },
      [SIG.horns('#e2c050'), SIG.sceptre('#e2c050', '#7fd0ff', '#3f9a5a')]),
    heroFrom('hero-elektra', 'Elektra', 'antihero', { bg: '#140a0a', accent: '#b82c3c', gold: '#c9a34c' },
      [SIG.sais('#f0e0d0', '#e0404c'), SIG.ribbon('#d8384a')]),
    heroFrom('hero-blade', 'Blade', 'antihero', { bg: '#0e0a0a', accent: '#9e2028', gold: '#b8bcc6' },
      [plus(M.glows([['#9e2028', '100% 100%', '40% 45%', 0.16]]), SIG.glaive('#e0e4ec', '#c0303a')), SIG.bloodRain('#c0303a')]),
    heroFrom('hero-moonknight', 'Moon Knight', 'antihero', { bg: '#0e0f14', accent: '#d6dae4', gold: '#c7a44c' },
      [M.moon('#f2f4fa', '#c8d4ff'), SIG.glyphs('#d8c080')]),
    heroFrom('hero-namor', 'Namor', 'antihero', { bg: '#0a1418', accent: '#2f9e8a', gold: '#d2ae40' },
      [M.waves('#6fe0cf', '#2f9e8a'), SIG.trident('#e2c050', '#9ff0e0')]),
    heroFrom('hero-bucky', 'Winter Soldier', 'antihero', { bg: '#0e1014', accent: '#b83a40', gold: '#9aa4b2' },
      [SIG.metalArm('#c8d2e0', '#ff4f5a'), M.brushed('#c8d2e0')]),

    // ----- Villains -----
    heroFrom('hero-thanos', 'Thanos', 'villain', { bg: '#110c16', accent: '#7d52b4', gold: '#d4ae3c' },
      [SIG.gauntletHand('#e2bd4c'), SIG.snapDust('#c8a070', '#8a7a70')]),
    heroFrom('hero-magneto', 'Magneto', 'villain', { bg: '#140a14', accent: '#a42c4c', gold: '#7c52b2' },
      [M.field('#d65a8a', '#9a7ae0'), SIG.magnetoHelm('#e0709a', '#c8c8d8')]),
    heroFrom('hero-ultron', 'Ultron', 'villain', { bg: '#0c0d10', accent: '#d0303a', gold: '#9aa4b0' },
      [SIG.ultronEyes('#ff3a44'), M.circuit('#ff5a64', '#d0303a')]),
    heroFrom('hero-goblin', 'Green Goblin', 'villain', { bg: '#0e120c', accent: '#6aa03c', gold: '#8252b0' },
      [SIG.pumpkins('#ff9a40', '#ffd070'), SIG.glider('#8fd050', '#ffa040')]),
    heroFrom('hero-octopus', 'Doctor Octopus', 'villain', { bg: '#0e1210', accent: '#4f9a6c', gold: '#c8a24c' },
      [SIG.ockArms('#d8e0c8', '#ff4a4a'), SIG.fusionSun('#ffd060', '#ff8a3a')]),
    heroFrom('hero-redskull', 'Red Skull', 'villain', { bg: '#120808', accent: '#c02c2c', gold: '#4fa8e8' },
      [SIG.tesseract('#7fd0ff', '#c02c2c'), M.glows([['#c02c2c', '0% 100%', '40% 45%', 0.12]])]),
    heroFrom('hero-hela', 'Hela', 'villain', { bg: '#0c100e', accent: '#3a8c5c', gold: '#9aa29c' },
      [M.blades('#8fe0b0', '#3a8c5c'), SIG.necroswords('#b8f0cc', '#3a8c5c')]),
    heroFrom('hero-dormammu', 'Dormammu', 'villain', { bg: '#150806', accent: '#e05c2c', gold: '#9a4ce0' },
      [SIG.dormammuFace('#ff7a2a', '#fff0c0'), SIG.darkVortex('#b87aff')]),
    heroFrom('hero-galactus', 'Galactus', 'villain', { bg: '#0c0c18', accent: '#6a52c4', gold: '#3f6ad2' },
      [SIG.galactusHelm('#b8a8ff', '#6a52c4'), SIG.devouredPlanet('#c8b8ff', '#5a8ad0')]),
    heroFrom('hero-carnage', 'Carnage', 'villain', { bg: '#120606', accent: '#c41c2e', gold: '#ff6a3a' },
      [SIG.spikes('#ff4a5a'), SIG.splatter('#ff3a4a', '#ff9a6a')]),
    heroFrom('hero-kingpin', 'Kingpin', 'villain', { bg: '#0e0e10', accent: '#dcdde3', gold: '#9a2a3a' },
      [M.pinstripe('#dcdde3', '#ffffff'), SIG.skyline('#e8e8ee', '#ffd070')]),
    heroFrom('hero-mysterio', 'Mysterio', 'villain', { bg: '#0c1014', accent: '#3fae8a', gold: '#8a52c2' },
      [SIG.fishbowl('#9ff0d8', '#7fe8c8'), M.smoke('#3fae8a', '#8a52c2')]),
    heroFrom('hero-electro', 'Electro', 'villain', { bg: '#0c0f14', accent: '#cfcf3c', gold: '#3a9ae0' },
      [SIG.starburst('#f8ffb0', '#e0e03a'), SIG.arcs('#f8ffb0', '#e0e03a')]),
    heroFrom('hero-killmonger', 'Killmonger', 'villain', { bg: '#0c0b10', accent: '#d2ac3c', gold: '#a0402e' },
      [SIG.fangNecklace('#d2ac3c', '#ffe39a'), SIG.scars('#e8c060')]),
  ];

  if (typeof window !== 'undefined') window.HERO_THEMES = HERO_THEMES;
  if (typeof module !== 'undefined' && module.exports) module.exports = { HERO_THEMES, derivePalette, M };
})();
