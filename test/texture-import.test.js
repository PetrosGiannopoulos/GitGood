// Unity texture import settings — what decides the size a texture actually ships at, which
// the image file in git does not say. The regressions worth catching: reading the legacy
// top-level Max Size instead of the Default platform's, counting a platform override that
// is switched off, and the importer's resize rule (NPOT rounding, sprites never rescaled).
const test = require('node:test');
const assert = require('node:assert');

const { parseTextureImport, diffTextureImport } = require('../src/main/lib/texture-import');
global.document = { addEventListener() {}, createElement() { return {}; }, getElementById() { return null; } };
const { unityImportedSize } = require('../src/renderer/js/04-diff.js');

const meta = ({ type = 0, npot = 1, legacyMax = 2048, defMax = 2048, mips = 1, android = null } = {}) => `fileFormatVersion: 2
guid: 0123456789abcdef0123456789abcdef
TextureImporter:
  internalIDToNameTable: []
  serializedVersion: 12
  mipmaps:
    mipMapMode: 0
    enableMipMap: ${mips}
    sRGBTexture: 1
  isReadable: 0
  maxTextureSize: ${legacyMax}
  textureSettings:
    serializedVersion: 2
    filterMode: 1
  nPOTScale: ${npot}
  spriteMode: ${type === 8 ? 1 : 0}
  textureType: ${type}
  platformSettings:
  - serializedVersion: 3
    buildTarget: DefaultTexturePlatform
    maxTextureSize: ${defMax}
    textureFormat: -1
    textureCompression: 1
    crunchedCompression: 0
    overridden: 0
  - serializedVersion: 3
    buildTarget: Android
    maxTextureSize: ${android ? android.max : 2048}
    textureFormat: ${android ? android.format : -1}
    textureCompression: 1
    crunchedCompression: 0
    overridden: ${android && android.on ? 1 : 0}
  spriteSheet:
    serializedVersion: 2
    sprites: []
  userData:
  assetBundleName:
`;

test('parseTextureImport: Default platform wins over the legacy field; names are readable', () => {
  const s = parseTextureImport(meta({ legacyMax: 4096, defMax: 1024, android: { on: true, max: 512, format: 50 } }));
  assert.strictEqual(s.default.maxTextureSize, 1024);
  assert.strictEqual(s.default.formatLabel, 'Automatic · Normal Quality');
  assert.strictEqual(s.typeName, 'Default');
  assert.strictEqual(s.mipmaps, 1);
  assert.deepStrictEqual(s.platforms.map(p => [p.name, p.overridden, p.maxTextureSize, p.formatLabel]),
    [['Android', true, 512, 'RGB(A) Compressed ASTC 6×6']]);
  // Windows line endings, as a checkout under core.autocrlf leaves them.
  assert.strictEqual(parseTextureImport(meta({ defMax: 256 }).replace(/\n/g, '\r\n')).default.maxTextureSize, 256);
});

test('parseTextureImport: a .meta without a TextureImporter is not a texture', () => {
  assert.strictEqual(parseTextureImport('fileFormatVersion: 2\nguid: abc\nMonoImporter:\n  serializedVersion: 2\n'), null);
  assert.strictEqual(parseTextureImport(''), null);
});

test('diffTextureImport: changes worded for a reader; an override that stays off is ignored', () => {
  const a = parseTextureImport(meta({ defMax: 2048, android: { on: false, max: 2048, format: -1 } }));
  const b = parseTextureImport(meta({ defMax: 1024, mips: 0, android: { on: true, max: 512, format: 50 } }));
  assert.deepStrictEqual(diffTextureImport(a, b), [
    { label: 'Generate Mipmaps', before: 'On', after: 'Off' },
    { label: 'Max Size', before: 2048, after: 1024 },
    { label: 'Android override', before: 'Off', after: '512 · RGB(A) Compressed ASTC 6×6' },
  ]);
  // Values edited inside a disabled override do nothing in Unity, so they are not a change.
  const off1 = parseTextureImport(meta({ android: { on: false, max: 2048, format: -1 } }));
  const off2 = parseTextureImport(meta({ android: { on: false, max: 256, format: 50 } }));
  assert.deepStrictEqual(diffTextureImport(off1, off2), []);
  assert.deepStrictEqual(diffTextureImport(null, b), []);
});

test('unityImportedSize: capped at Max Size, aspect kept', () => {
  assert.deepStrictEqual(unityImportedSize(4096, 4096, { npotScale: 1, textureType: 0 }, 1024), { w: 1024, h: 1024 });
  assert.deepStrictEqual(unityImportedSize(4096, 2048, { npotScale: 1, textureType: 0 }, 1024), { w: 1024, h: 512 });
  assert.deepStrictEqual(unityImportedSize(512, 512, { npotScale: 1, textureType: 0 }, 2048), { w: 512, h: 512 });
  assert.strictEqual(unityImportedSize(0, 512, {}, 2048), null);
});

test('unityImportedSize: non-power-of-two rounding per axis; sprites and "None" never rescale', () => {
  assert.deepStrictEqual(unityImportedSize(600, 300, { npotScale: 1, textureType: 0 }, 2048), { w: 512, h: 256 });
  assert.deepStrictEqual(unityImportedSize(800, 300, { npotScale: 1, textureType: 0 }, 2048), { w: 1024, h: 256 });
  assert.deepStrictEqual(unityImportedSize(600, 300, { npotScale: 2, textureType: 0 }, 2048), { w: 1024, h: 512 });
  assert.deepStrictEqual(unityImportedSize(600, 300, { npotScale: 3, textureType: 0 }, 2048), { w: 512, h: 256 });
  assert.deepStrictEqual(unityImportedSize(600, 300, { npotScale: 0, textureType: 0 }, 2048), { w: 600, h: 300 });
  assert.deepStrictEqual(unityImportedSize(600, 300, { npotScale: 1, textureType: 8 }, 2048), { w: 600, h: 300 });
  // A sprite past Max Size is still capped, aspect kept.
  assert.deepStrictEqual(unityImportedSize(3000, 1500, { npotScale: 1, textureType: 8 }, 1024), { w: 1024, h: 512 });
});
