// Comic-page backdrops for the hero themes, Marvel and DC alike.
//
// Settings → Appearance → Marvel themes → Backdrop picks one of three for every hero theme:
//   'art'   — the theme's own suit art (00-hero-themes.js), drawn by CSS as before;
//   'comic' — a full comic page starring that character (assets/comics/<theme id>.webp);
//   'print' — the same page as it would come off a newspaper press.
//
// The pages are generated offline (tools/comic-pages, `npm run comics`) and shipped *flat*.
// Everything that makes one look printed happens here, in a fragment shader, at the
// window's real pixel size: the CMYK separation, each plate screened into dots on its own
// angle (the rosette), the plates landing a pixel out of register, and the paper. Doing it
// here rather than baking it in keeps the dots crisp however the page is scaled to cover
// the window, and keeps each page a fifth of the size.
//
// The page is drawn on a fixed <canvas> under .screen (z-index 1, same layer as the suit
// art's body::before), so it is a backdrop exactly like the art: never drawn over text.
// Without WebGL the flat page is drawn with a 2D context instead — no dots, still a comic.

const heroComic = {
  style: 'art',
  canvas: null,
  gl: null,        // WebGL context, or false once it has failed
  prog: null,
  loc: null,
  tex: null,
  img: null,       // the loaded page
  imgId: null,     // which theme it belongs to
  token: 0,        // guards against a slow load landing after a newer theme switch
};

const HERO_COMIC_STYLES = ['art', 'comic', 'print'];

function applyHeroStyle(style) {
  heroComic.style = HERO_COMIC_STYLES.includes(style) ? style : 'art';
  refreshHeroComic();
}

// The hero theme currently applied, read off the classes applyTheme sets.
function activeHeroThemeId() {
  const cl = document.documentElement.classList;
  if (!cl.contains('theme-hero') || typeof HERO_THEMES === 'undefined') return null;
  const t = HERO_THEMES.find(t => cl.contains('theme-' + t.id));
  return t ? t.id : null;
}

// Called by applyTheme and applyHeroStyle: show, hide, or re-load the page.
function refreshHeroComic() {
  const id = activeHeroThemeId();
  const on = !!id && heroComic.style !== 'art';
  document.documentElement.classList.toggle('hero-comic', on);
  if (!on) return;
  heroComicCanvas();
  if (heroComic.imgId === id && heroComic.img) { drawHeroComic(); return; }
  const token = ++heroComic.token;
  const img = new Image();
  img.onload = () => {
    if (token !== heroComic.token) return;
    heroComic.img = img;
    heroComic.imgId = id;
    heroComic.texFor = null;
    drawHeroComic();
  };
  img.onerror = () => {
    // A theme with no page falls back to its suit art rather than a blank backdrop.
    if (token !== heroComic.token) return;
    document.documentElement.classList.remove('hero-comic');
    console.warn('No comic page for', id);
  };
  img.src = `assets/comics/${id}.webp`;
}

function heroComicCanvas() {
  if (heroComic.canvas) return heroComic.canvas;
  const c = document.createElement('canvas');
  c.id = 'hero-comic-print';
  c.setAttribute('aria-hidden', 'true');
  document.body.prepend(c);
  heroComic.canvas = c;
  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { if (document.documentElement.classList.contains('hero-comic')) drawHeroComic(); }, 120);
  });
  return c;
}

