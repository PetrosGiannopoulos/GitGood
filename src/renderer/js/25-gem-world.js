// ============================================
// GEM WORLD — what makes each gem theme a *stone*, beyond its palette (06-gems.css) and its
// particles (24-gem-juice.js):
//
//   - Commit dots drawn as the stone's real cut (gemDotSvg, called by 07-graph.js); the HEAD
//     stone's highlight turns toward the cursor (24-gem-juice.js writes the rotation).
//   - The Settings showroom stones (gemStoneHtml, called by 08-lfs-settings.js).
//   - A jeweller's loupe over diffs (hold Ctrl).
//   - Optional synthesized sound per gem (Settings, off by default).
//   - Per-stone lore that carries information:
//       Hope        — commits that arrived with a pull glow orange and fade (gemFreshAge)
//       Moussaieff  — the heartbeat speeds up with repo tension (html.tension-0..3)
//       Black Orlov — destructive confirmations look cursed (#modal-overlay.gem-cursed)
//       Dresden     — the graph grows in like a vine on open; long branches leaf (gemEdgeExtra)
//       Argyle      — constellation lanes by default, HEAD twinkles, tags are stars
//       Jubilee     — tags shimmer gold (CSS); a pushed tag gets fireworks (24-gem-juice.js)
//       Koh-i-Noor  — history rewrites are a "re-cut" (24-gem-juice.js); optional day/night
//                     pairing with Black Orlov (gemDayNight)
//       Chameleon   — drifts with the time of day (html --chameleon-dusk)
//
// Everything is inert outside a gem theme, and nothing here runs per frame: the timers are
// seconds apart and the observers fire on DOM changes the app makes anyway.
// ============================================

const GEM_CUTS = {
  orlov: 'cushion', hope: 'cushion', jubilee: 'cushion',
  pinkstar: 'oval', argyle: 'oval', kohinoor: 'oval',
  moussaieff: 'trillion', dresden: 'pear', chameleon: 'radiant',
};

// Dresden: grow the graph in on its next rebuild (a repo opened, or the theme arrived).
let gemGrowNext = false;

// The active gem's id, or null.
function gemThemeId() {
  const cl = document.documentElement.classList;
  if (!cl.contains('theme-gem')) return null;
  for (const id in GEM_CUTS) if (cl.contains('theme-' + id)) return id;
  return null;
}

// ---------------------------------------------------------------- commit dots as cut stones

