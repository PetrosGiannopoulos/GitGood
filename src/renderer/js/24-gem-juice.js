// ============================================
// GEM JUICE — the motion half of the gem themes (06-gems.css)
//
// Diamonds have three visual properties and each one drives a reaction:
//   brilliance     → a highlight that follows the cursor across the chrome and controls
//   scintillation  → sparkles where the cursor moves *fast* (a slow cursor leaves none)
//   fire           → spectral colour, only while something moves: drag trails, the
//                    resizer line, click bursts, a sweep of light when an operation succeeds
//
// Everything here is inert unless html.theme-gem is set, which applyTheme does for a
// gem theme. It watches the <html> class rather than being called by applyTheme, so it
// cannot miss a theme applied before this script loaded (it is script 24).
//
// Costs, deliberately bounded:
//   - One canvas over the window (pointer-events: none). Its rAF loop stops the moment no
//     particle is alive and the cursor is still — an idle window draws nothing.
//   - The highlight is two CSS custom properties written on a handful of chrome elements
//     and the one hovered control, never on <html>: --mx/--my are registered
//     non-inheriting, and an inherited write at the root would restyle every graph row on
//     every mouse move.
//   - No sparkles over text people read closely (diffs, editors, inputs, the terminal).
//   - prefers-reduced-motion keeps the highlight (it is light, not motion) and drops the
//     particles.
// ============================================

