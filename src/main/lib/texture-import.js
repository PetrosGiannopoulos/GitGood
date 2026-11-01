// Unity texture import settings, read from a texture's .meta file.
//
// A texture's pixels in git are only the source. What a build actually ships is decided by
// the TextureImporter block of `<texture>.meta`: a max size per platform, a compression
// format, power-of-two rescaling. A 4096² PNG capped at 1024 is a 1024² texture in the
// game, and a commit that only lowers the cap changes nothing but the .meta. This module
// reads that block into plain values, with display names, and lists what changed between
// two versions of it. main.js does the reading; the renderer computes imported sizes,
// because only it knows the source dimensions (it decoded the images).
'use strict';

const { flattenDocument } = require('./smart-diff');

// TextureImporterType. 0 doubles as the old "Image", 1 as "Bump"; 3 and 5 are obsolete.
const TEXTURE_TYPE = {
  0: 'Default', 1: 'Normal map', 2: 'Editor GUI and Legacy GUI', 3: 'Cubemap', 4: 'Cookie', 5: 'Advanced',
  6: 'Lightmap', 7: 'Cursor', 8: 'Sprite (2D and UI)', 10: 'Single Channel', 11: 'Shadowmask', 12: 'Directional Lightmap',
};
const NPOT = { 0: 'None', 1: 'To nearest', 2: 'To larger', 3: 'To smaller' };
const COMPRESSION = { 0: 'None', 1: 'Normal Quality', 2: 'High Quality', 3: 'Low Quality' };
const FILTER = { 0: 'Point', 1: 'Bilinear', 2: 'Trilinear' };
const SPRITE_MODE = { 0: 'None', 1: 'Single', 2: 'Multiple', 3: 'Polygon' };
// TextureImporterFormat: the explicit formats a platform override can pick.
const FORMAT = {
  '-1': 'Automatic', 1: 'Alpha 8', 2: 'ARGB 16', 3: 'RGB 24', 4: 'RGBA 32', 5: 'ARGB 32', 7: 'RGB 16', 9: 'R 16',
  10: 'RGB Compressed DXT1', 12: 'RGBA Compressed DXT5', 13: 'RGBA 16', 24: 'RGB HDR Compressed BC6H',
  25: 'RGB(A) Compressed BC7', 26: 'R Compressed BC4', 27: 'RG Compressed BC5', 28: 'RGB Crunched DXT1',
  29: 'RGBA Crunched DXT5', 30: 'RGB Compressed PVRTC 2 bits', 31: 'RGBA Compressed PVRTC 2 bits',
  32: 'RGB Compressed PVRTC 4 bits', 33: 'RGBA Compressed PVRTC 4 bits', 34: 'RGB Compressed ETC 4 bits',
  45: 'RGB Compressed ETC2 4 bits', 46: 'RGB + 1-bit Alpha Compressed ETC2 4 bits', 47: 'RGBA Compressed ETC2 8 bits',
  48: 'RGB(A) Compressed ASTC 4×4', 49: 'RGB(A) Compressed ASTC 5×5', 50: 'RGB(A) Compressed ASTC 6×6',
  51: 'RGB(A) Compressed ASTC 8×8', 52: 'RGB(A) Compressed ASTC 10×10', 53: 'RGB(A) Compressed ASTC 12×12',
  54: 'RGBA Compressed ASTC 4×4', 55: 'RGBA Compressed ASTC 5×5', 56: 'RGBA Compressed ASTC 6×6',
  57: 'RGBA Compressed ASTC 8×8', 58: 'RGBA Compressed ASTC 10×10', 59: 'RGBA Compressed ASTC 12×12',
  62: 'RG 16', 63: 'R 8', 64: 'RGB Crunched ETC', 65: 'RGBA Crunched ETC2',
};
// buildTarget → the tab name Unity's inspector uses.
const PLATFORM = {
  DefaultTexturePlatform: 'Default', Standalone: 'PC, Mac & Linux', Android: 'Android', iPhone: 'iOS',
  WebGL: 'WebGL', tvOS: 'tvOS', Server: 'Dedicated Server', WindowsStoreApps: 'Universal Windows',
  PS4: 'PS4', PS5: 'PS5', XboxOne: 'Xbox One', GameCoreXboxOne: 'Xbox One (GDK)',
  GameCoreXboxSeries: 'Xbox Series', Switch: 'Nintendo Switch', VisionOS: 'visionOS', LinuxHeadlessSimulation: 'Linux Headless',
};

const named = (table, v) => (v == null ? null : (table[v] || `#${v}`));

// The format a platform ends up with, as the inspector words it: an explicit format when one
// is set, else the compression level Unity chooses a format from automatically.
function formatLabel(p) {
  const base = p.format != null && p.format !== -1 ? named(FORMAT, p.format) : `Automatic · ${named(COMPRESSION, p.compression) || 'Normal Quality'}`;
  return p.crunched ? base + ' · Crunch' : base;
}