// SVG for one commit drawn as the active gem's cut, centred on (cx, cy). Drawn in its own
// pointer-events:none layer *under* the commit circles, which stay as transparent hit targets
// — every click/drag/hover in 07-graph.js keys on `circle.commit-dot`, untouched.
// opts: { head, merge, tagged, rel, selected, fresh, hash }
function gemDotSvg(cx, cy, r, color, opts = {}) {
  const id = gemThemeId();
  if (!id) return '';
  let cut = GEM_CUTS[id];
  if (id === 'argyle' && opts.tagged) cut = 'star';           // Argyle: tags are named stars
  const s = r * (opts.head ? 1.55 : 1.3);
  const f = (n) => Math.round(n * 100) / 100;
  const P = (pts) => pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
  const light = document.documentElement.classList.contains('theme-light');
  const edge = light ? 'rgba(20,30,50,0.55)' : 'rgba(0,0,0,0.55)';
  let outline, table, facets = '';
  const lines = (pairs) => pairs.map(([a, b]) => `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}`).join('');

  if (cut === 'cushion' || cut === 'radiant') {
    const w = s * (cut === 'radiant' ? 0.92 : 1), h = s * (cut === 'radiant' ? 1.12 : 1);
    const c = s * (cut === 'radiant' ? 0.36 : 0.3);
    const o = [[cx - w + c, cy - h], [cx + w - c, cy - h], [cx + w, cy - h + c], [cx + w, cy + h - c],
               [cx + w - c, cy + h], [cx - w + c, cy + h], [cx - w, cy + h - c], [cx - w, cy - h + c]];
    const k = 0.48;
    const t = o.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
    outline = cut === 'cushion'
      ? `<rect x="${f(cx - w)}" y="${f(cy - h)}" width="${f(2 * w)}" height="${f(2 * h)}" rx="${f(s * 0.42)}"/>`
      : `<polygon points="${P(o)}"/>`;
    table = `<polygon class="gem-table" points="${P(t)}"/>`;
    facets = lines(t.map((p, i) => [p, o[i]]));
  } else if (cut === 'oval') {
    const rx = s * 1.18, ry = s * 0.86;
    outline = `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}"/>`;
    table = `<ellipse class="gem-table" cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx * 0.5)}" ry="${f(ry * 0.5)}"/>`;
    const pairs = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pairs.push([[cx + Math.cos(a) * rx * 0.5, cy + Math.sin(a) * ry * 0.5], [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]]);
    }
    facets = lines(pairs);
  } else if (cut === 'trillion') {
    const R = s * 1.3;
    const o = [0, 1, 2].map(i => { const a = -Math.PI / 2 + i * (Math.PI * 2 / 3); return [cx + Math.cos(a) * R, cy + Math.sin(a) * R]; });
    const t = o.map(([x, y]) => [cx + (x - cx) * 0.45, cy + (y - cy) * 0.45]);
    outline = `<polygon points="${P(o)}"/>`;
    table = `<polygon class="gem-table" points="${P(t)}"/>`;
    facets = lines([[t[0], o[0]], [t[1], o[1]], [t[2], o[2]], [t[0], o[1]], [t[1], o[2]], [t[2], o[0]]]);
  } else if (cut === 'pear') {
    const top = cy - s * 1.35, b = cy + s * 0.95;
    outline = `<path d="M${f(cx)} ${f(top)} C${f(cx + s * 0.55)} ${f(cy - s * 0.6)} ${f(cx + s * 1.05)} ${f(cy - s * 0.05)} ${f(cx + s * 1.0)} ${f(cy + s * 0.25)}`
            + ` A${f(s)} ${f(s * 0.72)} 0 0 1 ${f(cx - s * 1.0)} ${f(cy + s * 0.25)}`
            + ` C${f(cx - s * 1.05)} ${f(cy - s * 0.05)} ${f(cx - s * 0.55)} ${f(cy - s * 0.6)} ${f(cx)} ${f(top)}Z"/>`;
    table = `<ellipse class="gem-table" cx="${f(cx)}" cy="${f(cy + s * 0.15)}" rx="${f(s * 0.48)}" ry="${f(s * 0.42)}"/>`;
    facets = lines([[[cx, cy - s * 0.27], [cx, top]], [[cx - s * 0.48, cy + s * 0.15], [cx - s * 1.0, cy + s * 0.25]],
                    [[cx + s * 0.48, cy + s * 0.15], [cx + s * 1.0, cy + s * 0.25]], [[cx, cy + s * 0.57], [cx, b]]]);
  } else {                                                    // star
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2, rr = i % 2 ? s * 0.62 : s * 1.45;
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    outline = `<polygon points="${P(pts)}"/>`;
    table = `<circle class="gem-table" cx="${f(cx)}" cy="${f(cy)}" r="${f(s * 0.4)}"/>`;
  }

  const cls = 'gem-cut' + (opts.head ? ' head' : '') + (opts.merge ? ' merge' : '') + (opts.rel ? ' rel' : '')
            + (opts.selected ? ' selected' : '') + (opts.fresh ? ' fresh' : '');
  // The HEAD stone's specular highlight: drawn at the top, rotated toward the cursor by
  // 24-gem-juice.js (it reads data-cx/cy, so it never has to parse the geometry).
  const spec = opts.head
    ? `<ellipse class="gem-spec" data-cx="${f(cx)}" data-cy="${f(cy)}" cx="${f(cx)}" cy="${f(cy - s * 0.62)}" rx="${f(s * 0.5)}" ry="${f(s * 0.17)}"/>`
    : '';
  return `<g class="${cls}" fill="${color}" stroke="${edge}">`
       + outline.replace(/\/>$/, ' stroke-width="1"/>')
       + table
       + (facets ? `<path class="gem-facets" d="${facets}"/>` : '')
       + spec + `</g>`;
}

