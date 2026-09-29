// Renders every character's comic page with Electron's own Chromium, so the SVG is drawn
// by exactly the engine the app uses. Run through `electron`, not node:
//
//   npm run comics                                   (all pages → src/renderer/assets/comics)
//   npx electron tools/comic-pages/render.js <outDir> [id ...] [--png] [--svg]
//
// The pages are written *flat* — clean colour, no dots. The newsprint look (CMYK halftone
// rosette, misregistration, paper) is laid on at runtime by the shader in
// src/renderer/js/22-comic-print.js, at the window's real resolution: baked-in dots would
// blur when the page is scaled to cover the window, and they cost ~5x the bytes.
//
// The page is drawn onto a canvas rather than captured from the window: a window cannot be
// larger than the screen, and the page is 2400×1500. SVG drawn as an image can still use
// installed fonts (Comic Sans MS, Impact), just not web fonts.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { page, W, H } = require('./compose');
const { HEROES } = require('./heroes');

const at = process.argv.findIndex(a => path.resolve(a) === __filename);
const argv = process.argv.slice(at + 1);
const args = argv.filter(a => !a.startsWith('--'));
const asPng = argv.includes('--png'), keepSvg = argv.includes('--svg');
const outDir = path.resolve(args[0] || path.join(__dirname, '../../src/renderer/assets/comics'));
const only = new Set(args.slice(1));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  await win.loadURL('data:text/html,<!doctype html><canvas></canvas>');
  for (const hero of HEROES) {
    if (only.size && !only.has(hero.id)) continue;
    const svg = page(hero);
    if (keepSvg) fs.writeFileSync(path.join(outDir, hero.id + '.svg'), svg);
    const b64 = await win.webContents.executeJavaScript(`(async () => {
      const blob = new Blob([${JSON.stringify(svg)}], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('svg failed to load')); img.src = url; });
      const c = document.querySelector('canvas');
      c.width = ${W}; c.height = ${H};
      c.getContext('2d').drawImage(img, 0, 0, ${W}, ${H});
      URL.revokeObjectURL(url);
      return c.toDataURL(${asPng ? "'image/png'" : "'image/webp', 0.9"}).split(',')[1];
    })()`);
    const file = path.join(outDir, hero.id + (asPng ? '.png' : '.webp'));
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log('rendered', hero.id, Math.round(fs.statSync(file).size / 1024) + ' KB');
  }
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
