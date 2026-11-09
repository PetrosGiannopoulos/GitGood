// GitGood's entry point (package.json "main"). It decides which main process to run:
//
//   bundled — src/main/main.js as installed. Always present, never modified.
//   source  — main.js from a copy of the `main` branch that Settings → About → "Update from
//             main" fetched into <userData>/app-source/ (see lib/source-boot.js).
//
// It only ever chooses source in an installed copy (or when GITGOOD_BOOTSTRAP is set, for
// testing from a clone); `npm start` from a checkout always runs the checkout.
//
// The rule this file lives by: nothing a fetched commit does may stop GitGood from
// starting. A source main.js that throws while loading is marked bad and the app
// relaunches on the bundled code; one that loads but never gets a window up is counted
// (MAX_BOOT_ATTEMPTS) and passed over the same way. This file is not updated by a source
// update — the shell's copy always runs — so keep it small and keep it boring.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const BUNDLED_MAIN = path.join(__dirname, 'main.js');

// The source tree has no node_modules (it is a git export). Bare requires from inside it
// that Node can't resolve fall back to the shell's own node_modules — which is why
// sourceCompatibility insists the dependencies are identical.
function shareBundledModules(sourceDir, bundledDir) {
  const norm = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  const prefix = norm(path.resolve(sourceDir) + path.sep);
  const bundledRequire = Module.createRequire(path.join(bundledDir, 'package.json'));
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    try {
      return orig.call(this, request, parent, isMain, options);
    } catch (e) {
      const bare = e && e.code === 'MODULE_NOT_FOUND' && !/^[./\\]/.test(request) && !path.isAbsolute(request);
      const fromSource = parent && parent.filename && norm(path.resolve(parent.filename)).startsWith(prefix);
      if (!bare || !fromSource) throw e;
      return bundledRequire.resolve(request);
    }
  };
}

function boot() {
  const shellVersion = app.getVersion();
  const enabled = app.isPackaged || !!process.env.GITGOOD_BOOTSTRAP;
  const info = { enabled, method: 'bundled', shellVersion, bundledDir: app.getAppPath(), root: null };
  global.__gitgoodBoot = info;
  if (!enabled) return null;

  let sb, root, state, plan;
  try {
    sb = require('./lib/source-boot');
    root = sb.sourceRoot(app.getPath('userData'));
    info.root = root;
    state = sb.readBootState(root);
    info.lastFailure = state.lastFailure;
    if (!state.current) return null;
    const shellPkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    const source = sb.inspectSource(root, state.current, shellPkg, process.versions.electron);
    plan = sb.chooseBoot({ state, shellVersion, source });
    if (plan.markBad) {
      state.bad = [...new Set([...state.bad, state.current.commit])];
      state.lastFailure = { commit: state.current.commit, at: new Date().toISOString(), error: 'Never finished starting.' };
      sb.writeBootState(root, state);
      info.lastFailure = state.lastFailure;
    }
    if (plan.note) info.note = plan.note;
    if (plan.use !== 'source') return null;

    const commit = state.current.commit;
    state.attempts[commit] = (state.attempts[commit] || 0) + 1;
    sb.writeBootState(root, state);
    Object.assign(info, { method: 'source', commit, version: source.pkg.version, dir: source.dir, sourceDir: state.current.dir });

    // Healthy = a window finished loading. Until then the attempt stays counted.
    app.on('web-contents-created', (_e, wc) => {
      wc.once('did-finish-load', () => {
        if (info.healthy) return;
        info.healthy = true;
        try {
          const s = sb.readBootState(root);
          s.attempts[commit] = 0;
          if (s.lastFailure && s.lastFailure.commit === commit) s.lastFailure = null;
          sb.writeBootState(root, s);
        } catch (e) { /* the counter just stays; worst case is a fallback later */ }
      });
    });

    shareBundledModules(source.dir, app.getAppPath());
    return path.join(source.dir, sb.SOURCE_MAIN);
  } catch (e) {
    console.error('[bootstrap] falling back to the installed code:', e);
    info.method = 'bundled';
    return null;
  }
}

const sourceMain = boot();
if (sourceMain) {
  try {
    require(sourceMain);
  } catch (e) {
    // Part of it may already have run (handlers registered, app events hooked), so it
    // cannot be followed by the bundled main.js in this process. Mark it and start over.
    console.error('[bootstrap] source main.js failed to load:', e);
    try {
      const sb = require('./lib/source-boot');
      const info = global.__gitgoodBoot;
      const s = sb.readBootState(info.root);
      s.bad = [...new Set([...s.bad, info.commit])];
      s.lastFailure = { commit: info.commit, at: new Date().toISOString(), error: String((e && e.stack) || e).slice(0, 2000) };
      sb.writeBootState(info.root, s);
    } catch (_) { /* relaunching is still right; the attempt counter catches it next time */ }
    app.relaunch();
    app.exit(1);
  }
} else {
  require(BUNDLED_MAIN);
}
