// Self-update: what counts as newer, and which release asset is the installer for the
// version main declares.
const test = require('node:test');
const assert = require('node:assert');

const { compareVersions, pickReleaseAsset, findInstallerIn } = require('../src/main/lib/self-update');

test('compareVersions: numeric, not lexical', () => {
  assert.strictEqual(compareVersions('1.1.24', '1.1.9'), 1);
  assert.strictEqual(compareVersions('1.1.9', '1.1.24'), -1);
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
  assert.strictEqual(compareVersions('2.0.0-beta', '2.0.0'), 0);
});

const asset = (name) => ({ name, size: 10, browser_download_url: 'https://example.com/' + name });

test('pickReleaseAsset: matches the whole version, not a prefix of a later one', () => {
  const releases = [
    { tag_name: 'release_1.1.24', name: 'Git Good v1.1.24 x64', assets: [asset('GitGood.Setup.1.1.24.x64.zip')] },
    { tag_name: 'release_1.1.2', name: 'Git Good v1.1.2 x64', assets: [asset('GitGood.Setup.1.1.2.x64.zip')] }
  ];
  assert.strictEqual(pickReleaseAsset(releases, '1.1.2').tag, 'release_1.1.2');
  const r = pickReleaseAsset(releases, '1.1.24');
  assert.strictEqual(r.tag, 'release_1.1.24');
  assert.strictEqual(r.zipped, true);
});

test('pickReleaseAsset: prefers a bare installer, skips drafts, null when unreleased', () => {
  const releases = [
    { tag_name: 'release_1.2.0', draft: true, assets: [asset('GitGood Setup 1.2.0 x64.exe')] },
    { tag_name: 'release_1.1.30', assets: [asset('GitGood.Setup.1.1.30.x64.zip'), asset('GitGood Setup 1.1.30 x64.exe')] }
  ];
  assert.strictEqual(pickReleaseAsset(releases, '1.2.0'), null);
  const r = pickReleaseAsset(releases, '1.1.30');
  assert.strictEqual(r.zipped, false);
  assert.match(r.name, /\.exe$/);
});

test('findInstallerIn: the Setup exe, never the unpacked app', () => {
  assert.strictEqual(findInstallerIn([
    'x/GitGood Setup 1.1.24 x64/win-unpacked/GitGood.exe',
    'x/GitGood Setup 1.1.24 x64/GitGood Setup 1.1.24 x64.exe'
  ]), 'x/GitGood Setup 1.1.24 x64/GitGood Setup 1.1.24 x64.exe');
  assert.strictEqual(findInstallerIn(['x\\win-unpacked\\GitGood.exe']), null);
});