// Dresden: a long-lived branch grows leaves along it. "Long-lived" is a lane that runs
// unbroken for GEM_VINE_ROWS rows — measured over the lane's chain of straight edges, since in
// a linear history every edge is a single row long. Marked once per render (07-graph.js).
const GEM_VINE_ROWS = 20;
function gemMarkVines(edges) {
  const on = gemThemeId() === 'dresden';
  const byLane = new Map();
  for (const e of edges) {
    e._vine = false;
    if (!on || e.fromLane !== e.toLane || e.type === 'continue-down' || e.type === 'stub-down') continue;
    if (!byLane.has(e.fromLane)) byLane.set(e.fromLane, []);
    byLane.get(e.fromLane).push(e);
  }
  for (const list of byLane.values()) {
    list.sort((a, b) => Math.min(a.fromRow, a.toRow) - Math.min(b.fromRow, b.toRow));
    let run = [], lo = 0, hi = -1;
    const flush = () => { if (hi - lo >= GEM_VINE_ROWS) for (const e of run) e._vine = true; };
    for (const e of list) {
      const a = Math.min(e.fromRow, e.toRow), b = Math.max(e.fromRow, e.toRow);
      if (run.length && a <= hi) { run.push(e); hi = Math.max(hi, b); }
      else { flush(); run = [e]; lo = a; hi = b; }
    }
    flush();
  }
}
function gemEdgeExtra(e, x1, y1, x2, y2, color) {
  if (!e._vine || x1 !== x2) return '';
  return `<line class="gem-vine" x1="${x1 - 2.6}" y1="${y1}" x2="${x2 - 2.6}" y2="${y2}" stroke="${color}"/>`
       + `<line class="gem-vine b" x1="${x1 + 2.6}" y1="${y1}" x2="${x2 + 2.6}" y2="${y2}" stroke="${color}"/>`;
}

// Argyle draws its lanes as constellations unless the user picked a style themselves.
function gemDefaultLineStyle() {
  return gemThemeId() === 'argyle' ? 'constellations' : null;
}

// ---------------------------------------------------------------- Hope: what a pull brought

// A pull's snapshot of the commits already in the graph; anything the graph shows afterwards
// that was not in it arrived with that pull. Marked the first time the renderer asks (the
// refresh after a pull renders before anything else could), remembered for FRESH_MS.
const GEM_FRESH_MS = 3 * 60 * 1000;
const gemFresh = new Map();               // hash → time it was first seen after a pull
let gemPullSnapshot = null, gemPullDoneAt = 0;

// Seconds since `hash` arrived with a pull, or null. Called by 07-graph.js per row/dot.
function gemFreshAge(hash) {
  if (gemThemeId() !== 'hope') return null;
  const now = Date.now();
  let t = gemFresh.get(hash);
  if (t == null && gemPullSnapshot && now - gemPullDoneAt < 20000 && !gemPullSnapshot.has(hash)) {
    gemFresh.set(hash, now);
    t = now;
  }
  if (t == null) return null;
  const age = now - t;
  if (age > GEM_FRESH_MS) { gemFresh.delete(hash); return null; }
  return age / 1000;
}

// ---------------------------------------------------------------- the Settings showroom

const GEM_STORIES = {
  orlov: 'Black Orlov · 67.50 ct · cushion · the “Eye of Brahma”',
  hope: 'Hope · 45.52 ct · cushion · glows red-orange under UV',
  pinkstar: 'Pink Star · 59.60 ct · oval · $71.2M at auction, 2017',
  moussaieff: 'Moussaieff Red · 5.11 ct · trillion · the largest known fancy red',
  dresden: 'Dresden Green · 41 ct · pear · green from natural radiation',
  argyle: 'Argyle Violet · 2.83 ct · oval · from the Argyle mine, Australia',
  jubilee: 'Golden Jubilee · 545.67 ct · cushion · the largest faceted diamond',
  kohinoor: 'Koh-i-Noor · 105.6 ct · oval · re-cut from 186 ct in 1852',
  chameleon: 'Chameleon · a type, not one stone · turns yellow when heated',
};

