// DC themes: heroes, anti-heroes and villains from the DC universe, built exactly like the
// Marvel ones (00-hero-themes.js) — same palette derivation, same two art layers painted
// under the glass panels, same --hero-strength — from the kit that file exports as HERO_KIT.
//
// They are appended to HERO_THEMES with `universe: 'dc'`, so applyTheme, the comic-page
// backdrop and the Settings picker need no second path; the picker only splits the list.
// Comic pages live at assets/comics/<id>.webp like the rest (tools/comic-pages/dc-heroes.js).
//
// Every character gets its own piece of art, never another character's: the Bat-Signal,
// the lantern, the lasso, the Omega. Shared motifs (glows, star fields) are only ambience.
(function () {
  const KIT = (typeof window !== 'undefined' && window.HERO_KIT) || require('./00-hero-themes.js').HERO_KIT;
  const ROSTER = (typeof window !== 'undefined' && window.HERO_THEMES) || require('./00-hero-themes.js').HERO_THEMES;
  const { mix, rgba, svg, f1, scatter, M, rng, lit, art, put, rg, layer, plus, pts, jag, line, poly, starPts, spiral,
    cloudF, metalG, fadeMask, fireBody, sym, glowArt, starfield, heroFrom } = KIT;

  // A noise cloud confined to a soft disc, as SVG markup: mist, gas, smoke, dust.
  const mist = (id, w, h, cx, cy, r, colour, { freq = '0.006 0.011', seed = 3, k = 2.4, o = -1.05, inner = 0.15 } = {}) => ({
    defs: cloudF(id, freq, 5, seed, colour, k, o) + fadeMask(id + 'm', w, h, cx, cy, r, inner),
    body: `<g mask='url(#${id}m)'><rect width='${w}' height='${h}' fill='#fff' filter='url(#${id})'/></g>`,
  });
  // A tiled field of small things, faded in from one corner.
  const cornerTile = (tile, w, h, at, reach = '46%') => layer([`${tile} 0 0 / ${w}px ${h}px repeat`], `radial-gradient(circle at ${at}, #000 0%, transparent ${reach})`);

  // ---------- shared shapes ----------
  // The bat, in a 200×100 box: left half from the top of the head round to the tail point,
  // mirrored for the right.
  const BAT_L = [[100, 30], [94, 30], [90, 12], [86, 32], [72, 36], [46, 30], [6, 16], [22, 40], [20, 56], [38, 52], [46, 70], [62, 60], [72, 80], [86, 64], [100, 90]];
  const BAT = BAT_L.concat(BAT_L.slice(1, -1).reverse().map(([x, y]) => [200 - x, y]));
  // A lightning bolt in a 100×160 box, the comic-book kind: two zigzags, not a jagged line.
  const BOLT = [[62, 0], [18, 78], [46, 78], [30, 160], [84, 62], [54, 62], [76, 0]];
  const ptsAt = (list, dx, dy, s = 1) => pts(list.map(([x, y]) => [dx + x * s, dy + y * s]));
  // A leaf: two arcs meeting at a point, along +x from the origin.
  const leaf = (x, y, len, rot, c, o = 0.3) =>
    `<path d='M0 0 Q${f1(len * 0.5)} ${f1(-len * 0.32)} ${len} 0 Q${f1(len * 0.5)} ${f1(len * 0.32)} 0 0 Z M0 0 L${f1(len * 0.9)} 0' fill='${c}' fill-opacity='${o}' stroke='${c}' stroke-opacity='.55' stroke-width='1' transform='translate(${f1(x)} ${f1(y)}) rotate(${f1(rot)})'/>`;

  // ---------- art ----------
  const ART = {
    // ----- Gotham -----
    // The Bat-Signal: a searchlight beam rising from the bottom-left into a bank of cloud
    // top-right, the bat dark inside the lit oval.
    batSignal(light, cloud, ink) {
      const W = 900, H = 640, cx = 640, cy = 180;
      const cl = mist('cl', W, H, cx, cy, 400, cloud, { seed: 23 });
      const defs = cl.defs + `<linearGradient id='bm' gradientUnits='userSpaceOnUse' x1='60' y1='640' x2='${cx}' y2='${cy}'><stop offset='0' stop-color='${light}' stop-opacity='.02'/><stop offset='1' stop-color='${light}' stop-opacity='.2'/></linearGradient>`;
      const body = cl.body +
        `<polygon points='30,640 110,640 ${cx + 150},${cy + 70} ${cx - 120},${cy - 80}' fill='url(#bm)'/>` +
        `<ellipse cx='${cx}' cy='${cy}' rx='170' ry='104' fill='${light}' fill-opacity='.22' filter='url(#b)'/>` +
        `<ellipse cx='${cx}' cy='${cy}' rx='160' ry='98' fill='${light}' fill-opacity='.12' stroke='${light}' stroke-opacity='.5' stroke-width='2'/>` +
        `<polygon points='${ptsAt(BAT, cx - 126, cy - 66, 1.26)}' fill='${ink}' fill-opacity='.78'/>`;
      return layer([put(art(W, H, body, 16, defs), 'right 0 top 0', W, H), rg(light, '100% 0%', '45% 45%', 0.08)]);
    },
    // Gotham along the bottom edge — gothic towers with spires, a few windows lit — and the
    // rain that never stops, kept to the edges.
    gotham(fill, win, rainC) {
      const r = rng(31);
      let b = '', x = -10;
      while (x < 1200) {
        const w = 44 + r() * 90, h = 50 + r() * 140, top = 220 - h;
        b += `<rect x='${f1(x)}' y='${f1(top)}' width='${f1(w)}' height='${f1(h)}' fill='${fill}' fill-opacity='.5' stroke='${win}' stroke-opacity='.18'/>`;
        if (r() < 0.45) b += `<polygon points='${pts([[x + w * 0.2, top], [x + w * 0.5, top - 30 - r() * 50], [x + w * 0.8, top]])}' fill='${fill}' fill-opacity='.5' stroke='${win}' stroke-opacity='.18'/>`;
        for (let wy = top + 12; wy < 210; wy += 18) for (let wx = x + 8; wx < x + w - 10; wx += 14) if (r() < 0.12) b += `<rect x='${f1(wx)}' y='${f1(wy)}' width='5' height='8' fill='${win}' fill-opacity='.5'/>`;
        x += w + r() * 8;
      }
      const rr = rng(8);
      let rain = '';
      for (let i = 0; i < 24; i++) { const rx = rr() * 180, ry = rr() * 180; rain += line(rx, ry, rx - 4, ry + 26, rainC, f1(0.12 + rr() * 0.18), 1); }
      return layer([`${svg(1200, 220, b)} 0 100% / 1200px 220px repeat-x`, `${svg(180, 180, rain)} 0 0 / 180px 180px repeat`],
        'linear-gradient(0deg, #000 0, #000 230px, transparent 231px), radial-gradient(ellipse 70% 70% at 50% 40%, transparent 45%, #000 95%)');
    },

    // ----- Metropolis -----
    // The S-shield: the five-sided field and the S, red on gold, in the bottom-right.
    sShield(red, gold) {
      const body = `<polygon points='30,8 170,8 198,44 100,186 2,44' fill='${gold}' fill-opacity='.16' stroke='${red}' stroke-opacity='.65' stroke-width='5' stroke-linejoin='round'/>` +
        `<polygon points='36,20 164,20 184,46 100,168 16,46' fill='none' stroke='${gold}' stroke-opacity='.45' stroke-width='2' stroke-linejoin='round'/>` +
        `<path d='M150 40 H74 C50 40 44 70 70 78 L128 96 C150 104 146 132 122 132 H56 M50 52 L36 46' fill='none' stroke='${red}' stroke-opacity='.6' stroke-width='16' stroke-linecap='round' stroke-linejoin='round'/>` +
        `<path d='M40 18 H160' stroke='#ffffff' stroke-opacity='.35' stroke-width='2'/>`;
      return layer([put(glowArt(200, 194, body, '', 6, 0.45), 'right 40px bottom 36px', 250, 242), rg(red, '100% 100%', '40% 45%', 0.12)]);
    },
    // The cape, billowing in from the top-left corner, and the yellow sun above it.
    cape(red, sun) {
      // Gathered at the top edge, flaring out and down, the hem rippling in three waves.
      const d = 'M0 0 H300 C330 90 400 170 470 230 C430 250 400 236 370 262 C330 250 300 280 260 300 C220 284 180 320 130 330 C90 300 40 320 0 310 Z';
      const body = `<path d='${d}' fill='url(#cp)' fill-opacity='.3' stroke='${red}' stroke-opacity='.5' stroke-width='2' stroke-linejoin='round'/>` +
        `<path d='M60 0 C80 110 100 220 130 330 M150 0 C190 100 220 190 260 300 M240 0 C280 90 320 170 370 262' fill='none' stroke='${mix(red, '#000000', 0.45)}' stroke-opacity='.45' stroke-width='4'/>` +
        `<path d='M100 0 C125 110 150 210 190 312 M196 0 C236 96 266 180 314 280' fill='none' stroke='${mix(red, '#ffffff', 0.3)}' stroke-opacity='.18' stroke-width='3'/>`;
      const defs = `<linearGradient id='cp' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${red}'/><stop offset='1' stop-color='${mix(red, '#000000', 0.5)}'/></linearGradient>`;
      return layer([put(art(480, 390, lit(body), 4, defs), 'left 0 top 0', 480, 390), rg(sun, '50% -10%', '55% 35%', 0.16)]);
    },
    // Krypton coming apart in the top-right, and the pod streaking away from it.
    krypton(planet, crack, trail) {
      const r = rng(19);
      let cracks = '';
      for (let i = 0; i < 9; i++) { const a = r() * Math.PI * 2; cracks += poly(jag(300, 160, 300 + Math.cos(a) * 120, 160 + Math.sin(a) * 120, 5, 10, r), crack, 0.7, 2.2); }
      let shards = '';
      for (let i = 0; i < 14; i++) { const a = r() * Math.PI * 2, d = 140 + r() * 150, x = 300 + Math.cos(a) * d, y = 160 + Math.sin(a) * d * 0.8, s = 4 + r() * 10; shards += `<polygon points='${pts([[x, y - s], [x + s, y], [x, y + s * 0.6], [x - s * 0.8, y]])}' fill='${planet}' fill-opacity='.45' stroke='${crack}' stroke-opacity='.5'/>`; }
      const body = `<circle cx='300' cy='160' r='160' fill='${crack}' fill-opacity='.16' filter='url(#b)'/>` +
        `<circle cx='300' cy='160' r='118' fill='url(#kp)' fill-opacity='.42' stroke='${crack}' stroke-opacity='.55' stroke-width='2'/>` + cracks + shards +
        `<path d='M190 250 C120 330 60 380 0 420' fill='none' stroke='${trail}' stroke-opacity='.45' stroke-width='3' stroke-dasharray='40 8 10 8'/><circle cx='186' cy='254' r='6' fill='#ffffff' fill-opacity='.9'/>`;
      const defs = `<radialGradient id='kp' cx='.4' cy='.35'><stop offset='0' stop-color='${mix(planet, '#ffffff', 0.3)}'/><stop offset='1' stop-color='${mix(planet, '#000000', 0.5)}'/></radialGradient>`;
      return layer([put(art(460, 430, `<g filter='url(#b)' opacity='.4'>${cracks}</g>` + body, 6, defs), 'right -40px top -40px', 460, 430)]);
    },
    // The Fortress of Solitude: crystal spires rising out of both lower corners.
    fortress(c, glow) {
      const r = rng(5);
      let b = '';
      for (let i = 0; i < 9; i++) {
        const x = 20 + i * 38 + r() * 20, h = 120 + r() * 260, w = 14 + r() * 18, tilt = (r() - 0.5) * 40;
        b += `<polygon points='${pts([[x - w, 420], [x - w * 0.7 + tilt, 420 - h], [x + tilt, 420 - h - w * 1.6], [x + w * 0.7 + tilt, 420 - h], [x + w, 420]])}' fill='${c}' fill-opacity='.1' stroke='${c}' stroke-opacity='.45' stroke-width='1.2'/>` +
          line(x + tilt, 420 - h - w * 1.6, x, 420, '#ffffff', 0.25, 0.8);
      }
      const img = (t) => art(420, 420, `<g transform='${t}'>${lit(b)}</g>`, 3);
      return layer([put(img(''), 'left bottom', 420, 420), put(img('translate(420 0) scale(-1 1)'), 'right bottom', 340, 340), rg(glow, '50% 110%', '70% 35%', 0.16)]);
    },

    // ----- Themyscira -----
    // The Lasso of Truth coiled in the bottom-left, glowing, its free end running off along
    // the floor.
    lasso(gold, glow) {
      let b = '';
      [[220, 300, 170, 58, -12], [240, 290, 140, 48, -6], [230, 296, 190, 66, -16], [250, 284, 120, 40, -2]].forEach(([cx, cy, rx, ry, rot]) => {
        b += `<ellipse cx='${cx}' cy='${cy}' rx='${rx}' ry='${ry}' fill='none' stroke='${gold}' stroke-opacity='.55' stroke-width='3' transform='rotate(${rot} ${cx} ${cy})'/>`;
      });
      b += `<path d='M380 270 C460 240 520 330 620 340' fill='none' stroke='${gold}' stroke-opacity='.5' stroke-width='3'/>`;
      return layer([put(art(640, 420, `<g filter='url(#b)' opacity='.6'>${b.replace(/stroke-width='3'/g, "stroke-width='10'").replace(new RegExp(gold, 'g'), glow)}</g>${b}`, 5), 'left -60px bottom -40px', 640, 420), rg(glow, '0% 100%', '40% 40%', 0.14)]);
    },
    // The double-W, gold, with a scatter of white stars over the top-left.
    wwEmblem(gold, star) {
      const W = (dx, dy) => `<polyline points='${ptsAt([[0, 0], [30, 100], [60, 30], [90, 100], [120, 0]], dx, dy)}' fill='none' stroke='${gold}' stroke-opacity='.65' stroke-width='14' stroke-linejoin='miter'/>`;
      const em = W(10, 20) + W(70, 20) + `<path d='M4 10 C70 -8 150 -8 206 10' fill='none' stroke='${gold}' stroke-opacity='.5' stroke-width='6'/>`;
      const r = rng(13);
      let stars = '';
      for (let i = 0; i < 16; i++) stars += `<polygon points='${starPts(r() * 300, r() * 180, 7 + r() * 5, 3, 5)}' fill='${star}' fill-opacity='${f1(0.2 + r() * 0.3)}'/>`;
      return layer([put(glowArt(212, 140, em, '', 5, 0.4), 'right 40px bottom 40px', 250, 165), put(art(300, 180, lit(stars), 2), 'left 20px top 64px', 300, 180)]);
    },

    // ----- Speed Force -----
    // A lightning emblem in its circle: the Flash's (white field, red rim, gold bolt) or,
    // with the colours turned over, Reverse-Flash's.
    speedEmblem(field, rim, bolt) {
      const body = `<circle cx='100' cy='100' r='92' fill='${field}' fill-opacity='.2' stroke='${rim}' stroke-opacity='.65' stroke-width='8'/>` +
        `<polygon points='${ptsAt([[120, 4], [52, 92], [96, 92], [58, 196], [150, 84], [104, 84], [140, 4]], 0, 0, 1)}' transform='translate(20 0) scale(.8 1)' fill='${bolt}' fill-opacity='.6' stroke='${bolt}' stroke-opacity='.8' stroke-width='2' stroke-linejoin='round'/>`;
      return layer([put(glowArt(200, 200, body, '', 6, 0.5), 'right 40px bottom 40px', 220, 220), rg(rim, '100% 100%', '40% 45%', 0.14)]);
    },
    // Speed: streaks running in from the left with the Speed Force crackling between them.
    speedLines(streak, spark) {
      const r = rng(41);
      let b = '';
      for (let i = 0; i < 22; i++) { const y = 20 + r() * 560, x = r() * 200, l = 200 + r() * 600; b += line(x, y, x + l, y, streak, f1(0.12 + r() * 0.25), 1 + r() * 2.4, "stroke-linecap='round'"); }
      for (let i = 0; i < 6; i++) { const y = 40 + r() * 520, x = r() * 300; b += poly(jag(x, y, x + 160 + r() * 200, y + (r() - 0.5) * 40, 9, 12, r), spark, 0.5, 1.4); }
      return layer([put(art(1000, 600, lit(b), 3), 'left center', 1000, 600)], 'linear-gradient(90deg, #000 0, rgba(0,0,0,.6) 35%, transparent 70%)');
    },
    // The Speed Force as a time vortex: arms spiralling into the top-left corner.
    timeVortex(c, c2) {
      let b = '';
      for (let k = 0; k < 6; k++) b += poly(spiral(80, 80, 6, 0.24, 2.6, k * Math.PI / 3, 0.85), k % 2 ? c2 : c, 0.32, 1.6);
      return layer([put(art(560, 480, lit(b), 4), 'left -40px top 0', 560, 480), rg(c, '0% 0%', '40% 45%', 0.14)]);
    },

    // ----- Oa -----
    // A ring corps' emblem: the circle between two bars. With `spikes`, Sinestro's — the
    // same lantern grown points.
    lanternEmblem(c, glow, spikes = false) {
      let b = `<circle cx='140' cy='110' r='54' fill='none' stroke='${c}' stroke-opacity='.65' stroke-width='16'/>` +
        `<rect x='40' y='34' width='200' height='14' rx='3' fill='${c}' fill-opacity='.55'/><rect x='40' y='172' width='200' height='14' rx='3' fill='${c}' fill-opacity='.55'/>`;
      if (spikes) for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2 + 0.31; b += `<polygon points='${pts([[140 + Math.cos(a - 0.12) * 66, 110 + Math.sin(a - 0.12) * 66], [140 + Math.cos(a) * 104, 110 + Math.sin(a) * 104], [140 + Math.cos(a + 0.12) * 66, 110 + Math.sin(a + 0.12) * 66]])}' fill='${c}' fill-opacity='.4' stroke='${c}' stroke-opacity='.6'/>`; }
      return layer([put(glowArt(280, 220, b, '', 8, 0.7), 'right 50px top 76px', 280, 220), rg(glow, '100% 10%', '45% 45%', 0.18)]);
    },
    // A power battery: the lantern a ring is charged from — round body, window bands, the
    // handle — lit from inside. Sinestro's is the same shape gone sharp.
    powerBattery(c, glow, sharp = false) {
      const crown = sharp ? `<polygon points='60,70 40,30 80,56 100,16 120,56 160,30 140,70' fill='${c}' fill-opacity='.25' stroke='${c}' stroke-opacity='.6' stroke-width='1.5'/>`
        : `<path d='M70 70 C70 30 130 30 130 70' fill='none' stroke='${c}' stroke-opacity='.6' stroke-width='6'/>`;
      const body = crown + `<rect x='54' y='70' width='92' height='16' rx='4' fill='${c}' fill-opacity='.3' stroke='${c}' stroke-opacity='.6'/>` +
        `<path d='M60 86 C40 120 40 190 60 224 H140 C160 190 160 120 140 86 Z' fill='${glow}' fill-opacity='.22' stroke='${c}' stroke-opacity='.65' stroke-width='2'/>` +
        `<path d='M50 130 H150 M48 180 H152' stroke='${c}' stroke-opacity='.5' stroke-width='6'/>` +
        `<ellipse cx='100' cy='155' rx='30' ry='50' fill='#ffffff' fill-opacity='.25'/>` +
        `<rect x='46' y='224' width='108' height='22' rx='4' fill='${c}' fill-opacity='.3' stroke='${c}' stroke-opacity='.6'/>`;
      return layer([put(glowArt(200, 250, body, '', 8, 0.7), 'left 40px bottom 30px', 180, 225), rg(glow, '0% 100%', '40% 45%', 0.16)]);
    },

    // ----- Atlantis -----
    // Orange scale-mail, fading in from the bottom-right.
    scales(c) {
      const tile = svg(28, 20, `<path d='M0 20 A14 14 0 0 1 28 20 M-14 10 A14 14 0 0 1 14 10 M14 10 A14 14 0 0 1 42 10' fill='none' stroke='${c}' stroke-opacity='.3' stroke-width='1.2'/>`);
      return plus(cornerTile(tile, 28, 20, '100% 100%', '44%'), rg(c, '100% 100%', '40% 45%', 0.1));
    },
    // Light shafts slanting down from the surface, and bubbles rising.
    undersea(light, bubble) {
      const r = rng(17);
      let shafts = '';
      for (let i = 0; i < 6; i++) { const x = 100 + i * 200 + r() * 80; shafts += `<polygon points='${pts([[x, 0], [x + 50 + r() * 40, 0], [x - 120 + r() * 60, 700], [x - 220, 700]])}' fill='url(#sh)'/>`; }
      const defs = `<linearGradient id='sh' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${light}' stop-opacity='.16'/><stop offset='1' stop-color='${light}' stop-opacity='0'/></linearGradient>`;
      const bubbles = scatter(51, 26, 260, 400).map(([x, y, s]) => `<circle cx='${x}' cy='${y}' r='${f1(2 + s * 7)}' fill='${bubble}' fill-opacity='.06' stroke='${bubble}' stroke-opacity='.4'/>`).join('');
      return layer([put(svg(1400, 700, `<defs>${defs}</defs>${shafts}`), '50% 0', 1400, 700), put(svg(260, 400, bubbles), 'left 40px bottom 0', 260, 400), put(svg(260, 400, bubbles), 'right 300px bottom 0', 200, 300)]);
    },

    // ----- S.T.A.R. Labs -----
    // Cyborg's eye: a red lens in a segmented socket, targeting ticks, the seams of the plate.
    cyberEye(steel, red) {
      let b = `<circle cx='150' cy='150' r='110' fill='${steel}' fill-opacity='.06' stroke='${steel}' stroke-opacity='.45' stroke-width='2'/>` +
        `<circle cx='150' cy='150' r='84' fill='none' stroke='${steel}' stroke-opacity='.5' stroke-width='10' stroke-dasharray='40 8'/>` +
        `<circle cx='150' cy='150' r='46' fill='${red}' fill-opacity='.35' stroke='${red}' stroke-opacity='.8' stroke-width='3'/>` +
        `<circle cx='150' cy='150' r='14' fill='#ffffff' fill-opacity='.7'/>`;
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; b += line(150 + Math.cos(a) * 54, 150 + Math.sin(a) * 54, 150 + Math.cos(a) * 74, 150 + Math.sin(a) * 74, red, 0.7, 2.4); }
      b += `<path d='M20 70 L70 40 H150 M40 260 L90 230 M240 30 L280 80 V200' fill='none' stroke='${steel}' stroke-opacity='.35' stroke-width='1.5'/>`;
      return layer([put(glowArt(300, 300, b, '', 5, 0.4), 'right 30px bottom 30px', 280, 280), rg(red, '100% 100%', '35% 40%', 0.14)]);
    },
    // A boom tube opening in the top-left: rings of white light round a bright throat.
    boomTube(c, glow) {
      const r = rng(23);
      let b = '';
      for (let k = 0; k < 6; k++) b += `<ellipse cx='200' cy='180' rx='${40 + k * 32}' ry='${28 + k * 24}' fill='none' stroke='${k % 2 ? glow : c}' stroke-opacity='${f1(0.6 - k * 0.07)}' stroke-width='${k ? 1.6 : 4}'/>`;
      for (let i = 0; i < 28; i++) { const a = r() * Math.PI * 2, r1 = 60 + r() * 60, r2 = r1 + 40 + r() * 80; b += line(200 + Math.cos(a) * r1, 180 + Math.sin(a) * r1 * 0.75, 200 + Math.cos(a) * r2, 180 + Math.sin(a) * r2 * 0.75, glow, 0.35, 1); }
      b += `<ellipse cx='200' cy='180' rx='30' ry='22' fill='#ffffff' fill-opacity='.5'/>`;
      return layer([put(art(420, 380, lit(b), 5), 'left -40px top 30px', 420, 380), rg(glow, '0% 10%', '40% 45%', 0.14)]);
    },

    // ----- Mars -----
    // Mars and its two moons in the top-right.
    mars(planet, glow) {
      const r = rng(9);
      let craters = '';
      for (let i = 0; i < 9; i++) { const a = r() * Math.PI * 2, d = r() * 90; craters += `<ellipse cx='${f1(220 + Math.cos(a) * d)}' cy='${f1(190 + Math.sin(a) * d)}' rx='${f1(6 + r() * 14)}' ry='${f1(4 + r() * 10)}' fill='#000000' fill-opacity='.2' stroke='${planet}' stroke-opacity='.4'/>`; }
      const body = `<circle cx='220' cy='190' r='150' fill='${glow}' fill-opacity='.14' filter='url(#b)'/>` +
        `<circle cx='220' cy='190' r='120' fill='url(#mp)' fill-opacity='.45' stroke='${planet}' stroke-opacity='.55' stroke-width='2'/>` + craters +
        `<path d='M120 120 C180 150 260 140 330 160 M108 210 C170 230 250 220 336 240' fill='none' stroke='#000000' stroke-opacity='.15' stroke-width='10'/>` +
        `<circle cx='60' cy='330' r='12' fill='${planet}' fill-opacity='.4' stroke='${planet}' stroke-opacity='.6'/><circle cx='380' cy='360' r='7' fill='${planet}' fill-opacity='.4' stroke='${planet}' stroke-opacity='.6'/>`;
      const defs = `<radialGradient id='mp' cx='.35' cy='.3'><stop offset='0' stop-color='${mix(planet, '#ffffff', 0.3)}'/><stop offset='1' stop-color='${mix(planet, '#000000', 0.55)}'/></radialGradient>`;
      return layer([put(art(420, 400, body, 10, defs), 'right -50px top -30px', 420, 400)]);
    },
    // The Manhunter's harness: two red bands crossed, a disc at each shoulder.
    xStraps(red, disc) {
      const band = (rot) => `<rect x='-260' y='-22' width='520' height='44' fill='${red}' fill-opacity='.18' stroke='${red}' stroke-opacity='.5' stroke-width='2' transform='rotate(${rot})'/>`;
      const discs = [[-170, -150], [170, -150]].map(([x, y]) => `<circle cx='${x}' cy='${y}' r='34' fill='${disc}' fill-opacity='.2' stroke='${disc}' stroke-opacity='.6' stroke-width='4'/><circle cx='${x}' cy='${y}' r='16' fill='none' stroke='${disc}' stroke-opacity='.5'/>`).join('');
      return layer([put(art(560, 460, `<g transform='translate(280 260)'>${lit(band(40) + band(-40) + discs)}</g>`, 4), 'left -120px bottom -120px', 560, 460), rg(red, '0% 100%', '40% 45%', 0.12)]);
    },

    // ----- Star City -----
    // A quiver of trick arrows, fanned: a boxing glove, a net, a plain broadhead.
    quiver(green, steel) {
      let b = `<g transform='rotate(-24 150 300)'><rect x='110' y='170' width='80' height='210' rx='20' fill='${green}' fill-opacity='.2' stroke='${green}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M110 210 H190 M110 340 H190' stroke='${green}' stroke-opacity='.45' stroke-width='4'/>`;
      [[-18, 'glove'], [-6, 'net'], [6, 'head'], [18, 'head']].forEach(([a, kind], i) => {
        b += `<g transform='rotate(${a} 150 200)'>${line(150, 200, 150, 40, steel, 0.6, 2.4)}`;
        b += `<path d='M150 196 l-12 20 v-26 Z M150 196 l12 20 v-26 Z' fill='${green}' fill-opacity='.5'/>`;
        if (kind === 'glove') b += `<ellipse cx='150' cy='30' rx='18' ry='22' fill='${mix(green, '#c03030', 0.6)}' fill-opacity='.4' stroke='${steel}' stroke-opacity='.6'/>`;
        else if (kind === 'net') b += `<circle cx='150' cy='32' r='16' fill='none' stroke='${steel}' stroke-opacity='.6'/><path d='M138 24 L162 40 M162 24 L138 40 M134 32 H166' stroke='${steel}' stroke-opacity='.45'/>`;
        else b += `<polygon points='150,${18 - i * 2} 140,44 160,44' fill='${steel}' fill-opacity='.5' stroke='${steel}' stroke-opacity='.7'/>`;
        b += '</g>';
      });
      b += '</g>';
      return layer([put(glowArt(300, 400, b, '', 4, 0.3), 'right 30px bottom 0', 270, 360), rg(green, '100% 100%', '40% 45%', 0.12)]);
    },
    // Leaves drifting down out of the top-left, the Emerald Archer's forest.
    leaves(c, c2) {
      const r = rng(61);
      let b = '';
      for (let i = 0; i < 18; i++) b += leaf(r() * 420, r() * 320, 18 + r() * 22, r() * 360, i % 3 ? c : c2, 0.22);
      return layer([put(art(440, 340, lit(b), 2), 'left 10px top 56px', 440, 340), rg(c, '0% 0%', '40% 40%', 0.1)]);
    },

    // ----- the Canary Cry -----
    // Sound arcs rolling out from the left edge.
    soundWaves(c) {
      let b = '';
      for (let k = 1; k <= 9; k++) { const R = k * 58; b += `<path d='M0 ${400 - R} A${R} ${R} 0 0 1 0 ${400 + R}' fill='none' stroke='${c}' stroke-opacity='${f1(0.5 - k * 0.04)}' stroke-width='${f1(1 + (k % 3) * 0.8)}' transform='translate(-${f1(R * 0.35)} 0)'/>`; }
      return layer([put(art(620, 800, lit(b), 4), 'left center', 620, 800), rg(c, '0% 50%', '30% 45%', 0.14)]);
    },
    // Fishnet, fading in from the bottom-right.
    fishnet(c) {
      const tile = svg(18, 18, `<path d='M0 0 L18 18 M18 0 L0 18' stroke='${c}' stroke-opacity='.24' stroke-width='.9'/>`);
      return plus(cornerTile(tile, 18, 18, '100% 100%', '40%'), rg(c, '100% 100%', '35% 40%', 0.08));
    },

    // ----- the Rock of Eternity -----
    // The chest bolt, gold, edged in white — the comic-book bolt, not a jagged one.
    chestBolt(gold, edge) {
      const body = `<polygon points='${ptsAt(BOLT, 10, 10, 1.4)}' fill='${gold}' fill-opacity='.4' stroke='${edge}' stroke-opacity='.75' stroke-width='3' stroke-linejoin='round'/>`;
      return layer([put(glowArt(160, 250, body, '', 6, 0.5), 'right 50px bottom 36px', 150, 234), rg(gold, '100% 100%', '40% 45%', 0.14)]);
    },
    // A single strike of magic lightning down from the top edge, flaring where it lands.
    strike(c, glow) {
      const r = rng(77);
      const main = jag(420, 0, 380, 520, 12, 26, r);
      let b = poly(main, glow, 0.35, 9) + poly(main, c, 0.6, 2.4) + poly(main, '#ffffff', 0.6, 0.9);
      for (let i = 0; i < 4; i++) { const t = 0.2 + r() * 0.5, y = 520 * t, x = 420 - 40 * t; const p = jag(x, y, x + (r() - 0.5) * 300, y + 80 + r() * 120, 6, 12, r); b += poly(p, glow, 0.25, 5) + poly(p, c, 0.45, 1.4); }
      return layer([put(art(840, 600, `<g filter='url(#b)'>${b}</g>${b}`, 5), '50% 0', 840, 600), rg(glow, '50% 0%', '40% 25%', 0.16)]);
    },

    // ----- Blüdhaven -----
    // The wingspan across the top: the bird swept out to both sides of the toolbar.
    nightwingSymbol(c, glow) {
      const half = `<path d='M450 120 L430 96 C340 60 200 40 20 14 C150 60 300 90 410 110 Z' fill='${c}' fill-opacity='.3' stroke='${glow}' stroke-opacity='.65' stroke-width='1.6' stroke-linejoin='round'/>`;
      const both = half + `<g transform='translate(900 0) scale(-1 1)'>${half}</g>`;
      return layer([put(art(900, 140, lit(both), 5), '50% 58px', 900, 140), rg(glow, '50% 0%', '50% 22%', 0.12)]);
    },
    // Escrima sticks, crossed, crackling with current.
    escrima(c, spark) {
      const r = rng(4);
      let b = '';
      [[30, 330, 300, 60], [40, 70, 310, 320]].forEach(([x1, y1, x2, y2]) => {
        b += line(x1, y1, x2, y2, c, 0.55, 12, "stroke-linecap='round'") + line(x1, y1, x1 + (x2 - x1) * 0.25, y1 + (y2 - y1) * 0.25, '#000000', 0.3, 13, "stroke-linecap='round'");
        b += poly(jag(x1 + (x2 - x1) * 0.4, y1 + (y2 - y1) * 0.4, x2, y2, 8, 12, r), spark, 0.6, 1.2);
      });
      return layer([put(art(340, 380, lit(b), 4), 'left 30px bottom 20px', 300, 335), rg(spark, '0% 100%', '35% 40%', 0.12)]);
    },

    // ----- the Batcave -----
    // A lettered emblem in a ring: Robin's R.
    letterEmblem(letter, ring, fill, ink) {
      const body = `<circle cx='90' cy='90' r='76' fill='${fill}' fill-opacity='.18' stroke='${ring}' stroke-opacity='.65' stroke-width='10'/>` +
        `<text x='90' y='126' text-anchor='middle' font-family='Impact, Arial Black, sans-serif' font-size='104' fill='${ink}' fill-opacity='.55' stroke='${ring}' stroke-opacity='.6' stroke-width='2'>${letter}</text>`;
      return layer([put(glowArt(180, 180, body, '', 5, 0.4), 'right 40px bottom 40px', 190, 190), rg(ring, '100% 100%', '35% 40%', 0.12)]);
    },
    // A flight of birds over the top-left.
    birds(c) {
      const r = rng(15);
      let b = '';
      for (let i = 0; i < 11; i++) { const x = r() * 420, y = r() * 220, s = 8 + r() * 16; b += `<path d='M${f1(x - s)} ${f1(y)} Q${f1(x - s * 0.5)} ${f1(y - s * 0.6)} ${f1(x)} ${f1(y)} Q${f1(x + s * 0.5)} ${f1(y - s * 0.6)} ${f1(x + s)} ${f1(y)}' fill='none' stroke='${c}' stroke-opacity='${f1(0.3 + r() * 0.3)}' stroke-width='2' stroke-linecap='round'/>`; }
      return layer([put(art(440, 240, lit(b), 2), 'left 20px top 70px', 440, 240)]);
    },
    // A bat drawn as an outline, for the ones who wear the symbol but are not the Bat.
    batOutline(c, glow, solid = 0.12) {
      const body = `<polygon points='${pts(BAT)}' fill='${c}' fill-opacity='${solid}' stroke='${c}' stroke-opacity='.65' stroke-width='2.4' stroke-linejoin='round'/>`;
      return layer([put(glowArt(200, 100, body, '', 4, 0.45), 'right 40px bottom 50px', 280, 140), rg(glow, '100% 100%', '40% 40%', 0.12)]);
    },
    // Oracle's monitors: a wall of windows over the top-left, each scrolling text.
    monitors(c) {
      const r = rng(27);
      let b = '';
      for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) {
        const x = 10 + col * 104, y = 10 + row * 74;
        b += `<rect x='${x}' y='${y}' width='92' height='62' rx='3' fill='${c}' fill-opacity='.05' stroke='${c}' stroke-opacity='.4'/>`;
        for (let k = 0; k < 5; k++) b += line(x + 8, y + 12 + k * 9, x + 8 + 20 + r() * 56, y + 12 + k * 9, c, 0.3, 2);
      }
      return layer([put(art(430, 240, lit(b), 2), 'left 16px top 66px', 430, 240)], 'radial-gradient(ellipse 60% 70% at 0 0, #000 40%, transparent 100%)');
    },

    // ----- Thanagar -----
    // The hawk helmet: a beak drawn down between the eyes, the crest swept back.
    hawkHelm(gold, eye) {
      const half = `<path d='M100 10 C60 10 30 40 26 90 L24 150 C30 180 50 200 72 210 L100 214 Z' fill='url(#hh)' fill-opacity='.36' stroke='${gold}' stroke-opacity='.7' stroke-width='1.6'/>` +
        `<path d='M100 60 C80 66 60 80 46 104 L92 112 Z' fill='#000000' fill-opacity='.45' stroke='${gold}' stroke-opacity='.5'/>` +
        `<path d='M30 60 C10 40 0 20 -4 0 C20 20 40 34 60 40' fill='${gold}' fill-opacity='.25' stroke='${gold}' stroke-opacity='.55'/>`;
      const beak = `<path d='M100 40 L114 120 L100 150 L86 120 Z' fill='url(#hh)' fill-opacity='.55' stroke='${gold}' stroke-opacity='.75' stroke-width='1.6'/>`;
      return layer([put(glowArt(200, 220, sym(half) + beak + `<g filter='url(#b)'>${sym(`<circle cx='72' cy='104' r='6' fill='${eye}'/>`)}</g>`,
        metalG('hh', '#fff1c4', gold, mix(gold, '#000000', 0.55), 0.6, 1), 4, 0.3), 'right 40px bottom 30px', 230, 253), rg(gold, '100% 100%', '40% 45%', 0.12)]);
    },
    // Wings spread along the top edge, feathers layered from the centre out.
    featherWings(c, tip) {
      const feather = (x, y, len, rot, fill, o) => `<g transform='translate(${f1(x)} ${f1(y)}) rotate(${f1(rot)})'><path d='M0 -5 C${f1(len * 0.4)} -9 ${f1(len * 0.8)} -6 ${f1(len)} 0 C${f1(len * 0.8)} 6 ${f1(len * 0.4)} 9 0 5 Z' fill='${fill}' fill-opacity='${o}' stroke='${c}' stroke-opacity='.45' stroke-width='1'/>${line(2, 0, len * 0.9, 0, c, 0.35, 0.8)}</g>`;
      const bone = (t) => [430 - t * 400, 40 - Math.sin(t * Math.PI) * 30 - t * 10];
      let half = '';
      for (let i = 15; i >= 0; i--) { const t = i / 15, [x, y] = bone(t); half += feather(x, y, 70 + Math.sin(t * Math.PI * 0.9 + 0.2) * 80, 96 + t * 40, tip, 0.22); }
      for (let i = 13; i >= 0; i--) { const t = i / 14 + 0.02, [x, y] = bone(t); half += feather(x, y + 4, 38 + Math.sin(t * Math.PI) * 24, 100 + t * 34, c, 0.28); }
      half += `<path d='M430 40 ${[0.25, 0.5, 0.75, 1].map(t => { const [x, y] = bone(t); return `L${f1(x)} ${f1(y)}`; }).join(' ')}' fill='none' stroke='${c}' stroke-opacity='.55' stroke-width='3' stroke-linejoin='round'/>`;
      const both = half + `<g transform='translate(900 0) scale(-1 1)'>${half}</g>`;
      return layer([put(art(900, 240, lit(both), 3), '50% 50px', 900, 240)]);
    },

    // ----- magic -----
    // A top hat with the wand laid across it, sparks flying off the tip.
    topHat(black, band, spark) {
      let b = `<ellipse cx='130' cy='230' rx='110' ry='26' fill='${black}' fill-opacity='.3' stroke='${band}' stroke-opacity='.5' stroke-width='2'/>` +
        `<path d='M64 226 L74 70 C110 58 150 58 186 70 L196 226 Z' fill='${black}' fill-opacity='.3' stroke='${band}' stroke-opacity='.5' stroke-width='2'/>` +
        `<ellipse cx='130' cy='70' rx='56' ry='14' fill='${black}' fill-opacity='.3' stroke='${band}' stroke-opacity='.5' stroke-width='2'/>` +
        `<path d='M68 186 L192 186 L194 208 L66 208 Z' fill='${band}' fill-opacity='.4'/>` +
        `<g transform='rotate(-30 130 150)'><rect x='30' y='144' width='200' height='12' rx='3' fill='${black}' fill-opacity='.5' stroke='${band}' stroke-opacity='.4'/><rect x='200' y='144' width='30' height='12' fill='#ffffff' fill-opacity='.55'/></g>`;
      const r = rng(3);
      for (let i = 0; i < 9; i++) b += `<polygon points='${starPts(240 + r() * 60, 20 + r() * 80, 6 + r() * 6, 1.6, 4)}' fill='${spark}' fill-opacity='.7'/>`;
      return layer([put(glowArt(310, 270, b, '', 4, 0.35), 'right 30px bottom 30px', 290, 252), rg(band, '100% 100%', '40% 45%', 0.12)]);
    },
    // A spell spoken backwards, trailing sparkles across the top-left.
    backwardsSpell(c, text) {
      const r = rng(83);
      let b = `<text x='30' y='120' font-family='Georgia, serif' font-style='italic' font-size='46' fill='${c}' fill-opacity='.28' transform='rotate(-6 30 120)'>${text}</text>`;
      for (let i = 0; i < 26; i++) { const t = i / 25, x = 20 + t * 520, y = 170 - Math.sin(t * Math.PI) * 120 + (r() - 0.5) * 30; b += `<polygon points='${starPts(x, y, 3 + r() * 6, 1, 4)}' fill='${c}' fill-opacity='${f1(0.25 + r() * 0.45)}'/>`; }
      return layer([put(art(560, 220, lit(b), 2), 'left 10px top 60px', 560, 220)]);
    },
    // An occult circle: two rings, a pentagram, runes between, smouldering orange.
    sigil(c, glow) {
      const r = rng(66);
      let b = `<circle cx='150' cy='150' r='130' fill='none' stroke='${c}' stroke-opacity='.55' stroke-width='2.4'/><circle cx='150' cy='150' r='106' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='1.4'/>`;
      const star = [0, 2, 4, 1, 3, 0].map(i => { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; return [150 + 104 * Math.cos(a), 150 + 104 * Math.sin(a)]; });
      b += `<polyline points='${pts(star)}' fill='${glow}' fill-opacity='.05' stroke='${c}' stroke-opacity='.6' stroke-width='2'/>`;
      for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2, x = 150 + 118 * Math.cos(a), y = 150 + 118 * Math.sin(a); b += `<path d='M${f1(x - 4)} ${f1(y - 4)} l${f1(r() * 8)} ${f1(r() * 8)} m-6 0 l${f1(r() * 6)} -3' stroke='${c}' stroke-opacity='.5' stroke-width='1.2' transform='rotate(${f1(a * 57.3 + 90)} ${f1(x)} ${f1(y)})'/>`; }
      return layer([put(glowArt(300, 300, b, '', 5, 0.5), 'right 20px bottom 20px', 300, 300), rg(glow, '100% 100%', '40% 45%', 0.14)]);
    },
    // Cigarette smoke curling up out of the bottom-left, the ember at its root.
    smokeWisps(c, ember) {
      let b = '';
      [[60, 0.4, 2.4], [90, 0.3, 1.8], [40, 0.22, 1.4]].forEach(([x, o, w], i) => {
        b += `<path d='M${x} 520 C${x + 40} 440 ${x - 40} 400 ${x + 10} 330 S${x + 90} 220 ${x + 40} 140 S${x + 60} 40 ${x + 120 + i * 30} 0' fill='none' stroke='${c}' stroke-opacity='${o}' stroke-width='${w}'/>`;
      });
      return layer([put(art(300, 540, `<g filter='url(#b)'>${b}</g>${b}<circle cx='60' cy='522' r='5' fill='${ember}' fill-opacity='.9'/><circle cx='60' cy='522' r='16' fill='${ember}' fill-opacity='.25'/>`, 6), 'left 30px bottom 0', 300, 540), rg(ember, '0% 100%', '25% 25%', 0.12)]);
    },
    // A raven of shadow spread over the top-right, outlined in light, eyes white.
    soulRaven(dark, glow) {
      const half = `<path d='M100 70 C96 50 98 36 100 30 C70 20 40 0 0 0 C30 20 50 40 60 60 C30 54 10 60 0 70 C40 80 70 90 84 110 L100 150 Z' fill='${dark}' fill-opacity='.5' stroke='${glow}' stroke-opacity='.6' stroke-width='1.4' stroke-linejoin='round'/>`;
      const bird = sym(half) + `<path d='M88 150 L100 190 L112 150 Z' fill='${dark}' fill-opacity='.5' stroke='${glow}' stroke-opacity='.5'/>` +
        `<path d='M94 26 L100 14 L106 26 Z' fill='${glow}' fill-opacity='.4'/>` + `<g filter='url(#b)'>${sym(`<ellipse cx='92' cy='44' rx='4' ry='2.6' fill='#ffffff'/>`)}</g>` + sym(`<ellipse cx='92' cy='44' rx='4' ry='2.6' fill='#ffffff' fill-opacity='.9'/>`);
      return layer([put(glowArt(200, 200, bird, '', 6, 0.5), 'right -40px top 40px', 520, 520), rg(glow, '100% 20%', '45% 45%', 0.12)]);
    },

    // ----- the Reach -----
    // The scarab: shell halves, the line between, the head and six legs.
    scarab(blue, gold) {
      const half = `<path d='M100 60 C70 60 46 80 44 120 C42 170 66 210 100 220 Z' fill='${blue}' fill-opacity='.3' stroke='${gold}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M60 90 C50 130 56 180 84 206' fill='none' stroke='#ffffff' stroke-opacity='.3' stroke-width='1.5'/>` +
        `<path d='M48 100 L18 84 L6 60 M44 140 L10 140 L-4 128 M50 180 L18 200 L10 224' fill='none' stroke='${gold}' stroke-opacity='.5' stroke-width='3' stroke-linecap='round'/>`;
      const body = sym(half) + `<path d='M100 60 V220' stroke='${gold}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M76 62 C76 36 124 36 124 62 Z' fill='${blue}' fill-opacity='.4' stroke='${gold}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M86 42 L76 18 M114 42 L124 18' stroke='${gold}' stroke-opacity='.5' stroke-width='2.4'/>`;
      return layer([put(glowArt(200, 230, body, '', 5, 0.45), 'right 40px bottom 30px', 220, 253), rg(blue, '100% 100%', '40% 45%', 0.14)]);
    },
    // Reach glyphs: angular traces in the top-right, every corner at forty-five degrees.
    reachGlyphs(c) {
      const r = rng(88);
      let b = '';
      for (let i = 0; i < 9; i++) {
        let x = 120 + r() * 380, y = r() * 220, d = `M${f1(x)} ${f1(y)}`;
        for (let k = 0; k < 5; k++) { const dir = Math.floor(r() * 4), l = 20 + r() * 40; const v = [[1, 0], [1, 1], [0, 1], [-1, 1]][dir]; x += v[0] * l; y += v[1] * l; d += ` L${f1(x)} ${f1(y)}`; }
        b += `<path d='${d}' fill='none' stroke='${c}' stroke-opacity='.4' stroke-width='1.6'/><circle cx='${f1(x)}' cy='${f1(y)}' r='3' fill='${c}' fill-opacity='.7'/>`;
      }
      return layer([put(art(560, 340, lit(b), 3), 'right 0 top 56px', 560, 340), rg(c, '100% 0%', '40% 40%', 0.12)]);
    },

    // ----- Tamaran -----
    // Starbolts: green balls of light flying up out of the bottom-left on trails.
    starbolts(c, core) {
      let b = '';
      [[80, 520, 360, 220], [40, 420, 300, 120], [160, 560, 520, 320], [20, 300, 200, 60]].forEach(([x1, y1, x2, y2]) => {
        b += `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}' stroke='url(#tr)' stroke-width='8' stroke-linecap='round'/>`;
        b += `<circle cx='${x2}' cy='${y2}' r='22' fill='${c}' fill-opacity='.35'/><circle cx='${x2}' cy='${y2}' r='11' fill='${core}' fill-opacity='.8'/>`;
      });
      const defs = `<linearGradient id='tr' x1='0' y1='1' x2='1' y2='0'><stop offset='0' stop-color='${c}' stop-opacity='0'/><stop offset='1' stop-color='${c}' stop-opacity='.5'/></linearGradient>`;
      return layer([put(art(600, 600, `<g filter='url(#b)'>${b}</g>${b}`, 8, defs), 'left 0 bottom 0', 600, 600)]);
    },
    // Hair that burns: flames pouring down from the top-right corner.
    fireHair(cols) {
      const fire = fireBody(700, 320, 12, cols, { heat: 0.9, id: 'fh' });
      const fade = fadeMask('fm', 700, 320, 700, 0, 640, 0.2);
      return layer([put(svg(700, 320, `<defs>${fire.defs}${fade}</defs><g mask='url(#fm)' opacity='.55'><g transform='translate(0 320) scale(1 -1)'>${fire.art}</g></g>`), 'right 0 top 0', 700, 320)]);
    },

    // ----- the 31st century -----
    // A Legion flight ring: the gold band and its L, under a sparse star field.
    legionRing(gold, glow) {
      const body = `<circle cx='100' cy='100' r='70' fill='none' stroke='${gold}' stroke-opacity='.6' stroke-width='18'/><circle cx='100' cy='100' r='82' fill='none' stroke='${gold}' stroke-opacity='.4'/>` +
        `<circle cx='100' cy='100' r='40' fill='${glow}' fill-opacity='.18' stroke='${gold}' stroke-opacity='.55' stroke-width='3'/>` +
        `<path d='M86 76 V122 H118' fill='none' stroke='${gold}' stroke-opacity='.75' stroke-width='9' stroke-linejoin='miter'/>`;
      return layer([put(glowArt(200, 200, body, '', 5, 0.45), 'left 40px bottom 40px', 170, 170), rg(glow, '0% 100%', '35% 40%', 0.12), starfield('#ffffff')],
        'radial-gradient(ellipse 50% 60% at 0 100%, #000 50%, transparent 100%), radial-gradient(ellipse 50% 40% at 50% 0, #000 0, transparent 100%)');
    },
    // Cosmic Boy's magnetism: iron debris riding elliptical orbits round a point.
    orbitDebris(c, field) {
      const r = rng(71);
      let b = '';
      [[160, 60, -20], [220, 90, 10], [280, 120, -8]].forEach(([rx, ry, rot]) => {
        b += `<ellipse cx='300' cy='200' rx='${rx}' ry='${ry}' fill='none' stroke='${field}' stroke-opacity='.3' stroke-width='1.2' stroke-dasharray='6 6' transform='rotate(${rot} 300 200)'/>`;
        for (let i = 0; i < 4; i++) {
          const a = r() * Math.PI * 2, rr = rot * Math.PI / 180, ex = rx * Math.cos(a), ey = ry * Math.sin(a);
          const x = 300 + ex * Math.cos(rr) - ey * Math.sin(rr), y = 200 + ex * Math.sin(rr) + ey * Math.cos(rr), s = 6 + r() * 12;
          b += `<polygon points='${pts([[x - s, y - s * 0.4], [x - s * 0.2, y - s], [x + s, y - s * 0.3], [x + s * 0.6, y + s * 0.8], [x - s * 0.6, y + s * 0.6]])}' fill='${c}' fill-opacity='.3' stroke='${c}' stroke-opacity='.6'/>`;
        }
      });
      b += `<circle cx='300' cy='200' r='22' fill='${field}' fill-opacity='.4'/>`;
      return layer([put(art(600, 400, lit(b), 4), 'right -60px top 40px', 600, 400), rg(field, '100% 15%', '40% 40%', 0.14)]);
    },
    // A ringed planet in the top-right, telepathy rippling out round it.
    ringedPlanet(planet, ring, wave) {
      let b = '';
      for (let k = 1; k <= 5; k++) b += `<circle cx='260' cy='170' r='${120 + k * 36}' fill='none' stroke='${wave}' stroke-opacity='${f1(0.3 - k * 0.04)}' stroke-width='1.2'/>`;
      b += `<path d='M70 200 A200 50 -14 0 1 450 120' fill='none' stroke='${ring}' stroke-opacity='.4' stroke-width='10'/>`;
      b += `<circle cx='260' cy='170' r='90' fill='url(#sp)' fill-opacity='.45' stroke='${planet}' stroke-opacity='.6' stroke-width='2'/>`;
      b += `<path d='M70 200 A200 50 -14 0 0 450 120' fill='none' stroke='${ring}' stroke-opacity='.55' stroke-width='10'/>`;
      const defs = `<radialGradient id='sp' cx='.35' cy='.3'><stop offset='0' stop-color='${mix(planet, '#ffffff', 0.35)}'/><stop offset='1' stop-color='${mix(planet, '#000000', 0.5)}'/></radialGradient>`;
      return layer([put(art(520, 440, `<g filter='url(#b)' opacity='.5'>${b}</g>${b}`, 4, defs), 'right -60px top 20px', 520, 440)]);
    },
    // Branching lightning — a Lichtenberg tree — reaching down from the top-right corner.
    lightningTree(c, glow) {
      const r = rng(12);
      let b = '';
      const grow = (x, y, a, len, depth) => {
        if (depth > 4 || len < 18) return;
        const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len, p = jag(x, y, x2, y2, 4, len * 0.1, r);
        b += poly(p, glow, f1(0.3 - depth * 0.04), 7 - depth) + poly(p, c, f1(0.65 - depth * 0.1), 2 - depth * 0.3);
        grow(x2, y2, a + 0.4 + r() * 0.3, len * 0.72, depth + 1);
        grow(x2, y2, a - 0.4 - r() * 0.3, len * 0.66, depth + 1);
      };
      grow(560, 0, 2.2, 150, 0);
      grow(600, 60, 2.6, 130, 1);
      return layer([put(art(600, 520, `<g filter='url(#b)'>${b}</g>${b}`, 4), 'right 0 top 56px', 600, 520), rg(glow, '100% 10%', '40% 40%', 0.14)]);
    },
    // A force-field bubble, hexagon-faceted, with Brainiac 5's working floating beside it.
    forceField(c, text) {
      let b = `<circle cx='150' cy='150' r='120' fill='${c}' fill-opacity='.06' stroke='${c}' stroke-opacity='.55' stroke-width='2'/>`;
      for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; b += line(150, 150, 150 + Math.cos(a) * 120, 150 + Math.sin(a) * 120, c, 0.2, 1); }
      b += `<polygon points='${pts([0, 1, 2, 3, 4, 5].map(i => [150 + 70 * Math.cos(i * Math.PI / 3), 150 + 70 * Math.sin(i * Math.PI / 3)]))}' fill='none' stroke='${c}' stroke-opacity='.4'/>`;
      b += `<path d='M70 70 C110 40 190 40 230 70' fill='none' stroke='#ffffff' stroke-opacity='.3' stroke-width='3' stroke-linecap='round'/>`;
      const eq = ['div E = rho/e0', 'e^(i*pi) + 1 = 0', 'sum 1/n^2 = pi^2/6', 'O(log n)', 'git bisect', 'P = NP ?'].map((t, i) =>
        `<text x='${10 + (i % 2) * 220}' y='${30 + Math.floor(i / 2) * 50}' font-family='Consolas, monospace' font-size='20' fill='${text}' fill-opacity='.35'>${t}</text>`).join('');
      return layer([put(glowArt(300, 300, b, '', 4, 0.4), 'right 30px bottom 30px', 260, 260), put(art(460, 160, eq, 2), 'right 300px top 70px', 460, 160)]);
    },

    // ----- anti-heroes -----
    // Cat's eyes in the dark top-right: almond, slit-pupilled, glowing.
    catEyes(c, glow) {
      const eye = (x) => `<path d='M${x - 50} 60 Q${x} 18 ${x + 50} 60 Q${x} 92 ${x - 50} 60 Z' fill='${c}' fill-opacity='.4' stroke='${glow}' stroke-opacity='.7' stroke-width='2'/><ellipse cx='${x}' cy='60' rx='6' ry='26' fill='#000000' fill-opacity='.7'/>`;
      return layer([put(glowArt(320, 120, eye(80) + eye(240), '', 6, 0.7), 'right 60px top 90px', 320, 120), rg(glow, '85% 15%', '30% 25%', 0.1)]);
    },
    // A whip uncoiling along the bottom, a diamond catching light at its end.
    whipDiamond(leather, glint) {
      const whip = `<path d='M40 260 C200 180 260 300 420 240 S700 160 860 230' fill='none' stroke='${leather}' stroke-opacity='.5' stroke-width='4' stroke-linecap='round'/><path d='M40 260 L10 290' stroke='${leather}' stroke-opacity='.6' stroke-width='10' stroke-linecap='round'/>`;
      const gem = `<polygon points='900,200 930,220 900,270 870,220' fill='${glint}' fill-opacity='.3' stroke='${glint}' stroke-opacity='.8' stroke-width='1.6'/><path d='M870 220 H930 M885 220 L900 200 L915 220 L900 270' fill='none' stroke='${glint}' stroke-opacity='.6'/>` +
        `<polygon points='${starPts(900, 200, 30, 3, 4)}' fill='#ffffff' fill-opacity='.6'/>`;
      return layer([put(art(960, 320, lit(whip + gem), 4), '50% 100%', 960, 320)]);
    },
    // Harlequin diamonds in red and black, fading in from the bottom-left.
    harlequin(red, black) {
      const tile = svg(40, 60, `<polygon points='20,0 40,30 20,60 0,30' fill='${red}' fill-opacity='.2' stroke='${red}' stroke-opacity='.3'/><polygon points='0,30 20,60 0,90 -20,60' fill='${black}' fill-opacity='.3'/><polygon points='40,30 60,60 40,90 20,60' fill='${black}' fill-opacity='.3'/><polygon points='0,-30 20,0 0,30 -20,0' fill='${black}' fill-opacity='.3'/><polygon points='40,-30 60,0 40,30 20,0' fill='${black}' fill-opacity='.3'/>`);
      return plus(cornerTile(tile, 40, 60, '0% 100%', '44%'), rg(red, '0% 100%', '40% 40%', 0.12));
    },
    // A carnival mallet in the bottom-right, hearts floating off it.
    mallet(head, handle, heart) {
      const hrt = (x, y, s, o) => `<path d='M${x} ${y + s * 0.9} C${x - s * 1.4} ${y} ${x - s * 0.7} ${y - s * 0.9} ${x} ${y - s * 0.3} C${x + s * 0.7} ${y - s * 0.9} ${x + s * 1.4} ${y} ${x} ${y + s * 0.9} Z' fill='${heart}' fill-opacity='${o}' stroke='${heart}' stroke-opacity='.6'/>`;
      const b = `<g transform='rotate(-35 170 200)'><rect x='160' y='120' width='20' height='220' rx='6' fill='${handle}' fill-opacity='.3' stroke='${handle}' stroke-opacity='.6'/>` +
        `<rect x='90' y='50' width='160' height='84' rx='12' fill='${head}' fill-opacity='.3' stroke='${head}' stroke-opacity='.65' stroke-width='2'/>` +
        `<rect x='90' y='50' width='26' height='84' rx='6' fill='${handle}' fill-opacity='.35'/><rect x='224' y='50' width='26' height='84' rx='6' fill='${handle}' fill-opacity='.35'/></g>` +
        hrt(60, 60, 16, 0.35) + hrt(30, 130, 10, 0.3) + hrt(90, 20, 8, 0.4);
      return layer([put(glowArt(340, 360, b, '', 4, 0.3), 'right 30px bottom 10px', 320, 340), rg(head, '100% 100%', '40% 45%', 0.12)]);
    },
    // Deathstroke's mask: black on one side, orange on the other, one eye slit.
    splitMask(orange, black, steel) {
      const shape = 'M100 8 C52 8 24 44 24 100 C24 160 56 200 100 210 C144 200 176 160 176 100 C176 44 148 8 100 8 Z';
      const body = `<defs><clipPath id='lh'><rect width='100' height='220'/></clipPath><clipPath id='rh'><rect x='100' width='100' height='220'/></clipPath></defs>` +
        `<path d='${shape}' fill='${black}' fill-opacity='.55' clip-path='url(#lh)'/><path d='${shape}' fill='${orange}' fill-opacity='.35' clip-path='url(#rh)'/>` +
        `<path d='${shape}' fill='none' stroke='${steel}' stroke-opacity='.6' stroke-width='1.8'/><path d='M100 8 V210' stroke='${steel}' stroke-opacity='.5' stroke-width='1.4'/>` +
        `<path d='M110 92 L156 84 L152 100 L114 104 Z' fill='#ffffff' fill-opacity='.85'/>` +
        `<path d='M60 150 H140 M70 168 H130' stroke='${steel}' stroke-opacity='.35' stroke-width='1.4'/>`;
      return layer([put(glowArt(200, 220, body, '', 4, 0.3), 'right 40px bottom 30px', 220, 242), rg(orange, '100% 100%', '40% 45%', 0.12)]);
    },
    // A sword drawn across the top-right, spent cartridges scattered beneath it.
    swordCasings(steel, brass) {
      const r = rng(55);
      let b = `<g transform='translate(520 40) rotate(140)'><polygon points='0,-6 380,-4 420,0 380,4 0,6' fill='${steel}' fill-opacity='.16' stroke='${steel}' stroke-opacity='.65' stroke-width='1.3'/>` +
        line(10, 0, 360, 0, '#ffffff', 0.35, 0.8) + `<rect x='-60' y='-5' width='56' height='10' rx='3' fill='${steel}' fill-opacity='.3' stroke='${steel}' stroke-opacity='.5'/><rect x='-6' y='-22' width='8' height='44' fill='${steel}' fill-opacity='.4'/></g>`;
      for (let i = 0; i < 7; i++) { const x = 300 + r() * 260, y = 200 + r() * 140; b += `<rect x='${f1(x)}' y='${f1(y)}' width='18' height='7' rx='2' fill='${brass}' fill-opacity='.4' stroke='${brass}' stroke-opacity='.6' transform='rotate(${f1(r() * 180)} ${f1(x)} ${f1(y)})'/>`; }
      return layer([put(art(560, 360, lit(b), 4), 'right 10px top 56px', 560, 360)]);
    },
    // The Red Hood: a smooth red dome, two hard white lenses.
    hoodHelmet(red, white) {
      const half = `<path d='M100 6 C52 6 24 44 24 100 C24 160 50 196 80 208 L100 210 Z' fill='url(#rh)' fill-opacity='.42' stroke='${red}' stroke-opacity='.7' stroke-width='1.8'/>` +
        `<path d='M48 96 L92 104 L90 120 L56 116 Z' fill='${white}' fill-opacity='.85'/>`;
      return layer([put(glowArt(200, 220, sym(half) + `<path d='M60 26 C80 14 120 14 140 26' fill='none' stroke='#ffffff' stroke-opacity='.4' stroke-width='3' stroke-linecap='round'/>` + `<g filter='url(#b)'>${sym(`<path d='M48 96 L92 104 L90 120 L56 116 Z' fill='${white}'/>`)}</g>`,
        metalG('rh', mix(red, '#ffffff', 0.35), red, mix(red, '#000000', 0.6), 0.6, 1), 4, 0.35), 'right 40px bottom 30px', 220, 242), rg(red, '100% 100%', '40% 45%', 0.14)]);
    },
    // Two pistols crossed in the top-left, a red bat stencilled behind them.
    crossedPistols(steel, red) {
      const gun = (rot) => `<g transform='translate(200 150) rotate(${rot})'><rect x='-20' y='-12' width='150' height='24' rx='4' fill='${steel}' fill-opacity='.18' stroke='${steel}' stroke-opacity='.6' stroke-width='1.6'/>` +
        `<path d='M-20 -6 L-80 4 L-90 60 L-56 64 L-44 12 L-20 12' fill='${steel}' fill-opacity='.2' stroke='${steel}' stroke-opacity='.6' stroke-width='1.6'/><circle cx='-30' cy='20' r='8' fill='none' stroke='${steel}' stroke-opacity='.5'/></g>`;
      const bat = `<polygon points='${ptsAt(BAT, 80, 90, 1.2)}' fill='${red}' fill-opacity='.18' stroke='${red}' stroke-opacity='.45'/>`;
      return layer([put(art(400, 300, lit(bat + gun(-35) + `<g transform='translate(400 0) scale(-1 1)'>${gun(-35)}</g>`), 3), 'left 10px top 56px', 400, 300), rg(red, '0% 0%', '35% 40%', 0.12)]);
    },
    // Swamp vines climbing out of both lower corners, curling, leafing.
    vines(c, leafC) {
      const r = rng(44);
      let b = '';
      for (let k = 0; k < 5; k++) {
        const x0 = 20 + k * 60, p = spiral(x0 + 60, 120 + k * 30, 8, 0.28, 1.4, k, 1);
        b += `<path d='M${x0} 520 C${x0 + 40} 420 ${x0 - 20} 320 ${x0 + 50} 230' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='${4 - k * 0.5}'/>` + poly(p, c, 0.35, 1.6);
        for (let i = 0; i < 5; i++) b += leaf(x0 + r() * 60, 260 + r() * 250, 16 + r() * 14, -60 - r() * 120, leafC, 0.25);
      }
      const img = (t) => art(380, 520, `<g transform='${t}'>${lit(b)}</g>`, 3);
      return layer([put(img(''), 'left bottom', 380, 520), put(img('translate(380 0) scale(-1 1)'), 'right bottom', 330, 450)]);
    },
    // Swamp mist low along the floor, fireflies drifting in it.
    swampMist(c, fly) {
      const m = mist('sw', 1400, 420, 700, 470, 680, c, { freq: '0.007 0.014', seed: 7 });
      const flies = scatter(77, 22, 300, 300).map(([x, y, s]) => `<circle cx='${x}' cy='${y}' r='${f1(1.2 + s * 2)}' fill='${fly}' fill-opacity='${f1(0.4 + s * 0.4)}'/>`).join('');
      return layer([`${svg(1400, 420, `<defs>${m.defs}</defs>${m.body}`)} 50% 100% / 1400px 420px no-repeat`, `${art(300, 300, lit(flies), 2)} 0 0 / 300px 300px repeat`],
        'linear-gradient(0deg, #000 0, rgba(0,0,0,.6) 25%, transparent 55%)');
    },
    // Lobo's hook and chain, swinging in from the top-right.
    hookChain(steel) {
      let b = '';
      for (let i = 0; i < 14; i++) { const t = i / 13, x = 540 - t * 300 - Math.sin(t * Math.PI) * 60, y = 0 + t * 300; b += `<ellipse cx='${f1(x)}' cy='${f1(y)}' rx='${i % 2 ? 7 : 14}' ry='${i % 2 ? 14 : 8}' fill='none' stroke='${steel}' stroke-opacity='.55' stroke-width='4' transform='rotate(${f1(-45 + t * 20)} ${f1(x)} ${f1(y)})'/>`; }
      b += `<path d='M240 300 V350 C240 400 180 410 168 370 L186 362 C194 384 222 380 222 350 V300' fill='${steel}' fill-opacity='.3' stroke='${steel}' stroke-opacity='.7' stroke-width='2'/><polygon points='168,370 160,346 186,362' fill='${steel}' fill-opacity='.6'/>`;
      return layer([put(art(560, 420, lit(b), 3), 'right 0 top 56px', 560, 420)]);
    },
    // An exhaust trail torn across the bottom-left: a space bike passing through.
    exhaust(cols, star) {
      const fire = fireBody(600, 200, 31, cols, { heat: 0.7, id: 'ex' });
      const fade = fadeMask('fm', 600, 200, 0, 200, 560, 0.2);
      return layer([put(svg(600, 200, `<defs>${fire.defs}${fade}</defs><g mask='url(#fm)' opacity='.5'>${fire.art}</g>`), 'left 0 bottom 0', 600, 200), starfield(star)],
        'radial-gradient(ellipse 70% 60% at 0 100%, #000 40%, transparent 100%), radial-gradient(ellipse 60% 50% at 100% 0, #000 0, transparent 100%)');
    },
    // Kahndaq: a pyramid and an obelisk on the horizon, lightning on the pyramid's point.
    pyramid(stone, bolt) {
      const r = rng(22);
      const p = jag(250, 0, 250, 180, 8, 18, r);
      const b = `<polygon points='60,420 250,180 440,420' fill='${stone}' fill-opacity='.14' stroke='${stone}' stroke-opacity='.5' stroke-width='1.6'/><path d='M250 180 L300 420' stroke='${stone}' stroke-opacity='.3'/>` +
        `<polygon points='480,420 492,220 506,200 520,220 532,420' fill='${stone}' fill-opacity='.14' stroke='${stone}' stroke-opacity='.5' stroke-width='1.4'/>` +
        poly(p, bolt, 0.3, 8) + poly(p, bolt, 0.7, 2) + `<circle cx='250' cy='180' r='16' fill='${bolt}' fill-opacity='.5'/>`;
      return layer([put(art(560, 420, `<g filter='url(#b)'>${poly(p, bolt, 0.5, 6)}</g>${b}`, 5), 'left 20px bottom 0', 560, 420)]);
    },
    // Desert dust blowing along the floor, and a small gold bolt in the far corner.
    sandstorm(c, gold) {
      const m = mist('sd', 1400, 380, 700, 430, 700, c, { freq: '0.004 0.02', seed: 17, o: -1.2 });
      const bolt = `<polygon points='${ptsAt(BOLT, 4, 4, 0.9)}' fill='${gold}' fill-opacity='.4' stroke='${gold}' stroke-opacity='.7' stroke-width='2' stroke-linejoin='round'/>`;
      return layer([`${svg(1400, 380, `<defs>${m.defs}</defs>${m.body}`)} 50% 100% / 1400px 380px no-repeat`, put(glowArt(100, 160, bolt, '', 4, 0.5), 'right 50px bottom 40px', 90, 144)],
        'linear-gradient(0deg, #000 0, rgba(0,0,0,.6) 20%, transparent 40%)');
    },
    // Rose vines with thorns, climbing in from the bottom-left, red blooms open.
    roses(stem, bloom) {
      const r = rng(35);
      let b = '';
      for (let k = 0; k < 4; k++) {
        const x0 = 20 + k * 70, x1 = x0 + 120 + r() * 120, y1 = 120 + r() * 180;
        b += `<path d='M${x0} 520 C${x0 + 60} 420 ${x1 - 80} ${y1 + 100} ${x1} ${y1}' fill='none' stroke='${stem}' stroke-opacity='.5' stroke-width='3'/>`;
        for (let i = 1; i < 6; i++) { const t = i / 6, x = x0 + (x1 - x0) * t, y = 520 + (y1 - 520) * t; b += `<polygon points='${pts([[x - 3, y], [x + 10, y - 4], [x + 2, y + 4]])}' fill='${stem}' fill-opacity='.6'/>`; b += leaf(x, y, 14, -40 + r() * 80, stem, 0.25); }
        let rose = '';
        for (let p = 0; p < 3; p++) rose += `<circle cx='${f1(x1)}' cy='${f1(y1)}' r='${18 - p * 5}' fill='${bloom}' fill-opacity='.22' stroke='${bloom}' stroke-opacity='.6' stroke-dasharray='${10 - p * 2} 4'/>`;
        b += rose;
      }
      return layer([put(art(480, 540, lit(b), 3), 'left 0 bottom 0', 480, 540), rg(bloom, '0% 100%', '35% 40%', 0.1)]);
    },
    // Pollen and spores, drifting everywhere, faint.
    pollen(c, c2) {
      const dots = scatter(91, 34, 260, 260).map(([x, y, s], i) => `<circle cx='${x}' cy='${y}' r='${f1(0.8 + s * 2.4)}' fill='${i % 3 ? c : c2}' fill-opacity='${f1(0.2 + s * 0.3)}'/>`).join('');
      return layer([`${art(260, 260, lit(dots), 1.5)} 0 0 / 260px 260px repeat`], 'radial-gradient(ellipse 80% 80% at 50% 50%, transparent 30%, #000 90%)');
    },
    // Peacemaker's helmet: a chrome dome with the flat brim round it, the dove on its front.
    peaceHelmet(chrome, dove) {
      const body = `<ellipse cx='130' cy='150' rx='120' ry='40' fill='url(#ph)' fill-opacity='.3' stroke='${chrome}' stroke-opacity='.65' stroke-width='2'/>` +
        `<path d='M50 150 C50 60 210 60 210 150 Z' fill='url(#ph)' fill-opacity='.42' stroke='${chrome}' stroke-opacity='.7' stroke-width='2'/>` +
        `<path d='M80 96 C110 76 150 76 176 92' fill='none' stroke='#ffffff' stroke-opacity='.55' stroke-width='4' stroke-linecap='round'/>` +
        `<path d='M110 130 C120 112 140 110 150 120 L170 112 L156 126 C150 138 128 142 110 130 Z' fill='${dove}' fill-opacity='.6'/>`;
      return layer([put(glowArt(260, 200, body, metalG('ph', '#ffffff', chrome, mix(chrome, '#000000', 0.55), 0.5, 1), 4, 0.35), 'right 30px bottom 40px', 260, 200), rg(dove, '100% 100%', '40% 45%', 0.12)]);
    },
    // A dove, wings up, over the top-left.
    dove(c) {
      const ink = `fill='${c}' fill-opacity='.16' stroke='${c}' stroke-opacity='.55' stroke-width='1.6' stroke-linejoin='round'`;
      const d = `<path d='M150 120 C170 80 200 40 250 14 C244 50 236 84 214 116 Z' ${ink}/>` +
        `<path d='M40 128 C60 108 100 104 140 112 C180 118 220 126 250 120 L282 108 L274 132 L284 150 L246 140 C200 154 140 160 100 152 C70 148 52 140 40 128 Z' ${ink}/>` +
        `<path d='M120 116 C130 70 150 30 196 4 C192 44 186 80 166 116 Z' ${ink}/>` +
        `<path d='M40 128 L22 132 L40 136 Z' fill='${c}' fill-opacity='.6'/><circle cx='54' cy='124' r='3' fill='${c}' fill-opacity='.8'/>` +
        `<path d='M26 134 C14 150 10 166 16 180' fill='none' stroke='${c}' stroke-opacity='.5' stroke-width='1.4'/>` + [[18, 146, 200], [12, 162, 160], [20, 172, 230]].map(([x, y, rot]) => leaf(x, y, 12, rot, c, 0.3)).join('');
      return layer([put(art(300, 200, lit(d), 4), 'left 20px top 70px', 300, 200), rg(c, '0% 0%', '35% 35%', 0.1)]);
    },

    // ----- villains -----
    // A Joker card, tilted in the bottom-right: the frame, the corner J's, the jester.
    jokerCard(purple, green, ink) {
      const body = `<g transform='rotate(14 110 150)'><rect x='20' y='10' width='180' height='270' rx='14' fill='${purple}' fill-opacity='.14' stroke='${purple}' stroke-opacity='.65' stroke-width='2'/>` +
        `<rect x='36' y='26' width='148' height='238' rx='8' fill='none' stroke='${green}' stroke-opacity='.45'/>` +
        `<text x='44' y='58' font-family='Georgia, serif' font-weight='700' font-size='26' fill='${green}' fill-opacity='.7'>J</text>` +
        `<text x='176' y='250' font-family='Georgia, serif' font-weight='700' font-size='26' fill='${green}' fill-opacity='.7' transform='rotate(180 170 242)'>J</text>` +
        `<path d='M110 92 C90 70 70 66 60 90 C76 84 88 92 98 110 M110 92 C130 70 150 66 160 90 C144 84 132 92 122 110 M110 92 C110 70 100 56 96 50' fill='none' stroke='${purple}' stroke-opacity='.65' stroke-width='3'/>` +
        `<circle cx='60' cy='90' r='6' fill='${green}' fill-opacity='.7'/><circle cx='160' cy='90' r='6' fill='${green}' fill-opacity='.7'/><circle cx='96' cy='50' r='6' fill='${green}' fill-opacity='.7'/>` +
        `<circle cx='110' cy='150' r='36' fill='${ink}' fill-opacity='.15' stroke='${purple}' stroke-opacity='.55' stroke-width='2'/>` +
        `<path d='M86 158 Q110 186 134 158' fill='none' stroke='${green}' stroke-opacity='.7' stroke-width='3'/><path d='M96 140 h6 M118 140 h6' stroke='${purple}' stroke-opacity='.7' stroke-width='3'/></g>`;
      return layer([put(glowArt(240, 320, body, '', 4, 0.35), 'right 30px bottom 20px', 230, 307), rg(purple, '100% 100%', '40% 45%', 0.14)]);
    },
    // HA HA HA, scattered in green across the top-left.
    laughter(c) {
      const r = rng(66);
      let b = '';
      for (let i = 0; i < 9; i++) {
        const x = (i % 3) * 150 + r() * 40, y = 50 + Math.floor(i / 3) * 95 + r() * 30;
        b += `<text x='${f1(x)}' y='${f1(y)}' font-family='Impact, Arial Black, sans-serif' font-size='${f1(24 + r() * 26)}' fill='${c}' fill-opacity='${f1(0.16 + r() * 0.24)}' transform='rotate(${f1((r() - 0.5) * 36)} ${f1(x + 40)} ${f1(y - 12)})'>HA${i % 2 ? ' HA' : ''}</text>`;
      }
      return layer([put(art(520, 320, lit(b), 2), 'left 20px top 60px', 520, 320)]);
    },
    // Kryptonite: a cluster of green crystals, glowing.
    kryptonite(c, core) {
      const r = rng(48);
      let b = '';
      for (let i = 0; i < 9; i++) {
        const a = -Math.PI / 2 + (r() - 0.5) * 1.6, len = 80 + r() * 140, w = 14 + r() * 16, bx = 150 + (r() - 0.5) * 80, by = 290;
        const tx = bx + Math.cos(a) * len, ty = by + Math.sin(a) * len, nx = -Math.sin(a) * w, ny = Math.cos(a) * w;
        b += `<polygon points='${pts([[bx - nx, by - ny], [tx - nx * 0.6, ty - ny * 0.6], [tx + Math.cos(a) * w, ty + Math.sin(a) * w], [tx + nx * 0.6, ty + ny * 0.6], [bx + nx, by + ny]])}' fill='${c}' fill-opacity='.22' stroke='${core}' stroke-opacity='.65' stroke-width='1.4'/>` + line(bx, by, tx, ty, '#ffffff', 0.3, 1);
      }
      return layer([put(glowArt(300, 300, b, '', 8, 0.7), 'right 30px bottom 10px', 290, 290), rg(c, '100% 100%', '40% 45%', 0.18)]);
    },
    // A corporate L in a hexagon, over the top-left.
    lexLogo(c) {
      const hex = pts([0, 1, 2, 3, 4, 5].map(i => [100 + 80 * Math.cos(i * Math.PI / 3 + Math.PI / 6), 100 + 80 * Math.sin(i * Math.PI / 3 + Math.PI / 6)]));
      const body = `<polygon points='${hex}' fill='${c}' fill-opacity='.08' stroke='${c}' stroke-opacity='.55' stroke-width='3'/><path d='M80 56 V140 H136' fill='none' stroke='${c}' stroke-opacity='.65' stroke-width='18' stroke-linejoin='miter'/>`;
      return layer([put(art(200, 200, lit(body), 3), 'left 40px top 80px', 170, 170), rg(c, '0% 0%', '35% 40%', 0.12)]);
    },
    // The Omega, red, top-right — and Omega beams from it, bending as they hunt.
    omega(red, stone) {
      const om = `<path d='M60 200 H110 V176 C70 160 50 130 50 96 C50 50 86 20 140 20 C194 20 230 50 230 96 C230 130 210 160 170 176 V200 H220' fill='none' stroke='${red}' stroke-opacity='.65' stroke-width='14' stroke-linejoin='round'/>`;
      let beams = '';
      [[110, 210, -40, 430], [170, 210, 70, 440]].forEach(([x, y, x2, y2]) => {
        const p = `M${x} ${y} L${x - 50} ${y + 60} L${x - 14} ${y + 120} L${x2} ${y2}`;
        beams += `<path d='${p}' fill='none' stroke='${red}' stroke-opacity='.25' stroke-width='12'/><path d='${p}' fill='none' stroke='#ffd0c8' stroke-opacity='.6' stroke-width='2'/>`;
      });
      return layer([put(art(300, 440, `<g filter='url(#b)'>${om}${beams}</g>${om}${beams}<circle cx='140' cy='110' r='120' fill='${stone}' fill-opacity='.04'/>`, 6), 'right 30px top 60px', 300, 440), rg(red, '100% 10%', '40% 45%', 0.14)]);
    },
    // Apokolips: fire pits all along the floor.
    firePits(cols) {
      const fire = fireBody(1400, 300, 9, cols, { heat: 0.8 });
      return layer([put(svg(1400, 300, `<defs>${fire.defs}</defs>${fire.art}`), '50% 100%', 1400, 300)], 'linear-gradient(0deg, #000 0, rgba(0,0,0,.6) 25%, transparent 50%)');
    },
    // Bane's mask: black leather, the eye openings rimmed, laces up the middle, the tube.
    luchador(black, trim, venom) {
      const half = `<path d='M100 8 C52 8 26 44 26 100 C26 160 56 200 100 210 Z' fill='${black}' fill-opacity='.45' stroke='${trim}' stroke-opacity='.55' stroke-width='1.6'/>` +
        `<path d='M50 96 C56 80 84 80 92 98 C86 112 58 114 50 96 Z' fill='#000000' fill-opacity='.4' stroke='${trim}' stroke-opacity='.7' stroke-width='3'/>` +
        `<path d='M64 154 H100 M64 154 V172 H100' fill='none' stroke='${trim}' stroke-opacity='.5' stroke-width='2'/>` + [70, 78, 86, 94].map(x => line(x, 156, x, 170, trim, 0.4, 1.4)).join('');
      let laces = '';
      for (let y = 30; y < 90; y += 12) laces += `<path d='M94 ${y} L106 ${y + 6} M106 ${y} L94 ${y + 6}' stroke='${trim}' stroke-opacity='.55' stroke-width='1.6'/>`;
      const tube = `<path d='M30 140 C0 160 -10 200 10 220' fill='none' stroke='${venom}' stroke-opacity='.6' stroke-width='8' stroke-linecap='round'/>`;
      return layer([put(glowArt(200, 230, sym(half) + laces + tube, '', 4, 0.3), 'right 40px bottom 30px', 220, 253), rg(venom, '100% 100%', '35% 40%', 0.12)]);
    },
    // Venom pumping through tubes up the left edge.
    venomTubes(c, glow) {
      let b = '';
      [[30, 6], [64, 4], [92, 3]].forEach(([x, w], i) => {
        const d = `M${x} 800 C${x + 40} 600 ${x - 20} 400 ${x + 30} 220 S${x + 10} 60 ${x + 60 + i * 20} 0`;
        b += `<path d='${d}' fill='none' stroke='${glow}' stroke-opacity='.25' stroke-width='${w * 3}'/><path d='${d}' fill='none' stroke='${c}' stroke-opacity='.55' stroke-width='${w}' stroke-dasharray='30 10'/>`;
      });
      return layer([put(art(200, 800, `<g filter='url(#b)'>${b}</g>${b}`, 5), 'left 0 bottom 0', 200, 800), rg(glow, '0% 100%', '25% 50%', 0.14)]);
    },
    // Two-Face's coin: one face clean, the other scorched and scratched.
    coin(silver, burn) {
      const r = rng(2);
      let scratches = '';
      for (let i = 0; i < 9; i++) { const x = 100 + r() * 70, y = 40 + r() * 120; scratches += line(x, y, x + (r() - 0.5) * 40, y + (r() - 0.5) * 40, burn, 0.7, 1.2); }
      const body = `<circle cx='100' cy='100' r='88' fill='url(#cg)' fill-opacity='.35' stroke='${silver}' stroke-opacity='.7' stroke-width='3'/><circle cx='100' cy='100' r='72' fill='none' stroke='${silver}' stroke-opacity='.4' stroke-dasharray='2 4'/>` +
        `<defs><clipPath id='bh'><rect x='100' width='100' height='200'/></clipPath></defs><circle cx='100' cy='100' r='88' fill='${burn}' fill-opacity='.35' clip-path='url(#bh)'/>` + scratches +
        `<path d='M70 70 C80 56 120 56 130 70 C140 90 128 120 100 128 C72 120 60 90 70 70 Z' fill='none' stroke='${silver}' stroke-opacity='.55' stroke-width='2'/>`;
      return layer([put(glowArt(200, 200, body, metalG('cg', '#ffffff', silver, mix(silver, '#000000', 0.5), 0.6, 1), 4, 0.35), 'right 40px bottom 40px', 200, 200), rg(silver, '100% 100%', '35% 40%', 0.1)]);
    },
    // The scarred half: burnt texture creeping in from the right edge only.
    scarred(c) {
      const m = mist('sc', 700, 900, 760, 450, 560, c, { freq: '0.012 0.02', seed: 13, k: 2.4, o: -1.3 });
      return layer([put(svg(700, 900, `<defs>${m.defs}</defs>${m.body}`), 'right 0 center', 700, 900)], 'linear-gradient(270deg, #000 0, rgba(0,0,0,.5) 18%, transparent 40%)');
    },
    // The question-mark cane, gold and green, standing in the bottom-right.
    questionCane(green, gold) {
      const b = `<path d='M80 340 V170 C80 140 150 130 150 80 C150 40 120 20 90 20 C60 20 36 40 36 70' fill='none' stroke='${gold}' stroke-opacity='.65' stroke-width='12' stroke-linecap='round'/>` +
        `<path d='M80 340 V170' stroke='${green}' stroke-opacity='.5' stroke-width='4'/><circle cx='80' cy='366' r='12' fill='${gold}' fill-opacity='.5' stroke='${gold}' stroke-opacity='.8'/>`;
      return layer([put(glowArt(190, 390, b, '', 5, 0.4), 'right 60px bottom 10px', 160, 330), rg(green, '100% 100%', '40% 45%', 0.12)]);
    },
    // Question marks, scattered over the top-left.
    riddles(c) {
      const r = rng(10);
      let b = '';
      for (let i = 0; i < 12; i++) b += `<text x='${f1(r() * 440)}' y='${f1(50 + r() * 250)}' font-family='Georgia, serif' font-weight='700' font-size='${f1(22 + r() * 46)}' fill='${c}' fill-opacity='${f1(0.15 + r() * 0.3)}'>?</text>`;
      return layer([put(art(500, 320, lit(b), 2), 'left 10px top 60px', 500, 320)]);
    },
    // An umbrella, open, in the bottom-right: scalloped canopy, ribs, the hooked handle.
    umbrella(canopy, handle) {
      // Canopy over the top, then the scalloped hem back from right to left, one dip per rib.
      const sw = 260 / 6;
      let ribs = '', hem = '';
      for (let i = 0; i <= 6; i++) { const x = 20 + i * sw; ribs += `<path d='M150 30 Q${f1(150 + (x - 150) * 0.6)} 60 ${f1(x)} 130' fill='none' stroke='${handle}' stroke-opacity='.4'/>`; }
      for (let i = 0; i < 6; i++) { const x0 = 280 - i * sw; hem += ` Q${f1(x0 - sw / 2)} 112 ${f1(x0 - sw)} 130`; }
      const b = `<path d='M20 130 C20 60 280 60 280 130${hem} Z' fill='${canopy}' fill-opacity='.3' stroke='${handle}' stroke-opacity='.55' stroke-width='2'/>` +
        `<path d='M20 130 C30 70 150 20 150 30 C150 20 270 70 280 130' fill='none' stroke='${handle}' stroke-opacity='.5'/>` + ribs +
        `<path d='M150 30 V300 C150 330 116 330 116 304' fill='none' stroke='${handle}' stroke-opacity='.65' stroke-width='6' stroke-linecap='round'/><path d='M150 30 V10' stroke='${handle}' stroke-opacity='.7' stroke-width='4'/>`;
      return layer([put(glowArt(300, 340, b, '', 4, 0.3), 'right 30px bottom 20px', 280, 317), rg(handle, '100% 100%', '40% 45%', 0.1)]);
    },
    // Penguins on the ice, along the bottom-left.
    penguins(c, ice) {
      const p = (x, s) => `<g transform='translate(${x} 180) scale(${s})'><ellipse cx='0' cy='-40' rx='22' ry='40' fill='${c}' fill-opacity='.4' stroke='${ice}' stroke-opacity='.5'/><ellipse cx='4' cy='-34' rx='13' ry='28' fill='${ice}' fill-opacity='.3'/><circle cx='2' cy='-86' r='14' fill='${c}' fill-opacity='.4' stroke='${ice}' stroke-opacity='.5'/><path d='M14 -88 L28 -84 L14 -80 Z' fill='#e0a040' fill-opacity='.6'/></g>`;
      const floe = `<path d='M0 180 L40 170 L200 174 L260 168 L420 176 L460 190 L0 196 Z' fill='${ice}' fill-opacity='.18' stroke='${ice}' stroke-opacity='.4'/>`;
      return layer([put(art(460, 200, lit(floe + p(60, 0.9) + p(130, 1.1) + p(210, 0.8) + p(300, 1)), 3), 'left 20px bottom 10px', 460, 200)]);
    },
    // Scarecrow's sack: burlap, stitched mouth, a rope at the neck, eyes lit with toxin.
    sackMask(burlap, rope, glow) {
      let stitches = '';
      for (let x = 66; x <= 134; x += 10) stitches += line(x, 160, x + 2, 176, rope, 0.6, 2);
      const body = `<path d='M100 6 C50 10 24 50 26 106 C28 160 60 196 100 200 C140 196 172 160 174 106 C176 50 150 10 100 6 Z' fill='${burlap}' fill-opacity='.25' stroke='${burlap}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M40 60 L60 66 M150 50 L134 62 M100 20 L104 40' stroke='${rope}' stroke-opacity='.4' stroke-width='1.4'/>` +
        `<path d='M60 168 Q100 156 140 168' fill='none' stroke='${rope}' stroke-opacity='.6' stroke-width='2'/>` + stitches +
        `<path d='M40 200 C80 214 120 214 160 200 L156 220 C120 230 80 230 44 220 Z' fill='${rope}' fill-opacity='.3' stroke='${rope}' stroke-opacity='.6'/>` +
        sym(`<path d='M54 100 C60 84 84 84 90 100 C84 116 60 116 54 100 Z' fill='#000000' fill-opacity='.6'/>`) +
        `<g filter='url(#b)'>${sym(`<circle cx='72' cy='100' r='9' fill='${glow}'/>`)}</g>`;
      return layer([put(glowArt(200, 232, body, '', 5, 0.3), 'right 40px bottom 20px', 220, 255), rg(glow, '100% 100%', '35% 40%', 0.1)]);
    },
    // Fear gas welling up off the floor, crows over the top.
    fearGas(gas, crow) {
      const m = mist('fg', 1400, 500, 700, 560, 760, gas, { freq: '0.008 0.012', seed: 21, k: 2.4, o: -1.2 });
      const r = rng(5);
      let crows = '';
      for (let i = 0; i < 7; i++) { const x = 100 + r() * 1200, y = 30 + r() * 120, s = 10 + r() * 12; crows += `<path d='M${f1(x - s)} ${f1(y - s * 0.3)} L${f1(x)} ${f1(y + s * 0.2)} L${f1(x + s)} ${f1(y - s * 0.3)} L${f1(x)} ${f1(y)} Z' fill='${crow}' fill-opacity='.45'/>`; }
      return layer([`${svg(1400, 500, `<defs>${m.defs}</defs>${m.body}`)} 50% 100% / 1400px 500px no-repeat`, put(svg(1400, 200, crows), '50% 60px', 1400, 200)],
        'linear-gradient(0deg, #000 0, rgba(0,0,0,.6) 22%, transparent 45%), linear-gradient(180deg, transparent 50px, #000 60px, #000 220px, transparent 260px)');
    },
    // Mr. Freeze's helmet: a glass dome, the red goggles behind it.
    cryoDome(glass, goggle) {
      const body = `<path d='M30 200 C20 90 60 20 120 20 C180 20 220 90 210 200 Z' fill='${glass}' fill-opacity='.12' stroke='${glass}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M60 80 C80 50 110 40 140 44' fill='none' stroke='#ffffff' stroke-opacity='.5' stroke-width='5' stroke-linecap='round'/>` +
        `<ellipse cx='120' cy='130' rx='54' ry='62' fill='${glass}' fill-opacity='.06' stroke='${glass}' stroke-opacity='.3'/>` +
        `<rect x='70' y='112' width='100' height='20' rx='10' fill='#000000' fill-opacity='.4'/><g filter='url(#b)'><circle cx='96' cy='122' r='9' fill='${goggle}'/><circle cx='144' cy='122' r='9' fill='${goggle}'/></g>` +
        `<circle cx='96' cy='122' r='8' fill='${goggle}' fill-opacity='.85'/><circle cx='144' cy='122' r='8' fill='${goggle}' fill-opacity='.85'/>` +
        `<rect x='20' y='196' width='200' height='26' rx='6' fill='${glass}' fill-opacity='.18' stroke='${glass}' stroke-opacity='.55'/>`;
      return layer([put(glowArt(240, 230, body, '', 4, 0.35), 'right 30px bottom 30px', 240, 230), rg(goggle, '100% 100%', '30% 35%', 0.08)]);
    },
    // A freeze beam across the top, ice crystallising where it ends.
    freezeBeam(beam, ice) {
      const r = rng(28);
      let crystals = '';
      for (let i = 0; i < 12; i++) { const a = r() * Math.PI * 2, len = 20 + r() * 60; crystals += `<polygon points='${pts([[900, 120], [900 + Math.cos(a - 0.1) * len * 0.5, 120 + Math.sin(a - 0.1) * len * 0.5], [900 + Math.cos(a) * len, 120 + Math.sin(a) * len], [900 + Math.cos(a + 0.1) * len * 0.5, 120 + Math.sin(a + 0.1) * len * 0.5]])}' fill='${ice}' fill-opacity='.2' stroke='${ice}' stroke-opacity='.6'/>`; }
      const b = `<path d='M0 100 L900 120' stroke='${beam}' stroke-opacity='.3' stroke-width='16'/><path d='M0 100 L900 120' stroke='#ffffff' stroke-opacity='.55' stroke-width='2.4'/>` +
        `<path d='M0 100 Q450 70 900 120 M0 100 Q450 140 900 120' fill='none' stroke='${beam}' stroke-opacity='.3' stroke-width='1.2'/>` + crystals;
      return layer([put(art(1000, 240, `<g filter='url(#b)'>${b}</g>${b}`, 5), 'left 0 top 60px', 1000, 240)], 'linear-gradient(90deg, rgba(0,0,0,.4) 0, #000 60%)');
    },
    // Brainiac's skull ship in the top-right, its tentacles trailing.
    skullShip(c, glow) {
      let b = `<path d='M200 20 C120 20 70 70 70 140 C70 180 90 210 120 220 L130 250 H270 L280 220 C310 210 330 180 330 140 C330 70 280 20 200 20 Z' fill='${c}' fill-opacity='.14' stroke='${glow}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M120 140 C120 116 168 112 172 140 C168 164 124 164 120 140 Z M280 140 C280 116 232 112 228 140 C232 164 276 164 280 140 Z' fill='${glow}' fill-opacity='.4'/>` +
        `<path d='M110 60 C150 40 250 40 290 60 M80 110 H320' fill='none' stroke='${glow}' stroke-opacity='.35'/>`;
      for (let i = 0; i < 7; i++) { const x = 140 + i * 20; b += `<path d='M${x} 250 C${x - 20} 300 ${x + 20} 340 ${x - 10 - i * 6} ${380 + (i % 3) * 30}' fill='none' stroke='${c}' stroke-opacity='.45' stroke-width='${f1(4 - Math.abs(i - 3) * 0.6)}' stroke-linecap='round'/>`; }
      return layer([put(glowArt(400, 440, b, '', 5, 0.4), 'right -20px top 56px', 360, 396), rg(glow, '100% 10%', '40% 45%', 0.14)]);
    },
    // A city in a bottle: the bell jar, the towers inside it.
    bottledCity(glass, city) {
      let towers = '';
      [[70, 120], [96, 170], [124, 140], [150, 190], [178, 130], [204, 110]].forEach(([x, h]) => {
        towers += `<rect x='${x - 9}' y='${270 - h}' width='18' height='${h}' fill='${city}' fill-opacity='.3' stroke='${city}' stroke-opacity='.6'/><polygon points='${x - 9},${270 - h} ${x},${250 - h} ${x + 9},${270 - h}' fill='${city}' fill-opacity='.4'/>`;
      });
      const b = towers + `<path d='M40 270 V100 C40 40 230 40 230 100 V270' fill='${glass}' fill-opacity='.08' stroke='${glass}' stroke-opacity='.6' stroke-width='2'/>` +
        `<path d='M60 110 C60 76 90 64 110 62' fill='none' stroke='#ffffff' stroke-opacity='.45' stroke-width='4' stroke-linecap='round'/>` +
        `<rect x='26' y='270' width='218' height='22' rx='4' fill='${glass}' fill-opacity='.2' stroke='${glass}' stroke-opacity='.6'/><circle cx='135' cy='42' r='10' fill='${glass}' fill-opacity='.3' stroke='${glass}' stroke-opacity='.6'/>`;
      return layer([put(glowArt(270, 300, b, '', 4, 0.35), 'left 40px bottom 20px', 240, 267), rg(city, '0% 100%', '35% 40%', 0.12)]);
    },
    // Bone breaking through from the bottom-right corner: jagged spikes, ridged.
    boneSpikes(bone, glow) {
      const r = rng(13);
      let b = '';
      for (let i = 0; i < 9; i++) {
        const a = Math.PI + 0.2 + i * 0.16 + (r() - 0.5) * 0.1, len = 160 + r() * 220, w = 18 + r() * 18, bx = 520 + (r() - 0.5) * 40, by = 520;
        const tx = bx + Math.cos(a) * len, ty = by + Math.sin(a) * len, nx = -Math.sin(a) * w, ny = Math.cos(a) * w;
        b += `<polygon points='${pts([[bx - nx, by - ny], [tx, ty], [bx + nx, by + ny]])}' fill='url(#bn)' fill-opacity='.3' stroke='${bone}' stroke-opacity='.6' stroke-width='1.4'/>`;
        for (let k = 1; k < 4; k++) { const t = k / 4; b += line(bx + (tx - bx) * t - nx * (1 - t), by + (ty - by) * t - ny * (1 - t), bx + (tx - bx) * t + nx * (1 - t), by + (ty - by) * t + ny * (1 - t), bone, 0.35, 1); }
      }
      return layer([put(art(540, 540, `<g filter='url(#b)' opacity='.4'>${b}</g>${b}`, 4, metalG('bn', '#ffffff', bone, mix(bone, '#000000', 0.6), 1, 1)), 'right 0 bottom 0', 540, 540), rg(glow, '100% 100%', '45% 45%', 0.12)]);
    },
    // The S-shield, torn: cracked through and a corner gone.
    tornShield(red, gold) {
      const r = rng(40);
      const cracks = [jag(100, 20, 70, 180, 7, 10, r), jag(60, 50, 160, 120, 6, 8, r), jag(130, 30, 110, 100, 4, 6, r)].map(p => poly(p, '#000000', 0.6, 3) + poly(p, gold, 0.5, 1)).join('');
      const body = `<polygon points='30,8 150,8 170,30 140,46 186,44 100,186 2,44' fill='${gold}' fill-opacity='.12' stroke='${red}' stroke-opacity='.55' stroke-width='4' stroke-linejoin='round'/>` +
        `<path d='M140 40 H74 C50 40 44 70 70 78 L128 96 C150 104 146 132 122 132 H56' fill='none' stroke='${red}' stroke-opacity='.45' stroke-width='14' stroke-linecap='round'/>` + cracks;
      return layer([put(glowArt(200, 194, body, '', 4, 0.3), 'left 40px bottom 40px', 200, 194), rg(red, '0% 100%', '35% 40%', 0.1)]);
    },
    // Black Manta's helmet: the great dome, the two red eyes, the fins.
    mantaHelm(shell, eye) {
      const half = `<path d='M100 10 C40 10 6 60 8 120 C10 170 50 200 100 206 Z' fill='${shell}' fill-opacity='.4' stroke='${eye}' stroke-opacity='.4' stroke-width='1.6'/>` +
        `<ellipse cx='58' cy='110' rx='38' ry='44' fill='${eye}' fill-opacity='.4' stroke='${eye}' stroke-opacity='.75' stroke-width='3'/>` +
        `<path d='M10 90 L-14 70 L-6 120 Z' fill='${shell}' fill-opacity='.4' stroke='${eye}' stroke-opacity='.3'/>`;
      return layer([put(glowArt(200, 220, sym(half) + `<path d='M100 150 V196 M86 170 H114' stroke='${eye}' stroke-opacity='.4' stroke-width='2'/>` + `<g filter='url(#b)'>${sym(`<ellipse cx='58' cy='110' rx='26' ry='30' fill='${eye}' fill-opacity='.7'/>`)}</g>`, '', 6, 0.4), 'right 40px bottom 30px', 240, 264), rg(eye, '100% 100%', '35% 40%', 0.12)]);
    },
    // The deep: a manta ray gliding over the top-left, motes of light drifting.
    deepSea(ray, mote) {
      const m = `<path d='M200 80 C150 30 60 10 0 40 C60 50 110 80 140 110 C150 140 170 150 200 150 C230 150 250 140 260 110 C290 80 340 50 400 40 C340 10 250 30 200 80 Z' fill='${ray}' fill-opacity='.18' stroke='${ray}' stroke-opacity='.5' stroke-width='1.6'/><path d='M200 150 C204 200 220 240 260 270' fill='none' stroke='${ray}' stroke-opacity='.45' stroke-width='2'/>`;
      const motes = scatter(19, 26, 300, 300).map(([x, y, s]) => `<circle cx='${x}' cy='${y}' r='${f1(0.8 + s * 2)}' fill='${mote}' fill-opacity='${f1(0.2 + s * 0.5)}'/>`).join('');
      return layer([put(art(400, 280, lit(m), 3), 'left 40px top 70px', 400, 280), `${art(300, 300, lit(motes), 2)} 0 0 / 300px 300px repeat`],
        'radial-gradient(ellipse 50% 50% at 15% 20%, #000 40%, transparent 100%), radial-gradient(ellipse 80% 80% at 50% 50%, transparent 40%, #000 95%)');
    },
    // Rosettes, fading in from the bottom-left.
    rosettes(c) {
      const r = rng(70);
      let b = '';
      for (let i = 0; i < 10; i++) {
        const x = r() * 120, y = r() * 120, s = 5 + r() * 5;
        b += [0, 1, 2, 3, 4].map(k => { const a = k / 5 * Math.PI * 2 + r(); return `<ellipse cx='${f1(x + Math.cos(a) * s)}' cy='${f1(y + Math.sin(a) * s)}' rx='${f1(s * 0.45)}' ry='${f1(s * 0.3)}' transform='rotate(${f1(a * 57.3)} ${f1(x + Math.cos(a) * s)} ${f1(y + Math.sin(a) * s)})'/>`; }).join('');
      }
      const tile = svg(120, 120, `<g fill='${c}' fill-opacity='.3'>${b}</g>`);
      return plus(cornerTile(tile, 120, 120, '0% 100%', '50%'), rg(c, '0% 100%', '40% 40%', 0.12));
    },
    // Tall grass along the floor, gold, swaying.
    grass(c) {
      const r = rng(25);
      let b = '';
      for (let i = 0; i < 70; i++) { const x = r() * 1200, h = 40 + r() * 120, lean = (r() - 0.5) * 50; b += `<path d='M${f1(x - 3)} 200 Q${f1(x + lean * 0.5)} ${f1(200 - h * 0.6)} ${f1(x + lean)} ${f1(200 - h)} Q${f1(x + lean * 0.4)} ${f1(200 - h * 0.5)} ${f1(x + 3)} 200 Z' fill='${c}' fill-opacity='${f1(0.1 + r() * 0.2)}'/>`; }
      return layer([`${svg(1200, 200, b)} 0 100% / 1200px 200px repeat-x`, rg(c, '50% 110%', '60% 30%', 0.12)]);
    },
    // The Lazarus Pit: a green pool glowing along the floor, mist rising out of it.
    lazarusPit(c, glow) {
      const m = mist('lz', 1200, 500, 600, 480, 460, glow, { freq: '0.006 0.014', seed: 31, k: 2.4, o: -1.15 });
      const body = m.body + `<ellipse cx='600' cy='470' rx='420' ry='40' fill='${c}' fill-opacity='.35' filter='url(#b)'/><ellipse cx='600' cy='470' rx='380' ry='30' fill='${glow}' fill-opacity='.25' stroke='${glow}' stroke-opacity='.5' stroke-width='2'/>`;
      return layer([put(art(1200, 500, body, 16, m.defs), '50% 100%', 1200, 500)], 'linear-gradient(0deg, #000 0, rgba(0,0,0,.7) 20%, transparent 50%)');
    },
    // A scimitar laid across the top-right.
    scimitar(steel, gold) {
      const b = `<g transform='translate(540 70) rotate(160)'><path d='M0 -6 C120 -14 260 -10 380 -40 C330 0 220 20 0 8 Z' fill='${steel}' fill-opacity='.16' stroke='${steel}' stroke-opacity='.65' stroke-width='1.4'/>` +
        `<path d='M10 0 C130 -6 250 -6 360 -32' fill='none' stroke='#ffffff' stroke-opacity='.35'/><rect x='-8' y='-24' width='10' height='44' rx='3' fill='${gold}' fill-opacity='.5'/><rect x='-70' y='-6' width='62' height='12' rx='5' fill='${gold}' fill-opacity='.3' stroke='${gold}' stroke-opacity='.5'/></g>`;
      return layer([put(art(560, 300, lit(b), 4), 'right 0 top 56px', 560, 300)]);
    },
  };

  // ---------- the roster ----------
  // `tags` are extra search words in the picker (a team, an alias, a home).
  const dc = (id, name, group, colours, layers, tags = '') => Object.assign(heroFrom('dc-' + id, name, group, colours, layers), { universe: 'dc', tags });

  const DC_THEMES = [
    // ----- Heroes -----
    dc('batman', 'Batman', 'hero', { bg: '#0d0f14', accent: '#8a96a8', gold: '#e8c23a' },
      [ART.batSignal('#f0dc8a', '#5a6272', '#0d0f14'), ART.gotham('#1c212c', '#e8c23a', '#c8d0e0')], 'bruce wayne dark knight gotham justice league'),
    dc('superman', 'Superman', 'hero', { bg: '#0c1226', accent: '#2f5fc0', gold: '#d8323a' },
      [ART.sShield('#e0404a', '#f0c840'), ART.cape('#c8303a', '#ffd870')], 'clark kent kal-el metropolis justice league'),
    dc('wonderwoman', 'Wonder Woman', 'hero', { bg: '#150c10', accent: '#b8283a', gold: '#e0b040' },
      [ART.lasso('#f0cc60', '#ffd870'), ART.wwEmblem('#e8c050', '#f4f0ff')], 'diana themyscira amazon justice league'),
    dc('flash', 'The Flash', 'hero', { bg: '#160a08', accent: '#c8282e', gold: '#f0c43a' },
      [ART.speedEmblem('#ffffff', '#e0303a', '#f8d040'), ART.speedLines('#ff8a60', '#ffe070')], 'barry allen speed force central city justice league'),
    dc('greenlantern', 'Green Lantern', 'hero', { bg: '#08140c', accent: '#3ab860', gold: '#dfe8e0' },
      [ART.lanternEmblem('#6aff9a', '#3ab860'), ART.powerBattery('#8affb0', '#3ab860')], 'hal jordan corps oa ring justice league'),
    dc('aquaman', 'Aquaman', 'hero', { bg: '#08141a', accent: '#e0902c', gold: '#3aa86a' },
      [ART.scales('#f0a040'), ART.undersea('#9fe8e0', '#cff4ff')], 'arthur curry atlantis justice league'),
    dc('cyborg', 'Cyborg', 'hero', { bg: '#0c0e12', accent: '#b8c0cc', gold: '#e8303a' },
      [ART.cyberEye('#c8d0dc', '#ff3a44'), ART.boomTube('#dfe8ff', '#7fb0ff')], 'victor stone teen titans justice league'),
    dc('martian', 'Martian Manhunter', 'hero', { bg: '#0c140e', accent: '#3a9a50', gold: '#c83030' },
      [ART.mars('#e06040', '#ff7a50'), ART.xStraps('#e04040', '#5a8ae0')], "j'onn j'onzz mars justice league"),
    dc('greenarrow', 'Green Arrow', 'hero', { bg: '#0c120c', accent: '#4a8a3a', gold: '#d8c070' },
      [ART.quiver('#6ab84a', '#dfe6d8'), ART.leaves('#7ab85a', '#d8c070')], 'oliver queen star city emerald archer'),
    dc('blackcanary', 'Black Canary', 'hero', { bg: '#0e0e12', accent: '#4ab0d8', gold: '#e8d070' },
      [ART.soundWaves('#7fd0f0'), ART.fishnet('#e8d070')], 'dinah lance birds of prey canary cry'),
    dc('shazam', 'Shazam', 'hero', { bg: '#140c08', accent: '#c8302a', gold: '#f0c840' },
      [ART.chestBolt('#f8d050', '#ffffff'), ART.strike('#fff4b0', '#f0c840')], 'billy batson captain marvel rock of eternity'),
    dc('nightwing', 'Nightwing', 'hero', { bg: '#0a0e18', accent: '#3a8ae0', gold: '#5ac0f0' },
      [ART.nightwingSymbol('#3a8ae0', '#7fd0ff'), ART.escrima('#aab4c4', '#7fd0ff')], 'dick grayson bludhaven teen titans robin'),
    dc('robin', 'Robin', 'hero', { bg: '#120c0a', accent: '#c8302a', gold: '#e8c040' },
      [ART.letterEmblem('R', '#e8c040', '#c8302a', '#c8302a'), ART.birds('#e8c040')], 'damian wayne tim drake boy wonder teen titans'),
    dc('batgirl', 'Batgirl', 'hero', { bg: '#100e18', accent: '#7a52b0', gold: '#e8c040' },
      [ART.batOutline('#f0cc50', '#7a52b0'), ART.monitors('#a88ae0')], 'barbara gordon oracle birds of prey gotham'),
    dc('supergirl', 'Supergirl', 'hero', { bg: '#0c1226', accent: '#3a6ad0', gold: '#e0303a' },
      [ART.krypton('#e05a3a', '#ffb070', '#dfe8ff'), ART.fortress('#bfe4ff', '#7ac0f0')], 'kara zor-el krypton fortress of solitude'),
    dc('hawkman', 'Hawkman', 'hero', { bg: '#120e0a', accent: '#6aa04a', gold: '#d8a040' },
      [ART.hawkHelm('#e0b050', '#ff6a3a'), ART.featherWings('#d8a040', '#8a6a3a')], 'carter hall thanagar justice society nth metal'),
    dc('zatanna', 'Zatanna', 'hero', { bg: '#0e0c14', accent: '#c8c8d8', gold: '#d03040' },
      [ART.topHat('#2a2a34', '#d8d8e8', '#fff2b0'), ART.backwardsSpell('#e8d8ff', '!hsup tig')], 'zatara magician justice league dark'),
    dc('bluebeetle', 'Blue Beetle', 'hero', { bg: '#0a1018', accent: '#2a7ad0', gold: '#e8a030' },
      [ART.scarab('#3a8ae0', '#e8b040'), ART.reachGlyphs('#5ab0ff')], 'jaime reyes scarab reach el paso'),
    dc('starfire', 'Starfire', 'hero', { bg: '#140a10', accent: '#e07a2a', gold: '#5ad050' },
      [ART.starbolts('#6aff6a', '#e8ffd8'), ART.fireHair(['#ffd070', '#ff6a2a', '#c8302a'])], "koriand'r tamaran teen titans"),
    dc('raven', 'Raven', 'hero', { bg: '#0e0a16', accent: '#6a4ab0', gold: '#d02840' },
      [ART.soulRaven('#1a1030', '#b89aff'), plus(M.smoke('#6a4ab0', '#3a2a6a'), rg('#d02840', '50% 105%', '25% 18%', 0.12))], 'rachel roth azarath teen titans'),
    dc('cosmicboy', 'Cosmic Boy', 'hero', { bg: '#0e0c14', accent: '#d04a9a', gold: '#e8e8f0' },
      [ART.orbitDebris('#c8ccd8', '#ff6ac0'), ART.legionRing('#e8c050', '#d04a9a')], 'rokk krinn braal magnetism legion of super-heroes'),
    dc('saturngirl', 'Saturn Girl', 'hero', { bg: '#120c10', accent: '#d83a5a', gold: '#e8c040' },
      [ART.ringedPlanet('#e8b070', '#f0d8a0', '#ff8ab0'), ART.legionRing('#e8c050', '#d83a5a')], 'imra ardeen titan telepath legion of super-heroes'),
    dc('lightninglad', 'Lightning Lad', 'hero', { bg: '#0c0e16', accent: '#3a6ad0', gold: '#f0d040' },
      [ART.lightningTree('#fff6c0', '#f0d040'), ART.legionRing('#e8c050', '#3a6ad0')], 'garth ranzz winath legion of super-heroes'),
    dc('brainiac5', 'Brainiac 5', 'hero', { bg: '#0a120c', accent: '#5ab840', gold: '#a050c0' },
      [ART.forceField('#7fe060', '#c8f0b8'), ART.legionRing('#e8c050', '#a050c0')], 'querl dox colu twelfth-level intellect legion of super-heroes'),

    // ----- Anti-heroes -----
    dc('catwoman', 'Catwoman', 'antihero', { bg: '#0c0c10', accent: '#7a5aa8', gold: '#e8d070' },
      [ART.catEyes('#c8e050', '#e8f070'), ART.whipDiamond('#8a7ab0', '#e8f4ff')], 'selina kyle gotham cat burglar'),
    dc('harley', 'Harley Quinn', 'antihero', { bg: '#120a0e', accent: '#d8304a', gold: '#4a6ad0' },
      [ART.harlequin('#e0304a', '#000000'), ART.mallet('#e0304a', '#e8e8f0', '#ff6a8a')], 'harleen quinzel suicide squad gotham'),
    dc('deathstroke', 'Deathstroke', 'antihero', { bg: '#0e0c0a', accent: '#e07a2a', gold: '#4a5a8a' },
      [ART.splitMask('#f08a3a', '#141418', '#c8ccd8'), ART.swordCasings('#dfe4ec', '#d8a040')], 'slade wilson terminator mercenary'),
    dc('redhood', 'Red Hood', 'antihero', { bg: '#120a0a', accent: '#c02a2a', gold: '#c8c8d0' },
      [ART.hoodHelmet('#d03838', '#f4f6fa'), ART.crossedPistols('#c8ccd8', '#e04040')], 'jason todd robin gotham outlaws'),
    dc('constantine', 'John Constantine', 'antihero', { bg: '#0e0e0a', accent: '#c8a24a', gold: '#e0402a' },
      [ART.sigil('#ff9a40', '#e05a2a'), ART.smokeWisps('#c8c8c0', '#ff6a2a')], 'hellblazer justice league dark occult'),
    dc('swampthing', 'Swamp Thing', 'antihero', { bg: '#0c120a', accent: '#4a8a3a', gold: '#c84a3a' },
      [ART.vines('#6a9a4a', '#8ac060'), ART.swampMist('#5a8a4a', '#e8f080')], 'alec holland the green avatar'),
    dc('lobo', 'Lobo', 'antihero', { bg: '#0c0e12', accent: '#c8ccd8', gold: '#c8302a' },
      [ART.hookChain('#c8ccd8'), ART.exhaust(['#ffd070', '#ff6a2a', '#8a2a1a'], '#ffffff')], 'czarnian main man bounty hunter'),
    dc('blackadam', 'Black Adam', 'antihero', { bg: '#0e0c08', accent: '#d4a83a', gold: '#6a6a78' },
      [ART.pyramid('#d8b878', '#ffe070'), ART.sandstorm('#c8a060', '#f0c840')], "teth-adam kahndaq justice society"),
    dc('poisonivy', 'Poison Ivy', 'antihero', { bg: '#0c120c', accent: '#4aa04a', gold: '#c83a3a' },
      [ART.roses('#5aa04a', '#e0404a'), ART.pollen('#c8f070', '#ff8ab0')], 'pamela isley gotham the green'),
    dc('peacemaker', 'Peacemaker', 'antihero', { bg: '#0e1014', accent: '#e8e8f0', gold: '#3a6ad0' },
      [ART.peaceHelmet('#dfe4ec', '#ffffff'), ART.dove('#cfe0ff')], 'christopher smith suicide squad'),

    // ----- Villains -----
    dc('joker', 'The Joker', 'villain', { bg: '#0e0a12', accent: '#7a3ab0', gold: '#5ab84a' },
      [ART.jokerCard('#a060e0', '#6ad05a', '#ffffff'), ART.laughter('#6ad05a')], 'clown prince of crime gotham'),
    dc('luthor', 'Lex Luthor', 'villain', { bg: '#0c120c', accent: '#3aa050', gold: '#7a4ab0' },
      [ART.kryptonite('#5aff7a', '#c8ffd0'), ART.lexLogo('#a080e0')], 'lexcorp metropolis kryptonite legion of doom'),
    dc('darkseid', 'Darkseid', 'villain', { bg: '#0c0c10', accent: '#c83a2a', gold: '#7a86a8' },
      [ART.omega('#ff4a3a', '#8a8a98'), ART.firePits(['#ffb060', '#e04a1a', '#6a1a10'])], 'uxas apokolips new gods omega'),
    dc('sinestro', 'Sinestro', 'villain', { bg: '#120e06', accent: '#e8c030', gold: '#9a3ab0' },
      [ART.lanternEmblem('#ffe040', '#e8c030', true), ART.powerBattery('#ffe050', '#e8c030', true)], 'thaal sinestro corps korugar fear'),
    dc('reverseflash', 'Reverse-Flash', 'villain', { bg: '#120e06', accent: '#e0c030', gold: '#c82a2a' },
      [ART.speedEmblem('#000000', '#e0303a', '#ff4a3a'), ART.timeVortex('#ff4a3a', '#f0d040')], 'eobard thawne professor zoom speed force'),
    dc('bane', 'Bane', 'villain', { bg: '#0e0e10', accent: '#3aa050', gold: '#8a8a98' },
      [ART.luchador('#1a1a20', '#dfe4ec', '#5aff7a'), ART.venomTubes('#5aff7a', '#3aa050')], 'santa prisca venom gotham'),
    dc('twoface', 'Two-Face', 'villain', { bg: '#0e0c0c', accent: '#d8d8e0', gold: '#8a3a4a' },
      [ART.coin('#dfe4ec', '#8a3a2a'), ART.scarred('#8a4a3a')], 'harvey dent gotham district attorney'),
    dc('riddler', 'The Riddler', 'villain', { bg: '#0a120a', accent: '#4ab04a', gold: '#7a4ab0' },
      [ART.questionCane('#5ad05a', '#e8c050'), ART.riddles('#6ae06a')], 'edward nygma gotham puzzles'),
    dc('penguin', 'The Penguin', 'villain', { bg: '#0c0c10', accent: '#d8d8e0', gold: '#7a3a8a' },
      [ART.umbrella('#2a2a34', '#dfe4ec'), ART.penguins('#2a2a34', '#cfe8ff')], 'oswald cobblepot iceberg lounge gotham'),
    dc('scarecrow', 'Scarecrow', 'villain', { bg: '#0e0c08', accent: '#b89a5a', gold: '#5ab84a' },
      [ART.sackMask('#c8a868', '#8a6a3a', '#7aff6a'), ART.fearGas('#5ab84a', '#8a8a6a')], 'jonathan crane fear toxin gotham'),
    dc('freeze', 'Mr. Freeze', 'villain', { bg: '#08121a', accent: '#7ac8e8', gold: '#c8d4e0' },
      [ART.cryoDome('#bfe8ff', '#ff4a4a'), ART.freezeBeam('#7ac8e8', '#dff4ff')], 'victor fries cryo gotham'),
    dc('brainiac', 'Brainiac', 'villain', { bg: '#0a120e', accent: '#4ab860', gold: '#c84aa0' },
      [ART.skullShip('#4ab860', '#8aff9a'), ART.bottledCity('#bfe8ff', '#ffb0e0')], 'vril dox colu kandor'),
    dc('doomsday', 'Doomsday', 'villain', { bg: '#0e0c0a', accent: '#a8a498', gold: '#5a8a4a' },
      [ART.boneSpikes('#e8e0d0', '#8a8a80'), ART.tornShield('#c8303a', '#e0c050')], 'the death of superman krypton'),
    dc('blackmanta', 'Black Manta', 'villain', { bg: '#0a0e14', accent: '#c02a2a', gold: '#3a6a5a' },
      [ART.mantaHelm('#1a1e26', '#ff3a3a'), ART.deepSea('#5a8a9a', '#7fe8ff')], 'david hyde atlantis the deep'),
    dc('cheetah', 'Cheetah', 'villain', { bg: '#120e08', accent: '#d8a03a', gold: '#3a2a1a' },
      [ART.rosettes('#e8b048'), ART.grass('#d8b060')], 'barbara minerva urzkartaga'),
    dc('rasalghul', "Ra's al Ghul", 'villain', { bg: '#0c120c', accent: '#3a8a5a', gold: '#c8a040' },
      [ART.lazarusPit('#3aa05a', '#7aff9a'), ART.scimitar('#dfe4ec', '#d8b050')], 'demons head league of assassins lazarus pit nanda parbat'),
  ];

  ROSTER.push(...DC_THEMES);
  if (typeof module !== 'undefined' && module.exports) module.exports = { DC_THEMES };
})();