(function gemJuice() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const html = document.documentElement;
  const reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // Chrome that carries the cursor highlight (background-attachment: fixed in 06-gems.css).
  const LIT_SEL = '.toolbar, .statusbar, .tabs, .repo-tabs, .sidebar-header';
  // Controls that get the highlight on their own face while hovered.
  const HOT_SEL = '.btn-medieval, .tool-btn, .mini-btn';
  // Things that react to a press with a burst.
  const PRESS_SEL = '.btn-medieval, .tool-btn, .mini-btn, .tab, .theme-card, .sidebar-item, .recent-item';
  // Where the cursor's sparkles would get in the way of reading.
  const QUIET_SEL = 'textarea, input, select, pre, code, .diff-line, .dsplit-side, .dsplit-row, ' +
                    '.cr-hunk, .terminal-overlay, .xterm, .smartdiff';
  const RESIZER_SEL = '.pane-resizer';

  const MAX_PARTS = 320;
  const SPARK_SPACING = 26;   // px of fast cursor travel per sparkle
  const SPARK_SPEED = 0.9;    // px/ms — below this the cursor leaves no sparkles
  const TRAIL_SPACING = 9;    // px of drag travel per trail particle

  let on = false;
  let canvas = null, ctx = null, dpr = 1, W = 0, H = 0;
  let raf = 0;
  const parts = [];

  // Palette, read from the active gem's CSS (06-gems.css): the glint colour and the five
  // --gem-fire-* stops. The canvas draws its "fire" from the same stops the CSS borders
  // use, so sparkles, trails and the resizer line can never drift off the theme.
  let glint = '255,255,255';
  let fire = [[255, 255, 255]];

  // Cursor
  let mx = -9999, my = -9999, lastX = 0, lastY = 0, lastT = 0, speed = 0, sparkAcc = 0;
  let lightDirty = false;
  let lit = [], litAt = 0;
  let hot = null;

  // Interactions
  let mode = null;            // null | 'drag' | 'resize' | 'press-drag'
  let resizer = null;
  let trailAcc = 0, trailHue = 0;
  let pressDown = null;       // { x, y, onDot } — graph dots drag by mouse, not HTML5 DnD

  // ---------------------------------------------------------------- helpers

  const now = () => performance.now();
  const rand = (a, b) => a + Math.random() * (b - a);
  const particlesAllowed = () => on && !reduceMQ.matches;

  function readPalette() {
    const cs = getComputedStyle(html);
    // Any CSS colour → [r, g, b], resolved by the browser through a hidden probe.
    const probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const rgbOf = (name) => {
      const v = cs.getPropertyValue(name).trim();
      if (!v) return null;
      probe.style.color = '';
      probe.style.color = v;
      const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
      return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : null;
    };
    const g = rgbOf('--gem-glint') || [255, 255, 255];
    glint = g.join(',');
    const stops = [1, 2, 3, 4, 5].map(i => rgbOf('--gem-fire-' + i)).filter(Boolean);
    fire = stops.length ? stops : [g];
    probe.remove();
  }
  // A colour along the fire stops, t in [0, 1), wrapping — so a trail that walks t
  // cycles smoothly through the theme's own dispersion. Returns "r,g,b".
  function fireRgb(t) {
    const n = fire.length;
    const u = ((((t % 1) + 1) % 1) * n);
    const i = Math.floor(u), f = u - i;
    const a = fire[i % n], b = fire[(i + 1) % n];
    return `${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)}`;
  }
  const fireA = (t, alpha) => `rgba(${fireRgb(t)},${alpha})`;

  function resizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setActive(flag) { html.classList.toggle('gem-active', !!flag); }

  // ---------------------------------------------------------------- enable / disable

  function enable() {
    if (on) return;
    on = true;
    readPalette();
    canvas = document.createElement('canvas');
    canvas.id = 'gem-juice-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resizeCanvas();
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
    lit = [];
    if (hot) clearLight(hot);
    hot = null;
    mode = null; resizer = null; pressDown = null;
    setActive(false);
  }

  // The observer also sees this module's own gem-active toggles, so only a change to the
  // theme itself (gem → another gem) re-reads the palette.
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

  function kick() { if (on && !raf) raf = requestAnimationFrame(frame); }

  function clearLight(el) {
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
  }

  function writeLight(t) {
    if (t - litAt > 700) {                  // chrome is re-rendered now and then; re-collect
      litAt = t;
      lit = Array.from(document.querySelectorAll(LIT_SEL));
    }
    const x = mx + 'px', y = my + 'px';
    for (const el of lit) { el.style.setProperty('--mx', x); el.style.setProperty('--my', y); }
    if (hot) { hot.style.setProperty('--mx', x); hot.style.setProperty('--my', y); }
  }

  function frame(t) {
    raf = 0;
    if (!on) return;
    if (lightDirty) { lightDirty = false; writeLight(t); }

    ctx.clearRect(0, 0, W, H);
    if (parts.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        const age = t - p.born;
        if (age >= p.life) { parts.splice(i, 1); continue; }
        drawParticle(p, age / p.life, t);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    if (parts.length || lightDirty) raf = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- particles

  function push(p) {
    if (parts.length >= MAX_PARTS) parts.shift();
    p.born = now();
    parts.push(p);
    kick();
  }

  // A sparkle: a four-point star with a soft core. rgb null = the gem's glint colour.
  function spark(x, y, o = {}) {
    push({
      kind: 'spark', x, y,
      vx: o.vx ?? rand(-0.02, 0.02), vy: o.vy ?? rand(-0.03, 0.01),
      size: o.size ?? rand(2, 4.5), life: o.life ?? rand(380, 680),
      rgb: o.rgb ?? null, drag: o.drag ?? 0.996, twinkle: rand(0, Math.PI * 2),
    });
  }

  function burst(x, y, count, power = 1, fireShare = 0.35) {
    if (!particlesAllowed()) return;
    const base = Math.random();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand(-0.3, 0.3);
      const v = rand(0.06, 0.22) * power;
      spark(x, y, {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 0.94,
        size: rand(1.8, 3.6) * (0.8 + power * 0.25), life: rand(420, 700),
        rgb: Math.random() < fireShare ? fireRgb(base + i / count) : null,
      });
    }
    push({ kind: 'ring', x, y, life: 420, r: 26 * power });
  }

  function drawStar(x, y, s, alpha, color) {
    ctx.fillStyle = `rgba(${color},${alpha * 0.22})`;
    ctx.beginPath(); ctx.arc(x, y, s * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(${color},${alpha})`;
    ctx.beginPath();
    ctx.moveTo(x, y - s * 2.4); ctx.lineTo(x + s * 0.38, y - s * 0.38);
    ctx.lineTo(x + s * 2.4, y); ctx.lineTo(x + s * 0.38, y + s * 0.38);
    ctx.lineTo(x, y + s * 2.4); ctx.lineTo(x - s * 0.38, y + s * 0.38);
    ctx.lineTo(x - s * 2.4, y); ctx.lineTo(x - s * 0.38, y - s * 0.38);
    ctx.closePath(); ctx.fill();
  }

  function drawParticle(p, k, t) {
    const dt = Math.min(t - (p.lastT || p.born), 40);
    p.lastT = t;
    switch (p.kind) {
      case 'spark': {
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= Math.pow(p.drag, dt); p.vy *= Math.pow(p.drag, dt);
        // Grow fast, glitter, fade — scintillation, not confetti.
        const env = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
        const tw = 0.65 + 0.35 * Math.sin(p.twinkle + t * 0.03);
        const color = p.rgb || glint;
        drawStar(p.x, p.y, p.size * (0.6 + 0.4 * env), Math.max(0, env * tw), color);
        break;
      }
      case 'ring': {
        const r = 4 + p.r * (1 - Math.pow(1 - k, 3));
        ctx.strokeStyle = `rgba(${glint},${(1 - k) * 0.5})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
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
        // Brilliance: one diagonal band of light crossing the window (an op succeeded).
        const e = k * k * (3 - 2 * k);
        const cx = -W * 0.35 + e * W * 1.7;
        ctx.save();
        ctx.translate(cx, H / 2);
        ctx.rotate(-0.38);
        const band = 180;
        const g = ctx.createLinearGradient(-band, 0, band, 0);
        const a = Math.sin(Math.PI * k);
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

  // ---------------------------------------------------------------- cursor

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
        if (mode !== 'press-drag') { mode = 'press-drag'; setActive(true); }
      }
      if (mode === 'press-drag') return dragTrail(dx, dy, dist);
    }

    // Scintillation: sparkles only for a quick flick, and never over text being read.
    if (speed < SPARK_SPEED) { sparkAcc = 0; return; }
    const tgt = e.target;
    if (tgt && tgt.closest && tgt.closest(QUIET_SEL)) return;
    sparkAcc += dist;
    while (sparkAcc >= SPARK_SPACING) {
      sparkAcc -= SPARK_SPACING;
      const f = sparkAcc / Math.max(dist, 1);
      spark(mx - dx * f + rand(-6, 6), my - dy * f + rand(-6, 6), {
        rgb: Math.random() < 0.3 ? fireRgb(Math.random()) : null,
        vx: -dx / dt * 0.05 + rand(-0.02, 0.02), vy: -dy / dt * 0.05 + rand(-0.02, 0.02),
      });
    }
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

  // ---------------------------------------------------------------- drag: dispersion

  // Light through a prism: the trail walks the spectrum as it goes, each particle drifting
  // slightly sideways off the path so the colours fan out behind the cursor.
  function dragTrail(dx, dy, dist) {
    trailAcc += dist;
    const len = Math.max(dist, 1);
    const nx = -dy / len, ny = dx / len;
    while (trailAcc >= TRAIL_SPACING) {
      trailAcc -= TRAIL_SPACING;
      trailHue = (trailHue + 0.035) % 1;
      const f = trailAcc / len;
      const side = rand(-1, 1);
      spark(mx - dx * f, my - dy * f, {
        rgb: fireRgb(trailHue), size: rand(1.6, 3.2), life: rand(450, 750),
        vx: nx * side * 0.05, vy: ny * side * 0.05 + 0.01, drag: 0.99,
      });
    }
  }

  function onDragStart() {
    if (!on) return;
    mode = 'drag'; trailAcc = 0;
    setActive(true);
  }
  // HTML5 drag suppresses pointermove; dragover carries the position instead.
  function onDragOver(e) {
    if (!on || mode !== 'drag' || !particlesAllowed()) return;
    if (!e.clientX && !e.clientY) return;
    const dx = e.clientX - mx, dy = e.clientY - my;
    const dist = Math.hypot(dx, dy);
    mx = e.clientX; my = e.clientY;
    if (dist > 0 && dist < 200) dragTrail(dx, dy, dist);
  }
  function onDragEnd(e) {
    if (!on || mode !== 'drag') return;
    mode = null;
    setActive(false);
    const x = e.clientX || mx, y = e.clientY || my;
    if (e.type === 'drop' || (e.dataTransfer && e.dataTransfer.dropEffect !== 'none')) burst(x, y, 14, 1.1, 0.8);
  }

  // ---------------------------------------------------------------- resize: the fire line

  function resizeTrail(dx, dist) {
    const r = resizer.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const n = Math.min(4, Math.ceil(dist / 5));
    for (let i = 0; i < n; i++) {
      // Most sparks near the cursor, some anywhere along the line.
      const y = Math.random() < 0.65 ? my + rand(-40, 40) : rand(r.top, r.bottom);
      spark(x, y, {
        rgb: fireRgb((y - r.top) / Math.max(r.height, 1)),
        vx: rand(-0.06, 0.06) + Math.sign(dx) * 0.03, vy: rand(-0.02, 0.02),
        size: rand(1.4, 2.8), life: rand(300, 560), drag: 0.97,
      });
    }
  }

  function onPointerDown(e) {
    if (!on || e.button !== 0) return;
    const tgt = e.target;
    if (!tgt || !tgt.closest) return;

    const rz = tgt.closest(RESIZER_SEL);
    if (rz) {
      mode = 'resize'; resizer = rz;
      setActive(true);
      return;
    }
    pressDown = { x: e.clientX, y: e.clientY, onDot: !!tgt.closest('circle.commit-dot') };

    if (!particlesAllowed()) return;
    const pressed = tgt.closest(PRESS_SEL);
    if (!pressed || pressed.disabled) return;
    const primary = pressed.classList.contains('primary');
    burst(e.clientX, e.clientY, primary ? 16 : 7, primary ? 1.3 : 0.7, primary ? 0.6 : 0.25);
  }

  function onPointerUp(e) {
    if (!on) return;
    if (mode === 'resize' && resizer) {
      if (particlesAllowed()) {
        const r = resizer.getBoundingClientRect();
        push({ kind: 'line', x: r.left + r.width / 2, y0: r.top, y1: r.bottom, life: 650 });
        burst(e.clientX, e.clientY, 8, 0.6, 0.7);
      }
      resizer = null; mode = null;
      setActive(false);
    } else if (mode === 'press-drag') {
      mode = null;
      setActive(false);
      burst(e.clientX, e.clientY, 12, 1, 0.8);
    }
    pressDown = null;
  }

  // ---------------------------------------------------------------- success: brilliance

  // Every successful operation already announces itself with a success toast (showToast in
  // 01-core.js), so that is the one place to listen — no call site needs to know about gems.
  function watchToasts() {
    const box = document.getElementById('toast-container');
    if (!box) return;
    new MutationObserver((muts) => {
      if (!particlesAllowed()) return;
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || !n.classList.contains('success')) continue;
        push({ kind: 'flash', life: 900 });
        // Let the toast lay out before reading where it landed.
        requestAnimationFrame(() => {
          const r = n.getBoundingClientRect();
          if (r.width) burst(r.left + 18, r.top + r.height / 2, 12, 0.9, 0.7);
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
    if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', () => { parts.length = 0; });

    new MutationObserver(sync).observe(html, { attributes: true, attributeFilter: ['class'] });
    watchToasts();
    sync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