// A slowly turning stone for a Settings card: the cut's silhouette (clip-path) over a band of
// facets that slides across it (a transform, so the compositor animates it, not the CPU).
function gemStoneHtml(id, swatches) {
  const cut = GEM_CUTS[id] || 'cushion';
  const [bg, stone, metal, text] = swatches || [];
  return `<span class="gem-stone cut-${cut}" style="--st-stone:${stone};--st-metal:${metal};--st-bg:${bg};--st-text:${text}">`
       + `<span class="gem-stone-body"><span class="gem-stone-facets"></span><span class="gem-stone-table"></span></span>`
       + `</span>`;
}
function gemStory(id) { return GEM_STORIES[id] || ''; }

// ---------------------------------------------------------------- preferences

// gemSound (bool), gemSoundVolume (0–100), gemDayNight (bool). Applied at startup and on
// every Settings save/cancel/preview, like applyHeroBackdrop.
const gemPrefs = { gemSound: false, gemSoundVolume: 40, gemDayNight: false };
function applyGemPrefs(p) {
  if (!p) return;
  for (const k of Object.keys(gemPrefs)) if (p[k] !== undefined) gemPrefs[k] = p[k];
  gemDayNightCheck();
}

// ---------------------------------------------------------------- Koh-i-Noor / Orlov by day and night

const gemDarkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function gemDayNightCheck() {
  if (!gemPrefs.gemDayNight || !gemDarkMQ || typeof applyTheme !== 'function') return;
  const id = gemThemeId();
  if (id !== 'kohinoor' && id !== 'orlov') return;          // only while one of the pair is chosen
  const want = gemDarkMQ.matches ? 'orlov' : 'kohinoor';
  if (want !== id) applyTheme(want);
}
if (gemDarkMQ && gemDarkMQ.addEventListener) gemDarkMQ.addEventListener('change', gemDayNightCheck);

// ---------------------------------------------------------------- sound

// Synthesized, so nothing ships but code. Each gem has a register and a timbre; every cue is
// a few oscillators and an envelope. Off unless Settings turns it on.
const GEM_VOICE = {
  orlov:      { base: 0.80, wave: 'sine' },
  hope:       { base: 0.72, wave: 'sine' },
  pinkstar:   { base: 1.12, wave: 'triangle' },
  moussaieff: { base: 0.92, wave: 'sine' },
  dresden:    { base: 1.00, wave: 'triangle' },
  argyle:     { base: 1.26, wave: 'sine' },
  jubilee:    { base: 1.06, wave: 'triangle' },
  kohinoor:   { base: 1.34, wave: 'sine' },
  chameleon:  { base: 0.95, wave: 'triangle' },
};
let gemAudio = null, gemMaster = null;
function gemAudioCtx() {
  if (!gemAudio) {
    try {
      gemAudio = new (window.AudioContext || window.webkitAudioContext)();
      gemMaster = gemAudio.createGain();
      gemMaster.connect(gemAudio.destination);
    } catch (e) { return null; }
  }
  if (gemAudio.state === 'suspended') gemAudio.resume().catch(() => {});
  gemMaster.gain.value = Math.max(0, Math.min(1, gemPrefs.gemSoundVolume / 100)) * 0.22;
  return gemAudio;
}
function gemTone(ctx, { f, f2, at = 0, dur = 0.5, gain = 0.5, wave = 'sine', attack = 0.005 }) {
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = wave;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(gemMaster);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
function gemNoise(ctx, { at = 0, dur = 0.6, gain = 0.3, from = 300, to = 2400, q = 1.2 }) {
  const t0 = ctx.currentTime + at;
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
  bp.frequency.setValueAtTime(from, t0); bp.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp); bp.connect(g); g.connect(gemMaster);
  src.start(t0); src.stop(t0 + dur + 0.05);
}
// A glass bell: inharmonic partials, as a struck crystal has.
function gemChime(ctx, f, at, wave, gain = 0.45, dur = 1.3) {
  gemTone(ctx, { f, at, dur, gain, wave });
  gemTone(ctx, { f: f * 2.76, at, dur: dur * 0.6, gain: gain * 0.35, wave: 'sine' });
  gemTone(ctx, { f: f * 5.40, at, dur: dur * 0.3, gain: gain * 0.15, wave: 'sine' });
}

