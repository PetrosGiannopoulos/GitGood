// ============================================
// GEM JUICE — the motion half of the gem themes (06-gems.css)
//
// Every gem shares the same *triggers* and has its own *language*:
//
//   trigger                      persona hook
//   ---------------------------  ------------------------------------------------------
//   a press on a control         press(x, y, big)      — big for primary buttons / drops
//   a drag (DnD, graph dot)      trail(x, y, nx, ny, n) — once per `trailSpacing` px
//   a pane resize                flick() along the divider, then a glint + press()
//   a success toast              success(x, y)         — every successful git operation
//   an error toast               error(x, y)
//
// Plain cursor movement leaves no particles (tried: the user found the trail distracting);
// it only carries the light — on the chrome, and *behind* the commit graph.
//
// Git operations get physical reactions, shared by every gem and coloured by it. They come
// from the 'gitgood:op' event withLoading() dispatches (01-core.js), keyed on its label:
//   pull      → an earthquake: the window shakes, seismic wavefronts spread from where you
//               clicked, a seismograph trace runs along the status bar
//   push      → a take-off: engines rumble while it runs, then a rocket streak lifts off
//               and the window kicks up; a failed push sputters and smokes
//   fetch     → sonar pings while it runs
//   commit    → a stamp: a downward thump and a puff of dust
//   checkout  → a warp: speed lines and a sideways slide
//   merge / cherry-pick / rebase → two streams converge and burst
//   stash     → an implosion; popping one → the burst back out
// Window shakes are CSS (`translate` on #app-screen, compositor-only) and last under a
// second; the push rumble is capped so a slow push is not a slow earthquake.
//
// The personas come from the stones themselves (each is described where it is defined):
// Black Orlov's facets, the Hope's red phosphorescence, Pink Star's petals, the
// Moussaieff's trillion cut and heartbeat, Dresden's vines and aurora, Argyle's night sky,
// Golden Jubilee's fireworks, Koh-i-Noor's ink and light, and the Chameleon, whose colour
// genuinely changes with heat: activity warms the whole theme from olive towards gold
// (html.heat-1..4, read by 06-gems.css) and it cools when you stop.
//
// Everything here is inert unless html.theme-gem is set, which applyTheme does for a gem
// theme. It watches the <html> class rather than being called by applyTheme, so it cannot
// miss a theme applied before this script loaded (it is script 24).
//
// Readability and responsiveness are the constraints, and they are enforced here:
//   - One canvas over the window (pointer-events: none). Its rAF loop stops the moment no
//     particle is alive and the cursor is still — an idle window draws nothing. Chameleon's
//     cooling runs on a 250 ms timer, not on frames.
//   - A hard particle cap (MAX_PARTS); soft glows are cached sprites, never per-frame
//     gradients; fire colours are quantised so the sprite cache stays small.
//   - Plain cursor movement spawns nothing at all. Window-wide effects (success, a pull's
//     quake, a checkout's warp) are brief and low-alpha, and shakes stay under 5 px.
//   - The cursor highlight is two CSS custom properties written on a handful of chrome
//     elements and the one hovered control, never on <html>: --mx/--my are registered
//     non-inheriting, and an inherited write at the root would restyle every graph row on
//     every mouse move.
//   - prefers-reduced-motion keeps the highlight (it is light, not motion) and drops the
//     particles and the Chameleon's heat.
// ============================================