// ---------- the press ----------
const HERO_COMIC_VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Mirrors what a four-colour press does, in order: the line art (black plate) prints solid;
// everything else is separated into C, M, Y and a little K relative to the *paper* (so the
// page's cream stays paper, not a field of yellow dots); each plate is screened on its own
// angle; the plates land slightly out of register; ink multiplies onto fibrous stock.
const HERO_COMIC_FS = `
precision highp float;
uniform sampler2D u_page;
uniform vec2 u_res;     // canvas, device px
uniform vec2 u_img;     // page, px
uniform float u_cell;   // screen ruling, device px per dot
uniform float u_print;  // 0 = flat page, 1 = newsprint
uniform float u_reg;    // misregistration, device px

const vec3 PAGE = vec3(0.957, 0.925, 0.847);   // the page colour the generator paints (#f4ecd8)
const vec3 STOCK = vec3(0.95, 0.915, 0.83);    // the newsprint it is printed on
const vec3 INK_C = vec3(0.0, 0.62, 0.87);
const vec3 INK_M = vec3(0.90, 0.10, 0.50);
const vec3 INK_Y = vec3(1.0, 0.89, 0.12);
const vec3 INK_K = vec3(0.13, 0.11, 0.11);

// Page colour under a canvas pixel, with the page scaled to cover the canvas.
vec3 page(vec2 frag) {
  float s = max(u_res.x / u_img.x, u_res.y / u_img.y);
  vec2 px = (vec2(frag.x, u_res.y - frag.y) - u_res * 0.5) / s + u_img * 0.5;
  return texture2D(u_page, clamp(px / u_img, 0.0, 1.0)).rgb;
}

// One pixel's separation: x/y/z = C/M/Y coverage, w = K. The line output is the line art, which
// the black plate prints solid rather than screened.
vec4 separate(vec3 c, out float line) {
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  line = clamp((0.26 - lum) / 0.08, 0.0, 1.0) * clamp((0.22 - sat) / 0.1, 0.0, 1.0);
  vec3 cmy = 1.0 - clamp(c / PAGE, 0.0, 1.0);
  float k = min(min(cmy.r, cmy.g), cmy.b) * 0.55;          // light grey-component replacement
  cmy = clamp((cmy - k) / max(1.0 - k, 0.001), 0.0, 1.0);
  cmy = pow(cmy * (1.0 - line), vec3(0.92));               // a touch of dot gain
  return vec4(cmy, k * (1.0 - line));
}

// Amplitude-modulated dots: round when light, a checkerboard at half, holes near solid.
// Antialiased with a threshold about a pixel wide.
float screen(float v, float deg) {
  float a = radians(deg);
  vec2 p = gl_FragCoord.xy;
  float u = (p.x * cos(a) + p.y * sin(a)) / u_cell;
  float w = (-p.x * sin(a) + p.y * cos(a)) / u_cell;
  float spot = (cos(6.2831853 * u) + cos(6.2831853 * w)) * 0.25 + 0.5;
  return clamp((v - (1.0 - spot)) / (1.4 / u_cell) + 0.5, 0.0, 1.0);
}

// Hash without sine: stable at the large coordinates of a 4K canvas.
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec2 q = gl_FragCoord.xy;
  if (u_print < 0.5) { gl_FragColor = vec4(page(q), 1.0); return; }

  // Each plate reads the page from where *it* landed on the sheet.
  float line, unused;
  vec4 sc = separate(page(q + vec2(u_reg, 0.0)), unused);
  vec4 sm = separate(page(q + vec2(0.0, u_reg)), unused);
  vec4 sy = separate(page(q - vec2(u_reg, u_reg) * 0.7), unused);
  vec4 sk = separate(page(q), line);

  float grain = (vnoise(q * 0.7) - 0.5) * 0.035       // fine tooth
              + (vnoise(q * 0.03) - 0.5) * 0.08        // cloudy formation
              + (vnoise(q * vec2(0.9, 0.08)) - 0.5) * 0.05; // fibres, mostly horizontal
  vec3 col = STOCK * (1.0 + grain);
  col *= 1.0 - screen(sc.x, 15.0) * (1.0 - INK_C);
  col *= 1.0 - screen(sm.y, 75.0) * (1.0 - INK_M);
  col *= 1.0 - screen(sy.z, 0.0) * (1.0 - INK_Y);
  col *= 1.0 - max(screen(sk.w, 45.0), line) * (1.0 - INK_K);
  // Uneven inking across the sheet.
  col *= 1.0 + (vnoise(q * 0.002) - 0.5) * 0.03;
  gl_FragColor = vec4(col, 1.0);
}`;

function heroComicGl() {
  if (heroComic.gl !== null) return heroComic.gl;
  const gl = heroComic.canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) { heroComic.gl = false; return false; }
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  try {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, HERO_COMIC_VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HERO_COMIC_FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    heroComic.prog = p;
    heroComic.loc = Object.fromEntries(['u_page', 'u_res', 'u_img', 'u_cell', 'u_print', 'u_reg'].map(n => [n, gl.getUniformLocation(p, n)]));
    heroComic.tex = gl.createTexture();
    heroComic.gl = gl;
  } catch (e) {
    console.warn('Comic print shader unavailable, drawing the page flat:', e);
    heroComic.gl = false;
  }
  return heroComic.gl;
}

function drawHeroComic() {
  const c = heroComic.canvas, img = heroComic.img;
  if (!c || !img) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr)), h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  const gl = heroComicGl();
  if (!gl) {
    // Fallback: the flat page, scaled to cover.
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return;
  }
  gl.viewport(0, 0, w, h);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, heroComic.tex);
  if (heroComic.texFor !== heroComic.imgId) {
    // Non-power-of-two page: no mipmaps, so clamp and filter linearly.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    heroComic.texFor = heroComic.imgId;
  }
  const L = heroComic.loc;
  gl.uniform1i(L.u_page, 0);
  gl.uniform2f(L.u_res, w, h);
  gl.uniform2f(L.u_img, img.naturalWidth, img.naturalHeight);
  // Five CSS pixels a dot: coarse enough to read as print, fine enough not to be a pattern.
  gl.uniform1f(L.u_cell, 5 * dpr);
  gl.uniform1f(L.u_print, heroComic.style === 'print' ? 1 : 0);
  gl.uniform1f(L.u_reg, 0.9 * dpr);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