function gemSound(cue) {
  if (!gemPrefs.gemSound) return;
  const id = gemThemeId();
  if (!id) return;
  const ctx = gemAudioCtx();
  if (!ctx) return;
  const v = GEM_VOICE[id], b = v.base;
  switch (cue) {
    case 'commit': gemChime(ctx, 880 * b, 0, v.wave); break;
    case 'push':
      gemNoise(ctx, { dur: 0.7, gain: 0.35, from: 280, to: 2600 });
      gemTone(ctx, { f: 220 * b, f2: 660 * b, dur: 0.6, gain: 0.25, wave: v.wave });
      break;
    case 'pull':
      gemTone(ctx, { f: 72 * b, f2: 44 * b, dur: 0.55, gain: 0.7, wave: 'sine', attack: 0.01 });
      gemNoise(ctx, { dur: 0.6, gain: 0.25, from: 180, to: 90, q: 0.7 });
      break;
    case 'fetch': gemTone(ctx, { f: 1180 * b, dur: 0.18, gain: 0.3 }); gemTone(ctx, { f: 1180 * b, at: 0.22, dur: 0.14, gain: 0.1 }); break;
    case 'checkout': gemTone(ctx, { f: 2200 * b, dur: 0.22, gain: 0.25 }); gemTone(ctx, { f: 3100 * b, at: 0.03, dur: 0.18, gain: 0.15 }); break;
    case 'merge': gemTone(ctx, { f: 440 * b, dur: 0.7, gain: 0.25, wave: v.wave }); gemTone(ctx, { f: 660 * b, at: 0.12, dur: 0.7, gain: 0.25, wave: v.wave }); break;
    case 'stash': gemChime(ctx, 1320 * b, 0, v.wave, 0.3, 0.6); gemChime(ctx, 990 * b, 0.1, v.wave, 0.3, 0.6); break;
    case 'recut': [1, 1.25, 1.5, 2].forEach((m, i) => gemChime(ctx, 660 * b * m, i * 0.07, v.wave, 0.28, 0.7)); break;
    case 'tag': [1, 1.26, 1.5, 2, 2.52].forEach((m, i) => gemChime(ctx, 523 * b * m, i * 0.09, v.wave, 0.3, 1)); break;
    case 'theme': [1, 1.5, 2, 3].forEach((m, i) => gemChime(ctx, 740 * b * m, i * 0.06, v.wave, 0.22, 0.9)); break;
    case 'error': gemTone(ctx, { f: 140 * b, f2: 95 * b, dur: 0.32, gain: 0.35, wave: 'square' }); break;
  }
}

// ---------------------------------------------------------------- wiring: operations

document.addEventListener('gitgood:op', (e) => {
  const d = e.detail || {};
  const m = String(d.message || '');
  // Hope: snapshot the graph before a pull so the refresh after it can tell what is new.
  if (/^(Pulling|Rebasing onto)/.test(m) && d.phase === 'start') {
    const g = typeof state !== 'undefined' && state.graph;
    gemPullSnapshot = g && g.commits ? new Set(g.commits.map(c => c.hash)) : null;
  }
  if (/^(Pulling|Rebasing onto)/.test(m) && d.phase === 'end' && d.ok === true) gemPullDoneAt = Date.now();
  if (d.phase !== 'end') return;
  if (d.ok === false) return gemSound('error');
  if (d.ok !== true) return;
  if (/^(Amending|Rewording|Combining commits|Rebasing|Running interactive rebase|Rewriting history)/.test(m)) return gemSound('recut');
  if (/^(Pulling|LFS pull)/.test(m)) return gemSound('pull');
  if (/^(Pushing|Force-pushing)/.test(m)) return gemSound('push');
  if (/^(Fetching|LFS fetch)/.test(m)) return gemSound('fetch');
  if (/^Committing/.test(m)) return gemSound('commit');
  if (/^(Checking out|Switching to|Returning to)/.test(m)) return gemSound('checkout');
  if (/^(Merging|Cherry-picking)/.test(m)) return gemSound('merge');
  if (/^Stashing|stash/i.test(m)) return gemSound('stash');
});
document.addEventListener('gitgood:tag-pushed', () => gemSound('tag'));

