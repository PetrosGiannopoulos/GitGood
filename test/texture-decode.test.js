// The texture decoders behind the Unity smart diff's hover preview. TGA and PSD are what
// Unity projects are mostly made of and a browser can draw neither, so 04-diff.js decodes
// them itself. The regressions worth catching are silent ones: an image drawn upside down
// (TGA's bottom-up default), channels swapped (TGA stores BGR), or PackBits runs misread.
const test = require('node:test');
const assert = require('node:assert');

global.document = { addEventListener() {}, createElement() { return {}; }, getElementById() { return null; } };
const { decodeTga, decodePsd } = require('../src/renderer/js/04-diff.js');

const px = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

// 2×2: top-left red, top-right green, bottom-left blue, bottom-right white.
const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], WHITE = [255, 255, 255, 255];
const tgaHeader = (type, bpp, desc) => [0, 0, type, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, bpp, desc];
const bgr = ([r, g, b]) => [b, g, r];

test('decodeTga: uncompressed 24-bit, bottom-up rows and BGR order', () => {
  // Stored bottom row first: blue, white, then red, green.
  const bytes = Uint8Array.from([...tgaHeader(2, 24, 0), ...bgr(BLUE), ...bgr(WHITE), ...bgr(RED), ...bgr(GREEN)]);
  const img = decodeTga(bytes);
  assert.deepStrictEqual([img.width, img.height], [2, 2]);
  assert.deepStrictEqual(px(img, 0, 0), RED);
  assert.deepStrictEqual(px(img, 1, 0), GREEN);
  assert.deepStrictEqual(px(img, 0, 1), BLUE);
  assert.deepStrictEqual(px(img, 1, 1), WHITE);
});

test('decodeTga: RLE 32-bit, top-down, an all-zero alpha channel is treated as opaque', () => {
  // Top row: a run of two red pixels; bottom row: two raw pixels, blue then white.
  const bytes = Uint8Array.from([...tgaHeader(10, 32, 0x20),
    0x81, ...bgr(RED), 0,
    0x01, ...bgr(BLUE), 0, ...bgr(WHITE), 0]);
  const img = decodeTga(bytes);
  assert.deepStrictEqual(px(img, 0, 0), RED);
  assert.deepStrictEqual(px(img, 1, 0), RED);
  assert.deepStrictEqual(px(img, 0, 1), BLUE);
  assert.deepStrictEqual(px(img, 1, 1), WHITE);
});

test('decodeTga: a real alpha channel is kept; unsupported and truncated files say so', () => {
  const bytes = Uint8Array.from([...tgaHeader(2, 32, 0x20), ...bgr(RED), 128, ...bgr(RED), 0, ...bgr(RED), 0, ...bgr(RED), 0]);
  assert.strictEqual(px(decodeTga(bytes), 0, 0)[3], 128);
  assert.strictEqual(px(decodeTga(bytes), 1, 0)[3], 0);
  assert.match(decodeTga(Uint8Array.from(tgaHeader(1, 8, 0))).error, /No preview/);
  assert.match(decodeTga(Uint8Array.from(tgaHeader(2, 24, 0))).error, /Truncated/);
});

// A minimal PSD: header, three empty sections, then the composite.
function psd(channels, mode, comp, body) {
  const head = Buffer.alloc(26);
  head.write('8BPS', 0, 'latin1');
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(channels, 12);
  head.writeUInt32BE(2, 14);       // height
  head.writeUInt32BE(2, 18);       // width
  head.writeUInt16BE(8, 22);
  head.writeUInt16BE(mode, 24);
  const sections = Buffer.alloc(12);    // three zero lengths
  const c = Buffer.alloc(2); c.writeUInt16BE(comp, 0);
  return new Uint8Array(Buffer.concat([head, sections, c, Buffer.from(body)]));
}

test('decodePsd: raw planar RGB composite', () => {
  // Planes, row-major: R, G, B — red, green / blue, white.
  const img = decodePsd(psd(3, 3, 0, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]));
  assert.deepStrictEqual(px(img, 0, 0), RED);
  assert.deepStrictEqual(px(img, 1, 0), GREEN);
  assert.deepStrictEqual(px(img, 0, 1), BLUE);
  assert.deepStrictEqual(px(img, 1, 1), WHITE);
});

test('decodePsd: PackBits RGBA composite, runs and literals per row', () => {
  // Row byte counts first (channels × height, 16-bit), then each row's PackBits data.
  // A run of 2 is header 0xFF (-1 → 2 copies); a literal of 2 is header 0x01.
  const rows = [
    [0xFF, 200], [0x01, 10, 20],       // R
    [0xFF, 0], [0xFF, 0],              // G
    [0xFF, 0], [0x01, 30, 40],         // B
    [0xFF, 255], [0x01, 0, 128],       // A
  ];
  const counts = [];
  for (const r of rows) counts.push(0, r.length);
  const img = decodePsd(psd(4, 3, 1, [...counts, ...rows.flat()]));
  assert.deepStrictEqual(px(img, 0, 0), [200, 0, 0, 255]);
  assert.deepStrictEqual(px(img, 1, 0), [200, 0, 0, 255]);
  assert.deepStrictEqual(px(img, 0, 1), [10, 0, 30, 0]);
  assert.deepStrictEqual(px(img, 1, 1), [20, 0, 40, 128]);
});

test('decodePsd: greyscale, and refusals for what it cannot draw', () => {
  const img = decodePsd(psd(1, 1, 0, [0, 50, 100, 255]));
  assert.deepStrictEqual(px(img, 1, 0), [50, 50, 50, 255]);
  assert.match(decodePsd(psd(4, 4, 0, [])).error, /CMYK/);
  assert.match(decodePsd(psd(3, 3, 2, [])).error, /ZIP/);
  assert.match(decodePsd(psd(3, 3, 0, [1, 2])).error, /Truncated/);
  assert.match(decodePsd(Uint8Array.from([1, 2, 3])).error, /Not a PSD/);
});
