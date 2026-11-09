// Bootstrap updates: an installed GitGood running the source of `main` instead of the
// code it was installed with. The pure half — `src/main/bootstrap.js` (the app's entry
// point) decides which code to load, `main.js` fetches new source; both read this.
//
// Layout under <userData>/app-source/:
//   repo.git/              bare repository, shallow-fetched from main (refs/gitgood/main)
//   versions/<sha12>/      one exported tree per fetched commit (git archive + tar)
//   state.json             { current: { commit, version, dir }, attempts, bad, lastFailure }
//
// The installed (bundled) code is never modified, so it is always there to fall back to.

const fs = require('fs');
const path = require('path');
const { compareVersions } = require('./self-update');

// A source version that has not finished loading a window this many times in a row is
// treated as broken, and the bundled code runs instead.
const MAX_BOOT_ATTEMPTS = 2;
const SOURCE_MAIN = path.join('src', 'main', 'main.js');
const SOURCE_MARKER = '.gitgood-source.json';

function sourceRoot(userData) { return path.join(userData, 'app-source'); }

function majorOf(spec) {
  const m = String(spec || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Whether `sourcePkg` (main's package.json) can run inside this installed shell. Two
// things cannot be updated from source: the Electron runtime (it is the .exe) and the
// node_modules the shell was packaged with (a user machine has no npm). So the source must
// want the same Electron major, and exactly the same dependencies — any change there needs
// the installer. devDependencies other than electron are build tools and don't matter.
function sourceCompatibility(shellPkg, sourcePkg, electronVersion) {
  if (!sourcePkg || typeof sourcePkg !== 'object') return { ok: false, reason: 'main has no readable package.json' };
  const want = majorOf((sourcePkg.devDependencies || {}).electron || (sourcePkg.dependencies || {}).electron);
  const have = majorOf(electronVersion);
  if (want !== null && have !== null && want !== have) {
    return { ok: false, reason: `main needs Electron ${want}, and this installed app runs Electron ${have}` };
  }
  const a = (shellPkg && shellPkg.dependencies) || {};
  const b = sourcePkg.dependencies || {};
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();
  if (changed.length) {
    return { ok: false, reason: `main changed its dependencies (${changed.join(', ')}), which only the installer can bring` };
  }
  return { ok: true };
}

// Which code to run at startup. `source` describes state.current's folder as found on
// disk: { exists, pkg, compat }. Returns { use: 'source'|'bundled', note?, markBad? };
// a note is said to the user (Settings → About) when a configured source was passed over.
function chooseBoot({ state, shellVersion, source }) {
  const cur = state && state.current;
  if (!cur || !cur.commit) return { use: 'bundled' };
  const short = cur.commit.slice(0, 7);
  if (!source || !source.exists) return { use: 'bundled', note: `The source of main @${short} is missing from disk, so the installed version is running.` };
  if ((state.bad || []).includes(cur.commit)) {
    return { use: 'bundled', note: `main @${short} failed to start on this machine, so the installed version is running.` };
  }
  if (((state.attempts || {})[cur.commit] || 0) >= MAX_BOOT_ATTEMPTS) {
    return { use: 'bundled', markBad: true, note: `main @${short} did not finish starting ${MAX_BOOT_ATTEMPTS} times in a row, so the installed version is running.` };
  }
  if (!source.compat || !source.compat.ok) {
    return { use: 'bundled', note: `main @${short} can't run in this installed app (${(source.compat && source.compat.reason) || 'unknown reason'}).` };
  }
  // An installer run since the source was fetched: the newer installed code wins. That is
  // routine, not a failure, so it says nothing.
  const sv = (source.pkg && source.pkg.version) || '';
  if (compareVersions(sv, shellVersion) < 0) return { use: 'bundled' };
  return { use: 'source' };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function readBootState(root) {
  const s = readJson(path.join(root, 'state.json')) || {};
  return {
    current: s.current && s.current.commit ? s.current : null,
    attempts: s.attempts && typeof s.attempts === 'object' ? s.attempts : {},
    bad: Array.isArray(s.bad) ? s.bad : [],
    lastFailure: s.lastFailure || null
  };
}

// Write-then-rename, so a crash mid-write never leaves a half file that reads as "no state".
function writeBootState(root, state) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'state.json');
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// The exported tree for state.current, read from disk: is it complete, what does it want.
function inspectSource(root, current, shellPkg, electronVersion) {
  if (!current || !current.dir) return { exists: false };
  const dir = path.join(root, current.dir);
  const pkg = readJson(path.join(dir, 'package.json'));
  const exists = !!pkg && fs.existsSync(path.join(dir, SOURCE_MAIN)) && fs.existsSync(path.join(dir, SOURCE_MARKER));
  return { exists, dir, pkg, compat: exists ? sourceCompatibility(shellPkg, pkg, electronVersion) : null };
}

// Which version folders to delete after an update: everything except the one just
// fetched and the one this process is running from (still loaded; deleting it under a
// running app is asking for trouble). Leftover temp folders from a failed export go too.
function versionDirsToPrune(names, keep) {
  const k = new Set((keep || []).filter(Boolean).map(n => path.basename(n)));
  return (names || []).filter(n => !k.has(n));
}

function versionDirName(commit) { return String(commit).slice(0, 12); }

module.exports = {
  MAX_BOOT_ATTEMPTS, SOURCE_MAIN, SOURCE_MARKER,
  sourceRoot, majorOf, sourceCompatibility, chooseBoot,
  readBootState, writeBootState, inspectSource, versionDirsToPrune, versionDirName
};
