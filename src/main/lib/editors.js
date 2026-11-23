'use strict';

// External editors: which are installed, what "Automatic" picks, and the command line that
// opens files in each. Pure — the filesystem (exists/readdir) and what Visual Studio's own
// installer reports (vswhere) are passed in, so the rules are testable without any editor
// installed. main.js does the I/O and the spawn.
//
// Automatic follows a fixed order on purpose (asked for, not guessed): Visual Studio, then
// VS Code, then Notepad++, then Notepad, which every Windows has. The other editors are
// detected so they can be chosen in Settings, but never picked silently.

const path = require('path');

const AUTO_RANK = { visualstudio: 4, vscode: 3, notepadpp: 2, notepad: 1 };

// Paths per platform. env is process.env (on Windows its keys are case-insensitive; a test
// passes the exact names).
function winRoots(env) {
  const P = path.win32;
  const local = env.LOCALAPPDATA || (env.USERPROFILE ? P.join(env.USERPROFILE, 'AppData', 'Local') : '');
  return {
    pf: env.ProgramFiles || 'C:\\Program Files',
    pf86: env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    local,
    sys: env.SystemRoot || env.windir || 'C:\\Windows'
  };
}

// Windows editors found at fixed install locations. `paths` lists candidates in preference
// order; the first that exists wins.
const WIN_FIXED = [
  { id: 'vscode', family: 'vscode', name: 'Visual Studio Code',
    paths: r => [[r.local, 'Programs', 'Microsoft VS Code', 'Code.exe'], [r.pf, 'Microsoft VS Code', 'Code.exe'], [r.pf86, 'Microsoft VS Code', 'Code.exe']] },
  { id: 'vscode-insiders', family: 'vscode-insiders', name: 'VS Code Insiders',
    paths: r => [[r.local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'], [r.pf, 'Microsoft VS Code Insiders', 'Code - Insiders.exe']] },
  { id: 'cursor', family: 'cursor', name: 'Cursor', paths: r => [[r.local, 'Programs', 'cursor', 'Cursor.exe']] },
  { id: 'windsurf', family: 'windsurf', name: 'Windsurf', paths: r => [[r.local, 'Programs', 'Windsurf', 'Windsurf.exe']] },
  { id: 'vscodium', family: 'vscodium', name: 'VSCodium',
    paths: r => [[r.local, 'Programs', 'VSCodium', 'VSCodium.exe'], [r.pf, 'VSCodium', 'VSCodium.exe']] },
  { id: 'zed', family: 'zed', name: 'Zed', paths: r => [[r.local, 'Programs', 'Zed', 'Zed.exe']] },
  { id: 'sublime', family: 'sublime', name: 'Sublime Text',
    paths: r => [[r.pf, 'Sublime Text', 'sublime_text.exe'], [r.pf, 'Sublime Text 3', 'sublime_text.exe'],
                 [r.pf86, 'Sublime Text', 'sublime_text.exe'], [r.pf86, 'Sublime Text 3', 'sublime_text.exe']] },
  { id: 'notepadpp', family: 'notepadpp', name: 'Notepad++',
    paths: r => [[r.pf, 'Notepad++', 'notepad++.exe'], [r.pf86, 'Notepad++', 'notepad++.exe']] },
  // Notepad takes one file per process; everything else here opens a list in one window.
  { id: 'notepad', family: 'notepad', name: 'Notepad', multi: false,
    paths: r => [[r.sys, 'System32', 'notepad.exe'], [r.sys, 'notepad.exe']] }
];

// JetBrains IDEs have a version in their folder name, and live in one of three places:
// Program Files\JetBrains\<name ver> (installer), %LOCALAPPDATA%\Programs\<name> (Toolbox
// 2.x) and %LOCALAPPDATA%\JetBrains\Toolbox\apps\<name>\ch-N\<ver> (Toolbox 1.x).
const JETBRAINS = [
  { id: 'rider', name: 'JetBrains Rider', exe: 'rider64.exe', prefixes: ['JetBrains Rider', 'Rider'], mac: ['Rider.app'], bin: ['rider'] },
  { id: 'idea', name: 'IntelliJ IDEA', exe: 'idea64.exe', prefixes: ['IntelliJ IDEA', 'IDEA'], mac: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'], bin: ['idea', 'intellij-idea-ultimate', 'intellij-idea-community'] },
  { id: 'webstorm', name: 'WebStorm', exe: 'webstorm64.exe', prefixes: ['WebStorm'], mac: ['WebStorm.app'], bin: ['webstorm'] },
  { id: 'pycharm', name: 'PyCharm', exe: 'pycharm64.exe', prefixes: ['PyCharm'], mac: ['PyCharm.app', 'PyCharm CE.app'], bin: ['pycharm', 'pycharm-professional', 'pycharm-community'] },
  { id: 'clion', name: 'CLion', exe: 'clion64.exe', prefixes: ['CLion'], mac: ['CLion.app'], bin: ['clion'] }
];

const byVersionDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });

function findJetBrains(jb, r, fsx) {
  const P = path.win32;
  const starts = d => jb.prefixes.some(p => d.toLowerCase().startsWith(p.toLowerCase()));
  const found = [];
  for (const root of [P.join(r.pf, 'JetBrains'), P.join(r.local, 'Programs')]) {
    for (const d of fsx.readdir(root).filter(starts).sort(byVersionDesc)) {
      const exe = P.join(root, d, 'bin', jb.exe);
      if (fsx.exists(exe)) found.push(exe);
    }
  }
  const apps = P.join(r.local, 'JetBrains', 'Toolbox', 'apps');
  for (const d of fsx.readdir(apps).filter(starts)) {
    for (const ch of fsx.readdir(P.join(apps, d)).filter(c => /^ch-\d+$/i.test(c))) {
      for (const v of fsx.readdir(P.join(apps, d, ch)).sort(byVersionDesc)) {
        const exe = P.join(apps, d, ch, v, 'bin', jb.exe);
        if (fsx.exists(exe)) found.push(exe);
      }
    }
  }
  return found[0] || null;
}

// "17.10.35004.147" > "16.11.5": numeric per segment.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// One entry per Visual Studio install that has the IDE (Build Tools has no devenv.exe),
// newest first. Keyed by instanceId, which survives updates, so a chosen install stays
// chosen across a 17.x → 17.y upgrade.
function visualStudios(instances, fsx) {
  const P = path.win32;
  const out = [];
  for (const inst of (Array.isArray(instances) ? instances : [])) {
    if (!inst || !inst.installationPath) continue;
    const devenv = /devenv\.exe$/i.test(inst.productPath || '')
      ? inst.productPath
      : P.join(inst.installationPath, 'Common7', 'IDE', 'devenv.exe');
    if (!fsx.exists(devenv)) continue;
    const year = inst.catalog && inst.catalog.productLineVersion;
    let name = inst.displayName || ('Visual Studio' + (year ? ' ' + year : ''));
    if (inst.isPrerelease && !/preview/i.test(name)) name += ' Preview';
    out.push({
      id: 'vs-' + (inst.instanceId || inst.installationPath),
      family: 'visualstudio', name, exe: devenv,
      // /Edit opens the files in a running Visual Studio rather than starting another one.
      pre: ['/Edit'], multi: true,
      version: inst.installationVersion || ''
    });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

function detectWindows({ env, fsx, vsInstances, notepadppDir }) {
  const P = path.win32;
  const r = winRoots(env);
  const list = visualStudios(vsInstances, fsx);

  // `code` on PATH points at <install>\bin\code.cmd, which finds an install anywhere.
  const pathDirs = String(env.PATH || env.Path || '').split(';').filter(Boolean);
  const codeOnPath = pathDirs
    .filter(d => P.basename(d).toLowerCase() === 'bin' && fsx.exists(P.join(d, 'code.cmd')))
    .map(d => P.join(P.dirname(d), 'Code.exe'));

  for (const e of WIN_FIXED) {
    const candidates = e.paths(r).filter(parts => parts.every(Boolean)).map(parts => P.join(...parts));
    if (e.id === 'vscode') candidates.push(...codeOnPath);
    if (e.id === 'notepadpp' && notepadppDir) candidates.unshift(P.join(notepadppDir, 'notepad++.exe'));
    const exe = candidates.find(c => fsx.exists(c));
    if (exe) list.push({ id: e.id, family: e.family, name: e.name, exe, pre: [], multi: e.multi !== false });
  }
  for (const jb of JETBRAINS) {
    const exe = r.local ? findJetBrains(jb, r, fsx) : null;
    if (exe) list.push({ id: jb.id, family: jb.id, name: jb.name, exe, pre: [], multi: true });
  }
  // gVim: Program Files\Vim\vim91\gvim.exe; the folder carries the version.
  const vimRoot = P.join(r.pf, 'Vim');
  const vim = fsx.readdir(vimRoot).filter(d => /^vim\d+$/i.test(d)).sort(byVersionDesc)
    .map(d => P.join(vimRoot, d, 'gvim.exe')).find(p => fsx.exists(p));
  if (vim) list.push({ id: 'gvim', family: 'gvim', name: 'gVim', exe: vim, pre: ['-p'], multi: true });
  return list;
}

// macOS: an app bundle is opened with `open -a <bundle> <files>`, which hands the files to a
// running instance the way double-clicking would.
const MAC_APPS = [
  { id: 'vscode', name: 'Visual Studio Code', apps: ['Visual Studio Code.app'] },
  { id: 'vscode-insiders', name: 'VS Code Insiders', apps: ['Visual Studio Code - Insiders.app'] },
  { id: 'cursor', name: 'Cursor', apps: ['Cursor.app'] },
  { id: 'windsurf', name: 'Windsurf', apps: ['Windsurf.app'] },
  { id: 'vscodium', name: 'VSCodium', apps: ['VSCodium.app'] },
  { id: 'zed', name: 'Zed', apps: ['Zed.app'] },
  { id: 'sublime', name: 'Sublime Text', apps: ['Sublime Text.app'] },
  { id: 'bbedit', name: 'BBEdit', apps: ['BBEdit.app'] },
  { id: 'xcode', name: 'Xcode', apps: ['Xcode.app'] },
  ...JETBRAINS.map(j => ({ id: j.id, name: j.name, apps: j.mac }))
];

function detectMac({ env, fsx }) {
  const roots = ['/Applications', env.HOME ? path.posix.join(env.HOME, 'Applications') : ''].filter(Boolean);
  const list = [];
  for (const e of MAC_APPS) {
    let app = null;
    for (const root of roots) {
      app = e.apps.map(a => path.posix.join(root, a)).find(p => fsx.exists(p));
      if (app) break;
    }
    if (app) list.push({ id: e.id, family: e.id, name: e.name, exe: '/usr/bin/open', pre: ['-a', app], multi: true });
  }
  // `open -t` is "the default text editor" (TextEdit unless changed) — the Notepad of a Mac.
  list.push({ id: 'mac-text', family: 'notepad', name: 'Default text editor (TextEdit)', exe: '/usr/bin/open', pre: ['-t'], multi: true });
  return list;
}

const LINUX_BINS = [
  { id: 'vscode', name: 'Visual Studio Code', bins: ['code'] },
  { id: 'vscode-insiders', name: 'VS Code Insiders', bins: ['code-insiders'] },
  { id: 'cursor', name: 'Cursor', bins: ['cursor'] },
  { id: 'windsurf', name: 'Windsurf', bins: ['windsurf'] },
  { id: 'vscodium', name: 'VSCodium', bins: ['codium'] },
  { id: 'zed', name: 'Zed', bins: ['zed', 'zeditor'] },
  { id: 'sublime', name: 'Sublime Text', bins: ['subl'] },
  ...JETBRAINS.map(j => ({ id: j.id, name: j.name, bins: j.bin })),
  { id: 'gvim', name: 'gVim', bins: ['gvim'], pre: ['-p'] },
  { id: 'kate', name: 'Kate', bins: ['kate'] },
  { id: 'gnome-text-editor', name: 'GNOME Text Editor', bins: ['gnome-text-editor'] },
  { id: 'gedit', name: 'gedit', bins: ['gedit'] },
  { id: 'mousepad', name: 'Mousepad', bins: ['mousepad'] },
  { id: 'xed', name: 'Xed', bins: ['xed'] }
];

function detectLinux({ env, fsx }) {
  const dirs = String(env.PATH || '').split(':').filter(Boolean);
  const list = [];
  for (const e of LINUX_BINS) {
    let exe = null;
    for (const b of e.bins) {
      exe = dirs.map(d => path.posix.join(d, b)).find(p => fsx.exists(p));
      if (exe) break;
    }
    if (exe) list.push({ id: e.id, family: e.id, name: e.name, exe, pre: e.pre || [], multi: true });
  }
  return list;
}

// fsx: { exists(p) → bool, readdir(p) → string[] (empty when missing) }.
function detectEditors({ platform, env = {}, fsx, vsInstances = [], notepadppDir = '' }) {
  if (platform === 'win32') return detectWindows({ env, fsx, vsInstances, notepadppDir });
  if (platform === 'darwin') return detectMac({ env, fsx });
  return detectLinux({ env, fsx });
}

// Highest-ranked family wins; within Visual Studio the list is already newest first.
function pickAuto(editors) {
  let best = null;
  for (const e of editors || []) {
    const rank = AUTO_RANK[e.family] || 0;
    if (rank && (!best || rank > (AUTO_RANK[best.family] || 0))) best = e;
  }
  return best;
}

function customEditor(exe) {
  const base = String(exe || '').split(/[\\/]/).pop() || 'Custom program';
  return { id: 'custom', family: 'custom', name: base.replace(/\.exe$/i, ''), exe, pre: [], multi: true };
}

// What a setting means right now. `fellBack` says a specific choice could not be honoured
// (uninstalled, custom path gone) and Automatic was used — the caller says so.
//   'auto' | 'system' | 'custom' | <detected id>
function resolveEditor(setting, customPath, editors, customExists) {
  const auto = () => {
    const e = pickAuto(editors);
    return e ? { kind: 'editor', editor: e } : { kind: 'system' };
  };
  const s = setting || 'auto';
  if (s === 'auto') return auto();
  if (s === 'system') return { kind: 'system' };
  if (s === 'custom') {
    if (customPath && customExists) return { kind: 'editor', editor: customEditor(customPath) };
    return Object.assign(auto(), { fellBack: true });
  }
  const e = (editors || []).find(x => x.id === s);
  return e ? { kind: 'editor', editor: e } : Object.assign(auto(), { fellBack: true });
}

// The processes to start: one for an editor that takes a list, one per file otherwise.
function launchPlan(editor, files) {
  const pre = editor.pre || [];
  if (editor.multi === false) return files.map(f => ({ exe: editor.exe, args: [...pre, f] }));
  return [{ exe: editor.exe, args: [...pre, ...files] }];
}

module.exports = { detectEditors, pickAuto, resolveEditor, launchPlan, customEditor, compareVersions, AUTO_RANK };
