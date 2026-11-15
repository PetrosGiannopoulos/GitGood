'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildGitignore, findUnityProjects, anchorFor, templateList } = require('../src/main/lib/gitignore-templates');

const patterns = text => text.split('\n').filter(l => l.trim() && !l.startsWith('#'));

test('Unity paths are anchored to the project folder, not the repo root', () => {
  const root = buildGitignore({ base: 'unity' }).text;
  assert.ok(patterns(root).includes('/[Ll]ibrary/'));
  const sub = buildGitignore({ base: 'unity', unityRoots: ['Game'] }).text;
  assert.ok(patterns(sub).includes('/Game/[Ll]ibrary/'));
  assert.ok(!patterns(sub).includes('/[Ll]ibrary/'));
});

test('two Unity projects get one anchored block each and one shared block', () => {
  const { text } = buildGitignore({ base: 'unity', unityRoots: ['Client', 'Tools/Editor'] });
  const p = patterns(text);
  assert.ok(p.includes('/Client/[Ll]ibrary/'));
  assert.ok(p.includes('/Tools/Editor/[Ll]ibrary/'));
  assert.strictEqual(p.filter(l => l === '*.csproj').length, 1);
});

test('glob characters and edge spaces in a folder name are escaped', () => {
  assert.strictEqual(anchorFor(''), '');
  assert.strictEqual(anchorFor('My Game'), '/My Game');
  assert.strictEqual(anchorFor('Game[2]'), '/Game\\[2\\]');
  assert.strictEqual(anchorFor('a\\b'), '/a/b');      // Windows separators
  assert.strictEqual(anchorFor(' x '), '/\\ x\\ ');
});

test('a pattern shared by base and add-on is written once', () => {
  const { text } = buildGitignore({ base: 'unity', addons: ['visualstudio', 'macos'] });
  const p = patterns(text);
  assert.strictEqual(p.filter(l => l === '.vs/').length, 1);
  assert.strictEqual(p.filter(l => l === '*.suo').length, 1);
  assert.ok(p.includes('.DS_Store'));
  // Visual Studio still contributes what Unity did not have.
  assert.ok(p.includes('*.rsuser'));
});

test('an add-on whose patterns are all duplicates adds no empty section', () => {
  const { text } = buildGitignore({ base: 'dotnet', addons: ['visualstudio'] });
  // Only .VC.db/.VC.opendb are new from Visual Studio, so its section exists but is short.
  assert.ok(/===== Visual Studio =====\n\*\.VC\.db\n\*\.VC\.opendb/.test(text));
  const none = buildGitignore({ existing: 'node_modules/\n', base: 'node', addons: [] });
  assert.ok(!none.text.includes('===== Node =====\n\n'));
});

test('an existing .gitignore is kept and only missing patterns are appended', () => {
  const existing = '# mine\n.DS_Store\nsecret.txt';
  const { text, added } = buildGitignore({ addons: ['macos'], existing });
  assert.ok(text.startsWith(existing + '\n\n# ----- Added by GitGood -----'));
  assert.strictEqual(patterns(text).filter(l => l === '.DS_Store').length, 1);
  assert.ok(added > 0);
});

test('nothing new to add returns the existing text and added 0', () => {
  const { text, added } = buildGitignore({ addons: ['rider'], existing: '.idea/\n*.sln.iml\n' });
  assert.strictEqual(added, 0);
  assert.strictEqual(text, '.idea/\n*.sln.iml\n');
  assert.deepStrictEqual(buildGitignore({ base: 'none' }), { text: '', added: 0 });
});

test('unknown ids are ignored, and the picker list carries no template text', () => {
  assert.strictEqual(buildGitignore({ base: 'cobol', addons: ['nope'] }).added, 0);
  const list = templateList();
  assert.ok(list.some(t => t.id === 'unity' && t.kind === 'base'));
  assert.ok(list.every(t => !('text' in t)));
});

test('findUnityProjects finds projects in subfolders and skips Library/node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-unity-'));
  try {
    const mk = (rel) => {
      fs.mkdirSync(path.join(dir, rel, 'ProjectSettings'), { recursive: true });
      fs.mkdirSync(path.join(dir, rel, 'Assets'), { recursive: true });
      fs.writeFileSync(path.join(dir, rel, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
    };
    mk('Game');
    mk('Tools/Baker');
    mk('node_modules/pkg');                       // never searched
    fs.mkdirSync(path.join(dir, 'Docs', 'ProjectSettings'), { recursive: true }); // no Assets, not a project
    fs.writeFileSync(path.join(dir, 'Docs', 'ProjectSettings', 'ProjectVersion.txt'), '');
    assert.deepStrictEqual(findUnityProjects(dir), ['Game', 'Tools/Baker']);
    mk('');
    assert.deepStrictEqual(findUnityProjects(dir), ['']);   // the root itself; nothing nests
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