// ---------------------------------------------------------------- Moussaieff: repo tension

// 0 clean · 1 uncommitted work · 2 behind the remote · 3 a conflict or an operation stopped
// halfway. Read from state every 1.5 s (a plain object read) and written only on change.
let gemTension = -1;
setInterval(() => {
  const html = document.documentElement;
  if (gemThemeId() !== 'moussaieff' || typeof state === 'undefined') {
    if (gemTension !== -1) { html.classList.remove('tension-0', 'tension-1', 'tension-2', 'tension-3'); gemTension = -1; }
    return;
  }
  const st = state.status, cf = state.conflicts;
  const level = (cf && ((cf.files && cf.files.length) || cf.operation)) ? 3
              : (st && st.behind > 0) ? 2
              : (st && st.files && st.files.length) ? 1 : 0;
  if (level === gemTension) return;
  if (gemTension >= 0) html.classList.remove('tension-' + gemTension);
  html.classList.add('tension-' + level);
  gemTension = level;
}, 1500);

// ---------------------------------------------------------------- Chameleon: time of day

// 0 through the morning, rising from noon to 1 at 21:00, falling back overnight. Written as a
// registered custom property on <html> once every 10 minutes — a whole-document restyle that
// rare is free.
function gemDusk(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  const ss = (x) => x * x * (3 - 2 * x);
  if (h < 6) return ss(1 - h / 6);
  if (h < 12) return 0;
  if (h < 21) return ss((h - 12) / 9);
  return 1;
}
function gemDuskUpdate() {
  const html = document.documentElement;
  if (gemThemeId() === 'chameleon') html.style.setProperty('--chameleon-dusk', gemDusk().toFixed(3));
  else html.style.removeProperty('--chameleon-dusk');
}
setInterval(gemDuskUpdate, 10 * 60 * 1000);

// ---------------------------------------------------------------- observers: theme, modal, graph