(function gemJuice() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const html = document.documentElement;
  const reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // Chrome that carries the cursor highlight (background-attachment: fixed in 06-gems.css).
  const LIT_SEL = '.toolbar, .statusbar, .tabs, .repo-tabs, .sidebar-header';
  // Scroll containers lit from *behind* their content. A fixed-attachment background on a
  // scroll container repaints on every scroll, so these get element-local coordinates
  // (--lx/--ly) on an ordinary background instead, which stays put while the rows scroll.
  const LOCAL_LIT_SEL = '#graph-container, #graph-detail';
  // Controls that get the highlight on their own face while hovered.
  const HOT_SEL = '.btn-medieval, .tool-btn, .mini-btn';
  // Things that react to a press.
  const PRESS_SEL = '.btn-medieval, .tool-btn, .mini-btn, .tab, .theme-card, .sidebar-item, .recent-item';
  const RESIZER_SEL = '.pane-resizer';

  const MAX_PARTS = 420;
  const TAU = Math.PI * 2;

  let on = false;
  let canvas = null, ctx = null, dpr = 1, W = 0, H = 0;
  let raf = 0;
  const parts = [];

  // Palette, read from the active gem's CSS (06-gems.css). Every colour an effect uses
  // comes from here, so nothing can drift off the theme.
  let glint = '255,255,255';       // --gem-glint
  let fire = [[255, 255, 255]];    // --gem-fire-1..5, the gem's own dispersion
  let ink = glint;                 // --gem-ink (Koh-i-Noor's pen); defaults to the glint
  let afterglow = '255,106,42';    // --gem-afterglow (the Hope's phosphorescence)
  let smoke = '150,150,165';
  // 'lighter' (additive light) on dark gems; a light gem sets --gem-blend: source-over,
  // because adding light to white shows nothing.
  let blend = 'lighter';
  let gemId = '';
  let persona = null;

  // Cursor
  let mx = -9999, my = -9999, lastX = 0, lastY = 0, lastT = 0, speed = 0;
  let lastPress = null;       // { x, y, t } — where an operation's effect starts from
  let lightDirty = false;
  let lit = [], litAt = 0, localLit = [];
  let hot = null;

  // Interactions
  let mode = null;            // null | 'drag' | 'resize' | 'press-drag'
  let resizer = null;
  let trailAcc = 0, trailN = 0;
  let pressDown = null;       // { x, y, onDot } — graph dots drag by mouse, not HTML5 DnD

  // ---------------------------------------------------------------- helpers

  const now = () => performance.now();
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const particlesAllowed = () => on && !reduceMQ.matches;
  const easeOut = (k) => 1 - Math.pow(1 - k, 3);

  function readPalette() {
    const cs = getComputedStyle(html);
    // Any CSS colour → "r,g,b", resolved by the browser through a hidden probe.
    const probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const rgbOf = (name) => {
      const v = cs.getPropertyValue(name).trim();
      if (!v) return null;
      probe.style.color = '';
      probe.style.color = v;
      const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
      return m && m.length >= 3 ? [Math.round(+m[0]), Math.round(+m[1]), Math.round(+m[2])] : null;
    };
    const g = rgbOf('--gem-glint') || [255, 255, 255];
    glint = g.join(',');
    const stops = [1, 2, 3, 4, 5].map(i => rgbOf('--gem-fire-' + i)).filter(Boolean);
    fire = stops.length ? stops : [g];
    ink = (rgbOf('--gem-ink') || g).join(',');
    afterglow = (rgbOf('--gem-afterglow') || [255, 106, 42]).join(',');
    probe.remove();
    blend = cs.getPropertyValue('--gem-blend').trim() === 'source-over' ? 'source-over' : 'lighter';
    smoke = blend === 'lighter' ? '150,150,165' : '90,100,120';
    spriteCache.clear();

    const prev = gemId;
    gemId = Object.keys(PERSONAS).find(id => html.classList.contains('theme-' + id)) || '';
    persona = Object.assign({}, BASE, PERSONAS[gemId] || {});
    if (prev === 'chameleon' && gemId !== 'chameleon') clearHeat();
    resetPersonaState();
  }

  // A colour along the fire stops, t in [0, 1), wrapping — so a trail that walks t cycles
  // smoothly through the gem's own dispersion. Quantised to 24 steps: smooth to the eye,
  // and it keeps the glow-sprite cache to a few dozen entries. Returns "r,g,b".
  function fireRgb(t) {
    const q = Math.round((((t % 1) + 1) % 1) * 24) / 24;
    const n = fire.length;
    const u = (q % 1) * n;
    const i = Math.floor(u), f = u - i;
    const a = fire[i % n], b = fire[(i + 1) % n];
    return `${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)}`;
  }
  const fireA = (t, alpha) => `rgba(${fireRgb(t)},${alpha})`;

  // Soft glows are drawn from one cached radial-gradient sprite per colour.
  const spriteCache = new Map();
  function sprite(rgb) {
    let c = spriteCache.get(rgb);
    if (c) return c;
    if (spriteCache.size > 96) spriteCache.clear();
    c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, `rgba(${rgb},1)`);
    gr.addColorStop(0.35, `rgba(${rgb},0.45)`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    spriteCache.set(rgb, c);
    return c;
  }
  function drawSprite(rgb, x, y, r, alpha) {
    if (alpha <= 0.004 || r <= 0) return;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sprite(rgb), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  function resizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setActive(flag) { html.classList.toggle('gem-active', !!flag); }

  // ---------------------------------------------------------------- Chameleon heat

  // Activity adds heat; heat decays ~0.09/s. Only the *level* (0–4) reaches the DOM, as a
  // class on <html>: a level change is a short CSS transition of --chameleon-heat, i.e. a
  // restyle a few times a minute at most — never per frame from here.
  let heat = 0, heatLevel = 0, lastCool = 0, coolTimer = 0;
  function addHeat(v) {
    if (gemId !== 'chameleon' || reduceMQ.matches) return;
    heat = Math.min(1, heat + v);
    applyHeat();
    kick();
  }
  function applyHeat() {
    const lvl = heat > 0.78 ? 4 : heat > 0.52 ? 3 : heat > 0.28 ? 2 : heat > 0.08 ? 1 : 0;
    if (lvl === heatLevel) return;
    if (heatLevel) html.classList.remove('heat-' + heatLevel);
    heatLevel = lvl;
    if (lvl) html.classList.add('heat-' + lvl);
  }
  function coolHeat(t) {
    if (heat <= 0) { lastCool = 0; return false; }
    if (lastCool) heat = Math.max(0, heat - (t - lastCool) * 0.00009);
    lastCool = t;
    applyHeat();
    return heat > 0;
  }
  function clearHeat() {
    heat = 0; lastCool = 0;
    if (coolTimer) { clearTimeout(coolTimer); coolTimer = 0; }
    applyHeat();
  }

  // ---------------------------------------------------------------- enable / disable

  function enable() {
    if (on) return;
    on = true;
    canvas = document.createElement('canvas');
    canvas.id = 'gem-juice-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resizeCanvas();
    readPalette();
    litAt = 0;
  }

  function disable() {
    if (!on) return;
    on = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    parts.length = 0;
    if (canvas) canvas.remove();
    canvas = ctx = null;
    for (const el of lit) clearLight(el);
    for (const el of localLit) clearLight(el);
    lit = []; localLit = [];
    for (const c of SHAKES) html.classList.remove(c);
    stopOpLoops();
    if (hot) clearLight(hot);
    hot = null;
    mode = null; resizer = null; pressDown = null;
    setActive(false);
    clearHeat();
    gemId = '';
  }

  // The observer also sees this module's own class toggles (gem-active, heat-N), so only a
  // change to the theme itself (gem → another gem) re-reads the palette.
  let themeKey = '';
  function sync() {
    const want = html.classList.contains('theme-gem');
    const key = Array.from(html.classList).filter(c => c.startsWith('theme-')).sort().join(' ');
    const changed = key !== themeKey;
    themeKey = key;
    if (want && !on) enable();
    else if (!want && on) disable();
    else if (want && on && changed) readPalette();
  }

  // ---------------------------------------------------------------- the loop

  function kick() {
    if (!on || raf) return;
    if (coolTimer) { clearTimeout(coolTimer); coolTimer = 0; }
    raf = requestAnimationFrame(frame);
  }

  function clearLight(el) {
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
    el.style.removeProperty('--lx');
    el.style.removeProperty('--ly');
  }

  function writeLight(t) {
    if (t - litAt > 700) {                  // chrome is re-rendered now and then; re-collect
      litAt = t;
      lit = Array.from(document.querySelectorAll(LIT_SEL));
      localLit = Array.from(document.querySelectorAll(LOCAL_LIT_SEL));
    }
    // Read every rect before writing anything, so the frame never forces a layout mid-write.
    const rects = localLit.map(el => el.getBoundingClientRect());
    const x = mx + 'px', y = my + 'px';
    for (const el of lit) { el.style.setProperty('--mx', x); el.style.setProperty('--my', y); }
    if (hot) { hot.style.setProperty('--mx', x); hot.style.setProperty('--my', y); }
    localLit.forEach((el, i) => {
      el.style.setProperty('--lx', (mx - rects[i].left) + 'px');
      el.style.setProperty('--ly', (my - rects[i].top) + 'px');
    });
  }

  function frame(t) {
    raf = 0;
    if (!on) return;
    if (lightDirty) { lightDirty = false; writeLight(t); }
    const warm = gemId === 'chameleon' && coolHeat(t);

    ctx.clearRect(0, 0, W, H);
    if (parts.length) {
      ctx.globalCompositeOperation = blend;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        const age = t - p.born - (p.delay || 0);
        if (age >= p.life) { p.dead = true; parts.splice(i, 1); continue; }
        if (age < 0) continue;              // staggered: not started yet
        drawParticle(p, age / p.life, t, age);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    if (parts.length || lightDirty) raf = requestAnimationFrame(frame);
    else if (warm) coolTimer = setTimeout(() => { coolTimer = 0; kick(); }, 250);
  }

  // ---------------------------------------------------------------- particles

  function push(p) {
    if (parts.length >= MAX_PARTS) { const old = parts.shift(); old.dead = true; }
    p.born = now();
    parts.push(p);
    kick();
    return p;
  }

  // A sparkle: a four-point star with a soft core. rgb null = the gem's glint colour.
  function spark(x, y, o = {}) {
    return push({
      kind: 'spark', x, y,
      vx: o.vx ?? rand(-0.02, 0.02), vy: o.vy ?? rand(-0.03, 0.01), g: o.g || 0,
      size: o.size ?? rand(2, 4.5), life: o.life ?? rand(380, 680), delay: o.delay || 0,
      rgb: o.rgb ?? null, drag: o.drag ?? 0.996, twinkle: rand(0, TAU),
    });
  }
  function ring(x, y, o = {}) {
    return push({ kind: 'ring', x, y, life: o.life ?? 420, r: o.r ?? 26, rgb: o.rgb ?? null,
                  w: o.w ?? 1.2, a: o.a ?? 0.5, delay: o.delay || 0 });
  }
  function glow(x, y, o = {}) {
    return push({ kind: 'glow', x, y, vx: o.vx || 0, vy: o.vy || 0, size: o.size ?? 12,
                  grow: o.grow || 0, a: o.a ?? 0.6, rgb: o.rgb || glint, life: o.life ?? 900,
                  delay: o.delay || 0 });
  }

  // The generic burst: sparks outward and a ring. Black Orlov's, and every gem's fallback.
  function burst(x, y, count, power = 1, fireShare = 0.35) {
    const base = Math.random();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + rand(-0.3, 0.3);
      const v = rand(0.06, 0.22) * power;
      spark(x, y, {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 0.94,
        size: rand(1.8, 3.6) * (0.8 + power * 0.25), life: rand(420, 700),
        rgb: Math.random() < fireShare ? fireRgb(base + i / count) : null,
      });
    }
    ring(x, y, { r: 26 * power });
  }

  function move(p, dt) {
    if (p.g) p.vy += p.g * dt;
    p.x += (p.vx || 0) * dt; p.y += (p.vy || 0) * dt;
    if (p.drag) { const d = Math.pow(p.drag, dt); p.vx *= d; p.vy *= d; }
    if (p.vrot) p.rot += p.vrot * dt;
  }
  // Fade in over the first `inF` of life, then out.
  const env = (k, inF = 0.15) => (k < inF ? k / inF : 1 - (k - inF) / (1 - inF));

  function drawStar(x, y, s, alpha, color) {
    if (alpha <= 0.004) return;
    ctx.fillStyle = `rgba(${color},${alpha * 0.22})`;
    ctx.beginPath(); ctx.arc(x, y, s * 2.2, 0, TAU); ctx.fill();
    ctx.fillStyle = `rgba(${color},${alpha})`;
    ctx.beginPath();
    ctx.moveTo(x, y - s * 2.4); ctx.lineTo(x + s * 0.38, y - s * 0.38);
    ctx.lineTo(x + s * 2.4, y); ctx.lineTo(x + s * 0.38, y + s * 0.38);
    ctx.lineTo(x, y + s * 2.4); ctx.lineTo(x - s * 0.38, y + s * 0.38);
    ctx.lineTo(x - s * 2.4, y); ctx.lineTo(x - s * 0.38, y - s * 0.38);
    ctx.closePath(); ctx.fill();
  }

  function drawLeaf(x, y, s, rot, rgb, alpha) {
    if (alpha <= 0.004) return;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = `rgba(${rgb},${alpha})`;
    ctx.beginPath();
    ctx.moveTo(-s, 0);
    ctx.quadraticCurveTo(0, -s * 0.55, s, 0);
    ctx.quadraticCurveTo(0, s * 0.55, -s, 0);
    ctx.fill();
    ctx.strokeStyle = `rgba(${glint},${alpha * 0.35})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(-s * 0.8, 0); ctx.lineTo(s * 0.8, 0); ctx.stroke();
    ctx.restore();
  }

  // Edge glow for the window-wide pulses (heartbeat, phosphorescence): four cheap gradients.
  function drawEdges(rgb, a) {
    if (a <= 0.004) return;
    const d = 70;
    const sides = [
      [0, 0, 0, d, 0, 0, W, d], [0, H, 0, H - d, 0, H - d, W, d],
      [0, 0, d, 0, 0, 0, d, H], [W, 0, W - d, 0, W - d, 0, d, H],
    ];
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(rx, ry, rw, rh);
    }
  }

  function drawParticle(p, k, t, age) {
    const dt = Math.min(t - (p.lastT || (p.born + (p.delay || 0))), 40);
    p.lastT = t;
    switch (p.kind) {
      case 'spark': {
        move(p, dt);
        // Grow fast, glitter, fade — scintillation, not confetti.
        const e = env(k);
        const tw = 0.65 + 0.35 * Math.sin(p.twinkle + t * 0.03);
        drawStar(p.x, p.y, p.size * (0.6 + 0.4 * e), Math.max(0, e * tw), p.rgb || glint);
        break;
      }
      case 'ring': {
        const r = 4 + p.r * easeOut(k);
        ctx.strokeStyle = `rgba(${p.rgb || glint},${(1 - k) * p.a})`;
        ctx.lineWidth = p.w * (1 - k * 0.5);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
        break;
      }
      case 'glow': {
        move(p, dt);
        // Long, slow tail: phosphorescence fades like a decay curve, not a straight line.
        const a = p.a * (k < 0.1 ? k / 0.1 : Math.pow(1 - (k - 0.1) / 0.9, 1.6));
        drawSprite(p.rgb, p.x, p.y, p.size * (1 + p.grow * easeOut(k)), a);
        break;
      }
      case 'facet': {
        // A brilliant cut seen from above: table octagon, crown octagon, star facets.
        const r = p.r * (0.3 + 0.7 * easeOut(k));
        const rot = p.rot + k * 0.5;
        const a = (1 - k) * 0.85;
        ctx.strokeStyle = `rgba(${glint},${a})`;
        ctx.lineWidth = 1;
        const outer = [], inner = [];
        for (let i = 0; i < 8; i++) {
          const ang = rot + (i / 8) * TAU;
          outer.push([p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r]);
          const ai = ang + TAU / 16;
          inner.push([p.x + Math.cos(ai) * r * 0.5, p.y + Math.sin(ai) * r * 0.5]);
        }
        ctx.beginPath();
        outer.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        inner.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        for (let i = 0; i < 8; i++) {
          ctx.moveTo(inner[i][0], inner[i][1]); ctx.lineTo(outer[i][0], outer[i][1]);
          ctx.moveTo(inner[i][0], inner[i][1]); ctx.lineTo(outer[(i + 1) % 8][0], outer[(i + 1) % 8][1]);
        }
        ctx.stroke();
        if (k < 0.35) drawSprite(glint, p.x, p.y, r * 0.7, (0.35 - k) * 0.9);
        break;
      }
      case 'bubble': {
        move(p, dt);
        const wob = Math.sin(t * 0.008 + p.ph) * 0.4;
        const r = p.size * (1 + k * 0.4);
        const a = env(k, 0.2) * 0.7;
        ctx.strokeStyle = `rgba(${p.rgb},${a})`;
        ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.arc(p.x + wob, p.y, r, 0, TAU); ctx.stroke();
        ctx.fillStyle = `rgba(${glint},${a * 0.8})`;
        ctx.beginPath(); ctx.arc(p.x + wob - r * 0.35, p.y - r * 0.35, Math.max(0.6, r * 0.22), 0, TAU); ctx.fill();
        break;
      }
      case 'bokeh': {
        move(p, dt);
        const a = env(k, 0.3) * p.a;
        drawSprite(p.rgb, p.x, p.y, p.size * 1.6, a * 0.8);
        ctx.strokeStyle = `rgba(${p.rgb},${a * 0.45})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.stroke();
        break;
      }
      case 'petal': {
        move(p, dt);
        const a = env(k, 0.12) * 0.8;
        if (a <= 0.004) break;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = `rgba(${p.rgb},${a})`;
        ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * 0.48, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(${glint},${a * 0.35})`;
        ctx.beginPath(); ctx.ellipse(-p.size * 0.2, -p.size * 0.1, p.size * 0.45, p.size * 0.18, 0, 0, TAU); ctx.fill();
        ctx.restore();
        break;
      }
      case 'shard': {
        move(p, dt);
        const a = env(k, 0.08) * 0.9;
        if (a <= 0.004) break;
        const s = p.size;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.moveTo(0, -s); ctx.lineTo(s * 0.87, s * 0.5); ctx.lineTo(-s * 0.87, s * 0.5); ctx.closePath();
        ctx.fillStyle = `rgba(${p.rgb},${a})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${glint},${a * 0.6})`;
        ctx.lineWidth = 0.7;
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'pulse': {
        // Window-edge glow. beats: 2 = a heartbeat (lub-dub), 1 = one slow swell.
        const bump = (c, w) => Math.exp(-Math.pow((k - c) / w, 2));
        const a = p.beats === 2 ? Math.max(bump(0.14, 0.07), 0.7 * bump(0.34, 0.07))
                                : bump(0.35, 0.22);
        drawEdges(p.rgb, a * p.a);
        break;
      }
      case 'mote': {
        move(p, dt);
        // Radiance: a mote that flickers like decay, dimming in steps rather than smoothly.
        const flick = Math.random() < 0.12 ? 0.25 : 1;
        const a = env(k, 0.2) * flick;
        drawSprite(p.rgb, p.x, p.y, p.size * 3, a * 0.5);
        ctx.fillStyle = `rgba(${p.rgb},${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 0.6, 0, TAU); ctx.fill();
        break;
      }
      case 'stroke': {
        // A line segment that fades: Dresden's vine and Koh-i-Noor's pen.
        const a = (1 - k) * p.a;
        if (a <= 0.004) break;
        ctx.strokeStyle = `rgba(${p.rgb},${a})`;
        ctx.lineWidth = p.w * (1 - k * 0.45);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x1, p.y1); ctx.stroke();
        break;
      }
      case 'leaf': {
        let x = p.x, y = p.y, rot = p.rot;
        if (p.orbit) {
          const o = p.orbit;
          const ang = o.a + o.w * age;
          const r = o.r0 + (o.r1 - o.r0) * easeOut(k);
          x = o.cx + Math.cos(ang) * r; y = o.cy + Math.sin(ang) * r;
          rot = ang + Math.PI / 2;
        } else move(p, dt);
        drawLeaf(x, y, p.size, p.orbit ? rot : p.rot, p.rgb, env(k, 0.15) * 0.85);
        break;
      }
      case 'aurora': {
        // Curtains of light hanging from the top edge, swaying.
        const a = Math.sin(Math.PI * k);
        const n = 26, sw = W / n;
        for (let i = 0; i < n; i++) {
          const x = i * sw + Math.sin(t * 0.002 + i * 0.55) * 10;
          const h = H * 0.26 * (0.55 + 0.45 * Math.sin(t * 0.0026 + i * 0.8));
          const g = ctx.createLinearGradient(0, 0, 0, h);
          g.addColorStop(0, fireA(i / n, 0.16 * a));
          g.addColorStop(1, fireA(i / n, 0));
          ctx.fillStyle = g;
          ctx.fillRect(x, 0, sw + 3, h);
        }
        break;
      }
      case 'cstar': {
        move(p, dt);
        const a = env(k, 0.1) * (0.7 + 0.3 * Math.sin(t * 0.02 + p.ph));
        // Constellation: a thin line to the star before it, while both still shine.
        const q = p.prev;
        if (q && !q.dead) {
          const qa = Math.min(a, 1 - (t - q.born - (q.delay || 0)) / q.life);
          if (qa > 0.01) {
            ctx.strokeStyle = `rgba(${glint},${qa * 0.32})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          }
        }
        drawStar(p.x, p.y, p.size, a, p.rgb || glint);
        break;
      }
      case 'nebula': {
        const a = Math.sin(Math.PI * k) * p.a;
        drawSprite(p.rgb, p.x, p.y, p.r0 + (p.r1 - p.r0) * easeOut(k), a);
        break;
      }
      case 'streak': {
        // A shooting star: a bright head on an eased path with a fading tail.
        const e = easeOut(k);
        const hx = p.x0 + (p.x1 - p.x0) * e, hy = p.y0 + (p.y1 - p.y0) * e;
        const dx = p.x1 - p.x0, dy = p.y1 - p.y0, len = Math.hypot(dx, dy) || 1;
        const tail = 140 * (1 - k * 0.5);
        const tx = hx - (dx / len) * tail, ty = hy - (dy / len) * tail;
        const a = 1 - Math.pow(k, 3);
        const g = ctx.createLinearGradient(tx, ty, hx, hy);
        g.addColorStop(0, `rgba(${glint},0)`);
        g.addColorStop(0.7, fireA(0.2, 0.35 * a));
        g.addColorStop(1, `rgba(${glint},${0.9 * a})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
        drawStar(hx, hy, 2.2, a, glint);
        break;
      }
      case 'glitter': {
        move(p, dt);
        // A spinning flake: its width is the cosine of its spin; edge-on it flashes white.
        const c = Math.cos(p.rot);
        const w = Math.max(0.5, p.size * Math.abs(c));
        const a = env(k, 0.1) * 0.9;
        ctx.fillStyle = Math.abs(c) > 0.92 ? `rgba(${glint},${a})` : `rgba(${p.rgb},${a})`;
        ctx.fillRect(p.x - w / 2, p.y - p.size / 2, w, p.size);
        break;
      }
      case 'rays': {
        // A sunburst: alternating long and short rays racing outward.
        const e = easeOut(k);
        const a = (1 - k) * 0.85;
        ctx.strokeStyle = `rgba(${p.rgb},${a})`;
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.4 * (1 - k * 0.6);
        ctx.beginPath();
        for (let i = 0; i < p.n; i++) {
          const ang = p.rot + (i / p.n) * TAU;
          const long = i % 2 ? 0.6 : 1;
          const r0 = 4 + p.r * e * 0.45, r1 = 6 + p.r * e * long;
          ctx.moveTo(p.x + Math.cos(ang) * r0, p.y + Math.sin(ang) * r0);
          ctx.lineTo(p.x + Math.cos(ang) * r1, p.y + Math.sin(ang) * r1);
        }
        ctx.stroke();
        if (k < 0.3) drawSprite(p.rgb, p.x, p.y, p.r * 0.5, (0.3 - k) * 1.6);
        break;
      }
      case 'godrays': {
        // Koh-i-Noor, "Mountain of Light": a fan of light falling from above.
        const a = Math.sin(Math.PI * k);
        const ox = W / 2, oy = -60;
        const sway = (k - 0.5) * 0.12;
        for (let i = 0; i < 9; i++) {
          const ang = Math.PI / 2 + (i - 4) * 0.13 + sway;
          const half = 0.022 + (i % 3) * 0.008;
          const L = H * 1.1;
          const g = ctx.createLinearGradient(ox, oy, ox + Math.cos(ang) * L, oy + Math.sin(ang) * L);
          g.addColorStop(0, `rgba(${glint},${0.16 * a})`);
          g.addColorStop(1, `rgba(${glint},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(ox, oy);
          ctx.lineTo(ox + Math.cos(ang - half) * L, oy + Math.sin(ang - half) * L);
          ctx.lineTo(ox + Math.cos(ang + half) * L, oy + Math.sin(ang + half) * L);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 'ember': {
        move(p, dt);
        const x = p.x + Math.sin(t * 0.006 + p.ph) * 2.5;   // heat shimmer
        const a = env(k, 0.15);
        const s = p.size * (1 - k * 0.5);
        drawSprite(p.rgb, x, p.y, s * 3.2, a * 0.45);
        ctx.fillStyle = `rgba(${p.rgb},${a})`;
        ctx.beginPath(); ctx.arc(x, p.y, s, 0, TAU); ctx.fill();
        break;
      }
      case 'smoke': {
        // An error: a dull haze — the stone clouding over.
        move(p, dt);
        drawSprite(smoke, p.x, p.y, p.r0 + (p.r1 - p.r0) * easeOut(k), Math.sin(Math.PI * k) * p.a);
        break;
      }
      case 'wave': {
        // A seismic wavefront: a ring whose edge trembles as it spreads.
        const r = p.r * easeOut(k);
        const a = (1 - k) * p.a;
        if (a <= 0.004) break;
        ctx.strokeStyle = `rgba(${p.rgb || glint},${a})`;
        ctx.lineWidth = 1.4 * (1 - k * 0.5);
        ctx.beginPath();
        for (let i = 0; i <= 72; i++) {
          const ang = (i / 72) * TAU;
          const rr = r + Math.sin(ang * 14 + t * 0.03 + p.ph) * 4 * (1 - k);
          const x = p.x + Math.cos(ang) * rr, y = p.y + Math.sin(ang) * rr;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
        break;
      }
      case 'seismo': {
        // A seismograph trace along the status bar's top edge, loudest under the epicentre.
        const a = (1 - k) * 0.75;
        const amp = 9 * Math.pow(1 - k, 1.6);
        ctx.strokeStyle = `rgba(${p.rgb || glint},${a})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 4) {
          const near = Math.exp(-Math.abs(x - p.ox) / 380);
          const y = p.y + Math.sin(x * 0.11 - t * 0.045) * amp * (0.25 + 0.75 * near)
                        + Math.sin(x * 0.37 + t * 0.02) * amp * 0.25 * near;
          x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
        break;
      }
      case 'home': {
        // A particle drawn to a point (merge streams, a stash imploding).
        const e = k * k;
        const x = p.x0 + (p.tx - p.x0) * e + Math.sin(k * Math.PI) * (p.bend || 0);
        const y = p.y0 + (p.ty - p.y0) * e;
        drawStar(x, y, p.size, Math.min(1, k * 4) * (0.6 + 0.4 * (1 - k)), p.rgb || glint);
        break;
      }
      case 'speed': {
        // A speed line crossing the window (checkout's warp).
        const x = p.x0 + (p.x1 - p.x0) * easeOut(k);
        const a = Math.sin(Math.PI * k) * p.a;
        const g = ctx.createLinearGradient(x - p.len, 0, x, 0);
        g.addColorStop(0, `rgba(${p.rgb || glint},0)`);
        g.addColorStop(1, `rgba(${p.rgb || glint},${a})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = p.w;
        ctx.beginPath(); ctx.moveTo(x - p.len, p.y); ctx.lineTo(x, p.y); ctx.stroke();
        break;
      }
      case 'line': {
        // A glint running down a resizer after release.
        const e = 1 - Math.pow(1 - k, 2);
        const y = p.y0 + (p.y1 - p.y0 + 160) * e - 80;
        const g = ctx.createLinearGradient(0, y - 80, 0, y + 80);
        g.addColorStop(0, fireA(0.0, 0));
        g.addColorStop(0.3, fireA(0.15, 0.55 * (1 - k)));
        g.addColorStop(0.5, `rgba(${glint},${0.95 * (1 - k)})`);
        g.addColorStop(0.7, fireA(0.65, 0.55 * (1 - k)));
        g.addColorStop(1, fireA(0.8, 0));
        ctx.fillStyle = g;
        ctx.fillRect(p.x - 1.5, Math.max(p.y0, y - 80), 3, 160);
        ctx.fillStyle = `rgba(${glint},${0.12 * (1 - k)})`;
        ctx.fillRect(p.x - 6, Math.max(p.y0, y - 40), 12, 80);
        break;
      }
      case 'flash': {
        // Brilliance: one diagonal band of light crossing the window.
        const e = k * k * (3 - 2 * k);
        const cx = -W * 0.35 + e * W * 1.7;
        ctx.save();
        ctx.translate(cx, H / 2);
        ctx.rotate(-0.38);
        const band = 180;
        const g = ctx.createLinearGradient(-band, 0, band, 0);
        const a = Math.sin(Math.PI * k) * (p.a ?? 1);
        g.addColorStop(0, fireA(0.1, 0));
        g.addColorStop(0.35, fireA(0.2, 0.05 * a));
        g.addColorStop(0.5, `rgba(${glint},${0.11 * a})`);
        g.addColorStop(0.65, fireA(0.7, 0.05 * a));
        g.addColorStop(1, fireA(0.8, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-band, -H * 1.2, band * 2, H * 2.4);
        ctx.restore();
        break;
      }
    }
  }

  // ---------------------------------------------------------------- personas

  // Per-persona scratch state (where a vine or a pen stroke last ended, the last star of a
  // constellation). Reset whenever a gesture starts and when the gem changes.
  const st = { px: null, py: null, phase: 0, lastStar: null };
  function resetPersonaState() { st.px = st.py = null; st.phase = 0; st.lastStar = null; }

  // BLACK ORLOV is the base: white scintillation, crisp facet diagrams, a light sweep.
  const BASE = {
    trailSpacing: 9,
    flick(x, y, vx, vy) {
      spark(x, y, { rgb: Math.random() < 0.3 ? fireRgb(Math.random()) : null, vx: vx * 0.05, vy: vy * 0.05 });
    },
    press(x, y, big) {
      push({ kind: 'facet', x, y, r: big ? 30 : 20, rot: rand(0, TAU), life: big ? 560 : 440 });
      burst(x, y, big ? 10 : 5, big ? 1.1 : 0.6, 0.3);
    },
    trail(x, y, nx, ny, n) {
      const side = rand(-1, 1);
      spark(x, y, { rgb: fireRgb(n * 0.035), size: rand(1.6, 3.2), life: rand(450, 750),
                    vx: nx * side * 0.05, vy: ny * side * 0.05 + 0.01, drag: 0.99 });
    },
    success(x, y) {
      push({ kind: 'flash', life: 900 });
      if (x != null) push({ kind: 'facet', x, y, r: 34, rot: rand(0, TAU), life: 650 }), burst(x, y, 12, 0.9, 0.5);
    },
    error(x, y) {
      for (let i = 0; i < 4; i++) {
        push({ kind: 'smoke', x: x + rand(-14, 14), y: y + rand(-8, 8), vx: rand(-0.01, 0.01), vy: -rand(0.006, 0.02),
               r0: 6, r1: rand(26, 40), a: blend === 'lighter' ? 0.22 : 0.18, life: rand(900, 1300), delay: i * 70 });
      }
    },
  };

  const PERSONAS = {
    orlov: {},

    // HOPE — the deep-water blue stone. Its real party trick: after ultraviolet light it
    // phosphoresces red-orange for seconds. So clicks ripple like water and leave an
    // orange afterglow, a drag leaves a glowing wake, and success is that glow rising from
    // the edges of the window.
    hope: {
      flick(x, y, vx, vy) {
        push({ kind: 'bubble', x, y, vx: vx * 0.02, vy: -rand(0.02, 0.05), size: rand(1.6, 3.4),
               ph: rand(0, TAU), rgb: Math.random() < 0.5 ? glint : fireRgb(Math.random()), life: rand(750, 1150) });
      },
      press(x, y, big) {
        ring(x, y, { r: big ? 40 : 28, life: 700, a: 0.55, rgb: fireRgb(0) });
        ring(x, y, { r: big ? 62 : 44, life: 900, a: 0.3, delay: 140, rgb: fireRgb(0.25) });
        glow(x, y, { size: big ? 26 : 18, a: 0.55, rgb: afterglow, life: 2300, delay: 160 });
      },
      trail(x, y, nx, ny, n) {
        spark(x, y, { rgb: fireRgb(n * 0.04), size: rand(1.3, 2.4), life: rand(380, 600),
                      vx: nx * rand(-1, 1) * 0.04, vy: ny * rand(-1, 1) * 0.04 });
        if (n % 3 === 0) glow(x, y, { size: rand(5, 8), a: 0.5, rgb: afterglow, life: rand(1700, 2500), delay: 220 });
      },
      success(x, y) {
        push({ kind: 'pulse', rgb: afterglow, beats: 1, a: 0.32, life: 2000 });
        push({ kind: 'flash', life: 900, a: 0.7 });
        if (x != null) this.press(x, y, true);
      },
    },

    // PINK STAR — the romantic one. Petals unfold where you click, soft bokeh drifts up
    // from a dragged divider, and success is a slow rain of petals.
    pinkstar: {
      flick(x, y, vx, vy) {
        push({ kind: 'bokeh', x, y, vx: vx * 0.015, vy: -rand(0.01, 0.03), size: rand(3, 7),
               a: rand(0.3, 0.5), rgb: fireRgb(Math.random()), life: rand(800, 1300) });
      },
      press(x, y, big) {
        const n = big ? 7 : 5, r0 = rand(0, TAU);
        for (let i = 0; i < n; i++) {
          const a = r0 + (i / n) * TAU, v = big ? 0.13 : 0.09;
          push({ kind: 'petal', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 0.988,
                 rot: a, vrot: rand(-0.002, 0.002), size: big ? 9 : 7, rgb: fireRgb(i / n), life: rand(700, 900) });
        }
        spark(x, y, { vx: 0, vy: 0, size: big ? 3.5 : 2.6, life: 420 });
      },
      trail(x, y, nx, ny, n) {
        push({ kind: 'bokeh', x: x + nx * rand(-6, 6), y: y + ny * rand(-6, 6), vx: 0, vy: -rand(0.008, 0.02),
               size: rand(4, 9), a: rand(0.3, 0.5), rgb: fireRgb(n * 0.03), life: rand(900, 1400) });
      },
      success(x, y) {
        push({ kind: 'flash', life: 900, a: 0.6 });
        for (let i = 0; i < 18; i++) {
          push({ kind: 'petal', x: rand(0, W), y: rand(-40, -8), vx: rand(-0.025, 0.025), vy: rand(0.06, 0.11),
                 rot: rand(0, TAU), vrot: rand(-0.004, 0.004), size: rand(6, 9), rgb: fireRgb(Math.random()),
                 life: rand(2200, 3000), delay: rand(0, 700) });
        }
        if (x != null) this.press(x, y, true);
      },
    },

    // MOUSSAIEFF RED — the rarest colour there is, cut as a trillion (a triangle). Its
    // shapes are triangles; a click shatters into spinning shards; success is a heartbeat
    // at the edges of the window. (The primary button's slow pulse is in 06-gems.css.)
    moussaieff: {
      flick(x, y, vx, vy) {
        push({ kind: 'shard', x, y, vx: vx * 0.04 + rand(-0.02, 0.02), vy: vy * 0.04 - 0.02, g: 0.0003,
               rot: rand(0, TAU), vrot: rand(-0.012, 0.012), size: rand(2, 3.4), rgb: fireRgb(Math.random()), life: rand(520, 820) });
      },
      press(x, y, big) {
        const n = big ? 12 : 8;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + rand(-0.25, 0.25), v = rand(0.1, 0.26) * (big ? 1.2 : 0.9);
          push({ kind: 'shard', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.04, g: 0.0006, drag: 0.985,
                 rot: rand(0, TAU), vrot: rand(-0.02, 0.02), size: rand(3, big ? 6 : 5), rgb: fireRgb(i / n), life: rand(700, 1000) });
        }
        ring(x, y, { r: big ? 30 : 22, rgb: fireRgb(0), a: 0.6 });
      },
      trail(x, y, nx, ny, n) {
        push({ kind: 'shard', x, y, vx: nx * rand(-1, 1) * 0.04, vy: ny * rand(-1, 1) * 0.04 + 0.01, g: 0.0002,
               rot: rand(0, TAU), vrot: rand(-0.01, 0.01), size: rand(1.8, 3.2), rgb: fireRgb(n * 0.04), life: rand(500, 800) });
      },
      success(x, y) {
        push({ kind: 'pulse', rgb: fireRgb(0), beats: 2, a: 0.42, life: 1400 });
        if (x != null) this.press(x, y, true);
      },
    },

    // DRESDEN GREEN — green from natural radiation, kept for centuries in the Green Vault.
    // A resized divider sheds flickering radiant motes, a drag grows a curling vine,
    // clicks spiral leaves outward, and success is an aurora across the top of the window.
    dresden: {
      trailSpacing: 6,
      flick(x, y, vx, vy) {
        push({ kind: 'mote', x, y, vx: vx * 0.015, vy: -rand(0.01, 0.025), size: rand(1.2, 2.4),
               rgb: fireRgb(Math.random()), life: rand(900, 1500) });
      },
      press(x, y, big) {
        const n = big ? 8 : 6;
        for (let i = 0; i < n; i++) {
          push({ kind: 'leaf', orbit: { cx: x, cy: y, a: (i / n) * TAU, r0: 2, r1: big ? 36 : 26, w: 0.004 },
                 size: rand(4, 6), rgb: fireRgb(i / n), life: rand(750, 900) });
        }
        ring(x, y, { r: big ? 22 : 16, rgb: fireRgb(0.6), a: 0.35 });
      },
      trail(x, y, nx, ny, n) {
        st.phase += 0.55;
        const off = Math.sin(st.phase) * 6;
        const vx = x + nx * off, vy = y + ny * off;
        if (st.px != null) {
          push({ kind: 'stroke', x0: st.px, y0: st.py, x1: vx, y1: vy, w: 2.2, a: 0.8, rgb: fireRgb(0), life: 950 });
          if (n % 5 === 0) {
            push({ kind: 'leaf', x: vx, y: vy, vx: nx * 0.02 * Math.sign(off || 1), vy: 0.008,
                   rot: Math.atan2(ny, nx) + (off > 0 ? 0.6 : -0.6), vrot: rand(-0.002, 0.002),
                   size: rand(3.5, 5), rgb: fireRgb(rand(0, 1)), life: 1200 });
          }
        }
        st.px = vx; st.py = vy;
      },
      success(x, y) {
        push({ kind: 'aurora', life: 2000 });
        if (x != null) this.press(x, y, true);
      },
    },

    // ARGYLE VIOLET — from the Australian outback, under its night sky. A drag or a
    // resize leaves stars that join into constellations, a click is a puff of nebula, and success
    // is a shooting star.
    argyle: {
      trailSpacing: 16,
      flick(x, y) {
        const prev = st.lastStar && !st.lastStar.dead && Math.hypot(st.lastStar.x - x, st.lastStar.y - y) < 170 ? st.lastStar : null;
        st.lastStar = push({ kind: 'cstar', x: x + rand(-8, 8), y: y + rand(-8, 8), vx: 0, vy: 0, size: rand(1.3, 2.5),
                             rgb: Math.random() < 0.5 ? null : fireRgb(Math.random()), prev, ph: rand(0, TAU), life: rand(1200, 1700) });
      },
      press(x, y, big) {
        for (let i = 0; i < 3; i++) {
          push({ kind: 'nebula', x: x + rand(-8, 8), y: y + rand(-8, 8), r0: 6, r1: (big ? 50 : 34) * rand(0.7, 1),
                 a: 0.3, rgb: fireRgb(i / 3 + rand(0, 0.1)), life: rand(1000, 1300), delay: i * 60 });
        }
        for (let i = 0; i < (big ? 6 : 4); i++) {
          const a = rand(0, TAU), r = rand(10, big ? 34 : 24);
          spark(x + Math.cos(a) * r, y + Math.sin(a) * r, { vx: 0, vy: 0, size: rand(1.2, 2.2), life: rand(600, 900), delay: rand(80, 300) });
        }
      },
      trail(x, y) { this.flick(x, y); },
      success(x, y) {
        const x0 = rand(W * 0.08, W * 0.35), y0 = rand(H * 0.05, H * 0.2);
        push({ kind: 'streak', x0, y0, x1: x0 + W * rand(0.35, 0.5), y1: y0 + H * rand(0.12, 0.22), life: 1000 });
        if (x != null) this.press(x, y, true);
      },
    },

    // GOLDEN JUBILEE — the largest faceted diamond, named for a king's jubilee. Gold
    // glitter falls from a resized divider, a click is a sunburst, a drag leaves falling gold dust,
    // and success is fireworks.
    jubilee: {
      flick(x, y, vx, vy) {
        push({ kind: 'glitter', x, y, vx: vx * 0.015 + rand(-0.02, 0.02), vy: rand(-0.03, 0), g: 0.00025, drag: 0.998,
               rot: rand(0, TAU), vrot: rand(0.012, 0.03), size: rand(2, 3.4), rgb: fireRgb(Math.random()), life: rand(800, 1200) });
      },
      press(x, y, big) {
        push({ kind: 'rays', x, y, r: big ? 46 : 30, n: big ? 16 : 12, rot: rand(0, TAU), rgb: fireRgb(0), life: 540 });
        const n = big ? 10 : 6;
        for (let i = 0; i < n; i++) {
          const a = rand(0, TAU), v = rand(0.05, 0.16);
          push({ kind: 'glitter', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.05, g: 0.0004, drag: 0.99,
                 rot: rand(0, TAU), vrot: rand(0.015, 0.035), size: rand(2, 3.4), rgb: fireRgb(Math.random()), life: rand(800, 1100) });
        }
      },
      trail(x, y, nx, ny) {
        push({ kind: 'glitter', x: x + rand(-4, 4), y, vx: nx * rand(-0.02, 0.02), vy: rand(0, 0.02), g: 0.0003, drag: 0.998,
               rot: rand(0, TAU), vrot: rand(0.012, 0.03), size: rand(1.6, 3), rgb: fireRgb(Math.random()), life: rand(900, 1300) });
      },
      success(x, y) {
        push({ kind: 'flash', life: 900, a: 0.7 });
        // The fireworks burst over the toolbar band, not over the commit list: a celebration
        // that covers commit messages for a second is a celebration that costs reading.
        for (let b = 0; b < 3; b++) {
          const fx = rand(W * 0.25, W * 0.85), fy = rand(16, 44), d = b * 260;
          push({ kind: 'rays', x: fx, y: fy, r: rand(38, 50), n: 18, rot: rand(0, TAU), rgb: fireRgb(b / 3), life: 700, delay: d });
          for (let i = 0; i < 16; i++) {
            const a = rand(0, TAU), v = rand(0.06, 0.15);
            push({ kind: 'glitter', x: fx, y: fy, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6, g: 0.0001, drag: 0.985,
                   rot: rand(0, TAU), vrot: rand(0.015, 0.035), size: rand(2, 3.4), rgb: fireRgb(Math.random()),
                   life: rand(900, 1300), delay: d });
          }
        }
        if (x != null) this.press(x, y, false);
      },
    },

    // KOH-I-NOOR — the "Mountain of Light", and the light gem. On white, light has to be
    // drawn as ink: clicks are crisp ink ripples, a drag is a calligraphic pen stroke
    // (faster is thinner), and success is rays of light falling from above.
    kohinoor: {
      trailSpacing: 5,
      flick(x, y, vx, vy) {
        spark(x, y, { rgb: Math.random() < 0.5 ? ink : fireRgb(Math.random()), size: rand(1.3, 2.4),
                      vx: vx * 0.04, vy: vy * 0.04, life: rand(380, 620) });
      },
      press(x, y, big) {
        ring(x, y, { r: big ? 34 : 24, w: 1.4, a: 0.55, rgb: ink, life: 620 });
        ring(x, y, { r: big ? 52 : 36, w: 1, a: 0.3, rgb: ink, life: 780, delay: 120 });
      },
      trail(x, y) {
        if (st.px != null) {
          const w = Math.max(0.8, Math.min(3.2, 3.4 - speed * 1.3));
          push({ kind: 'stroke', x0: st.px, y0: st.py, x1: x, y1: y, w, a: 0.6, rgb: ink, life: 850 });
        }
        st.px = x; st.py = y;
      },
      success(x, y) {
        push({ kind: 'godrays', life: 1700 });
        if (x != null) this.press(x, y, true);
      },
    },

    // CHAMELEON — the diamond whose colour changes when heated. Here, *you* are the heat:
    // clicks, drags, resizes and successes warm the whole theme from olive towards gold, and it
    // cools back over about ten seconds of rest. Embers rise, coloured by the current heat.
    chameleon: {
      flick(x, y, vx) {
        push({ kind: 'ember', x, y, vx: vx * 0.01 + rand(-0.01, 0.01), vy: -rand(0.03, 0.07), size: rand(1.2, 2.4),
               ph: rand(0, TAU), rgb: fireRgb(heat * 0.75 + rand(0, 0.1)), life: rand(700, 1100) });
        addHeat(0.004);
      },
      press(x, y, big) {
        ring(x, y, { r: big ? 32 : 22, rgb: fireRgb(heat * 0.75), a: 0.55 });
        for (let i = 0; i < (big ? 10 : 6); i++) {
          push({ kind: 'ember', x: x + rand(-8, 8), y: y + rand(-4, 4), vx: rand(-0.02, 0.02), vy: -rand(0.04, 0.09),
                 size: rand(1.3, 2.6), ph: rand(0, TAU), rgb: fireRgb(heat * 0.75 + rand(0, 0.15)), life: rand(700, 1100) });
        }
        addHeat(big ? 0.12 : 0.06);
      },
      trail(x, y) {
        push({ kind: 'ember', x: x + rand(-4, 4), y, vx: rand(-0.01, 0.01), vy: -rand(0.03, 0.06), size: rand(1.2, 2.2),
               ph: rand(0, TAU), rgb: fireRgb(heat * 0.75 + rand(0, 0.1)), life: rand(700, 1000) });
        addHeat(0.006);
      },
      success(x, y) {
        addHeat(1);
        push({ kind: 'flash', life: 900, a: 0.7 });
        if (x != null) this.press(x, y, true);
      },
    },
  };

  // ---------------------------------------------------------------- gestures

  function trailTo(dx, dy, dist) {
    trailAcc += dist;
    const len = Math.max(dist, 1);
    const nx = -dy / len, ny = dx / len;
    while (trailAcc >= persona.trailSpacing) {
      trailAcc -= persona.trailSpacing;
      const f = trailAcc / len;
      persona.trail(mx - dx * f, my - dy * f, nx, ny, trailN++);
    }
  }

  function beginGesture() {
    trailAcc = 0; trailN = 0;
    resetPersonaState();
    setActive(true);
  }

  function onPointerMove(e) {
    if (!on) return;
    mx = e.clientX; my = e.clientY;
    lightDirty = true;
    kick();

    const t = e.timeStamp || now();
    const dx = mx - lastX, dy = my - lastY;
    const dist = Math.hypot(dx, dy);
    const dt = Math.max(1, t - lastT);
    lastX = mx; lastY = my; lastT = t;
    if (dist > 200) return; // a jump (re-entered the window), not a movement
    speed = speed * 0.75 + (dist / dt) * 0.25;

    if (!particlesAllowed()) return;

    if (mode === 'resize' && resizer) return resizeTrail(dx, dist);
    if (pressDown && (e.buttons & 1)) {
      if (pressDown.onDot && Math.hypot(mx - pressDown.x, my - pressDown.y) > 4) {
        if (mode !== 'press-drag') { mode = 'press-drag'; beginGesture(); }
      }
      if (mode === 'press-drag') return trailTo(dx, dy, dist);
    }
    // Plain movement: light only, no particles (see the header).
  }

  function onPointerOver(e) {
    if (!on) return;
    const el = e.target && e.target.closest ? e.target.closest(HOT_SEL) : null;
    if (el === hot) return;
    if (hot) clearLight(hot);
    hot = el;
    lightDirty = true;
    kick();
  }

  function onLeaveWindow(e) {
    if (!on || e.relatedTarget) return;
    mx = my = -9999;
    lightDirty = true;
    kick();
  }

  function onDragStart() {
    if (!on) return;
    mode = 'drag';
    beginGesture();
  }
  // HTML5 drag suppresses pointermove; dragover carries the position instead.
  function onDragOver(e) {
    if (!on || mode !== 'drag' || !particlesAllowed()) return;
    if (!e.clientX && !e.clientY) return;
    const dx = e.clientX - mx, dy = e.clientY - my;
    const dist = Math.hypot(dx, dy);
    mx = e.clientX; my = e.clientY;
    if (dist > 0 && dist < 200) trailTo(dx, dy, dist);
  }
  function onDragEnd(e) {
    if (!on || mode !== 'drag') return;
    mode = null;
    setActive(false);
    const x = e.clientX || mx, y = e.clientY || my;
    const dropped = e.type === 'drop' || (e.dataTransfer && e.dataTransfer.dropEffect !== 'none');
    if (dropped && particlesAllowed()) persona.press(x, y, true);
  }

  // Resizing: the gem's own flick shape, shed along the divider.
  function resizeTrail(dx, dist) {
    const r = resizer.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const n = Math.min(3, Math.ceil(dist / 6));
    for (let i = 0; i < n; i++) {
      const y = Math.random() < 0.65 ? my + rand(-40, 40) : rand(r.top, r.bottom);
      persona.flick(x + rand(-2, 2), y, -Math.sign(dx) * 0.4, 0);
    }
  }

  function onPointerDown(e) {
    if (!on || e.button !== 0) return;
    const tgt = e.target;
    if (!tgt || !tgt.closest) return;

    const rz = tgt.closest(RESIZER_SEL);
    if (rz) {
      mode = 'resize'; resizer = rz;
      beginGesture();
      return;
    }
    pressDown = { x: e.clientX, y: e.clientY, onDot: !!tgt.closest('circle.commit-dot') };
    lastPress = { x: e.clientX, y: e.clientY, t: now() };

    if (!particlesAllowed()) return;
    const pressed = tgt.closest(PRESS_SEL);
    if (!pressed || pressed.disabled) return;
    persona.press(e.clientX, e.clientY, pressed.classList.contains('primary'));
  }

  function onPointerUp(e) {
    if (!on) return;
    if (mode === 'resize' && resizer) {
      if (particlesAllowed()) {
        const r = resizer.getBoundingClientRect();
        push({ kind: 'line', x: r.left + r.width / 2, y0: r.top, y1: r.bottom, life: 650 });
        persona.press(e.clientX, e.clientY, false);
      }
      resizer = null; mode = null;
      setActive(false);
    } else if (mode === 'press-drag') {
      mode = null;
      setActive(false);
      if (particlesAllowed()) persona.press(e.clientX, e.clientY, true);
    }
    pressDown = null;
  }

  // ---------------------------------------------------------------- git operations

  const SHAKES = ['gem-quake', 'gem-rumble', 'gem-liftoff', 'gem-thump', 'gem-swoosh', 'gem-sputter'];
  const shakeTimers = {};
  // Shake the app (06-gems.css animates `translate` on #app-screen). Removing and re-adding
  // in the next frame restarts the animation without forcing a layout.
  function shake(cls, ms) {
    if (reduceMQ.matches) return;
    clearTimeout(shakeTimers[cls]);
    html.classList.remove(cls);
    requestAnimationFrame(() => {
      if (!on) return;
      html.classList.add(cls);
      shakeTimers[cls] = setTimeout(() => html.classList.remove(cls), ms);
    });
  }

  function opKind(message) {
    const m = String(message || '');
    if (/^(Pulling|LFS pull)/.test(m)) return 'pull';
    if (/^(Pushing|Force-pushing)/.test(m)) return 'push';
    if (/^(Fetching|LFS fetch)/.test(m)) return 'fetch';
    if (/^(Committing|Amending|Combining commits)/.test(m)) return 'commit';
    if (/^(Checking out|Switching to|Returning to)/.test(m)) return 'checkout';
    if (/^(Merging|Cherry-picking|Rebasing)/.test(m)) return 'merge';
    if (/^Stashing/.test(m)) return 'stash';
    if (/^(Popping|Applying)/.test(m) && /stash/i.test(m)) return 'unstash';
    return null;
  }

  // Where an operation's effect starts: the control that was just pressed, else the top
  // of the window (an operation started from a keyboard shortcut or the palette).
  function origin() {
    if (lastPress && now() - lastPress.t < 4000) return { x: lastPress.x, y: lastPress.y };
    return { x: W / 2, y: 44 };
  }

  // Loops that run while an operation runs (push rumble, fetch sonar), always capped.
  const opLoops = {};
  function stopOpLoops(kind) {
    for (const k of kind ? [kind] : Object.keys(opLoops)) {
      if (opLoops[k]) { clearInterval(opLoops[k].id); clearTimeout(opLoops[k].cap); delete opLoops[k]; }
    }
    if (!kind || kind === 'push') html.classList.remove('gem-rumble');
  }
  function loop(kind, everyMs, capMs, fn) {
    stopOpLoops(kind);
    let n = 0;
    const id = setInterval(() => { if (!on) return stopOpLoops(kind); fn(n++); }, everyMs);
    const cap = setTimeout(() => stopOpLoops(kind), capMs);
    opLoops[kind] = { id, cap };
  }

  function exhaust(o, power) {
    for (let i = 0; i < 2 * power; i++) {
      glow(o.x + rand(-6, 6), o.y + 8, { vx: rand(-0.03, 0.03), vy: rand(0.03, 0.08), size: rand(4, 7),
                                        a: 0.5, rgb: fireRgb(rand(0, 0.4)), life: rand(300, 500) });
      push({ kind: 'smoke', x: o.x + rand(-8, 8), y: o.y + 12, vx: rand(-0.05, 0.05), vy: rand(0.01, 0.04),
             r0: 4, r1: rand(14, 24), a: blend === 'lighter' ? 0.16 : 0.12, life: rand(600, 900) });
    }
  }

  const OPS = {
    pull: {
      // P-wave: the faint first arrival while the transfer runs.
      start(o) { push({ kind: 'wave', x: o.x, y: o.y, r: 90, a: 0.35, ph: rand(0, TAU), life: 900 }); },
      // The S-wave: the quake.
      ok(o) {
        shake('gem-quake', 800);
        for (let i = 0; i < 4; i++) {
          push({ kind: 'wave', x: o.x, y: o.y, r: Math.max(W, H) * (0.45 + i * 0.12), a: 0.42 - i * 0.07,
                 rgb: fireRgb(i / 4), ph: rand(0, TAU), life: 1300 + i * 120, delay: i * 130 });
        }
        const sb = document.querySelector('.statusbar');
        const y = sb ? sb.getBoundingClientRect().top : H - 26;
        push({ kind: 'seismo', ox: o.x, y, rgb: fireRgb(0.2), life: 1500 });
      },
      fail(o) { shake('gem-sputter', 450); },
    },
    push: {
      // Engines spooling: a rumble and exhaust at the button, capped at 1.4 s.
      start(o) {
        // loop() first: it clears any previous push loop, and that clears the rumble class.
        loop('push', 70, 1400, (n) => exhaust(o, n < 6 ? 1 : 2));
        if (!reduceMQ.matches) html.classList.add('gem-rumble');
      },
      ok(o) {
        stopOpLoops('push');
        shake('gem-liftoff', 700);
        const x1 = o.x + rand(-40, 40);
        push({ kind: 'streak', x0: o.x, y0: o.y, x1, y1: -60, life: 900 });
        for (let i = 0; i < 14; i++) {                      // the smoke ring at the pad
          const a = rand(0, Math.PI), v = rand(0.06, 0.16);
          push({ kind: 'smoke', x: o.x, y: o.y + 10, vx: Math.cos(a) * v * (Math.random() < 0.5 ? -1 : 1), vy: rand(-0.01, 0.02),
                 r0: 5, r1: rand(18, 30), a: blend === 'lighter' ? 0.2 : 0.14, life: rand(800, 1200) });
        }
        for (let i = 0; i < 12; i++) {                      // the burn trail behind the streak
          const f = i / 12;
          glow(o.x + (x1 - o.x) * f * 0.4, o.y - (o.y + 60) * f * 0.4, { size: rand(5, 9), a: 0.45,
               rgb: fireRgb(f * 0.5), life: rand(400, 700), delay: i * 30 });
        }
      },
      // The engines sputter out.
      fail(o) {
        stopOpLoops('push');
        shake('gem-sputter', 450);
        for (let i = 0; i < 5; i++) {
          push({ kind: 'smoke', x: o.x + rand(-10, 10), y: o.y + rand(-4, 8), vx: rand(-0.02, 0.02), vy: -rand(0.01, 0.03),
                 r0: 5, r1: rand(20, 34), a: blend === 'lighter' ? 0.24 : 0.16, life: rand(900, 1400), delay: i * 90 });
        }
      },
    },
    fetch: {
      start(o) {
        const ping = () => {
          ring(o.x, o.y, { r: 70, w: 1.2, a: 0.5, rgb: fireRgb(0.1), life: 1000 });
          ring(o.x, o.y, { r: 40, w: 1, a: 0.35, rgb: fireRgb(0.3), life: 800, delay: 120 });
        };
        ping();
        loop('fetch', 850, 3500, ping);
      },
      ok(o) { stopOpLoops('fetch'); ring(o.x, o.y, { r: 110, w: 1.6, a: 0.55, rgb: glint, life: 900 }); },
      fail() { stopOpLoops('fetch'); },
    },
    commit: {
      ok(o) {
        shake('gem-thump', 420);
        persona.press(o.x, o.y, true);
        for (let i = 0; i < 8; i++) {                       // dust kicked out sideways
          const dir = i % 2 ? 1 : -1;
          push({ kind: 'smoke', x: o.x + dir * rand(4, 14), y: o.y + rand(6, 12), vx: dir * rand(0.04, 0.1), vy: -rand(0, 0.02),
                 r0: 3, r1: rand(12, 20), a: blend === 'lighter' ? 0.18 : 0.12, life: rand(600, 900) });
        }
      },
    },
    checkout: {
      ok(o) {
        shake('gem-swoosh', 520);
        for (let i = 0; i < 14; i++) {
          const y = rand(H * 0.08, H * 0.92);
          push({ kind: 'speed', x0: -80, x1: W + 260, y, len: rand(120, 260), w: rand(0.8, 1.6),
                 a: rand(0.18, 0.34), rgb: Math.random() < 0.5 ? null : fireRgb(Math.random()),
                 life: rand(380, 560), delay: rand(0, 160) });
        }
      },
    },
    merge: {
      ok(o) {
        const n = 16, travel = 650;
        for (let i = 0; i < n; i++) {
          const left = i % 2 === 0;
          push({ kind: 'home', x0: left ? -10 : W + 10, y0: o.y + rand(-80, 80), tx: o.x, ty: o.y,
                 bend: rand(-60, 60), size: rand(1.6, 2.8), rgb: fireRgb(left ? 0.1 : 0.6), life: travel, delay: i * 18 });
        }
        setTimeout(() => { if (on) persona.press(o.x, o.y, true); }, travel + n * 18 - 120);
      },
    },
    stash: {
      ok(o) {
        const n = 14;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU, r = rand(50, 80);
          push({ kind: 'home', x0: o.x + Math.cos(a) * r, y0: o.y + Math.sin(a) * r, tx: o.x, ty: o.y,
                 size: rand(1.4, 2.4), rgb: fireRgb(i / n), life: 520 });
        }
        setTimeout(() => { if (on) ring(o.x, o.y, { r: 14, a: 0.7, life: 300 }); }, 480);
      },
    },
    unstash: {
      ok(o) { persona.press(o.x, o.y, true); ring(o.x, o.y, { r: 60, a: 0.4, life: 700 }); },
    },
  };

  function onOp(e) {
    if (!on || !particlesAllowed()) return;
    const d = e.detail || {};
    const kind = opKind(d.message);
    const fx = kind && OPS[kind];
    if (!fx) return;
    const o = origin();
    try {
      if (d.phase === 'start') { if (fx.start) fx.start(o); }
      else if (d.ok === true) { if (fx.ok) fx.ok(o); }
      else if (d.ok === false) { if (fx.fail) fx.fail(o); else stopOpLoops(kind); }
      else stopOpLoops(kind);                     // cancelled
    } catch (err) { /* an effect must never break an operation */ }
  }

  // ---------------------------------------------------------------- toasts: success / error

  // Every git operation already announces its outcome with a toast (showToast in
  // 01-core.js), so that is the one place to listen — no call site needs to know about gems.
  function watchToasts() {
    const box = document.getElementById('toast-container');
    if (!box) return;
    new MutationObserver((muts) => {
      if (!particlesAllowed()) return;
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const ok = n.classList.contains('success'), bad = n.classList.contains('error');
        if (!ok && !bad) continue;
        // Let the toast lay out before reading where it landed.
        requestAnimationFrame(() => {
          if (!on) return;
          const r = n.getBoundingClientRect();
          const x = r.width ? r.left + 18 : null, y = r.width ? r.top + r.height / 2 : null;
          if (ok) persona.success(x, y);
          else if (x != null) persona.error(x, y);
        });
        return;
      }
    }).observe(box, { childList: true });
  }

  // ---------------------------------------------------------------- wiring

  function init() {
    document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
    document.addEventListener('pointerover', onPointerOver, { passive: true });
    document.addEventListener('pointerout', onLeaveWindow, { passive: true });
    document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true, capture: true });
    window.addEventListener('blur', () => { if (on && mode) { mode = null; resizer = null; setActive(false); } });
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('dragover', onDragOver, { passive: true, capture: true });
    document.addEventListener('dragend', onDragEnd, true);
    document.addEventListener('drop', onDragEnd, true);
    window.addEventListener('resize', () => { resizeCanvas(); litAt = 0; });
    if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', () => { parts.length = 0; clearHeat(); });

    new MutationObserver(sync).observe(html, { attributes: true, attributeFilter: ['class'] });
    watchToasts();
    document.addEventListener('gitgood:op', onOp);
    sync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