// `.meta` text → settings, or null when it holds no TextureImporter (a script's .meta, a
// folder's, a model's). `platforms` lists only the non-default build targets.
function parseTextureImport(text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\r$/, ''));
  const start = lines.findIndex(l => /^TextureImporter:\s*$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^\S/.test(lines[i])) { end = i; break; }
  const props = flattenDocument(lines.slice(start, end));
  const get = (k) => props.get('TextureImporter.' + k);
  const num = (k) => { const v = get(k); return v == null || v === '' || isNaN(Number(v)) ? null : Number(v); };

  const all = [];
  for (let i = 0; get(`platformSettings[${i}].buildTarget`) != null; i++) {
    const pre = `platformSettings[${i}].`;
    const p = {
      target: get(pre + 'buildTarget'),
      maxTextureSize: num(pre + 'maxTextureSize'),
      format: num(pre + 'textureFormat'),
      compression: num(pre + 'textureCompression'),
      quality: num(pre + 'compressionQuality'),
      crunched: num(pre + 'crunchedCompression') === 1,
      overridden: num(pre + 'overridden') === 1,
    };
    p.name = PLATFORM[p.target] || p.target;
    p.formatLabel = formatLabel(p);
    all.push(p);
  }
  // The Default tab is a platform entry since Unity 5.5; older files only have the
  // top-level fields, which newer ones still keep in step.
  const def = all.find(p => p.target === 'DefaultTexturePlatform') || {
    target: 'DefaultTexturePlatform', name: 'Default', maxTextureSize: num('maxTextureSize'),
    format: null, compression: num('textureCompression'), crunched: false, overridden: false,
  };
  if (!def.formatLabel) def.formatLabel = formatLabel(def);
  if (def.maxTextureSize == null) def.maxTextureSize = num('maxTextureSize');

  const s = {
    textureType: num('textureType'), spriteMode: num('spriteMode'), npotScale: num('nPOTScale'),
    mipmaps: num('mipmaps.enableMipMap'), sRGB: num('mipmaps.sRGBTexture'), readable: num('isReadable'),
    filterMode: num('textureSettings.filterMode'), alphaIsTransparency: num('alphaIsTransparency'),
    default: def,
    platforms: all.filter(p => p.target !== 'DefaultTexturePlatform'),
  };
  s.typeName = named(TEXTURE_TYPE, s.textureType);
  return s;
}

// What changed between two versions of the settings, worded for a reader:
// [{ label, before, after }]. Either side may be null (the .meta was added or removed).
// Platform overrides are compared only while switched on — an override that is off keeps
// its old values in the file, and Unity ignores them.
function diffTextureImport(a, b) {
  if (!a || !b) return [];
  const out = [];
  const cmp = (label, x, y) => { if (x !== y) out.push({ label, before: x, after: y }); };
  const onOff = (v) => (v == null ? null : v ? 'On' : 'Off');
  cmp('Texture Type', a.typeName, b.typeName);
  if (a.textureType === 8 || b.textureType === 8) cmp('Sprite Mode', named(SPRITE_MODE, a.spriteMode), named(SPRITE_MODE, b.spriteMode));
  cmp('Non-Power of 2', named(NPOT, a.npotScale), named(NPOT, b.npotScale));
  cmp('sRGB (Color Texture)', onOff(a.sRGB), onOff(b.sRGB));
  cmp('Read/Write', onOff(a.readable), onOff(b.readable));
  cmp('Generate Mipmaps', onOff(a.mipmaps), onOff(b.mipmaps));
  cmp('Filter Mode', named(FILTER, a.filterMode), named(FILTER, b.filterMode));
  cmp('Alpha Is Transparency', onOff(a.alphaIsTransparency), onOff(b.alphaIsTransparency));
  cmp('Max Size', a.default.maxTextureSize, b.default.maxTextureSize);
  cmp('Format', a.default.formatLabel, b.default.formatLabel);
  const targets = new Set([...a.platforms, ...b.platforms].map(p => p.target));
  for (const t of targets) {
    const pa = a.platforms.find(p => p.target === t), pb = b.platforms.find(p => p.target === t);
    const on = (p) => !!(p && p.overridden);
    const name = (pb || pa).name;
    if (on(pa) !== on(pb)) {
      out.push({ label: `${name} override`, before: on(pa) ? `${pa.maxTextureSize} · ${pa.formatLabel}` : 'Off',
        after: on(pb) ? `${pb.maxTextureSize} · ${pb.formatLabel}` : 'Off' });
    } else if (on(pa)) {
      cmp(`${name} Max Size`, pa.maxTextureSize, pb.maxTextureSize);
      cmp(`${name} Format`, pa.formatLabel, pb.formatLabel);
    }
  }
  return out;
}

module.exports = { parseTextureImport, diffTextureImport };