(function gemObservers() {
  const html = document.documentElement;
  let lastTheme = '', lastRepo = '';
  const onTheme = () => {
    const id = gemThemeId() || '';
    if (id === lastTheme) return;
    const prev = lastTheme;
    lastTheme = id;
    gemDuskUpdate();
    if (id === 'dresden' && prev !== 'dresden') gemGrowNext = true;   // grow on arrival
  };
  new MutationObserver(onTheme).observe(html, { attributes: true, attributeFilter: ['class'] });

  // Black Orlov: a dialog whose confirm button is a danger button is a cursed one.
  const start = () => {
    const footer = document.getElementById('modal-footer');
    const overlay = document.getElementById('modal-overlay');
    if (footer && overlay) {
      new MutationObserver(() => {
        overlay.classList.toggle('gem-cursed', !!footer.querySelector('.btn-medieval.danger'));
      }).observe(footer, { childList: true });
    }
    // Dresden: when a repository opens (or the theme arrives), the graph grows in once.
    const gc = document.getElementById('graph-container');
    if (gc) {
      new MutationObserver(() => {
        const repo = (typeof state !== 'undefined' && state.repo && state.repo.path) || '';
        if (repo !== lastRepo) { lastRepo = repo; gemGrowNext = true; }
        if (!gemGrowNext || gemThemeId() !== 'dresden') return;
        const svg = gc.querySelector('.graph-svg');
        if (!svg) return;
        gemGrowNext = false;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        svg.classList.add('gem-grow');
        setTimeout(() => svg.classList.remove('gem-grow'), 1600);
      }).observe(gc, { childList: true });
    }
    onTheme();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

// ---------------------------------------------------------------- the jeweller's loupe

// Hold Ctrl over a diff (a short hold, so Ctrl+C / Ctrl+A never flash it): a lens magnifies
// the lines under the cursor. Alt would be the natural key, but this window has a menu bar
// and Windows gives a bare Alt press to it.
//
// The lens holds *clones* of the hovered line and its neighbours, scaled — crisp text, not
// pixels. Clones lose every id, data-* attribute and the `dsel` class: partial staging reads
// `.dsel[data-dkey]` from the whole document (04-diff.js), and a clone must never count.
(function gemLoupe() {
  const R = 118, ZOOM = 1.85, AROUND = 5;
  let el = null, view = null, on = false, timer = 0, held = false;
  let mx = 0, my = 0, target = null, builtFor = null, prevH = 0, raf = 0;

  function ensure() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'gem-loupe';
    el.setAttribute('aria-hidden', 'true');
    view = document.createElement('div');
    view.className = 'gem-loupe-view';
    el.appendChild(view);
    document.body.appendChild(el);
  }
  function hide() {
    on = false; held = false;
    clearTimeout(timer); timer = 0;
    if (el) el.classList.remove('on');
    builtFor = null;
  }
  function strip(node) {
    if (node.nodeType !== 1) return;
    node.removeAttribute('id');
    node.classList.remove('dsel');
    for (const a of Array.from(node.attributes)) if (a.name.startsWith('data-')) node.removeAttribute(a.name);
    for (const c of node.children) strip(c);
  }
  function build(line) {
    const sel = line.classList.contains('dsplit-row') ? '.dsplit-row' : '.diff-line';
    const sibs = Array.from(line.parentElement.children).filter(n => n.matches(sel));
    const i = sibs.indexOf(line);
    const from = Math.max(0, i - AROUND), to = Math.min(sibs.length - 1, i + AROUND);
    const cs = getComputedStyle(line);
    const wrap = document.createElement('div');
    wrap.className = 'gem-loupe-lines';
    wrap.style.width = line.offsetWidth + 'px';
    wrap.style.fontFamily = cs.fontFamily;
    wrap.style.fontSize = cs.fontSize;
    wrap.style.lineHeight = cs.lineHeight;
    prevH = 0;
    for (let k = from; k <= to; k++) {
      const c = sibs[k].cloneNode(true);
      strip(c);
      wrap.appendChild(c);
      if (k < i) prevH += sibs[k].offsetHeight;
    }
    view.innerHTML = '';
    view.appendChild(wrap);
    builtFor = line;
  }
  function update() {
    raf = 0;
    if (!on) return;
    const line = target && target.closest ? target.closest('.diff-line, .dsplit-row') : null;
    if (!line || !gemThemeId()) { el.classList.remove('on'); builtFor = null; return; }
    if (line !== builtFor) build(line);
    const r = line.getBoundingClientRect();
    const px = mx - r.left, py = prevH + (my - r.top);
    const wrap = view.firstChild;
    wrap.style.transform = `translate(${R - px * ZOOM}px, ${R - py * ZOOM}px) scale(${ZOOM})`;
    el.style.transform = `translate(${mx - R}px, ${my - R}px)`;
    el.classList.add('on');
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

  document.addEventListener('pointermove', (e) => {
    mx = e.clientX; my = e.clientY; target = e.target;
    if (on) schedule();
  }, { passive: true, capture: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control') {
      if (e.repeat || held || !gemThemeId()) return;
      held = true;
      timer = setTimeout(() => { ensure(); on = true; schedule(); }, 220);
    } else if (held) hide();                       // Ctrl+<key> is a shortcut, not a look
  }, true);
  document.addEventListener('keyup', (e) => { if (e.key === 'Control') hide(); }, true);
  window.addEventListener('blur', hide);
  document.addEventListener('wheel', () => { if (on) { builtFor = null; schedule(); } }, { passive: true, capture: true });
})();
