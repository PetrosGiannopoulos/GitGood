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

    // Forked lightning striking down from the top edge, glow first, white-hot core last.
    lightning(bolt, glow, corner = 'tr', scale = 1) {
      const C = CORNERS[corner];
      const bolts = [
        '100,0 140,90 108,110 180,230 146,248 230,400',
        '180,230 218,280 210,300 246,352',
        '20,40 50,120 30,132 80,230',
        '108,110 70,160 84,172 52,214',
      ];
      const draw = (w, op, c, filt) => bolts.map((p, i) =>
        `<polyline points='${p}' fill='none' stroke='${c}' stroke-opacity='${i === 0 ? op : op * 0.7}' stroke-width='${i === 0 ? w : w * 0.6}' stroke-linejoin='round' ${filt || ''}/>`).join('');
      const img = svg(300, 420,
        `<defs>${blur('b', 6)}</defs><g transform='${C.flip(300, 420)}'>` +
        draw(12, 0.4, glow, "filter='url(#b)'") + draw(3, 0.6, bolt) + draw(1.2, 0.55, '#ffffff') + `</g>`);
      const s = Math.round(300 * scale), h = Math.round(420 * scale);
      return { bg: `${img} ${C.pos} / ${s}px ${h}px no-repeat, radial-gradient(circle at ${C.at}, ${rgba(glow, 0.16)}, transparent 40%)` };
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
        star: { d: (() => { let d = ''; for (let i = 0; i < 10; i++) { const r = i % 2 ? 18 : 44, a = -Math.PI / 2 + i * Math.PI / 5; d += (i ? 'L' : 'M') + f1(50 + r * Math.cos(a)) + ' ' + f1(52 + r * Math.sin(a)); } return d + 'Z'; })() },
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

    // Parallel slashes raked diagonally from a corner, a hot glow under a bright cut.
    claws(color, glow, { n = 3, corner = 'tr' } = {}) {
      const C = CORNERS[corner];
      let body = `<defs>${blur('b', 5)}`;
      const lines = [];
      for (let i = 0; i < n; i++) lines.push([300 - i * 44, -10 + i * 14, 60 - i * 44, 470 + i * 14]);
      lines.forEach(([x1, y1, x2, y2], i) => {
        body += `<linearGradient id='c${i}' gradientUnits='userSpaceOnUse' x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}'><stop offset='0' stop-color='${color}' stop-opacity='0'/><stop offset='.2' stop-color='${color}' stop-opacity='.55'/><stop offset='.75' stop-color='${color}' stop-opacity='.32'/><stop offset='1' stop-color='${color}' stop-opacity='0'/></linearGradient>`;
      });
      // The art already leans in from the top-right; the other corners are mirrors of it.
      const t = { tr: '', tl: 'translate(360 0) scale(-1 1)', br: 'translate(0 480) scale(1 -1)', bl: 'translate(360 480) scale(-1 -1)' }[corner];
      body += `</defs><g transform='${t}'>`;
      lines.forEach(([x1, y1, x2, y2], i) => {
        body += `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}' stroke='${glow}' stroke-opacity='.26' stroke-width='10' filter='url(#b)'/>`;
        body += `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}' stroke='url(#c${i})' stroke-width='2.4'/>`;
      });
      body += '</g>';
      return { bg: `${svg(360, 480, body)} ${C.pos} / 360px 480px no-repeat, radial-gradient(circle at ${C.at}, ${rgba(glow, 0.14)}, transparent 42%)` };
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

    // A magic circle: rings, a band of ticks, two crossed squares, an eight-point star —
    // drawn twice (blurred, then crisp) so it glows. Sparks drift off its edge.
    sigil(color, spark, corner = 'tr', { ticks = true } = {}) {
      const C = CORNERS[corner];
      const sq = (rot) => `<rect x='150' y='150' width='300' height='300' fill='none' stroke='${color}' stroke-opacity='.24' stroke-width='1.2' transform='rotate(${rot} 300 300)'/>`;
      let star = '';
      for (let i = 0; i < 16; i++) { const r = i % 2 ? 62 : 112, a = i * Math.PI / 8; star += (i ? 'L' : 'M') + f1(300 + r * Math.cos(a)) + ' ' + f1(300 + r * Math.sin(a)); }
      const art =
        `<circle cx='300' cy='300' r='262' fill='none' stroke='${color}' stroke-opacity='.3' stroke-width='1.5'/>` +
        (ticks ? `<circle cx='300' cy='300' r='246' fill='none' stroke='${color}' stroke-opacity='.26' stroke-width='16' stroke-dasharray='1.5 6'/>` : '') +
        `<circle cx='300' cy='300' r='228' fill='none' stroke='${color}' stroke-opacity='.3' stroke-width='1.2'/>` +
        sq(0) + sq(45) +
        `<circle cx='300' cy='300' r='150' fill='none' stroke='${color}' stroke-opacity='.26' stroke-width='1'/>` +
        `<circle cx='300' cy='300' r='128' fill='none' stroke='${color}' stroke-opacity='.2' stroke-width='1' stroke-dasharray='4 8'/>` +
        `<path d='${star}Z' fill='none' stroke='${color}' stroke-opacity='.2' stroke-width='1'/>`;
      const sparks = scatter(7, 7, 600, 600).filter(([x, y]) => Math.hypot(x - 300, y - 300) > 240 && Math.hypot(x - 300, y - 300) < 300)
        .concat([[560, 330, 0.6], [330, 568, 0.5], [520, 470, 0.8], [470, 520, 0.4]])
        .map(([x, y, r]) => `<circle cx='${x}' cy='${y}' r='${f1(1 + r * 1.6)}' fill='${spark}' fill-opacity='.55'/>`).join('');
      const img = svg(600, 600,
        `<defs>${blur('b', 3)}<radialGradient id='g'><stop offset='0' stop-color='${spark}' stop-opacity='.2'/><stop offset='1' stop-color='${spark}' stop-opacity='0'/></radialGradient></defs>` +
        `<g transform='${C.flip(600, 600)}'><circle cx='300' cy='300' r='300' fill='url(#g)'/>` +
        `<g filter='url(#b)'>${art}</g>${art}<g filter='url(#b)'>${sparks}</g>${sparks}</g>`);
      const x = corner[1] === 'l' ? 'left -300px' : 'right -300px';
      const y = corner[0] === 't' ? 'top -300px' : 'bottom -300px';
      return { bg: `${img} ${x} ${y} / 600px 600px no-repeat, radial-gradient(circle at ${C.at}, ${rgba(spark, 0.14)}, transparent 32%)` };
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

    // Living strands reaching in from the bottom-left and top-right corners. `mech` segments
    // them like a machine's arms instead.
    tendrils(color, glow, { mech = false } = {}) {
      const paths = [
        ['M0 480 C120 420 160 300 300 260 S520 180 700 60', 7],
        ['M0 440 C90 400 150 360 220 300 S330 160 420 90', 4],
        ['M0 500 C160 470 260 430 380 380 S560 330 640 250', 5],
        ['M40 500 C60 420 30 330 90 250 S160 120 140 30', 3],
      ];
      const dash = mech ? "stroke-dasharray='16 5'" : '';
      const art = (t) => `<g transform='${t}'>` + paths.map(([d, w]) =>
        `<path d='${d}' fill='none' stroke='${glow}' stroke-opacity='.22' stroke-width='${w * 2.4}' stroke-linecap='round' filter='url(#b)'/>` +
        `<path d='${d}' fill='none' stroke='${color}' stroke-opacity='.26' stroke-width='${w}' stroke-linecap='round' ${dash}/>` +
        `<path d='${d}' fill='none' stroke='#ffffff' stroke-opacity='.12' stroke-width='${f1(w / 3)}' stroke-linecap='round'/>`).join('') + '</g>';
      const a = svg(700, 500, `<defs>${blur('b', 6)}</defs>${art('')}`);
      const b = svg(700, 500, `<defs>${blur('b', 6)}</defs>${art('rotate(180 350 250)')}`);
      return {
        bg: `${a} left -40px bottom -30px / 560px 400px no-repeat, ${b} right -60px top -40px / 460px 330px no-repeat, radial-gradient(ellipse 45% 50% at 0% 100%, ${rgba(glow, 0.14)}, transparent 70%)`,
        mask: 'radial-gradient(ellipse 62% 58% at 52% 48%, transparent 35%, #000 85%)',
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

    // A web spun into a corner, fading out before it reaches the work.
    web(line, glow, corner = 'tl') {
      const at = CORNERS[corner].at;
      return {
        bg: `repeating-radial-gradient(circle at ${at}, transparent 0 46px, ${rgba(line, 0.1)} 47px 48px), ` +
          `repeating-conic-gradient(from 0deg at ${at}, ${rgba(line, 0.1)} 0 0.35deg, transparent 0.35deg 11.25deg), ` +
          `radial-gradient(circle at ${at}, ${rgba(glow, 0.18)}, transparent 40%)`,
        mask: `radial-gradient(circle at ${at}, #000 0%, transparent 44%)`,
      };
    },

    // Waves rolling along the bottom edge.
    waves(color, glow) {
      const wave = (y, amp, op, w) => `<path d='M0 ${y} C75 ${y - amp} 75 ${y + amp} 150 ${y} S225 ${y - amp} 300 ${y}' fill='none' stroke='${color}' stroke-opacity='${op}' stroke-width='${w}'/>`;
      const art = wave(40, 18, 0.14, 1.2) + wave(78, 22, 0.2, 1.6) + wave(114, 26, 0.26, 2) + wave(146, 20, 0.3, 2.4);
      return { bg: `${svg(300, 160, `<defs>${blur('b', 3)}</defs><g filter='url(#b)'>${art}</g>${art}`)} 0 100% / 300px 160px repeat-x, radial-gradient(ellipse 90% 45% at 50% 110%, ${rgba(glow, 0.22)}, transparent 70%)` };
    },

    // The six Infinity Stones in an arc, bottom-right.
    gauntlet(gold) {
      const stones = ['#4f8cff', '#f2d541', '#e0303a', '#9a4fe0', '#3fd07a', '#f08a2a'];
      let body = `<defs>${blur('b', 9)}${blur('c', 3)}</defs>`;
      stones.forEach((c, i) => {
        const a = Math.PI * (1.08 + i * 0.1), cx = f1(300 + 220 * Math.cos(a)), cy = f1(330 + 220 * Math.sin(a));
        body += `<circle cx='${cx}' cy='${cy}' r='20' fill='${c}' fill-opacity='.55' filter='url(#b)'/>`;
        body += `<circle cx='${cx}' cy='${cy}' r='7' fill='${c}' fill-opacity='.85' filter='url(#c)'/>`;
        body += `<circle cx='${cx}' cy='${cy}' r='2.4' fill='#ffffff' fill-opacity='.8'/>`;
      });
      return { bg: `${svg(420, 320, body)} right 10px bottom -30px / 420px 320px no-repeat, radial-gradient(ellipse 40% 45% at 100% 100%, ${rgba(gold, 0.2)}, transparent 70%)` };
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
      [M.reactor('#8fe3ff', '#d8a94a', '#b8352e'), M.circuit('#d8a94a', '#b8352e')]),
    heroFrom('hero-cap', 'Captain America', 'hero', { bg: '#0e1426', accent: '#3f64b8', gold: '#c0414a' },
      [M.shield('#c0414a', '#3f64b8', '#e8ecf4'), M.glows([['#c0414a', '0% 0%', '40% 45%', 0.12], ['#e8ecf4', '0% 100%', '35% 40%', 0.06]])]),
    heroFrom('hero-thor', 'Thor', 'hero', { bg: '#0e121c', accent: '#6f9ee0', gold: '#b8403a' },
      [M.lightning('#dfe9ff', '#6f9ee0', 'tr'), M.glows([['#b8403a', '0% 100%', '55% 60%', 0.16], ['#6f9ee0', '50% 0%', '60% 30%', 0.1]])]),
    heroFrom('hero-hulk', 'Hulk', 'hero', { bg: '#0f160f', accent: '#5f9f4a', gold: '#7d58a8' },
      [M.gamma('#7fd05a'), M.glows([['#7d58a8', '100% 0%', '40% 45%', 0.14], ['#7d58a8', '0% 0%', '30% 35%', 0.08]])]),
    heroFrom('hero-widow', 'Black Widow', 'hero', { bg: '#0f0d10', accent: '#c0343c', gold: '#8e96a4' },
      [M.emblem('hourglass', '#c0343c', '#ff5a64', 'br'), M.lightning('#bfe0ff', '#4f9aff', 'tl', 0.6)]),
    heroFrom('hero-hawkeye', 'Hawkeye', 'hero', { bg: '#130f1a', accent: '#8651bf', gold: '#d0a24a' },
      [M.arrows('#d0a24a', '#c9a3f0'), M.glows([['#8651bf', '0% 100%', '50% 55%', 0.16]])]),
    heroFrom('hero-panther', 'Black Panther', 'hero', { bg: '#0c0b12', accent: '#8d62e8', gold: '#c3c6d4' },
      [M.claws('#d8c8ff', '#8d62e8', { corner: 'tr' }), M.hex('#b99cff', 'bl', '#8d62e8')]),
    heroFrom('hero-marvel', 'Captain Marvel', 'hero', { bg: '#0f1428', accent: '#c43a48', gold: '#e2bd4c' },
      [M.rays('#ffd98a', '#fff1c4', '50% -4%', { alpha: 0.11 }), M.cosmic('#c43a48', '#3f64b8')]),
    heroFrom('hero-wanda', 'Scarlet Witch', 'hero', { bg: '#160a10', accent: '#c43250', gold: '#e0648e' },
      [M.sigil('#ff4f7a', '#ff8fb0', 'tl'), M.smoke('#c43250', '#e0648e')]),
    heroFrom('hero-antman', 'Ant-Man', 'hero', { bg: '#130d0e', accent: '#bd3a33', gold: '#8f9aa8' },
      [M.hex('#7ad0ff', 'tr', '#7ad0ff'), M.glows([['#bd3a33', '0% 100%', '50% 55%', 0.16], ['#7ad0ff', '0% 0%', '25% 30%', 0.08]])]),
    heroFrom('hero-wasp', 'The Wasp', 'hero', { bg: '#12100a', accent: '#d9ad3c', gold: '#c24a3a' },
      [M.hex('#ffd76a', 'tl', '#d9ad3c'), M.lightning('#fff2b8', '#ffd76a', 'tr', 0.55)]),
    heroFrom('hero-falcon', 'Falcon', 'hero', { bg: '#10141c', accent: '#c03e3e', gold: '#98a6ba' },
      [M.rays('#c8d4e6', '#ffffff', '0% 0%', { step: 6, width: 0.8, alpha: 0.12, reach: '60% 70%' }), M.glows([['#c03e3e', '100% 100%', '50% 55%', 0.16]])]),
    heroFrom('hero-starlord', 'Star-Lord', 'hero', { bg: '#150e0c', accent: '#c35a31', gold: '#6fb3de' },
      [M.rays('#ffb86b', '#fff0d0', '0% 100%', { step: 10, alpha: 0.1, reach: '55% 65%' }), M.cosmic('#c35a31', '#6fb3de')]),
    heroFrom('hero-gamora', 'Gamora', 'hero', { bg: '#0c140f', accent: '#4aa874', gold: '#c4508c' },
      [M.claws('#9ff0c4', '#4aa874', { n: 1, corner: 'tr' }), M.cosmic('#4aa874', '#c4508c')]),
    heroFrom('hero-groot', 'Groot', 'hero', { bg: '#120f0a', accent: '#7c9b4c', gold: '#a8763e' },
      [M.tendrils('#b8e07a', '#7c9b4c'), M.embers('#d8f0a0', '#f2d58a')]),
    heroFrom('hero-rocket', 'Rocket', 'hero', { bg: '#14100c', accent: '#cf8a3c', gold: '#5a8ac2' },
      [M.circuit('#ffc27a', '#cf8a3c'), M.hex('#5a8ac2', 'tr', '#5a8ac2')]),
    heroFrom('hero-surfer', 'Silver Surfer', 'hero', { bg: '#0b0f18', accent: '#b4c1d6', gold: '#6f9fe0' },
      [M.beam('#9fc4ff', '#ffffff'), M.cosmic('#6f9fe0', '#b4c1d6')]),
    heroFrom('hero-daredevil', 'Daredevil', 'hero', { bg: '#140808', accent: '#b0272f', gold: '#d45c3c' },
      [M.sonar('#ff4b4b', 'br'), M.glows([['#b0272f', '0% 0%', '40% 45%', 0.12]])]),
    heroFrom('hero-storm', 'Storm', 'hero', { bg: '#0f1320', accent: '#cfd6e4', gold: '#6f9fe0' },
      [M.lightning('#ffffff', '#9fc4ff', 'tl'), M.smoke('#8a94a8', '#6f9fe0')]),
    heroFrom('hero-cyclops', 'Cyclops', 'hero', { bg: '#0f1220', accent: '#d43a40', gold: '#e0b44a' },
      [M.beam('#ff4a55', '#ffd0d4'), M.glows([['#e0b44a', '100% 100%', '45% 50%', 0.12], ['#3f64b8', '0% 100%', '45% 50%', 0.12]])]),
    heroFrom('hero-phoenix', 'Phoenix', 'hero', { bg: '#160c08', accent: '#de5c2c', gold: '#eec048' },
      [M.flames('#de5c2c', '#eec048'), M.rays('#ffb04a', '#fff0c0', '50% -4%', { alpha: 0.09 })]),
    heroFrom('hero-iceman', 'Iceman', 'hero', { bg: '#0b141a', accent: '#7cc4e4', gold: '#e0f2ff' },
      [M.frost('#bfeaff', '#7cc4e4'), M.embers('#ffffff', '#bfeaff')]),
    heroFrom('hero-torch', 'Human Torch', 'hero', { bg: '#160c06', accent: '#e6732c', gold: '#f0c048' },
      [M.flames('#e6732c', '#f0c048'), M.embers('#ffb050', '#fff0a0')]),
    heroFrom('hero-shangchi', 'Shang-Chi', 'hero', { bg: '#140c0c', accent: '#c4363c', gold: '#dcb048' },
      [M.tenrings('#9fd0ff', '#5aa8ff'), M.glows([['#dcb048', '0% 0%', '40% 45%', 0.12], ['#c4363c', '0% 100%', '40% 45%', 0.12]])]),
    heroFrom('hero-miles', 'Miles Morales', 'hero', { bg: '#0c0c10', accent: '#d02e3e', gold: '#cfd4de' },
      [M.web('#e8ecf4', '#d02e3e', 'tr'), M.lightning('#dff4ff', '#7fd8ff', 'tl', 0.55)]),
    heroFrom('hero-gwen', 'Spider-Gwen', 'hero', { bg: '#0f0f15', accent: '#e05c9c', gold: '#5ad0d6' },
      [M.web('#e8ecf4', '#e05c9c', 'tl'), M.glows([['#5ad0d6', '100% 100%', '45% 50%', 0.14]])]),

    // ----- Anti-heroes -----
    heroFrom('hero-deadpool', 'Deadpool', 'antihero', { bg: '#140909', accent: '#c22c2c', gold: '#d8d8de' },
      [M.katanas('#e8ecf4', '#ff5555'), M.glows([['#c22c2c', '0% 0%', '40% 45%', 0.14]])]),
    heroFrom('hero-venom', 'Venom', 'antihero', { bg: '#08090c', accent: '#d6dbe4', gold: '#c0343c' },
      [M.tendrils('#e8ecf4', '#8a94a8'), M.glows([['#c0343c', '50% 110%', '60% 35%', 0.14]])]),
    heroFrom('hero-punisher', 'Punisher', 'antihero', { bg: '#0c0c0e', accent: '#dcdde3', gold: '#9a2a2a' },
      [M.emblem('skull', '#ffffff', '#ffffff', 'br'), M.glows([['#9a2a2a', '0% 0%', '40% 45%', 0.12]])]),
    heroFrom('hero-ghostrider', 'Ghost Rider', 'antihero', { bg: '#120806', accent: '#ec7a2c', gold: '#d6cebe' },
      [M.flames('#ec7a2c', '#ffcf6a'), M.embers('#ffae4a', '#fff0a0')]),
    heroFrom('hero-loki', 'Loki', 'antihero', { bg: '#0c1410', accent: '#3f9a5a', gold: '#d2ae40' },
      [M.sigil('#6fe08f', '#f2d27a', 'tr'), M.glows([['#d2ae40', '0% 100%', '45% 50%', 0.12]])]),
    heroFrom('hero-elektra', 'Elektra', 'antihero', { bg: '#140a0a', accent: '#b82c3c', gold: '#c9a34c' },
      [M.katanas('#f0d8a0', '#ff5064'), M.smoke('#b82c3c', '#5a1a24')]),
    heroFrom('hero-blade', 'Blade', 'antihero', { bg: '#0e0a0a', accent: '#9e2028', gold: '#b8bcc6' },
      [M.claws('#e8ecf4', '#9e2028', { n: 1, corner: 'tr' }), M.embers('#c0303a', '#6a1418')]),
    heroFrom('hero-moonknight', 'Moon Knight', 'antihero', { bg: '#0e0f14', accent: '#d6dae4', gold: '#c7a44c' },
      [M.moon('#f2f4fa', '#c8d4ff'), M.cosmic('#3a4a7a', '#c7a44c')]),
    heroFrom('hero-namor', 'Namor', 'antihero', { bg: '#0a1418', accent: '#2f9e8a', gold: '#d2ae40' },
      [M.waves('#6fe0cf', '#2f9e8a'), M.glows([['#d2ae40', '100% 0%', '35% 40%', 0.1]])]),
    heroFrom('hero-bucky', 'Winter Soldier', 'antihero', { bg: '#0e1014', accent: '#b83a40', gold: '#9aa4b2' },
      [M.emblem('star', '#ff4f5a', '#ff4f5a', 'bl'), M.brushed('#c8d2e0')]),

    // ----- Villains -----
    heroFrom('hero-thanos', 'Thanos', 'villain', { bg: '#110c16', accent: '#7d52b4', gold: '#d4ae3c' },
      [M.gauntlet('#d4ae3c'), M.cosmic('#7d52b4', '#3f64b8')]),
    heroFrom('hero-magneto', 'Magneto', 'villain', { bg: '#140a14', accent: '#a42c4c', gold: '#7c52b2' },
      [M.field('#d65a8a', '#9a7ae0'), M.glows([['#a42c4c', '50% 0%', '55% 30%', 0.12]])]),
    heroFrom('hero-ultron', 'Ultron', 'villain', { bg: '#0c0d10', accent: '#d0303a', gold: '#9aa4b0' },
      [M.reactor('#ff3a44', '#9aa4b0', '#d0303a'), M.circuit('#ff5a64', '#d0303a')]),
    heroFrom('hero-goblin', 'Green Goblin', 'villain', { bg: '#0e120c', accent: '#6aa03c', gold: '#8252b0' },
      [M.embers('#ffa040', '#9fe07a', 1.6), M.smoke('#6aa03c', '#8252b0')]),
    heroFrom('hero-octopus', 'Doctor Octopus', 'villain', { bg: '#0e1210', accent: '#4f9a6c', gold: '#c8a24c' },
      [M.tendrils('#d8e0c8', '#c8a24c', { mech: true }), M.glows([['#4f9a6c', '100% 0%', '40% 45%', 0.12]])]),
    heroFrom('hero-redskull', 'Red Skull', 'villain', { bg: '#120808', accent: '#c02c2c', gold: '#4fa8e8' },
      [M.rays('#7fd0ff', '#d8f0ff', '100% 100%', { step: 8, alpha: 0.14, reach: '55% 65%' }), M.glows([['#c02c2c', '0% 0%', '45% 50%', 0.16]])]),
    heroFrom('hero-hela', 'Hela', 'villain', { bg: '#0c100e', accent: '#3a8c5c', gold: '#9aa29c' },
      [M.blades('#8fe0b0', '#3a8c5c'), M.smoke('#3a8c5c', '#1a3a28')]),
    heroFrom('hero-dormammu', 'Dormammu', 'villain', { bg: '#150806', accent: '#e05c2c', gold: '#9a4ce0' },
      [M.flames('#e05c2c', '#ffb04a'), M.sigil('#b87aff', '#e0a0ff', 'tr', { ticks: false })]),
    heroFrom('hero-galactus', 'Galactus', 'villain', { bg: '#0c0c18', accent: '#6a52c4', gold: '#3f6ad2' },
      [M.rays('#b8a8ff', '#ffffff', '50% -4%', { step: 7, alpha: 0.1 }), M.cosmic('#6a52c4', '#3f6ad2')]),
    heroFrom('hero-carnage', 'Carnage', 'villain', { bg: '#120606', accent: '#c41c2e', gold: '#ff6a3a' },
      [M.tendrils('#ff4a5a', '#c41c2e'), M.embers('#ff3a4a', '#ff9a6a')]),
    heroFrom('hero-kingpin', 'Kingpin', 'villain', { bg: '#0e0e10', accent: '#dcdde3', gold: '#9a2a3a' },
      [M.pinstripe('#dcdde3', '#ffffff'), M.glows([['#9a2a3a', '0% 100%', '40% 45%', 0.12]])]),
    heroFrom('hero-mysterio', 'Mysterio', 'villain', { bg: '#0c1014', accent: '#3fae8a', gold: '#8a52c2' },
      [M.smoke('#3fae8a', '#8a52c2'), M.sigil('#7fe8c8', '#b89aff', 'tr', { ticks: false })]),
    heroFrom('hero-electro', 'Electro', 'villain', { bg: '#0c0f14', accent: '#cfcf3c', gold: '#3a9ae0' },
      [M.lightning('#f8ffb0', '#e0e03a', 'tr'), M.lightning('#dff0ff', '#3a9ae0', 'bl', 0.7)]),
    heroFrom('hero-killmonger', 'Killmonger', 'villain', { bg: '#0c0b10', accent: '#d2ac3c', gold: '#a0402e' },
      [M.claws('#ffe39a', '#d2ac3c', { corner: 'tr' }), M.hex('#d2ac3c', 'bl', '#a0402e')]),
  ];

  if (typeof window !== 'undefined') window.HERO_THEMES = HERO_THEMES;
  if (typeof module !== 'undefined' && module.exports) module.exports = { HERO_THEMES, derivePalette, M };
})();
