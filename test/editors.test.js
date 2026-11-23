'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectEditors, pickAuto, resolveEditor, launchPlan } = require('../src/main/lib/editors');

// A fake disk: a set of existing paths; readdir lists the direct children it implies.
function fakeFs(paths) {
  const norm = p => p.replace(/\//g, '\\').toLowerCase();
  const set = new Set(paths.map(norm));
  return {
    exists: p => set.has(norm(p)) || [...set].some(s => s.startsWith(norm(p) + '\\')),
    readdir: p => {
      const pre = norm(p) + '\\';
      const names = new Set();
      for (const orig of paths) {
        const n = norm(orig);
        if (n.startsWith(pre)) names.add(orig.replace(/\//g, '\\').slice(pre.length).split('\\')[0]);
      }
      return [...names];
    }
  };
}

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  PATH: ''
};
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const NPP = 'C:\\Program Files\\Notepad++\\notepad++.exe';
const CODE = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const VS22 = 'D:\\VS\\2022\\Community\\Common7\\IDE\\devenv.exe';
const VS19 = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional\\Common7\\IDE\\devenv.exe';

const win = (paths, extra = {}) => detectEditors(Object.assign({ platform: 'win32', env: ENV, fsx: fakeFs(paths) }, extra));

test('automatic: Notepad when nothing else is installed', () => {
  assert.strictEqual(pickAuto(win([NOTEPAD])).id, 'notepad');
});

test('automatic: Notepad++ over Notepad, VS Code over both, Visual Studio over all', () => {
  assert.strictEqual(pickAuto(win([NOTEPAD, NPP])).id, 'notepadpp');
  assert.strictEqual(pickAuto(win([NOTEPAD, NPP, CODE])).id, 'vscode');
  const vs = [{ instanceId: 'abc', installationPath: 'D:\\VS\\2022\\Community', productPath: VS22,
    displayName: 'Visual Studio Community 2022', installationVersion: '17.10.1' }];
  const auto = pickAuto(win([NOTEPAD, NPP, CODE, VS22], { vsInstances: vs }));
  assert.strictEqual(auto.family, 'visualstudio');
  assert.strictEqual(auto.name, 'Visual Studio Community 2022');
  assert.deepStrictEqual(launchPlan(auto, ['C:\\r\\a.cs']), [{ exe: VS22, args: ['/Edit', 'C:\\r\\a.cs'] }]);
});

test('Visual Studio: Build Tools (no devenv) is skipped, newest install is preferred', () => {
  const vs = [
    { instanceId: 'old', installationPath: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional',
      installationVersion: '16.11.5', catalog: { productLineVersion: '2019' } },
    { instanceId: 'bt', installationPath: 'C:\\BuildTools', installationVersion: '17.12.0' },
    { instanceId: 'new', installationPath: 'D:\\VS\\2022\\Community', installationVersion: '17.9.0', displayName: 'VS 2022' }
  ];
  const list = win([VS19, VS22], { vsInstances: vs }).filter(e => e.family === 'visualstudio');
  assert.deepStrictEqual(list.map(e => e.id), ['vs-new', 'vs-old']);
  assert.strictEqual(list[1].name, 'Visual Studio 2019');
});

test('VS Code installed somewhere unusual is found through `code` on PATH', () => {
  const env = Object.assign({}, ENV, { PATH: 'C:\\Windows;E:\\Tools\\VSCode\\bin' });
  const list = detectEditors({ platform: 'win32', env, fsx: fakeFs(['E:\\Tools\\VSCode\\bin\\code.cmd', 'E:\\Tools\\VSCode\\Code.exe']) });
  assert.strictEqual(list.find(e => e.id === 'vscode').exe, 'E:\\Tools\\VSCode\\Code.exe');
});

test('Notepad++ in a custom folder is found through its registry key', () => {
  const list = win(['E:\\Apps\\npp\\notepad++.exe'], { notepadppDir: 'E:\\Apps\\npp' });
  assert.strictEqual(list.find(e => e.id === 'notepadpp').exe, 'E:\\Apps\\npp\\notepad++.exe');
});

test('other IDEs are listed (newest JetBrains folder wins) but never picked automatically', () => {
  const list = win([
    'C:\\Program Files\\JetBrains\\JetBrains Rider 2023.3\\bin\\rider64.exe',
    'C:\\Program Files\\JetBrains\\JetBrains Rider 2024.2.1\\bin\\rider64.exe',
    'C:\\Program Files\\Sublime Text\\sublime_text.exe',
    'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe'
  ]);
  assert.strictEqual(list.find(e => e.id === 'rider').exe, 'C:\\Program Files\\JetBrains\\JetBrains Rider 2024.2.1\\bin\\rider64.exe');
  assert.ok(list.find(e => e.id === 'sublime'));
  assert.ok(list.find(e => e.id === 'cursor'));
  assert.strictEqual(pickAuto(list), null);
});

test('Notepad gets one process per file; list-taking editors get one', () => {
  const [np] = win([NOTEPAD]);
  assert.strictEqual(launchPlan(np, ['a', 'b']).length, 2);
  const code = win([CODE]).find(e => e.id === 'vscode');
  assert.deepStrictEqual(launchPlan(code, ['a', 'b']), [{ exe: CODE, args: ['a', 'b'] }]);
});

test('resolveEditor: a specific choice, a vanished one, custom and system', () => {
  const list = win([NOTEPAD, NPP, CODE]);
  assert.strictEqual(resolveEditor('notepadpp', '', list, false).editor.id, 'notepadpp');
  const gone = resolveEditor('rider', '', list, false);
  assert.strictEqual(gone.editor.id, 'vscode');
  assert.strictEqual(gone.fellBack, true);
  const custom = resolveEditor('custom', 'E:\\ed\\MyEd.exe', list, true);
  assert.strictEqual(custom.editor.name, 'MyEd');
  assert.strictEqual(resolveEditor('custom', 'E:\\gone.exe', list, false).fellBack, true);
  assert.deepStrictEqual(resolveEditor('system', '', list, false), { kind: 'system' });
});

test('macOS: apps open through `open -a`; the default text editor is the fallback', () => {
  const list = detectEditors({ platform: 'darwin', env: { HOME: '/Users/u' },
    fsx: { exists: p => p === '/Applications/Visual Studio Code.app', readdir: () => [] } });
  const code = list.find(e => e.id === 'vscode');
  assert.deepStrictEqual(launchPlan(code, ['/r/a.cs']), [{ exe: '/usr/bin/open', args: ['-a', '/Applications/Visual Studio Code.app', '/r/a.cs'] }]);
  assert.strictEqual(pickAuto(list.filter(e => e.id !== 'vscode')).id, 'mac-text');
});

test('Linux: editors on PATH; with none of the ranked ones, automatic means system default', () => {
  const list = detectEditors({ platform: 'linux', env: { PATH: '/usr/bin:/snap/bin' },
    fsx: { exists: p => p === '/usr/bin/gedit' || p === '/snap/bin/code', readdir: () => [] } });
  assert.strictEqual(pickAuto(list).id, 'vscode');
  const noCode = list.filter(e => e.id !== 'vscode');
  assert.deepStrictEqual(resolveEditor('auto', '', noCode, false), { kind: 'system' });
});
