// Hero themes: Marvel heroes, anti-heroes and villains, each a palette plus backdrop art.
//
// Same `vars` shape as the Alacritty palettes (00-alacritty-themes.js), so applyTheme in
// 08-lfs-settings.js injects them the same way. What's extra is the art: two layers,
// --hero-aura / --hero-mask and --hero-aura-2 / --hero-mask-2, which the HERO SUIT THEMES
// block in 04-themes.css paints *underneath* the UI (body::before / body::after, below
// .screen). The panels above it are made translucent with the --hero-glass-* colours solved
// in heroTheme, so the art shows through them without ever being drawn over text.
//
// How the art is built, from the bottom up:
//   - materials: SVG filters (feTurbulence) for anything organic — fire, cloud, smoke,
//     nebulae — so those read as the real thing rather than as a drawing of it.
//   - ART: each character's own object drawn with its real construction (the gauntlet's
//     plates and settings, Mjolnir's faces and wrapped grip, a helmet's faceplate).
//   - M / SIG: the older ambient motifs (glows, webs, rain, embers) and single pieces.
//   - SCENE: a character's two layers, composed from the above.
// Rules that keep it a backdrop: palettes are calm (derivePalette); the subject sits in a
// corner or along an edge; fills are faint and only edges and points of light carry
// weight; --hero-strength (Settings → Appearance) scales the whole thing.
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
        hourglass: { d: 'M24 14 H76 L53 47 H47 Z M47 53 H53 L76 86 H24 Z', solid: 0.4 },
        skull: {
          d: 'M50 6 C27 6 13 22 13 43 C13 55 19 63 27 67 V76 H73 V67 C81 63 87 55 87 43 C87 22 73 6 50 6 Z ' +
            'M24 40 C24 31 42 31 42 42 C42 50 28 52 24 40 Z M76 40 C76 31 58 31 58 42 C58 50 72 52 76 40 Z M50 50 L45 62 H55 Z',
          extra: `<path d='M30 76 V95 M40 76 V97 M50 76 V98 M60 76 V97 M70 76 V95' stroke='${stroke}' stroke-opacity='.32' stroke-width='3.2' stroke-linecap='round'/>`,
        },
      };
      const S = SHAPES[shape];
      const body = `<path d='${S.d}' fill='${fill}' fill-opacity='${S.solid || 0.08}' fill-rule='evenodd' stroke='${stroke}' stroke-opacity='.3' stroke-width='1.2'/>${S.extra || ''}`;
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

    // The Ten Rings circling in a tilted orbit, each a heavy metal band lit blue from inside.
    tenrings(color, glow) {
      let back = '', front = '';
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2, cx = f1(260 + 190 * Math.cos(a)), cy = f1(220 + 70 * Math.sin(a)), s = f1(0.75 + 0.25 * Math.sin(a));
        const ring = `<g transform='translate(${cx} ${cy}) scale(${s}) rotate(${f1(Math.cos(a) * 30)})'>` +
          `<ellipse rx='30' ry='12' fill='none' stroke='${glow}' stroke-opacity='.45' stroke-width='12' filter='url(#b)'/>` +
          `<ellipse rx='30' ry='12' fill='none' stroke='url(#rm)' stroke-width='7'/><ellipse rx='30' ry='12' fill='none' stroke='${color}' stroke-opacity='.7' stroke-width='1.2'/></g>`;
        if (Math.sin(a) < 0) back += ring; else front += ring;
      }
      const defs = metalG('rm', '#ffffff', '#c0a860', '#5a4a20', 0, 1);
      return { bg: `${art(520, 440, `<ellipse cx='260' cy='220' rx='190' ry='70' fill='none' stroke='${glow}' stroke-opacity='.15' stroke-width='3'/>${back}${front}`, 5, defs)} right -40px bottom -40px / 520px 440px no-repeat, radial-gradient(circle at 100% 100%, ${rgba(glow, 0.16)}, transparent 42%)` };
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

  // ---------- materials ----------
  // Procedural texture via SVG filters (feTurbulence), which is what lets fire, smoke, cloud
  // and nebula read as the real thing rather than as a drawing of it. Rasterised once per
  // window size by the compositor; nothing here animates.
  //
  // Displace a shape's edges with noise: ragged fire, torn smoke, wet goo.
  const warpF = (id, fx, fy, oct, seed, scale, blurS = 0) =>
    `<filter id='${id}' x='-30%' y='-30%' width='160%' height='160%'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='${fx} ${fy}' numOctaves='${oct}' seed='${seed}' result='t'/>` +
    `<feDisplacementMap in='SourceGraphic' in2='t' scale='${scale}' xChannelSelector='R' yChannelSelector='G'${blurS ? " result='d'/>" + `<feGaussianBlur in='d' stdDeviation='${blurS}'/>` : '/>'}</filter>`;
  // Fill a shape with a noise texture in one colour: clouds, smoke, nebulae, dust. `k` is the
  // contrast of the noise → alpha ramp, `o` its offset (lower = sparser).
  const cloudF = (id, freq, oct, seed, colour, k = 2.4, o = -0.95) => {
    const [r, g, b] = hexRgb(colour).map(v => f1(v / 255 * 100) / 100);
    return `<filter id='${id}' x='0' y='0' width='100%' height='100%'>` +
      `<feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${oct}' seed='${seed}' result='t'/>` +
      `<feColorMatrix in='t' type='matrix' values='0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  ${k} 0 0 0 ${o}' result='c'/>` +
      `<feComposite in='c' in2='SourceGraphic' operator='in'/></filter>`;
  };
  // A vertical or diagonal metal ramp for shading plates: light, body, shadow.
  const metalG = (id, light, body, dark, x2 = 1, y2 = 0.35) =>
    `<linearGradient id='${id}' x1='0' y1='0' x2='${x2}' y2='${y2}'><stop offset='0' stop-color='${light}'/><stop offset='.45' stop-color='${body}'/><stop offset='1' stop-color='${dark}'/></linearGradient>`;
  // A soft radial fade used as a mask: `white` where art may show, black where it may not.
  const fadeMask = (id, w, h, cx, cy, r, inner = 0.35) =>
    `<radialGradient id='${id}g' gradientUnits='userSpaceOnUse' cx='${cx}' cy='${cy}' r='${r}'><stop offset='${inner}' stop-color='white'/><stop offset='1' stop-color='black'/></radialGradient>` +
    `<mask id='${id}'><rect width='${w}' height='${h}' fill='url(#${id}g)'/></mask>`;

  // Flames: tongues of a vertical fire gradient, torn apart by noise so they lick upward.
  // Drawn at the bottom of a w×h box; `heat` scales the tongues' height.
  function fireBody(w, h, seed, cols, { heat = 1, count, glow = true, id = 'fb' } = {}) {
    const [core, mid, outer] = cols;
    const r = rng(seed);
    const n = count || Math.round(w / 34);
    let tongues = '';
    for (let i = 0; i < n; i++) {
      const x = (i + r() * 0.6 - 0.3) * (w / n), tw = (w / n) * (1.3 + r() * 0.9), th = h * heat * (0.35 + r() * 0.6), sway = (r() - 0.5) * tw * 0.8;
      tongues += `<path d='M${f1(x - tw / 2)} ${h} C${f1(x - tw * 0.45)} ${f1(h - th * 0.45)} ${f1(x + sway * 0.4)} ${f1(h - th * 0.7)} ${f1(x + sway)} ${f1(h - th)} ` +
        `C${f1(x + tw * 0.2)} ${f1(h - th * 0.6)} ${f1(x + tw * 0.5)} ${f1(h - th * 0.4)} ${f1(x + tw / 2)} ${h} Z'/>`;
    }
    const defs = `<linearGradient id='${id}g' x1='0' y1='1' x2='0' y2='0'>` +
      `<stop offset='0' stop-color='${core}' stop-opacity='.75'/><stop offset='.18' stop-color='${mid}' stop-opacity='.6'/>` +
      `<stop offset='.5' stop-color='${outer}' stop-opacity='.32'/><stop offset='1' stop-color='${outer}' stop-opacity='0'/></linearGradient>` +
      warpF(id + 'w', 0.012, 0.035, 3, seed, 70) + warpF(id + 'v', 0.03, 0.08, 2, seed + 3, 30) + blur(id + 'b', 14);
    const body = `<g fill='url(#${id}g)'>${tongues}</g>`;
    return {
      defs,
      art: (glow ? `<g filter='url(#${id}b)' opacity='.7'>${body}</g>` : '') +
        `<g filter='url(#${id}w)'>${body}</g><g filter='url(#${id}v)' opacity='.6' transform='translate(0 ${f1(h * 0.08)}) scale(1 .92)'>${body}</g>`,
    };
  }

  // Mirror a left half about x=100, for faces and helmets drawn in a 200-wide box.
  const sym = (half) => half + `<g transform='translate(200 0) scale(-1 1)'>${half}</g>`;

  // ---------- illustrations ----------
  // The characters' own objects, drawn as objects: shaded, with their real construction
  // (a gauntlet has plates and knuckle settings, a hammer has faces and a wrapped grip).
  // They sit in a corner or along an edge under glass, at backdrop strength — the fills are
  // faint and only the edges and the few points of light carry any weight.
  const ART = {
    // The Infinity Gauntlet, back of the left hand, fingers raised: knuckle plates, jointed
    // finger armour, the flared cuff, and the six stones in their MCU settings.
    gauntlet(gold, stones) {
      const G = (d, extra = '') => `<path d='${d}' fill='url(#gm)' fill-opacity='.34' stroke='${gold}' stroke-opacity='.62' stroke-width='1.6' stroke-linejoin='round' ${extra}/>`;
      const hi = (d, o = 0.5) => `<path d='${d}' fill='none' stroke='#fff3c8' stroke-opacity='${o}' stroke-width='1.1' stroke-linecap='round'/>`;
      let b = '';
      // Cuff: three flared bands and a centre ridge.
      b += G('M112 392 L298 392 L318 512 L92 512 Z');
      b += G('M104 440 L306 440 L312 474 L98 474 Z');
      b += hi('M114 398 H296') + hi('M205 392 V512', 0.3);
      // Back of the hand, broad at the knuckles, a raised ridge down the middle.
      b += G('M118 392 C112 340 104 280 110 236 C150 222 262 222 300 236 C306 282 300 340 292 392 Z');
      b += `<path d='M150 240 L205 262 L260 240 M205 262 V380' fill='none' stroke='${gold}' stroke-opacity='.4' stroke-width='1.3'/>`;
      b += hi('M122 250 C120 300 124 350 128 386', 0.35);
      // Fingers: little, ring, middle, index — each three plates that overlap at the joints.
      const fingers = [[124, 108, 30], [162, 62, 34], [204, 44, 35], [246, 72, 33]];
      fingers.forEach(([x, top, w]) => {
        const base = 238, seg = (base - top) / 3;
        for (let k = 0; k < 3; k++) {
          const y0 = base - seg * k, y1 = y0 - seg - 6, ww = w - k * 3, cx = x + w / 2;
          b += G(`M${f1(cx - ww / 2)} ${f1(y0)} L${f1(cx - ww / 2 + 1)} ${f1(y1 + 10)} Q${f1(cx)} ${f1(y1 - (k === 2 ? 14 : 4))} ${f1(cx + ww / 2 - 1)} ${f1(y1 + 10)} L${f1(cx + ww / 2)} ${f1(y0)} Z`);
          b += hi(`M${f1(cx - ww / 2 + 5)} ${f1(y0 - 4)} L${f1(cx - ww / 2 + 5)} ${f1(y1 + 14)}`, 0.28);
        }
      });
      // Thumb, angled out from the side of the hand.
      b += `<g transform='rotate(38 300 330)'>` + G('M284 340 L284 270 Q300 252 316 270 L316 340 Z') + G('M287 272 L287 214 Q300 194 313 214 L313 272 Z') + '</g>';
      // Settings: a raised collar round each stone.
      const set = [[139, 236, 13, stones[0]], [179, 236, 13, stones[1]], [221, 236, 13, stones[2]], [262, 236, 13, stones[3]], [300, 318, 13, stones[4]], [205, 318, 22, stones[5]]];
      let s = '';
      set.forEach(([x, y, R, c]) => {
        s += `<circle cx='${x}' cy='${y}' r='${R + 6}' fill='url(#gm)' fill-opacity='.4' stroke='${gold}' stroke-opacity='.7' stroke-width='1.5'/>`;
        s += `<circle cx='${x}' cy='${y}' r='${R * 2.2}' fill='${c}' fill-opacity='.28' filter='url(#b)'/>`;
        s += `<ellipse cx='${x}' cy='${y}' rx='${R}' ry='${R * (R > 15 ? 1.25 : 1)}' fill='url(#st${c.slice(1)})'/>`;
        s += `<ellipse cx='${x - R * 0.35}' cy='${y - R * 0.4}' rx='${R * 0.28}' ry='${R * 0.2}' fill='#ffffff' fill-opacity='.75'/>`;
      });
      const stoneG = [...new Set(set.map(z => z[3]))].map(c => `<radialGradient id='st${c.slice(1)}' cx='.4' cy='.35'><stop offset='0' stop-color='${mix(c, '#ffffff', 0.5)}' stop-opacity='.95'/><stop offset='.6' stop-color='${c}' stop-opacity='.85'/><stop offset='1' stop-color='${mix(c, '#000000', 0.4)}' stop-opacity='.8'/></radialGradient>`).join('');
      return art(420, 520, `<g filter='url(#b)' opacity='.35'>${b}</g>${b}${s}`, 3,
        metalG('gm', '#fbe7a4', gold, mix(gold, '#000000', 0.55), 1, 0.2) + stoneG);
    },

    // Mjolnir in three-quarter view: a block head with bevelled faces and the knotwork on its
    // end, a leather-wrapped handle, the pommel and its wrist strap.
    mjolnir(steel, leather) {
      const dark = mix(steel, '#000000', 0.55);
      let b = `<g transform='translate(210 150) rotate(-32)'>`;
      // Head: front face, top face, end face.
      b += `<path d='M-120 -58 L96 -58 L96 58 L-120 58 Z' fill='url(#hm)' fill-opacity='.36' stroke='${steel}' stroke-opacity='.7' stroke-width='1.8'/>`;
      b += `<path d='M-120 -58 L-92 -84 L124 -84 L96 -58 Z' fill='${steel}' fill-opacity='.22' stroke='${steel}' stroke-opacity='.6' stroke-width='1.4'/>`;
      b += `<path d='M96 -58 L124 -84 L124 32 L96 58 Z' fill='${dark}' fill-opacity='.3' stroke='${steel}' stroke-opacity='.6' stroke-width='1.4'/>`;
      // Bevel lines inset on the front face, and the knot on the end.
      b += `<path d='M-108 -46 H84 V46 H-108 Z' fill='none' stroke='${steel}' stroke-opacity='.3'/>`;
      b += `<g transform='translate(110 -13) scale(.42 .9)'><circle r='40' fill='none' stroke='${steel}' stroke-opacity='.55' stroke-width='3'/>` +
        [0, 120, 240].map(a => `<path d='M0 -34 C22 -20 22 10 0 4 C-22 10 -22 -20 0 -34 Z' fill='none' stroke='${steel}' stroke-opacity='.55' stroke-width='2.4' transform='rotate(${a})'/>`).join('') + '</g>';
      b += `<path d='M-114 -52 L90 -52' stroke='#ffffff' stroke-opacity='.4' stroke-width='1.4'/>`;
      // Handle: collar, a wrap of angled leather strips, pommel, strap.
      b += `<rect x='-22' y='58' width='44' height='16' rx='3' fill='${steel}' fill-opacity='.3' stroke='${steel}' stroke-opacity='.6'/>`;
      b += `<rect x='-15' y='74' width='30' height='210' fill='${leather}' fill-opacity='.28' stroke='${leather}' stroke-opacity='.55'/>`;
      for (let i = 0; i < 12; i++) b += `<path d='M-15 ${80 + i * 17} L15 ${90 + i * 17}' stroke='${mix(leather, '#ffffff', 0.35)}' stroke-opacity='.45' stroke-width='2'/>`;
      b += `<rect x='-19' y='284' width='38' height='22' rx='6' fill='url(#hm)' fill-opacity='.4' stroke='${steel}' stroke-opacity='.7'/>`;
      b += `<path d='M-6 304 C-30 372 30 372 6 304' fill='none' stroke='${leather}' stroke-opacity='.55' stroke-width='4.5' stroke-linejoin='round'/>`;
      b += '</g>';
      return b;
    },

    // ----- faces, helmets and emblems -----
    // All drawn in a 200-wide box, centred on x=100; most are drawn as a left half and
    // mirrored (`sym`), which is what keeps a face from looking hand-wobbled.

    // Mark-series helmet: red shell, gold faceplate with its widow's peak, slit eyes lit.
    ironHelmet(red, gold, eye) {
      const half = `<path d='M100 40 C74 40 56 52 50 74 L48 122 C50 150 58 172 72 190 L86 214 L100 218 Z' fill='url(#fp)' fill-opacity='.4' stroke='${gold}' stroke-opacity='.7' stroke-width='1.6'/>` +
        `<path d='M50 78 C68 68 86 72 100 60' fill='none' stroke='${gold}' stroke-opacity='.55' stroke-width='1.4'/>` +
        `<path d='M60 142 L76 178 L86 186 H100' fill='none' stroke='${gold}' stroke-opacity='.45' stroke-width='1.3'/>` +
        `<path d='M54 102 L90 110 L88 119 L60 114 Z' fill='${eye}' fill-opacity='.85'/>`;
      return `<path d='M100 6 C50 6 26 44 26 96 L28 150 C30 188 52 216 78 232 L122 232 C148 216 170 188 172 150 L174 96 C174 44 150 6 100 6 Z' fill='url(#sh)' fill-opacity='.36' stroke='${red}' stroke-opacity='.7' stroke-width='1.8'/>` +
        sym(half) + `<path d='M100 126 V160' stroke='${gold}' stroke-opacity='.3'/><path d='M70 22 C84 16 116 16 130 22' fill='none' stroke='#ffffff' stroke-opacity='.35' stroke-width='1.6'/>` +
        `<g filter='url(#b)'>${sym(`<path d='M54 102 L90 110 L88 119 L60 114 Z' fill='${eye}' fill-opacity='.9'/>`)}</g>`;
    },

    // The shield: red, silver, red, a blue field and the star; a sheen raked across it.
    capShield(red, silver, blue) {
      let b = `<circle cx='150' cy='150' r='146' fill='${red}' fill-opacity='.3' stroke='${silver}' stroke-opacity='.55' stroke-width='2'/>` +
        `<circle cx='150' cy='150' r='116' fill='${silver}' fill-opacity='.22'/><circle cx='150' cy='150' r='86' fill='${red}' fill-opacity='.34'/>` +
        `<circle cx='150' cy='150' r='57' fill='${blue}' fill-opacity='.45'/>` +
        `<polygon points='${starPts(150, 150, 54, 21, 5)}' fill='${silver}' fill-opacity='.6'/>`;
      [146, 116, 86, 57].forEach(r => { b += `<circle cx='150' cy='150' r='${r}' fill='none' stroke='#000000' stroke-opacity='.25' stroke-width='1.2'/>`; });
      b += `<path d='M40 110 A118 118 0 0 1 120 34' fill='none' stroke='#ffffff' stroke-opacity='.35' stroke-width='5' stroke-linecap='round'/>`;
      b += `<circle cx='150' cy='150' r='146' fill='url(#sn)'/>`;
      return b;
    },

    // The Panther helmet: raised ears, angular lenses, the silver tracery of the suit.
    pantherMask(silver, eye) {
      const half = `<path d='M100 18 L60 22 L36 12 L42 80 C38 130 56 180 100 212 Z' fill='${silver}' fill-opacity='.08' stroke='${silver}' stroke-opacity='.55' stroke-width='1.6'/>` +
        `<path d='M52 100 L92 110 L88 124 L60 120 C54 114 52 108 52 100 Z' fill='${eye}' fill-opacity='.75'/>` +
        `<path d='M100 40 L76 56 L58 92 M100 40 L84 76 L92 108 M40 30 L62 56' fill='none' stroke='${silver}' stroke-opacity='.4' stroke-width='1.2'/>` +
        `<path d='M100 128 L90 156 L100 164' fill='none' stroke='${silver}' stroke-opacity='.45' stroke-width='1.2'/>` +
        `<path d='M60 150 L78 180 L100 188' fill='none' stroke='${silver}' stroke-opacity='.35' stroke-width='1.2'/>`;
      return sym(half) + `<g filter='url(#b)'>${sym(`<path d='M52 100 L92 110 L88 124 L60 120 Z' fill='${eye}' fill-opacity='.8'/>`)}</g>`;
    },

    // Captain Marvel's eight-pointed star.
    marvelStar(gold) {
      const p = [];
      for (let i = 0; i < 16; i++) { const a = -Math.PI / 2 + i * Math.PI / 8, R = i % 2 ? 26 : (i % 4 === 0 ? 96 : 56); p.push([100 + R * Math.cos(a), 100 + R * Math.sin(a)]); }
      return `<polygon points='${pts(p)}' fill='url(#gs)' fill-opacity='.5' stroke='${gold}' stroke-opacity='.75' stroke-width='1.6' stroke-linejoin='round'/>` +
        [0, 1, 2, 3].map(k => { const a = -Math.PI / 2 + k * Math.PI / 2; return line(100, 100, 100 + 92 * Math.cos(a), 100 + 92 * Math.sin(a), '#ffffff', 0.35, 1); }).join('');
    },

    // Ant-Man's helmet: two big lenses, the mouth grille, the breathing tubes.
    antHelmet(shell, lens, steel) {
      let half = `<path d='M100 14 C56 14 32 48 32 96 C32 150 56 190 100 200 Z' fill='${shell}' fill-opacity='.14' stroke='${steel}' stroke-opacity='.55' stroke-width='1.6'/>` +
        `<path d='M92 80 C70 64 44 72 42 98 C40 124 62 136 86 124 C98 116 98 90 92 80 Z' fill='${lens}' fill-opacity='.55' stroke='${steel}' stroke-opacity='.6' stroke-width='2.4'/>` +
        `<path d='M60 88 C68 80 78 80 84 86' fill='none' stroke='#ffffff' stroke-opacity='.5' stroke-width='2' stroke-linecap='round'/>` +
        `<path d='M46 150 C30 160 26 184 38 196' fill='none' stroke='${steel}' stroke-opacity='.45' stroke-width='7' stroke-linecap='round'/>`;
      let grille = `<rect x='74' y='140' width='52' height='46' rx='10' fill='${steel}' fill-opacity='.12' stroke='${steel}' stroke-opacity='.55' stroke-width='1.5'/>`;
      for (let x = 82; x <= 118; x += 6) grille += line(x, 146, x, 180, steel, 0.4, 1.4);
      return sym(half) + grille + `<g filter='url(#b)'>${sym(`<ellipse cx='66' cy='100' rx='18' ry='14' fill='${lens}' fill-opacity='.6'/>`)}</g>`;
    },

    // Venom: the white eyes swept back, the grin full of teeth, the tongue.
    venomFace(white, tongue, sheen) {
      const eye = `<path d='M96 70 C76 70 40 56 22 22 C58 36 82 44 98 58 Z' fill='${white}' fill-opacity='.7' stroke='${white}' stroke-opacity='.8'/>`;
      let teeth = '';
      for (let i = 0; i < 13; i++) {
        const x = 38 + i * 10, up = 128 + Math.abs(i - 6) * -2.5 + Math.abs(i - 6) ** 2 * 0.7, dn = 188 - Math.abs(i - 6) ** 2 * 0.9;
        teeth += `<polygon points='${pts([[x - 4, up], [x + 4, up], [x + 0.5, up + 24 - Math.abs(i - 6)]])}' fill='${white}' fill-opacity='.65'/>`;
        teeth += `<polygon points='${pts([[x - 4, dn], [x + 4, dn], [x - 0.5, dn - 22 + Math.abs(i - 6)]])}' fill='${white}' fill-opacity='.6'/>`;
      }
      return `<path d='M100 0 C40 0 6 40 8 96 C10 150 44 200 100 210 C156 200 190 150 192 96 C194 40 160 0 100 0 Z' fill='${sheen}' fill-opacity='.05' stroke='${sheen}' stroke-opacity='.3' stroke-width='1.4'/>` +
        `<path d='M30 128 C60 118 140 118 170 128 C164 170 136 196 100 196 C64 196 36 170 30 128 Z' fill='#000000' fill-opacity='.45' stroke='${white}' stroke-opacity='.3'/>` +
        sym(eye) + teeth +
        `<path d='M106 176 C120 200 104 236 86 246 C98 226 100 204 92 184 Z' fill='${tongue}' fill-opacity='.5' stroke='${tongue}' stroke-opacity='.6'/>` +
        `<path d='M60 20 C80 10 120 10 140 20' fill='none' stroke='#ffffff' stroke-opacity='.3' stroke-width='3' stroke-linecap='round'/>`;
    },

    // The Punisher's skull: a rounded dome, deep sockets, and the long teeth.
    punisherSkull(c) {
      const half = `<path d='M100 8 C56 8 26 38 26 84 C26 118 38 138 52 150 L56 176 L100 176 Z' fill='${c}' fill-opacity='.16' stroke='${c}' stroke-opacity='.6' stroke-width='1.6'/>` +
        `<path d='M92 98 C92 80 76 72 58 76 C44 80 40 96 46 110 C54 128 88 126 92 98 Z' fill='#000000' fill-opacity='.55' stroke='${c}' stroke-opacity='.5'/>`;
      let teeth = '';
      [58, 72, 86, 100, 114, 128].forEach((x, i) => { const L = 60 - Math.abs(i - 2.5) * 10; teeth += `<path d='M${x} 178 L${x} ${178 + L} C${x} ${184 + L} ${x + 12} ${184 + L} ${x + 12} ${178 + L} L${x + 12} 178 Z' fill='${c}' fill-opacity='.2' stroke='${c}' stroke-opacity='.6' stroke-width='1.4'/>`; });
      return sym(half) + `<path d='M100 118 L90 144 H110 Z' fill='#000000' fill-opacity='.5' stroke='${c}' stroke-opacity='.45'/>` + teeth;
    },

    // Loki's helm: a gold cowl open at the face, and the two long horns sweeping out of the
    // temples, up and back, to fine points. Drawn in a 200×260 box.
    lokiHelm(gold) {
      const half = `<path d='M100 92 C66 92 44 114 42 148 L40 250 L60 256 L62 172 C64 146 80 132 100 132 Z' fill='url(#lh)' fill-opacity='.4' stroke='${gold}' stroke-opacity='.7' stroke-width='1.5'/>` +
        `<path d='M60 124 C24 116 -4 84 -2 10 C14 60 42 86 80 100 Z' fill='url(#lh)' fill-opacity='.48' stroke='${gold}' stroke-opacity='.75' stroke-width='1.5'/>` +
        `<path d='M4 32 C14 70 40 90 66 102' fill='none' stroke='#fff3c0' stroke-opacity='.45' stroke-width='1.2'/>` +
        `<path d='M100 92 V114 M74 104 C84 112 92 114 100 114' fill='none' stroke='${gold}' stroke-opacity='.4'/>` +
        `<path d='M54 150 L52 240' stroke='#fff3c0' stroke-opacity='.3'/>`;
      return sym(half);
    },

    // Magneto's helm: the domed crown, the ridge down to the brow, cheek guards notched.
    magnetoHelm(c, dark) {
      const half = `<path d='M100 6 C58 6 30 40 28 90 L26 170 L48 196 L56 150 C58 128 70 116 84 112 L100 128 Z' fill='${dark}' fill-opacity='.2' stroke='${c}' stroke-opacity='.65' stroke-width='1.6'/>` +
        `<path d='M100 6 C88 30 86 70 92 110' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.3'/>` +
        `<path d='M38 84 C54 70 74 66 90 70' fill='none' stroke='${c}' stroke-opacity='.4' stroke-width='1.2'/>` +
        `<path d='M40 180 L30 196 M36 150 L28 160' stroke='${c}' stroke-opacity='.45' stroke-width='1.4'/>`;
      return sym(half) + `<path d='M60 24 C80 12 120 12 140 24' fill='none' stroke='#ffffff' stroke-opacity='.3' stroke-width='2.5' stroke-linecap='round'/>`;
    },

    // Hela's headdress: black antler-blades swept outward and up off a pointed brow-piece,
    // over the pale shape of her face.
    helaCrown(c, glow) {
      let b = '';
      for (let i = 0; i < 6; i++) {
        const bx = 84 - i * 6, by = 118 + i * 8, a = (-112 - i * 13) * Math.PI / 180, L = 170 - i * 12;
        const tx = bx + Math.cos(a) * L, ty = by + Math.sin(a) * L;
        const mx = (bx + tx) / 2 + Math.sin(a) * 26, my = (by + ty) / 2 - Math.cos(a) * 26;
        b += `<path d='M${bx - 8} ${by + 4} Q${f1(mx - 6)} ${f1(my + 4)} ${f1(tx)} ${f1(ty)} Q${f1(mx + 6)} ${f1(my - 4)} ${bx + 8} ${by - 4} Z' fill='url(#hc)' fill-opacity='.6' stroke='${glow}' stroke-opacity='.55' stroke-width='1.2' stroke-linejoin='round'/>`;
      }
      b += `<path d='M100 96 L66 118 L56 150 C72 140 88 138 100 140 Z' fill='url(#hc)' fill-opacity='.7' stroke='${glow}' stroke-opacity='.6'/>`;
      b += `<path d='M100 140 C80 140 66 152 64 176 C64 206 82 228 100 232 Z' fill='#dfe8e2' fill-opacity='.08' stroke='#dfe8e2' stroke-opacity='.3'/>`;
      b += `<path d='M72 176 C80 170 88 170 94 176' fill='none' stroke='${glow}' stroke-opacity='.6' stroke-width='2'/>`;
      return sym(b);
    },

    // Doom's mask: riveted iron with a brow ridge, slit eyes, the barred mouth, cheek plates,
    // framed by the green hood. Drawn in a 200×240 box.
    doomMask(iron, hood) {
      const half = `<path d='M100 0 C46 0 10 40 8 110 L6 240 L44 232 L48 120 C50 80 70 58 100 56 Z' fill='${hood}' fill-opacity='.3' stroke='${hood}' stroke-opacity='.6' stroke-width='1.4'/>` +
        `<path d='M100 60 C76 60 58 68 56 90 L56 150 C58 176 68 196 84 208 L100 214 Z' fill='url(#dm)' fill-opacity='.42' stroke='${iron}' stroke-opacity='.7' stroke-width='1.6'/>` +
        `<path d='M58 96 C70 88 86 90 97 98' fill='none' stroke='${iron}' stroke-opacity='.65' stroke-width='2.2'/>` +
        `<polygon points='64,104 93,106 93,114 66,112' fill='#000000' fill-opacity='.8' stroke='${iron}' stroke-opacity='.6'/>` +
        `<path d='M58 128 L78 150 L80 186 M100 98 L93 140 L100 146' fill='none' stroke='${iron}' stroke-opacity='.45' stroke-width='1.3'/>` +
        [[62, 160], [62, 176], [67, 192], [60, 80]].map(([x, y]) => `<circle cx='${x}' cy='${y}' r='2.4' fill='${iron}' fill-opacity='.7'/>`).join('');
      let mouth = `<rect x='74' y='166' width='52' height='13' fill='#000000' fill-opacity='.7' stroke='${iron}' stroke-opacity='.55'/>`;
      for (let x = 80; x < 126; x += 6.5) mouth += line(x, 166, x, 179, iron, 0.55, 1.2);
      return sym(half) + mouth;
    },

    // The sling-ring mandala Strange conjures: rings of runes, two squares turned into a star.
    mandala(c) {
      const r = rng(17);
      let b = '';
      [[190, 2], [176, 1], [150, 1.4], [96, 1.2], [70, 2]].forEach(([R, w]) => { b += `<circle cx='200' cy='200' r='${R}' fill='none' stroke='${c}' stroke-opacity='.5' stroke-width='${w}'/>`; });
      for (let i = 0; i < 64; i++) { const a = i / 64 * Math.PI * 2, x = 200 + 183 * Math.cos(a), y = 200 + 183 * Math.sin(a); b += `<path d='M${f1(x - 3)} ${f1(y - 3)} l${f1(r() * 6)} ${f1(r() * 6)} m-4 0 l${f1(r() * 5)} -2' stroke='${c}' stroke-opacity='.45' stroke-width='1' transform='rotate(${f1(a * 57.3 + 90)} ${f1(x)} ${f1(y)})'/>`; }
      for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; b += line(200 + 150 * Math.cos(a), 200 + 150 * Math.sin(a), 200 + 176 * Math.cos(a), 200 + 176 * Math.sin(a), c, 0.4, 1); }
      b += `<rect x='94' y='94' width='212' height='212' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.5'/><rect x='94' y='94' width='212' height='212' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.5' transform='rotate(45 200 200)'/>`;
      b += `<polygon points='${starPts(200, 200, 66, 30, 8)}' fill='${c}' fill-opacity='.08' stroke='${c}' stroke-opacity='.5'/>`;
      return b;
    },

    // The Eye of Agamotto: a gold casing shaped like an eye, the green stone inside.
    agamotto(gold, stone) {
      return `<path d='M10 60 C40 20 120 20 150 60 C120 100 40 100 10 60 Z' fill='url(#ag)' fill-opacity='.4' stroke='${gold}' stroke-opacity='.75' stroke-width='2'/>` +
        `<path d='M30 60 C52 36 108 36 130 60 C108 84 52 84 30 60 Z' fill='none' stroke='${gold}' stroke-opacity='.5'/>` +
        `<circle cx='80' cy='60' r='18' fill='${stone}' fill-opacity='.6' filter='url(#b)'/><circle cx='80' cy='60' r='12' fill='${stone}' fill-opacity='.85'/>` +
        `<path d='M80 18 V4 M80 102 V116' stroke='${gold}' stroke-opacity='.6' stroke-width='3'/>`;
    },

    // Three adamantium claws out of a fist's knuckles, shaded like polished steel.
    claws(steel) {
      let b = '';
      [[0, 0], [34, 10], [68, 24]].forEach(([dx, dy], i) => {
        b += `<g transform='translate(${40 + dx} ${300 + dy}) rotate(${-28 + i * 4})'>` +
          `<path d='M-9 0 C-10 -120 -4 -220 6 -290 C12 -220 12 -120 9 0 Z' fill='url(#cl)' fill-opacity='.55' stroke='${steel}' stroke-opacity='.75' stroke-width='1.2'/>` +
          `<path d='M-2 -10 C-2 -120 2 -210 5 -270' fill='none' stroke='#ffffff' stroke-opacity='.55' stroke-width='1.2'/></g>`;
      });
      return b;
    },

    // Deadpool's mask: red, the black patches, the white eyes narrowed.
    deadpoolMask(red, white) {
      const half = `<path d='M100 6 C48 6 20 46 20 100 C20 156 54 196 100 200 Z' fill='${red}' fill-opacity='.22' stroke='${red}' stroke-opacity='.6' stroke-width='1.6'/>` +
        `<path d='M96 72 C70 58 38 64 30 90 C26 112 46 128 70 124 C88 120 98 100 96 72 Z' fill='#000000' fill-opacity='.6' stroke='${red}' stroke-opacity='.45'/>` +
        `<path d='M86 92 C74 84 52 86 44 98 C54 106 76 106 86 92 Z' fill='${white}' fill-opacity='.8'/>`;
      return sym(half) + `<path d='M100 20 V190' stroke='#000000' stroke-opacity='.3' stroke-width='1.5'/><path d='M60 22 C80 12 120 12 140 22' fill='none' stroke='#ffffff' stroke-opacity='.3' stroke-width='2.5' stroke-linecap='round'/>`;
    },

    // Star-Lord's mask: silver ribbed plates and the two red eyes.
    starlordMask(silver, eye) {
      const half = `<path d='M100 10 C56 10 30 44 30 96 C30 150 56 196 100 206 Z' fill='${silver}' fill-opacity='.1' stroke='${silver}' stroke-opacity='.55' stroke-width='1.6'/>` +
        `<path d='M94 88 C74 76 46 80 40 102 C36 120 52 132 72 128 C90 124 98 106 94 88 Z' fill='${eye}' fill-opacity='.7' stroke='${silver}' stroke-opacity='.6' stroke-width='1.5'/>` +
        `<path d='M40 150 C56 170 76 180 100 182 M36 128 C50 160 70 176 100 190' fill='none' stroke='${silver}' stroke-opacity='.4' stroke-width='1.2'/>` +
        `<path d='M100 30 C80 34 62 46 52 66' fill='none' stroke='${silver}' stroke-opacity='.4' stroke-width='1.2'/>`;
      return sym(half) + `<g filter='url(#b)'>${sym(`<ellipse cx='68' cy='104' rx='20' ry='16' fill='${eye}' fill-opacity='.6'/>`)}</g>`;
    },

    // A skull: cranium, brow, sockets, cheekbones, the nasal notch, a row of teeth.
    skull(bone, socket) {
      return `<path d='M100 14 C52 14 22 48 22 94 C22 124 36 144 50 154 L54 186 C54 196 64 202 74 200 L126 200 C136 202 146 196 146 186 L150 154 C164 144 178 124 178 94 C178 48 148 14 100 14 Z' fill='${bone}' fill-opacity='.14' stroke='${bone}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M44 104 C46 84 64 76 84 84 C92 90 90 116 76 124 C60 132 44 124 44 104 Z' fill='${socket}' fill-opacity='.55' stroke='${bone}' stroke-opacity='.5' stroke-width='1.5'/>` +
        `<path d='M156 104 C154 84 136 76 116 84 C108 90 110 116 124 124 C140 132 156 124 156 104 Z' fill='${socket}' fill-opacity='.55' stroke='${bone}' stroke-opacity='.5' stroke-width='1.5'/>` +
        `<path d='M100 128 L90 150 C94 156 106 156 110 150 Z' fill='${socket}' fill-opacity='.5' stroke='${bone}' stroke-opacity='.45'/>` +
        `<path d='M40 70 C60 58 80 62 96 72 M160 70 C140 58 120 62 104 72' fill='none' stroke='${bone}' stroke-opacity='.35' stroke-width='2'/>` +
        `<path d='M58 158 C74 166 126 166 142 158' fill='none' stroke='${bone}' stroke-opacity='.4' stroke-width='1.5'/>` +
        [66, 78, 90, 102, 114, 126].map(x => `<path d='M${x} 164 L${x} 186 C${x} 190 ${x + 10} 190 ${x + 10} 186 L${x + 10} 164' fill='${bone}' fill-opacity='.2' stroke='${bone}' stroke-opacity='.5' stroke-width='1.2'/>`).join('');
    },
  };

  // A drawn piece with a soft glow behind it, as a CSS image.
  const glowArt = (w, h, body, defs = '', s = 4, go = 0.35) => art(w, h, `<g filter='url(#b)' opacity='${go}'>${body}</g>${body}`, s, defs);
  // A nebula: noise clouds in two or three colours, each confined to its own soft region.
  function nebula(w, h, seed, clouds) {
    let defs = '', body = '';
    clouds.forEach(([c, cx, cy, r, k = 2.4, o = -1], i) => {
      defs += cloudF('n' + i, 0.004 + i * 0.0015, 5, seed + i * 7, c, k, o) + fadeMask('m' + i, w, h, cx * w, cy * h, r * Math.max(w, h), 0.1);
      body += `<g mask='url(#m${i})'><rect width='${w}' height='${h}' fill='#fff' filter='url(#n${i})'/></g>`;
    });
    return svg(w, h, `<defs>${defs}</defs>${body}`);
  }
  // A real orb-web: spokes out of a corner, each ring sagging between the spokes it joins.
  function orbWeb(c, R = 520, spokes = 11, rings = 12) {
    const ang = Array.from({ length: spokes }, (_, i) => (i / (spokes - 1)) * Math.PI / 2);
    let b = ang.map(a => line(0, 0, R * Math.cos(a), R * Math.sin(a), c, 0.4, 1.1)).join('');
    for (let k = 1; k <= rings; k++) {
      const r = k * R / (rings + 0.5) * (1 + (k % 2) * 0.02);
      let d = `M${f1(r * Math.cos(ang[0]))} ${f1(r * Math.sin(ang[0]))}`;
      for (let i = 1; i < spokes; i++) {
        const a0 = ang[i - 1], a1 = ang[i], am = (a0 + a1) / 2, rm = r * 0.9;
        d += ` Q${f1(rm * Math.cos(am))} ${f1(rm * Math.sin(am))} ${f1(r * Math.cos(a1))} ${f1(r * Math.sin(a1))}`;
      }
      b += `<path d='${d}' fill='none' stroke='${c}' stroke-opacity='${f1(0.42 - k * 0.018)}' stroke-width='1'/>`;
    }
    return b;
  }

  // A sparse, tiled star field; the occasional star gets four points.
  const starfield = (c) => `${svg(240, 240, scatter(1234, 22, 240, 240).map(([x, y, r]) => r > 0.9
    ? `<polygon points='${starPts(x, y, 3.5, 0.8, 4)}' fill='${c}' fill-opacity='.6'/>`
    : `<circle cx='${x}' cy='${y}' r='${f1(0.4 + r * 0.7)}' fill='${c}' fill-opacity='${f1(0.2 + r * 0.4)}'/>`).join(''))} 0 0 / 240px 240px repeat`;

  // ---------- scenes ----------
  // One composition per character where the art above is the subject.
  const SCENE = {
    ironman() {
      const defs = metalG('fp', '#fbe3a0', '#d8a94a', '#7a5a1a', 0.3, 1) + metalG('sh', '#e86a5a', '#b8352e', '#4a0e0c', 0.6, 1);
      return [
        M.reactor('#8fe3ff', '#d8a94a', '#b8352e'),
        layer([put(glowArt(200, 240, ART.ironHelmet('#d8483e', '#e0b050', '#bff4ff'), defs, 5), 'right 40px bottom 30px', 250, 300), rg('#b8352e', '100% 100%', '45% 50%', 0.14), SIG.ironmanHud('#8fe3ff').bg]),
      ];
    },
    cap() {
      const defs = `<radialGradient id='sn' cx='.3' cy='.25' r='.9'><stop offset='0' stop-color='#ffffff' stop-opacity='.22'/><stop offset='.5' stop-color='#ffffff' stop-opacity='0'/><stop offset='1' stop-color='#000000' stop-opacity='.3'/></radialGradient>`;
      return [
        layer([put(glowArt(300, 300, ART.capShield('#c8434c', '#e8ecf4', '#3f64b8'), defs, 5, 0.3), 'right -60px bottom -60px', 380, 380), rg('#3f64b8', '100% 100%', '45% 50%', 0.14)]),
        SIG.starsStripes('#c0414a', '#e8ecf4'),
      ];
    },
    hulk() {
      const haze = cloudF('gh', '0.007 0.012', 4, 5, '#7fd05a', 2.4, -1.05) + fadeMask('fm', 1400, 420, 700, 470, 620, 0.15);
      return [SIG.smash('#7fd05a', '#e0ffd0'),
        layer([`${svg(1400, 420, `<defs>${haze}</defs><g mask='url(#fm)'><rect width='1400' height='420' fill='#fff' filter='url(#gh)'/></g>`)} 50% 100% / 1400px 420px no-repeat`, M.gamma('#7fd05a').bg], M.gamma('#7fd05a').mask)];
    },
    killmonger() {
      return [
        layer([put(glowArt(200, 220, ART.pantherMask('#e8c060', '#ffe9a0'), '', 4, 0.35), 'right 40px bottom 40px', 240, 264), rg('#d2ac3c', '100% 100%', '40% 45%', 0.14)]),
        SIG.fangNecklace('#d2ac3c', '#ffe39a'),
      ];
    },
    thor() { return [SIG.mjolnir('#c8d0dc', '#dfe9ff', '#6f9ee0'), SIG.bifrost()]; },
    panther() {
      return [
        layer([put(glowArt(200, 220, ART.pantherMask('#c3c6d4', '#e8e4ff'), '', 4, 0.3), 'right 40px bottom 40px', 240, 264), SIG.kinetic('#b99cff', '#e0d4ff').bg]),
        SIG.wakanda('#c3c6d4'),
      ];
    },
    marvel() {
      const defs = metalG('gs', '#fff1c4', '#e2bd4c', '#8a6a1a', 1, 1);
      return [
        layer([put(glowArt(200, 200, ART.marvelStar('#f0cc60'), defs, 6, 0.5), 'right 50px bottom 40px', 230, 230), `${nebula(900, 500, 3, [['#e2bd4c', 0.5, 0, 0.5], ['#c43a48', 0.9, 0.2, 0.4], ['#4f7ad8', 0.1, 0.2, 0.4]])} 50% 0 / 900px 500px no-repeat`]),
        M.rays('#ffd98a', '#fff1c4', '50% -4%', { alpha: 0.07 }),
      ];
    },
    antman() {
      return [
        layer([put(glowArt(200, 210, ART.antHelmet('#bd3a33', '#ff6a50', '#c8d0da'), '', 4, 0.3), 'right 40px bottom 40px', 230, 242), SIG.ants('#e0605a').bg]),
        layer([`${nebula(1000, 700, 8, [['#3aa8ff', 0.05, 0.05, 0.45, 3.2, -1.15], ['#ff3ac0', 0.3, 0.0, 0.4, 3.2, -1.15], ['#ffa030', 0.0, 0.4, 0.35, 3.2, -1.15]])} left top / 1000px 700px no-repeat`], 'radial-gradient(ellipse 60% 70% at 0 0, #000 30%, transparent 100%)'),
      ];
    },
    starlord() {
      return [
        layer([put(glowArt(200, 210, ART.starlordMask('#c8ccd6', '#ff3a30'), '', 4, 0.3), 'right 40px bottom 40px', 220, 231), SIG.mixtape('#e07a3a', '#ffc27a', false).bg]),
        layer([`${nebula(1200, 800, 21, [['#c35a31', 0.0, 0.0, 0.5, 2.2, -1.05], ['#6fb3de', 1, 0.1, 0.45, 2.2, -1.05], ['#a060d0', 0.2, 1, 0.4, 2.2, -1.05]])} center / 1200px 800px no-repeat`, starfield('#ffffff')]),
      ];
    },
    surfer() {
      return [SIG.surfboard('#dfe8f5', '#9fc4ff'),
        layer([`${nebula(1200, 800, 33, [['#6f9fe0', 0.0, 1.0, 0.5], ['#b4c1d6', 1, 0.9, 0.4], ['#8060d0', 0.1, 0.0, 0.35]])} center / 1200px 800px no-repeat`, SIG.warp('#dfe8ff').bg], SIG.warp('#dfe8ff').mask)];
    },
    storm() {
      const r = rng(14);
      const bolts = [jag(420, 150, 330, 520, 10, 18, r), jag(420, 150, 560, 460, 8, 14, r)].map(p => poly(p, '#9fc4ff', 0.35, 7) + poly(p, '#ffffff', 0.55, 1.4)).join('');
      const defs = cloudF('c1', '0.005 0.009', 5, 12, '#b8c2d8', 2.2, -1.05) + fadeMask('fm', 900, 560, 360, 40, 420, 0.1);
      const img = art(900, 560, `<g mask='url(#fm)'><rect width='900' height='560' fill='#fff' filter='url(#c1)'/></g><g filter='url(#b)'>${bolts}</g>${bolts}`, 5, defs);
      return [layer([put(img, 'left -120px top -40px', 900, 560)]), SIG.wind('#e8f0ff')];
    },
    wanda() {
      const defs = cloudF('ch', '0.009 0.006', 4, 7, '#ff3a60', 3, -1.35) + fadeMask('fm', 1400, 700, 700, 760, 820, 0.2);
      return [SIG.tiara('#c43250', '#ff4f7a'),
        layer([`${svg(1400, 700, `<defs>${defs}${warpF('w', 0.01, 0.01, 2, 3, 80)}</defs><g mask='url(#fm)' filter='url(#w)'><rect width='1400' height='700' fill='#fff' filter='url(#ch)'/></g>`)} 50% 100% / 1400px 700px no-repeat`, SIG.chaos('#ff4f7a', '#e0648e').bg], 'linear-gradient(0deg, #000 0, rgba(0,0,0,.45) 22%, transparent 45%)')];
    },
    venom() {
      return [
        layer([put(glowArt(200, 250, ART.venomFace('#f0f2f6', '#c0343c', '#8a90a0'), '', 5, 0.3), 'right 40px bottom 20px', 260, 325), rg('#c0343c', '100% 110%', '40% 35%', 0.12)]),
        SIG.goo('#e8ecf4'),
      ];
    },
    punisher() {
      return [layer([put(glowArt(200, 250, ART.punisherSkull('#eceef4'), '', 4, 0.3), 'right 50px bottom 30px', 220, 275)]), SIG.bulletHoles('#e8e8ee')];
    },
    deadpool() {
      return [
        layer([put(glowArt(200, 210, ART.deadpoolMask('#e03a3a', '#ffffff'), '', 4, 0.3), 'right 50px bottom 40px', 220, 231), M.katanas('#e8ecf4', '#ff5555').bg]),
        SIG.bubble('#f0f0f4'),
      ];
    },
    loki() {
      const defs = metalG('lh', '#fff0b0', '#d2ae40', '#6a5010', 0.7, 1);
      return [
        layer([put(glowArt(240, 262, `<g transform='translate(20 0)'>${ART.lokiHelm('#e2c050')}</g>`, defs, 5, 0.35), 'left 30px bottom 20px', 240, 262), rg('#e2c050', '0% 100%', '40% 40%', 0.1)]),
        SIG.sceptre('#e2c050', '#7fd0ff', '#3f9a5a'),
      ];
    },
    magneto() {
      return [M.field('#d65a8a', '#9a7ae0'),
        layer([put(glowArt(200, 200, ART.magnetoHelm('#e0709a', '#a42c4c'), '', 4, 0.3), 'right 40px bottom 40px', 240, 240), rg('#a42c4c', '100% 100%', '40% 45%', 0.14)])];
    },
    hela() {
      return [
        layer([put(glowArt(200, 240, ART.helaCrown('#1e3a2a', '#8fe0b0'), `<linearGradient id='hc' x1='0' y1='1' x2='0' y2='0'><stop offset='0' stop-color='#0c1a12'/><stop offset='1' stop-color='#3a8c5c'/></linearGradient>`, 4, 0.4), 'right 30px bottom 20px', 300, 360), rg('#3a8c5c', '100% 100%', '45% 45%', 0.14)]),
        SIG.necroswords('#b8f0cc', '#3a8c5c'),
      ];
    },
    redskull() {
      return [SIG.tesseract('#7fd0ff', '#c02c2c'),
        layer([put(glowArt(200, 210, ART.skull('#e05050', '#200606'), '', 4, 0.3), 'left 40px bottom 40px', 200, 210), rg('#c02c2c', '0% 100%', '40% 45%', 0.12)])];
    },
    doom() {
      const defs = metalG('dm', '#e8ece6', '#9aa49c', '#3a403c', 0.5, 1);
      const mist = cloudF('mi', '0.006 0.012', 4, 9, '#78c85a', 2.6, -1.1) + fadeMask('fm', 1400, 400, 700, 460, 700, 0.1);
      return [
        layer([put(glowArt(200, 230, ART.doomMask('#c8d0c8', '#2f5a28'), defs, 4, 0.3), 'right 40px bottom 30px', 240, 276), rg('#c2a24a', '88% -4%', '30% 30%', 0.1)]),
        layer([`${svg(1400, 400, `<defs>${mist}</defs><g mask='url(#fm)'><rect width='1400' height='400' fill='#fff' filter='url(#mi)'/></g>`)} 50% 100% / 1400px 400px no-repeat`], 'linear-gradient(0deg, #000 0, rgba(0,0,0,.5) 18%, transparent 38%)'),
      ];
    },
    strange() {
      const defs = metalG('ag', '#fff0b0', '#d8a850', '#6a4a10', 1, 1);
      return [
        layer([put(glowArt(400, 400, ART.mandala('#f0a850'), '', 4, 0.45), 'right -120px top -80px', 460, 460), rg('#e0a458', '100% 0%', '40% 45%', 0.14)]),
        layer([put(glowArt(160, 120, ART.agamotto('#e0b060', '#4fe08a'), defs, 4, 0.4), 'left 40px bottom 40px', 160, 120), rg('#b8364a', '0% 100%', '50% 55%', 0.14)]),
      ];
    },
    spider(rev) {
      const glowC = rev ? '#3f6fd1' : '#c73a44';
      const spider = `<ellipse cx='100' cy='70' rx='14' ry='20' fill='#e8ebf4' fill-opacity='.35'/><ellipse cx='100' cy='118' rx='18' ry='32' fill='#e8ebf4' fill-opacity='.3'/>` +
        sym(`<path d='M88 64 L60 30 L54 2 M88 76 L52 60 L30 40 M88 108 L50 124 L28 160 M88 124 L62 156 L56 196' fill='none' stroke='#e8ebf4' stroke-opacity='.45' stroke-width='3' stroke-linejoin='round' stroke-linecap='round'/>`);
      return [
        layer([put(art(560, 560, lit(orbWeb('#c8d2ee')), 1.5), 'left top', 560, 560), rg(glowC, '0% 0%', '40% 45%', 0.14)]),
        layer([put(glowArt(200, 200, spider, '', 3, 0.3), 'right 50px bottom 40px', 180, 180)]),
      ];
    },
    wolverine() {
      const defs = metalG('cl', '#ffffff', '#c8d4e4', '#5a6474', 1, 0.2);
      return [
        layer([put(glowArt(200, 330, ART.claws('#dfe8f4'), defs, 4, 0.3), 'right 30px bottom 0', 220, 363), rg('#e0b43a', '100% 100%', '40% 45%', 0.12)]),
        layer([SIG.slashes('#dfe8f4', '#e0b43a').bg, rg('#5a7fd0', '0% 100%', '45% 50%', 0.14)]),
      ];
    },
    vision() {
      const facets = `<polygon points='60,10 100,0 140,10 150,40 100,70 50,40' fill='url(#gv)' fill-opacity='.7' stroke='#fff6c0' stroke-opacity='.8'/>` +
        `<path d='M60 10 L80 40 L100 0 L120 40 L140 10 M50 40 H150 M80 40 L100 70 L120 40' fill='none' stroke='#fff6c0' stroke-opacity='.55'/>`;
      const defs = `<linearGradient id='gv' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff6c0'/><stop offset='1' stop-color='#e8b83a'/></linearGradient>`;
      return [
        layer([put(glowArt(200, 80, facets, defs, 8, 0.8), '50% 8px', 120, 48), rg('#6cc394', '50% -6%', '65% 40%', 0.12), rg('#c24b56', '50% 115%', '60% 40%', 0.1)]),
        M.rays('#e8cc5a', '#fff6c0', '50% 2%', { alpha: 0.06 }),
      ];
    },
  };

  const SIG = {
    // Three claw marks raked across the top-right: a steel cut with a hot edge, fading out.
    slashes(steel, hot) {
      let b = '';
      [0, 34, 68].forEach((o, i) => {
        const d = `M${260 + o} 20 C${200 + o} 120 ${130 + o} 220 ${60 + o} ${300 - i * 10}`;
        b += `<path d='${d}' fill='none' stroke='${hot}' stroke-opacity='.14' stroke-width='8' stroke-linecap='round'/><path d='${d}' fill='none' stroke='${steel}' stroke-opacity='.35' stroke-width='1.8' stroke-linecap='round'/>`;
      });
      return layer([put(art(360, 340, lit(b), 4), 'right 60px top 60px', 360, 340)]);
    },

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

    // Mjolnir in the top-right under a storm: noise-built thunderheads, lightning forking
    // out of the cloud and off the hammer's head.
    mjolnir(steel, bolt, glow) {
      const r = rng(11);
      let bolts = '';
      [[250, 190, 120, 440, 6], [250, 190, 60, 60, 5], [250, 190, 470, 450, 6], [640, 40, 560, 280, 5]].forEach(([x1, y1, x2, y2, n]) => {
        const p = jag(x1, y1, x2, y2, n * 2, 14, r);
        bolts += poly(p, glow, 0.3, 7) + poly(p, bolt, 0.45, 1.8) + poly(p, '#ffffff', 0.45, 0.7);
      });
      const defs = cloudF('cl', '0.006 0.012', 5, 4, mix(glow, '#8a93a8', 0.6), 2.6, -1.05) + fadeMask('fm', 700, 460, 520, 0, 520, 0.2) + metalG('hm', '#eef3fa', steel, mix(steel, '#000000', 0.5), 0.6, 1);
      const img = art(700, 460, `<g mask='url(#fm)'><rect width='700' height='300' filter='url(#cl)' fill='#fff'/></g>` +
        `<g filter='url(#b)'>${bolts}</g>${bolts}<g transform='translate(290 70) scale(.8)'>${lit(ART.mjolnir(steel, '#a8805a'))}</g>`, 4, defs);
      return layer([put(img, 'right 0 top 0', 700, 460), rg(glow, '100% 0%', '45% 50%', 0.12)]);
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
        cracks += poly(jag(500, 330, x2, y2, 7, 14, r), glow, 0.22, 5);
        const mx = 500 + Math.cos(a) * len * 0.5, my = 330 + Math.sin(a) * len * 0.5, b = a + (r() - 0.5) * 1.2;
        cracks += poly(jag(mx, my, mx + Math.cos(b) * len * 0.35, my + Math.sin(b) * len * 0.35, 4, 8, r), glow, 0.16, 3);
      }
      const coreLines = cracks.replace(new RegExp(`stroke='${glow}'`, 'g'), `stroke='${core}'`).replace(/stroke-width='[35]'/g, "stroke-width='1.1'").replace(/stroke-opacity='0\.(22|16)'/g, "stroke-opacity='0.3'");
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

    // Falcon's wings spread from the top-left: carbon feathers fanned on a steel frame, red
    // tips; Redwing crossing the top-right on a red trail.
    falconWings(steel, red) {
      let f = '';
      for (let i = 0; i < 12; i++) {
        const a = 4 + i * 7.5, len = 240 + Math.sin(i / 11 * Math.PI) * 110;
        f += `<g transform='rotate(${f1(a)})'><path d='M24 -10 L${f1(len)} -7 L${f1(len + 34)} 0 L${f1(len)} 8 L24 10 Z' fill='url(#fw)' fill-opacity='.4' stroke='${steel}' stroke-opacity='.55' stroke-width='1.1'/>` +
          line(34, 0, len + 20, 0, '#ffffff', 0.3, 0.8) + `<path d='M${f1(len - 30)} -7 L${f1(len)} -7 L${f1(len + 34)} 0 L${f1(len)} 8 L${f1(len - 30)} 8 Z' fill='${red}' fill-opacity='.45'/></g>`;
      }
      f += `<circle cx='20' cy='20' r='26' fill='${steel}' fill-opacity='.2' stroke='${steel}' stroke-opacity='.6' stroke-width='2'/>`;
      const tr = `<linearGradient id='t' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='${red}' stop-opacity='0'/><stop offset='1' stop-color='${red}' stop-opacity='.55'/></linearGradient>` + metalG('fw', '#ffffff', steel, mix(steel, '#000000', 0.55), 1, 0.2);
      const drone = `<path d='M20 190 C160 160 300 70 456 76' fill='none' stroke='url(#t)' stroke-width='3'/>` +
        `<polygon points='${pts([[486, 74], [450, 60], [458, 76], [450, 92]])}' fill='${red}' fill-opacity='.5' stroke='${red}' stroke-opacity='.8'/><circle cx='470' cy='76' r='3' fill='#ffffff' fill-opacity='.9'/>`;
      return layer([put(art(480, 480, lit(f), 3, tr), 'left 0 top 40px', 480, 480), put(art(520, 220, lit(drone), 4, tr), 'right 10px top 70px', 520, 220)]);
    },

    // An equaliser dancing along the bottom edge, the Awesome Mix in the corner.
    mixtape(orange, gold, withTape = true) {
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
      return layer([`${art(240, 150, lit(bars), 2.5, q)} 0 100% / 240px 150px repeat-x`, withTape && put(art(240, 150, lit(tape), 3), 'right 24px bottom 24px', 240, 150)]);
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

    // The Phoenix Force: a firebird with its wings raised, its body and tail made of flame —
    // the silhouette is filled with a fire ramp and torn by noise, so it burns rather than
    // being outlined.
    firebird(flame, gold) {
      // Leading edge out to the tip, then back along a trailing edge of feather points.
      const wingPts = [[392, 236], [330, 170], [230, 108], [120, 52], [30, 14], [70, 96], [104, 84], [128, 150], [168, 136], [196, 200], [234, 186], [262, 244], [300, 232], [330, 280], [364, 270], [396, 300]];
      const wing = 'M' + wingPts.map(([x, y]) => `${x} ${y}`).join(' L') + ' Z';
      const bird = `<path d='${wing}'/><path d='${wing}' transform='translate(800 0) scale(-1 1)'/>` +
        `<path d='M400 170 C420 170 432 190 428 214 L440 250 C440 300 424 330 400 420 C376 330 360 300 360 250 L372 214 C368 190 380 170 400 170 Z'/>` +
        `<path d='M400 330 C380 400 330 440 300 470 C350 450 380 430 400 400 C420 430 450 450 500 470 C470 440 420 400 400 330 Z'/>`;
      const defs = `<linearGradient id='pg' x1='0' y1='1' x2='0' y2='0'><stop offset='0' stop-color='${flame}' stop-opacity='.2'/><stop offset='.5' stop-color='${flame}' stop-opacity='.5'/><stop offset='.85' stop-color='${gold}' stop-opacity='.6'/><stop offset='1' stop-color='#fff4c8' stop-opacity='.7'/></linearGradient>` +
        warpF('pw', 0.03, 0.06, 2, 6, 12) + blur('pb', 14);
      const body = `<g fill='url(#pg)'>${bird}</g>`;
      const img = svg(800, 480, `<defs>${defs}</defs><g filter='url(#pb)' opacity='.8'>${body}</g><g filter='url(#pw)'>${body}</g><circle cx='400' cy='196' r='6' fill='#ffffff' fill-opacity='.8'/>`);
      return layer([put(img, '50% 20px', 720, 432), rg(gold, '50% 0%', '45% 35%', 0.14)]);
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

    // Flame on: fire climbing the right edge of the window, sparks thrown off it.
    flameComet(flame, gold) {
      const f = fireBody(520, 620, 23, ['#fff4c8', gold, flame], { heat: 1, count: 9, id: 'tc' });
      const r = rng(31);
      let sparks = '';
      for (let i = 0; i < 40; i++) sparks += `<circle cx='${f1(80 + r() * 440)}' cy='${f1(r() * 420)}' r='${f1(0.8 + r() * 1.8)}' fill='${gold}' fill-opacity='${f1(0.25 + r() * 0.45)}'/>`;
      return layer([put(art(520, 620, f.art + sparks, 4, f.defs), 'right -60px bottom 0', 520, 620), rg(flame, '100% 100%', '50% 55%', 0.16)]);
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

    // A speech bubble, because he would.
    bubble(c) {
      const b = `<path d='M16 12 H204 A12 12 0 0 1 216 24 V84 A12 12 0 0 1 204 96 H70 L40 122 L46 96 H16 A12 12 0 0 1 4 84 V24 A12 12 0 0 1 16 12 Z' fill='${c}' fill-opacity='.05' stroke='${c}' stroke-opacity='.4' stroke-width='2'/>` +
        [80, 110, 140].map(x => `<circle cx='${x}' cy='54' r='6' fill='${c}' fill-opacity='.5'/>`).join('');
      return layer([put(art(220, 130, lit(b), 2), 'left 30px top 70%', 220, 130), rg('#c22c2c', '0% 0%', '40% 45%', 0.14)]);
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

    // Hellfire along the floor and the Rider's skull burning in the bottom-left corner.
    hellfire(bone) {
      const cols = ['#fff1b0', '#ff9a2a', '#d8401a'];
      const floor = fireBody(1400, 260, 5, cols, { heat: 0.8, id: 'ff' });
      const head = fireBody(300, 300, 9, cols, { heat: 1.1, count: 7, id: 'fh' });
      const skull = `<g transform='translate(50 140) scale(1)'>${ART.skull(bone, '#ff7a1a')}` +
        `<ellipse cx='64' cy='104' rx='14' ry='12' fill='#ffb040' fill-opacity='.5' filter='url(#b)'/><ellipse cx='136' cy='104' rx='14' ry='12' fill='#ffb040' fill-opacity='.5' filter='url(#b)'/></g>`;
      return layer([
        `${art(1400, 260, floor.art, 6, floor.defs)} 50% 100% / 1400px 260px repeat-x`,
        put(art(300, 360, `<g transform='translate(0 -10)'>${head.art}</g>${skull}`, 5, head.defs), 'left 30px bottom 40px', 300, 360),
        rg('#d8401a', '50% 115%', '80% 40%', 0.18),
      ]);
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

    // The metal arm down the left edge: overlapping plates, the red star on the shoulder.
    metalArm(steel, red) {
      let b = `<path d='M0 20 C80 0 150 20 180 70 C190 100 180 130 170 150 L0 160 Z' fill='url(#ma)' fill-opacity='.35' stroke='${steel}' stroke-opacity='.6' stroke-width='1.5'/>`;
      for (let i = 0; i < 9; i++) {
        const y = 150 + i * 52;
        b += `<path d='M0 ${y} C60 ${y - 10} 120 ${y - 4} 168 ${y + 8} L166 ${y + 56} C120 ${y + 46} 60 ${y + 50} 0 ${y + 60} Z' fill='url(#ma)' fill-opacity='.3' stroke='${steel}' stroke-opacity='.55' stroke-width='1.3'/>` +
          line(12, y + 6, 156, y + 12, '#ffffff', 0.25, 1);
      }
      b += `<polygon points='${starPts(92, 88, 38, 15, 5)}' fill='${red}' fill-opacity='.5' stroke='${red}' stroke-opacity='.85' stroke-width='1.5'/>`;
      return layer([put(art(200, 640, lit(b), 3, metalG('ma', '#ffffff', steel, mix(steel, '#000000', 0.6), 1, 0.3)), 'left -20px top 50px', 200, 640)]);
    },

    // The Infinity Gauntlet raised in the bottom-right, a violet haze behind it.
    gauntletHand(gold) {
      // Little, ring, middle, index, thumb, back of the hand: Soul, Reality, Space, Power, Time, Mind.
      const img = ART.gauntlet(gold, ['#f08a2a', '#e0303a', '#4f8cff', '#9a4fe0', '#3fd07a', '#f2d541']);
      return layer([put(img, 'right 10px bottom -60px', 378, 468), rg('#7d52b4', '100% 100%', '45% 55%', 0.16), rg(gold, '96% 92%', '22% 28%', 0.08)]);
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

    // Ultron's face: angular silver plates, eyes and mouth burning red, bottom-right.
    ultronEyes(red) {
      const half = `<path d='M100 8 L60 18 L34 56 L30 122 L44 170 L72 202 L100 210 Z' fill='#9aa4b0' fill-opacity='.14' stroke='#c8d0da' stroke-opacity='.55' stroke-width='1.6'/>` +
        `<path d='M50 100 L90 110 L86 120 L56 114 Z' fill='${red}' fill-opacity='.85'/>` +
        `<path d='M100 40 L80 60 L60 58 M36 90 L54 130 L60 170 M100 130 L92 150 L100 156 M48 150 L72 186' fill='none' stroke='#c8d0da' stroke-opacity='.4' stroke-width='1.2'/>` +
        `<path d='M68 174 L100 170 L100 180 L72 184 Z' fill='${red}' fill-opacity='.6'/>`;
      const glowEyes = sym(`<path d='M50 100 L90 110 L86 120 L56 114 Z' fill='${red}' fill-opacity='.9'/><path d='M68 174 L100 170 L100 180 L72 184 Z' fill='${red}' fill-opacity='.7'/>`);
      return layer([put(art(200, 220, `${sym(half)}<g filter='url(#b)'>${glowEyes}</g>`, 5), 'right 40px bottom 30px', 230, 253), rg(red, '100% 100%', '40% 45%', 0.12)]);
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

    // Four mechanical arms rising from the bottom-left: stacked armoured segments that narrow
    // toward three-fingered pincers, a red sensor at each tip.
    ockArms(steel, light) {
      let b = '';
      const arms = [[[0, 580], [120, 380], [60, 220], [240, 130]], [[0, 580], [210, 440], [270, 320], [420, 270]],
        [[0, 580], [50, 430], [-10, 310], [90, 170]], [[0, 580], [240, 540], [370, 500], [540, 440]]];
      const defs = `<radialGradient id='sg' cx='.35' cy='.3'><stop offset='0' stop-color='#ffffff' stop-opacity='.5'/><stop offset='.5' stop-color='${steel}' stop-opacity='.3'/><stop offset='1' stop-color='${mix(steel, '#000000', 0.6)}' stop-opacity='.4'/></radialGradient>`;
      arms.forEach(([p0, p1, p2, p3]) => {
        const at = (t) => { const u = 1 - t; return [0, 1].map(k => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]); };
        for (let i = 0; i <= 30; i++) { const [x, y] = at(i / 30), R = f1(17 - i * 0.28); b += `<circle cx='${f1(x)}' cy='${f1(y)}' r='${R}' fill='url(#sg)' stroke='${steel}' stroke-opacity='.5' stroke-width='1.1'/>`; }
        const [ex, ey] = at(1), [bx, by] = at(0.95), a = Math.atan2(ey - by, ex - bx);
        [-0.7, 0, 0.7].forEach(o => { b += `<path d='M${f1(ex)} ${f1(ey)} q${f1(Math.cos(a + o) * 24)} ${f1(Math.sin(a + o) * 24)} ${f1(Math.cos(a + o * 1.6) * 38)} ${f1(Math.sin(a + o * 1.6) * 38)}' fill='none' stroke='${steel}' stroke-opacity='.7' stroke-width='4' stroke-linecap='round'/>`; });
        b += `<circle cx='${f1(ex)}' cy='${f1(ey)}' r='9' fill='${light}' fill-opacity='.5' filter='url(#b)'/><circle cx='${f1(ex)}' cy='${f1(ey)}' r='4.5' fill='${light}' fill-opacity='.9'/>`;
      });
      return layer([put(art(640, 600, b, 4, defs), 'left -20px bottom -20px', 640, 600)]);
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

    // Dormammu: a head made of fire, two eyes burning white in it, over the right edge.
    dormammuFace(fire, core) {
      const f = fireBody(460, 560, 61, ['#fff0c0', '#ff9a3a', fire], { heat: 1.05, count: 8, id: 'dh' });
      const eye = (x) => `<path d='M${x - 44} 290 C${x - 20} 262 ${x + 20} 262 ${x + 44} 290 C${x + 20} 304 ${x - 20} 304 ${x - 44} 290 Z' fill='${core}' fill-opacity='.75'/>`;
      const eyes = eye(170) + eye(290) + `<path d='M170 400 C200 420 260 420 290 400' fill='none' stroke='${core}' stroke-opacity='.35' stroke-width='5' stroke-linecap='round'/>`;
      const defs = f.defs + fadeMask('hm', 460, 560, 250, 340, 250, 0.35);
      return layer([put(art(460, 560, `<g mask='url(#hm)'>${f.art}</g><g filter='url(#b)'>${eyes}${eyes}</g>${eyes}`, 5, defs), 'right -40px bottom -20px', 460, 560), rg(fire, '100% 100%', '50% 55%', 0.16)]);
    },
    // The Dark Dimension turning beneath everything.
    darkVortex(c) {
      let arms = '';
      for (let k = 0; k < 6; k++) { const p = spiral(400, 560, 20, 0.16, 1.9, k * Math.PI / 3, 0.55); arms += poly(p, c, 0.22, 10) + poly(p, c, 0.4, 1.4); }
      return layer([put(art(800, 520, `<g filter='url(#b)'>${arms}</g>${arms}`, 5), '50% 100%', 800, 520), rg(c, '50% 110%', '60% 35%', 0.16)]);
    },

    // Galactus's helm: the dome with its crest over a face in shadow, and the two tall fins
    // rising from the temples.
    galactusHelm(c, deep) {
      const half = `<path d='M100 60 C62 60 40 86 38 130 L36 250 L64 256 L66 160 C68 132 82 118 100 118 Z' fill='${deep}' fill-opacity='.3' stroke='${c}' stroke-opacity='.6' stroke-width='1.6'/>` +
        `<path d='M46 120 L20 118 L6 -4 L34 0 L52 96 Z' fill='${deep}' fill-opacity='.32' stroke='${c}' stroke-opacity='.65' stroke-width='1.6'/>` +
        `<path d='M26 108 L14 12' stroke='#ffffff' stroke-opacity='.3'/>` +
        `<path d='M100 70 L84 70 L74 96 L88 86 L100 104' fill='none' stroke='${c}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M100 118 C86 118 76 130 74 150 L74 210 C80 236 92 248 100 250 Z' fill='#000000' fill-opacity='.35'/>` +
        `<path d='M78 156 L96 160 L94 166 L80 163 Z' fill='${c}' fill-opacity='.8'/>`;
      return layer([put(art(200, 260, lit(sym(half)), 4), 'left 40px bottom 20px', 220, 286), rg(c, '0% 100%', '40% 45%', 0.14)]);
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
        b += poly(p, glow, 0.16, 6) + poly(p, c, 0.38, 1);
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

  // The translucent colour that, laid over `base`, gives exactly `target`: the smallest alpha
  // for which the needed colour still fits in 0–255. This is how a panel keeps its look while
  // the backdrop art shows through it (see the HERO SUIT THEMES block in 04-themes.css).
  function glass(target, base) {
    const T = hexRgb(target), B = hexRgb(base);
    let a = 0.02;
    T.forEach((t, i) => { const d = t - B[i]; if (d > 0) a = Math.max(a, d / (255 - B[i])); else if (d < 0) a = Math.max(a, -d / B[i]); });
    a = Math.min(1, a);
    const C = T.map((t, i) => Math.max(0, Math.min(255, Math.round(B[i] + (t - B[i]) / a))));
    return `rgba(${C.join(', ')}, ${Math.round(a * 1000) / 1000})`;
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
      '--hero-solid-bg': p.bg, '--hero-solid-panel': p.panel, '--hero-solid-raised': p.raised, '--hero-solid-shadow': p.shadow,
      '--hero-glass-panel': glass(p.panel, p.bg), '--hero-glass-raised': glass(p.raised, p.bg), '--hero-glass-shadow': glass(p.shadow, p.bg),
      '--hero-glass-added': glass(p.addedBg, p.bg), '--hero-glass-removed': glass(p.removedBg, p.bg),
      '--hero-frost-bg': rgba(p.bg, 0.86), '--hero-frost-panel': rgba(p.panel, 0.88), '--hero-frost-raised': rgba(p.raised, 0.9), '--hero-frost-shadow': rgba(p.shadow, 0.9),
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
  // The first six keep hand-tuned palettes; everything after derives its palette from three colours.
  const HERO_THEMES = [
    // Iron mask, forest-green cloak, gold clasp.
    heroTheme('hero-doom', 'Doctor Doom', 'villain', {
      bg: '#121715', shadow: '#0c100e', panel: '#171d1a', raised: '#1f2723', border: '#2e3833', borderStrong: '#4a574f',
      text: '#d6dbd4', dim: '#9aa59e', muted: '#6c7770',
      accent: '#5f8f4a', bright: '#79a862', deep: '#3f6630', blood: '#2a4520', gold: '#c2a24a',
      added: '#8dbf73', addedBg: '#1b2c1b', removed: '#c9695f', removedBg: '#33201d',
    }, SCENE.doom()),
    // Indigo tunic, crimson Cloak of Levitation, the Eye's amber glow.
    heroTheme('hero-strange', 'Doctor Strange', 'hero', {
      bg: '#0f1224', shadow: '#0a0c19', panel: '#141934', raised: '#1b2143', border: '#2a3160', borderStrong: '#5a3350',
      text: '#e6e0d2', dim: '#a8abc6', muted: '#737a9a',
      accent: '#b8364a', bright: '#cf5064', deep: '#8a2436', blood: '#5c1826', gold: '#e0a458',
      added: '#62b98f', addedBg: '#16302d', removed: '#e07a6e', removedBg: '#351a28', pillText: '#ffffff',
    }, SCENE.strange()),
    // Suit red over suit blue, silver webbing.
    heroTheme('hero-spider', 'Spider-Man', 'hero', {
      bg: '#0e1224', shadow: '#090c19', panel: '#131a33', raised: '#1a2245', border: '#283466', borderStrong: '#3d5294',
      text: '#e8ebf4', dim: '#a7b0d0', muted: '#707a9e',
      accent: '#c73a44', bright: '#dc5560', deep: '#962a33', blood: '#621b22', gold: '#6f95e8',
      added: '#5bbf82', addedBg: '#14302c', removed: '#e8806f', removedBg: '#351a26', pillText: '#ffffff',
    }, SCENE.spider(false)),
    // The same suit with its colours swapped: blue leads, red is the secondary, and the
    // surfaces take the red's dark tint where the classic suit has navy.
    heroTheme('hero-spider-rev', 'Spider-Man Reversed', 'hero', {
      bg: '#1a0f14', shadow: '#12090d', panel: '#21121a', raised: '#2b1822', border: '#48263a', borderStrong: '#8a3a4c',
      text: '#f1e9ec', dim: '#cfb0b8', muted: '#9a7480',
      accent: '#3f6fd1', bright: '#5a88e6', deep: '#2b4f9e', blood: '#1c3470', gold: '#dc5560',
      added: '#5bbf82', addedBg: '#1a2c24', removed: '#e8806f', removedBg: '#3a1a22', pillText: '#ffffff',
    }, SCENE.spider(true)),
    // Mustard yellow and blue, adamantium steel.
    heroTheme('hero-wolverine', 'Wolverine', 'antihero', {
      bg: '#11141b', shadow: '#0b0d12', panel: '#161a24', raised: '#1e2331', border: '#2d3547', borderStrong: '#6e6230',
      text: '#e8e9ec', dim: '#a8afbe', muted: '#717a8c',
      accent: '#e0b43a', bright: '#efc75a', deep: '#a8841f', blood: '#6e5614', gold: '#5a7fd0',
      added: '#6cbd7a', addedBg: '#182c20', removed: '#d9705a', removedBg: '#33201c', pillText: '#1a1407',
    }, SCENE.wolverine()),
    // Crimson synthezoid skin, green suit, the Mind Stone's yellow.
    heroTheme('hero-vision', 'Vision', 'hero', {
      bg: '#0f1813', shadow: '#0a110d', panel: '#142019', raised: '#1b2a21', border: '#2a3d31', borderStrong: '#466b52',
      text: '#e6ede3', dim: '#a4b6a8', muted: '#6e8274',
      accent: '#c24b56', bright: '#d8646e', deep: '#8e3540', blood: '#5e2229', gold: '#e8cc5a',
      added: '#6cc394', addedBg: '#163026', removed: '#e68a64', removedBg: '#33221b', pillText: '#ffffff',
    }, SCENE.vision()),

    // ----- Heroes -----
    heroFrom('hero-ironman', 'Iron Man', 'hero', { bg: '#170d0d', accent: '#b8352e', gold: '#d8a94a' },
      SCENE.ironman()),
    heroFrom('hero-cap', 'Captain America', 'hero', { bg: '#0e1426', accent: '#3f64b8', gold: '#c0414a' },
      SCENE.cap()),
    heroFrom('hero-thor', 'Thor', 'hero', { bg: '#0e121c', accent: '#6f9ee0', gold: '#b8403a' },
      SCENE.thor()),
    heroFrom('hero-hulk', 'Hulk', 'hero', { bg: '#0f160f', accent: '#5f9f4a', gold: '#7d58a8' },
      SCENE.hulk()),
    heroFrom('hero-widow', 'Black Widow', 'hero', { bg: '#0f0d10', accent: '#c0343c', gold: '#8e96a4' },
      [M.emblem('hourglass', '#c0343c', '#ff5a64', 'br'), SIG.widowBites('#6fb0ff')]),
    heroFrom('hero-hawkeye', 'Hawkeye', 'hero', { bg: '#130f1a', accent: '#8651bf', gold: '#d0a24a' },
      [M.arrows('#d0a24a', '#c9a3f0'), SIG.target('#8651bf', '#d0a24a')]),
    heroFrom('hero-panther', 'Black Panther', 'hero', { bg: '#0c0b12', accent: '#8d62e8', gold: '#c3c6d4' },
      SCENE.panther()),
    heroFrom('hero-marvel', 'Captain Marvel', 'hero', { bg: '#0f1428', accent: '#c43a48', gold: '#e2bd4c' },
      SCENE.marvel()),
    heroFrom('hero-wanda', 'Scarlet Witch', 'hero', { bg: '#160a10', accent: '#c43250', gold: '#e0648e' },
      SCENE.wanda()),
    heroFrom('hero-antman', 'Ant-Man', 'hero', { bg: '#130d0e', accent: '#bd3a33', gold: '#8f9aa8' },
      SCENE.antman()),
    heroFrom('hero-wasp', 'The Wasp', 'hero', { bg: '#12100a', accent: '#d9ad3c', gold: '#c24a3a' },
      [SIG.waspWings('#ffd76a', '#ffe9a8', '#fff2a0'), M.hex('#ffd76a', 'tr', '#d9ad3c')]),
    heroFrom('hero-falcon', 'Falcon', 'hero', { bg: '#10141c', accent: '#c03e3e', gold: '#98a6ba' },
      [SIG.falconWings('#c8d4e6', '#e04848'), M.glows([['#c03e3e', '100% 100%', '50% 55%', 0.14], ['#98a6ba', '0% 0%', '35% 40%', 0.1]])]),
    heroFrom('hero-starlord', 'Star-Lord', 'hero', { bg: '#150e0c', accent: '#c35a31', gold: '#6fb3de' },
      SCENE.starlord()),
    heroFrom('hero-gamora', 'Gamora', 'hero', { bg: '#0c140f', accent: '#4aa874', gold: '#c4508c' },
      [SIG.godslayer('#e0f0e8', '#4fd08a'), SIG.zenMarks('#dfe8e4')]),
    heroFrom('hero-groot', 'Groot', 'hero', { bg: '#120f0a', accent: '#7c9b4c', gold: '#a8763e' },
      [SIG.branches('#b08a5a', '#b8e07a'), M.embers('#d8f0a0', '#f2d58a')]),
    heroFrom('hero-rocket', 'Rocket', 'hero', { bg: '#14100c', accent: '#cf8a3c', gold: '#5a8ac2' },
      [SIG.blueprint('#5ab0e8', '#dff0ff'), SIG.reticle('#ffa040')]),
    heroFrom('hero-surfer', 'Silver Surfer', 'hero', { bg: '#0b0f18', accent: '#b4c1d6', gold: '#6f9fe0' },
      SCENE.surfer()),
    heroFrom('hero-daredevil', 'Daredevil', 'hero', { bg: '#140808', accent: '#b0272f', gold: '#d45c3c' },
      [plus(M.sonar('#ff4b4b', 'br'), SIG.ddEmblem('#ff5a5a')), SIG.rain('#f0c8c8')]),
    heroFrom('hero-storm', 'Storm', 'hero', { bg: '#0f1320', accent: '#cfd6e4', gold: '#6f9fe0' },
      SCENE.storm()),
    heroFrom('hero-cyclops', 'Cyclops', 'hero', { bg: '#0f1220', accent: '#d43a40', gold: '#e0b44a' },
      [M.beam('#ff4a55', '#ffd0d4'), plus(M.glows([['#3f64b8', '0% 100%', '45% 50%', 0.14]]), SIG.xEmblem('#e0b44a', '#d43a40'))]),
    heroFrom('hero-phoenix', 'Phoenix', 'hero', { bg: '#160c08', accent: '#de5c2c', gold: '#eec048' },
      [SIG.firebird('#ff8a3a', '#ffd060'), M.embers('#ffb04a', '#fff0a0')]),
    heroFrom('hero-iceman', 'Iceman', 'hero', { bg: '#0b141a', accent: '#7cc4e4', gold: '#e0f2ff' },
      [M.frost('#bfeaff', '#7cc4e4'), SIG.snowflakes('#e8f8ff')]),
    heroFrom('hero-torch', 'Human Torch', 'hero', { bg: '#160c06', accent: '#e6732c', gold: '#f0c048' },
      [SIG.flameComet('#ff7a2a', '#ffd060'), M.embers('#ffb04a', '#fff0a0')]),
    heroFrom('hero-shangchi', 'Shang-Chi', 'hero', { bg: '#140c0c', accent: '#c4363c', gold: '#dcb048' },
      [M.tenrings('#9fd0ff', '#5aa8ff'), SIG.dragonScales('#4fd0c0', '#dcb048')]),
    heroFrom('hero-miles', 'Miles Morales', 'hero', { bg: '#0c0c10', accent: '#d02e3e', gold: '#cfd4de' },
      [SIG.verse('#e0303e', '#5ae0ff'), SIG.spray('#e0303e', '#9a4fe0', '#7fd8ff')]),
    heroFrom('hero-gwen', 'Spider-Gwen', 'hero', { bg: '#0f0f15', accent: '#e05c9c', gold: '#5ad0d6' },
      [SIG.watercolor('#ff6fb0', '#5ad0d6', '#a07aff'), SIG.stageLights(['#ff6fb0', '#5ad0d6', '#a07aff'])]),

    // ----- Anti-heroes -----
    heroFrom('hero-deadpool', 'Deadpool', 'antihero', { bg: '#140909', accent: '#c22c2c', gold: '#d8d8de' },
      SCENE.deadpool()),
    heroFrom('hero-venom', 'Venom', 'antihero', { bg: '#08090c', accent: '#d6dbe4', gold: '#c0343c' },
      SCENE.venom()),
    heroFrom('hero-punisher', 'Punisher', 'antihero', { bg: '#0c0c0e', accent: '#dcdde3', gold: '#9a2a2a' },
      SCENE.punisher()),
    heroFrom('hero-ghostrider', 'Ghost Rider', 'antihero', { bg: '#120806', accent: '#ec7a2c', gold: '#d6cebe' },
      [SIG.hellfire('#e8dcc8'), SIG.hellChain('#d6cebe', '#ff7a2a')]),
    heroFrom('hero-loki', 'Loki', 'antihero', { bg: '#0c1410', accent: '#3f9a5a', gold: '#d2ae40' },
      SCENE.loki()),
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
      SCENE.magneto()),
    heroFrom('hero-ultron', 'Ultron', 'villain', { bg: '#0c0d10', accent: '#d0303a', gold: '#9aa4b0' },
      [SIG.ultronEyes('#ff3a44'), M.circuit('#ff5a64', '#d0303a')]),
    heroFrom('hero-goblin', 'Green Goblin', 'villain', { bg: '#0e120c', accent: '#6aa03c', gold: '#8252b0' },
      [SIG.pumpkins('#ff9a40', '#ffd070'), SIG.glider('#8fd050', '#ffa040')]),
    heroFrom('hero-octopus', 'Doctor Octopus', 'villain', { bg: '#0e1210', accent: '#4f9a6c', gold: '#c8a24c' },
      [SIG.ockArms('#d8e0c8', '#ff4a4a'), SIG.fusionSun('#ffd060', '#ff8a3a')]),
    heroFrom('hero-redskull', 'Red Skull', 'villain', { bg: '#120808', accent: '#c02c2c', gold: '#4fa8e8' },
      SCENE.redskull()),
    heroFrom('hero-hela', 'Hela', 'villain', { bg: '#0c100e', accent: '#3a8c5c', gold: '#9aa29c' },
      SCENE.hela()),
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
      SCENE.killmonger()),
  ];

  if (typeof window !== 'undefined') window.HERO_THEMES = HERO_THEMES;
  if (typeof module !== 'undefined' && module.exports) module.exports = { HERO_THEMES, derivePalette, M };
})();
