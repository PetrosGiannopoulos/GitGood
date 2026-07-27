const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const simpleGit = require('simple-git');

// Disable hardware acceleration issues on some systems
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

let mainWindow;
let currentRepoPath = null;
let git = null;

// Persist last opened repo
const settingsPath = path.join(app.getPath('userData'), 'gitgood-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  return { recentRepos: [] };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function addRecentRepo(repoPath) {
  const settings = loadSettings();
  settings.recentRepos = settings.recentRepos || [];
  settings.recentRepos = settings.recentRepos.filter(p => p !== repoPath);
  settings.recentRepos.unshift(repoPath);
  settings.recentRepos = settings.recentRepos.slice(0, 10);
  saveSettings(settings);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0a0606',
    title: 'GitGood',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Allow the Local Font Access API (used to list installed fonts for the font picker);
  // deny everything else by default. The renderer falls back to canvas detection if
  // this is unavailable, so denial is harmless.
  try {
    const ses = mainWindow.webContents.session;
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'local-fonts');
    });
    if (ses.setPermissionCheckHandler) {
      ses.setPermissionCheckHandler((wc, permission) => permission === 'local-fonts');
    }
  } catch (e) { /* non-fatal */ }

  // Open DevTools when launched with --dev flag, or if env var is set
  if (process.argv.includes('--dev') || process.env.GITGOOD_DEBUG) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Also log preload errors so we can see them in the terminal
  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error('[PRELOAD ERROR]', preloadPath, error);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[RENDERER CRASHED]', details);
    // If the renderer was killed (usually OOM from a huge diff), try to recover
    // by reloading. The user loses unsaved input but at least gets a working window
    // back instead of a black screen.
    if (details && (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.reload(); } catch (e) { /* nothing else to do */ }
      }
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[RENDERER UNRESPONSIVE] — will recover when idle');
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Notify renderer when the app regains focus so it can auto-refresh
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-focused');
    }
  });

  // Remove the default menu but keep a minimal one
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Repository',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu-open-repo')
        },
        {
          label: 'Clone Repository',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => mainWindow.webContents.send('menu-clone-repo')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About GitGood',
          click: () => mainWindow.webContents.send('menu-about')
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ============================================
// IPC HANDLERS — Git operations
// ============================================

// simple-git blocks GIT_SSH_COMMAND by default for safety. Since our SSH key path comes
// from the user's own file picker (not an untrusted source), we opt-in to allow it.
const SG_OPTS = { unsafe: { allowUnsafeSshCommand: true } };

function makeGit(dir) {
  return simpleGit({ baseDir: dir, ...SG_OPTS });
}

// Emit a git operation progress event to the renderer. simple-git's progress
// callback fires with { method, stage, progress, processed, total } where progress
// is 0-100. We forward a normalized payload the renderer can render as a bar.
function emitOpProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('op:progress', payload); } catch (e) {}
  }
}

// Build a git instance that reports transfer progress for the current repo.
// Used for clone/pull/push/fetch where git emits "Receiving objects: NN%" etc.
function makeProgressGit(dir) {
  return simpleGit({
    baseDir: dir,
    ...SG_OPTS,
    progress({ method, stage, progress, processed, total }) {
      emitOpProgress({ method, stage, progress, processed, total, active: true });
    }
  });
}

function ensureGit() {
  if (!git || !currentRepoPath) {
    throw new Error('No repository opened. Open or clone a repository first.');
  }
  return git;
}

// simple-git returns rich class instances (StatusSummary, BranchSummaryResult, etc.)
// that have methods on their prototype. Electron's IPC structured clone cannot
// serialize methods, so we round-trip through JSON to get a plain serializable object.
function serialize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return String(value);
  }
}

function wrap(fn) {
  return async (...args) => {
    try {
      const result = await fn(...args);
      return { ok: true, data: serialize(result) };
    } catch (err) {
      // Provide friendlier error messages for common SSH/auth issues
      let msg = err.message || String(err);
      if (/Host key verification failed/i.test(msg)) {
        msg = 'SSH host key verification failed. Run `ssh -T git@<host>` once in a terminal to accept the host key, then try again.\n\nOriginal error: ' + msg;
      } else if (/Permission denied \(publickey\)/i.test(msg)) {
        msg = 'SSH authentication failed (publickey).\n• Ensure your SSH key is added to your ssh-agent (`ssh-add ~/.ssh/id_rsa`) or registered with your git host.\n• On Windows, make sure the OpenSSH Agent service is running.\n\nOriginal error: ' + msg;
      } else if (/could not read Username|Authentication failed/i.test(msg)) {
        msg = 'HTTPS authentication failed.\n• Use a Personal Access Token as the password (not your account password).\n• Or set up a git credential helper.\n\nOriginal error: ' + msg;
      } else if (/Could not resolve host|unable to access/i.test(msg)) {
        msg = 'Network error: could not reach the remote host. Check your internet connection and the URL.\n\nOriginal error: ' + msg;
      }
      return { ok: false, error: msg };
    }
  };
}

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose a repository folder'
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, data: result.filePaths[0] };
});

ipcMain.handle('dialog:selectFolder', async (_, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: title || 'Select folder'
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, data: result.filePaths[0] };
});

ipcMain.handle('dialog:selectFile', async (_, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'showHiddenFiles'],
    title: title || 'Select file'
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, data: result.filePaths[0] };
});

ipcMain.handle('app:getRecentRepos', () => {
  const settings = loadSettings();
  return { ok: true, data: (settings.recentRepos || []).filter(p => fs.existsSync(p)) };
});

ipcMain.handle('app:removeRecentRepo', (_, repoPath) => {
  const settings = loadSettings();
  settings.recentRepos = (settings.recentRepos || []).filter(p => p !== repoPath);
  saveSettings(settings);
  return { ok: true, data: settings.recentRepos };
});

ipcMain.handle('app:clearRecentRepos', () => {
  const settings = loadSettings();
  settings.recentRepos = [];
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('app:getHome', () => {
  return { ok: true, data: os.homedir() };
});

// Copy text via the native clipboard. The renderer's navigator.clipboard is denied
// when called from a context-menu handler (document not focused), so we route through
// the main process where Electron's clipboard module always works.
ipcMain.handle('app:copyText', (_, text) => {
  clipboard.writeText(text == null ? '' : String(text));
  return { ok: true };
});

ipcMain.handle('repo:open', wrap(async (_, repoPath) => {
  if (!fs.existsSync(repoPath)) throw new Error('Path does not exist: ' + repoPath);
  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) throw new Error('Not a git repository: ' + repoPath);
  git = makeGit(repoPath);
  currentRepoPath = repoPath;
  addRecentRepo(repoPath);
  return { path: repoPath, name: path.basename(repoPath) };
}));

ipcMain.handle('repo:init', wrap(async (_, folderPath) => {
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
  const g = makeGit(folderPath);
  await g.init();
  git = g;
  currentRepoPath = folderPath;
  addRecentRepo(folderPath);
  return { path: folderPath, name: path.basename(folderPath) };
}));

ipcMain.handle('repo:clone', wrap(async (_, { url, destination, sshKeyPath }) => {
  if (!url) throw new Error('Repository URL required');
  if (!destination) throw new Error('Destination folder required');
  if (!fs.existsSync(destination)) fs.mkdirSync(destination, { recursive: true });

  // Derive a sensible repo folder name from the URL
  // Supports: https://host/user/repo.git, git@host:user/repo.git, ssh://git@host/user/repo.git
  let repoName = url
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .split(/[\/:]/)
    .pop() || 'repo';
  const targetPath = path.join(destination, repoName);

  if (fs.existsSync(targetPath)) {
    throw new Error(`A folder named "${repoName}" already exists in the destination.`);
  }

  // Build environment for the git child process.
  // For SSH URLs we want to make sure git can find the user's SSH key.
  const cloneEnv = { ...process.env };

  if (sshKeyPath && fs.existsSync(sshKeyPath)) {
    // Use a specific SSH key for this clone. -o IdentitiesOnly=yes forces ssh
    // to use only this key. StrictHostKeyChecking=accept-new auto-trusts new hosts
    // (much friendlier than asking the user to ssh into the host first).
    const keyArg = sshKeyPath.replace(/\\/g, '/');
    cloneEnv.GIT_SSH_COMMAND = `ssh -i "${keyArg}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  } else if (/^(git@|ssh:\/\/)/i.test(url)) {
    // SSH URL without an explicit key — still set accept-new to avoid the
    // interactive "are you sure you want to add this host" prompt that hangs forever.
    cloneEnv.GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=accept-new';
  }

  // For non-interactive operation (no password prompts hanging the UI)
  if (!cloneEnv.GIT_TERMINAL_PROMPT) cloneEnv.GIT_TERMINAL_PROMPT = '0';

  // Create a progress-aware simple-git instance bound to the destination, with our env
  const g = simpleGit({
    baseDir: destination,
    ...SG_OPTS,
    progress({ method, stage, progress, processed, total }) {
      emitOpProgress({ method, stage, progress, processed, total, active: true });
    }
  }).env(cloneEnv);
  try {
    await g.clone(url, targetPath, ['--progress']);
  } finally {
    emitOpProgress({ active: false, done: true });
  }

  // Now open the cloned repo with default env
  git = makeGit(targetPath);
  currentRepoPath = targetPath;
  addRecentRepo(targetPath);
  return { path: targetPath, name: repoName };
}));

ipcMain.handle('repo:current', () => {
  if (!currentRepoPath) return { ok: true, data: null };
  return { ok: true, data: { path: currentRepoPath, name: path.basename(currentRepoPath) } };
});

ipcMain.handle('repo:close', () => {
  // Tear the watcher and the background fetch down with the repo, or they keep firing
  // against a path the app is no longer showing.
  try { stopRepoWatcher(); } catch (e) { /* defined later in this file; safe if absent */ }
  try { stopAutoFetch(); } catch (e) { /* ditto */ }
  git = null;
  currentRepoPath = null;
  return { ok: true };
});

ipcMain.handle('repo:status', wrap(async () => {
  const g = ensureGit();
  const status = await g.status();
  // Detect detached HEAD. simple-git's status.detached is reliable; we also treat a
  // current ref of "HEAD" as detached. As a final cross-check, symbolic-ref prints the
  // branch ref when attached and nothing when detached.
  let detached = !!status.detached || status.current === 'HEAD' || !status.current;
  try {
    const symRef = (await g.raw(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    if (symRef) detached = false;   // we ARE on a branch
    else detached = true;            // empty output => detached
  } catch (e) {
    detached = true;                 // non-zero exit => detached
  }
  let headHash = null;
  try {
    headHash = (await g.revparse(['--short', 'HEAD'])).trim();
  } catch (e) { /* empty repo */ }

  // When the current branch has NO upstream tracking ref yet (e.g. you committed but
  // never ran `push -u` to set one), simple-git reports ahead=0/behind=0 — git has
  // nothing to compare against. That's misleading: every commit on this branch is "to
  // push" the next time you push. Fall back to counting commits reachable from HEAD,
  // but only when a remote actually exists (otherwise there's nowhere to push).
  let ahead = status.ahead || 0;
  let behind = status.behind || 0;
  let upstreamMissing = false;
  if (!detached && !status.tracking) {
    try {
      const remotes = await g.getRemotes(true);
      if (remotes && remotes.length) {
        // Try to find a remote-tracking branch with the same short name on any remote
        // (e.g. you fetched origin and origin/<branch> exists, but tracking isn't set).
        // If we find one, compare against it directly. Otherwise fall back to total
        // commits — every commit on this branch is unpushed.
        let comparedToRef = null;
        for (const r of remotes) {
          const candidate = `${r.name}/${status.current}`;
          try {
            // rev-parse --verify --quiet returns the SHA on success, or exits 1 with
            // empty output on failure. simple-git treats exit-1 as throw only when
            // --quiet isn't set; with --quiet we may get a successful Promise resolve
            // with an empty string. So treat empty output as "not present" too.
            const ref = (await g.raw(['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`])).trim();
            if (ref) { comparedToRef = candidate; break; }
          } catch (e) { /* not present on this remote */ }
        }
        if (comparedToRef) {
          // git rev-list LEFT...RIGHT --left-right --count prints "<ahead>\t<behind>"
          const out = (await g.raw(['rev-list', '--left-right', '--count', `HEAD...${comparedToRef}`])).trim();
          const [a, b] = out.split(/\s+/).map(n => parseInt(n, 10) || 0);
          ahead = a; behind = b;
        } else {
          // No corresponding remote ref — every local commit will be pushed.
          try {
            const c = (await g.raw(['rev-list', '--count', 'HEAD'])).trim();
            ahead = parseInt(c, 10) || 0;
          } catch (e) { /* empty branch */ }
          upstreamMissing = true;
        }
      }
    } catch (e) { /* leave ahead/behind as the original 0/0 */ }
  }

  // Which of these paths are submodules. The renderer needs it on every status refresh to
  // tell a gitlink row from an ordinary modified file, and it costs one stat() in the
  // (overwhelmingly common) case of a repo with no submodules at all.
  let submodulePaths = [];
  try {
    submodulePaths = (await submodulePathList()).map(s => s.path);
  } catch (e) { /* never let this break a status refresh */ }

  return { ...status, detached, headHash, ahead, behind, upstreamMissing, submodulePaths };
}));

ipcMain.handle('repo:branches', wrap(async () => {
  const g = ensureGit();
  const local = await g.branchLocal();
  let remotes = { all: [], branches: {} };
  try {
    remotes = await g.branch(['-r']);
  } catch (e) { /* no remotes */ }
  return { local, remotes };
}));

ipcMain.handle('repo:log', wrap(async (_, opts) => {
  const g = ensureGit();
  const options = { maxCount: (opts && opts.limit) || 100, '--all': null };
  const log = await g.log(options);
  return log;
}));

// Returns a map of { commitHash: [changed file paths] } for the most recent commits,
// in a single `git log --name-only` pass. Used for "filter by file inside commit".
ipcMain.handle('repo:commitFiles', wrap(async (_, opts) => {
  const g = ensureGit();
  const limit = (opts && opts.limit) || 1000;
  // Custom format: a sentinel line with the full hash, then the name-only file list.
  const raw = await g.raw([
    'log', '--all', `--max-count=${limit}`,
    '--name-only', '--no-renames', '--pretty=format:\x01%H'
  ]);
  const map = {};
  let current = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) {
      current = line.slice(1).trim();
      map[current] = [];
    } else if (current && line.trim()) {
      map[current].push(line.trim());
    }
  }
  return map;
}));

// Pickaxe search: returns the hashes of commits whose diff CONTENT changed the occurrences
// of the given text — i.e. `git log -S<string>`. Powers the "Diff content" filter mode,
// answering "which commits added or removed this function/text?". We use -S (not -G)
// because -S is a LITERAL string match by default: it never treats the query as a regex,
// so identifiers with punctuation like "myFunc(" match as-is. (-G always parses its
// argument as a regex, and this platform's engine rejects a lone "(" even when escaped.)
// Scoped to --all to match the graph; the caller intersects the result with its loaded
// commits, so extra hashes are harmless.
// Diff-content ("pickaxe", git log -S) search. This is inherently expensive: git has to
// diff every commit it walks, so on big repos it can take many seconds — and `--max-count`
// bounds only *matching* commits, not commits *traversed*, so a rare/absent query still
// diffs the whole history. To keep the UI responsive we run git as a killable child process
// instead of simple-git's blocking .raw(), so we can: (a) cancel an in-flight search when the
// query changes, (b) enforce a hard timeout, and (c) stream matches to the renderer as they
// arrive (via the `search:progress` channel) so the graph lights up progressively.
//
// This handler is intentionally NOT wrapped by wrap(): it hand-rolls the { ok, data } shape so
// it can resolve on the child's `close` event with partial/timeout/cancel flags.
let _diffSearch = null; // { proc, cancelled, hashes }

ipcMain.handle('repo:searchDiffContent', (_e, opts) => {
  const query = ((opts && opts.query) || '').trim();
  if (!query) return { ok: true, data: { hashes: [], timedOut: false, cancelled: false } };
  if (!currentRepoPath) return { ok: false, error: 'No repository opened.' };

  // Cancel any search still running for a previous query so processes don't pile up.
  if (_diffSearch && _diffSearch.proc) {
    _diffSearch.cancelled = true;
    try { _diffSearch.proc.kill(); } catch (e) {}
  }

  const limit = (opts && opts.limit) || 2000;
  const timeoutMs = (opts && opts.timeoutMs) || 15000;
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const record = { proc: null, cancelled: false, hashes: [] };
    _diffSearch = record;

    let proc;
    try {
      // `-S<string>` is glued into one argv element so no shell parses it and a leading '-'
      // in the query can't be mistaken for a flag. windowsHide avoids a console flash.
      proc = spawn('git', [
        'log', '--all', `--max-count=${limit}`, '--format=%H', '-S' + query
      ], {
        cwd: currentRepoPath,
        windowsHide: true,
        env: Object.assign({}, process.env, { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' })
      });
    } catch (err) {
      if (_diffSearch === record) _diffSearch = null;
      resolve({ ok: false, error: err.message });
      return;
    }
    record.proc = proc;

    // Buffer stdout by line; flush new hashes to the renderer in throttled batches.
    let buf = '';
    let pending = [];
    let flushTimer = null;
    const sendProgress = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('search:progress', payload); } catch (e) {}
      }
    };
    const flush = () => {
      flushTimer = null;
      if (!pending.length) return;
      const delta = pending; pending = [];
      sendProgress({ query, hashesDelta: delta, done: false });
    };
    const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, 120); };

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) { record.hashes.push(line); pending.push(line); }
      }
      scheduleFlush();
    });
    proc.stderr.on('data', () => { /* ignore — an invalid pattern just yields no matches */ });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch (e) {}
    }, timeoutMs);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (flushTimer) { clearTimeout(flushTimer); }
      // Emit anything still buffered (last line may lack a trailing newline).
      const tail = buf.trim();
      if (tail) { record.hashes.push(tail); pending.push(tail); }
      if (pending.length) sendProgress({ query, hashesDelta: pending, done: false });
      pending = [];
      if (_diffSearch === record) _diffSearch = null;
      sendProgress({ query, hashesDelta: [], done: true, timedOut, cancelled: record.cancelled });
      resolve({ ok: true, data: { hashes: record.hashes, timedOut, cancelled: record.cancelled } });
    };

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (_diffSearch === record) _diffSearch = null;
      resolve({ ok: false, error: err.message });
    });
    proc.on('close', finish);
  });
});

// Cancel any in-flight diff-content search (e.g. the user cleared the filter box). The killed
// process resolves its pending invoke with cancelled:true, so the renderer won't cache it.
ipcMain.handle('repo:cancelDiffSearch', () => {
  if (_diffSearch && _diffSearch.proc) {
    _diffSearch.cancelled = true;
    try { _diffSearch.proc.kill(); } catch (e) {}
  }
  return { ok: true };
});

// Hashes of commits reachable from some ref but NOT from any remote-tracking ref — i.e. the
// local-only (unpushed) commits. The graph uses this to optionally hide them. On a repo with no
// remote-tracking refs, `--not --remotes` is a no-op that would return the ENTIRE history, so we
// guard that case and return [] (nothing to hide) rather than letting the option blank the graph.
ipcMain.handle('repo:localOnlyCommits', wrap(async () => {
  const g = ensureGit();
  let hasRemoteRefs = false;
  try {
    const rr = await g.raw(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/']);
    hasRemoteRefs = !!rr.trim();
  } catch (e) { /* treat as no remotes */ }
  if (!hasRemoteRefs) return [];
  const raw = await g.raw(['rev-list', '--all', '--not', '--remotes']);
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}));

// Returns commits with parents and ref decorations — the data the visual graph needs
ipcMain.handle('repo:graphLog', wrap(async (_, opts) => {
  const g = ensureGit();
  const limit = (opts && opts.limit) || 500;

  // Use a unique field separator that's unlikely to appear in commit metadata.
  // Format fields: hash | parents | refs | author name | author email | iso date | subject
  const SEP = '\x1f';       // Unit separator
  // --topo-order ensures parents always come AFTER children — required for our layout algorithm.
  // --date-order keeps chronological-ish ordering within the topo constraint.
  const raw = await g.raw([
    'log',
    '--all',
    '--topo-order',
    '--decorate=full',
    `--pretty=format:%H${SEP}%P${SEP}%D${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s%x1e`,
    `-n`, String(limit)
  ]);

  // Get current HEAD so we can mark it
  let head = '';
  try { head = (await g.revparse(['HEAD'])).trim(); } catch (e) {}

  const lines = raw.split(/\x1e\r?\n?/).map(s => s.trim()).filter(Boolean);
  const commits = lines.map(line => {
    const [hash, parents, refs, an, ae, date, subject] = line.split(SEP);
    return {
      hash,
      parents: (parents || '').split(' ').filter(Boolean),
      refs: parseRefs(refs || ''),
      author_name: an || '',
      author_email: ae || '',
      date: date || '',
      message: subject || ''
    };
  });

  return { commits, head };
}));

function parseRefs(refStr) {
  // %D output examples:
  //   HEAD -> refs/heads/main, tag: v1.0, refs/remotes/origin/main
  // We split on ", " and classify each part.
  if (!refStr) return [];
  const parts = refStr.split(', ').map(s => s.trim()).filter(Boolean);
  const result = [];
  for (const p of parts) {
    let s = p;
    let isHead = false;
    if (s.startsWith('HEAD -> ')) {
      isHead = true;
      s = s.slice('HEAD -> '.length);
    } else if (s === 'HEAD') {
      result.push({ type: 'head', name: 'HEAD', isHead: true });
      continue;
    }
    if (s.startsWith('tag: ')) {
      result.push({ type: 'tag', name: s.slice('tag: '.length).replace(/^refs\/tags\//, '') });
    } else if (s.startsWith('refs/heads/')) {
      result.push({ type: 'local', name: s.slice('refs/heads/'.length), isHead });
    } else if (s.startsWith('refs/remotes/')) {
      result.push({ type: 'remote', name: s.slice('refs/remotes/'.length) });
    } else {
      result.push({ type: 'other', name: s });
    }
  }
  return result;
}

// `-w` (--ignore-all-space) hides pure-whitespace edits. NOTE: a diff produced with it is
// NOT applicable — its hunks no longer describe the real byte changes — so the renderer
// disables partial staging whenever it is on.
function wsArgs(opts) {
  return (opts && opts.ignoreWhitespace) ? ['-w'] : [];
}

ipcMain.handle('repo:diff', wrap(async (_, filePath, opts) => {
  const g = ensureGit();
  const ws = wsArgs(opts);
  if (!filePath) return await g.diff(ws);
  // Try staged first; if empty, get unstaged
  const staged = await g.diff([...ws, '--cached', '--', filePath]);
  if (staged && staged.trim()) return staged;
  return await g.diff([...ws, '--', filePath]);
}));

ipcMain.handle('repo:diffUnstaged', wrap(async (_, filePath, opts) => {
  const g = ensureGit();
  return await g.diff([...wsArgs(opts), '--', filePath]);
}));

ipcMain.handle('repo:diffStaged', wrap(async (_, filePath, opts) => {
  const g = ensureGit();
  return await g.diff([...wsArgs(opts), '--cached', '--', filePath]);
}));

ipcMain.handle('repo:stage', wrap(async (_, files) => {
  const g = ensureGit();
  const fileList = Array.isArray(files) ? files : [files];
  await g.add(fileList);
  return true;
}));

ipcMain.handle('repo:stageAll', wrap(async () => {
  const g = ensureGit();
  await g.add('.');
  return true;
}));

ipcMain.handle('repo:unstage', wrap(async (_, files) => {
  const g = ensureGit();
  const fileList = Array.isArray(files) ? files : [files];
  await g.reset(['HEAD', '--', ...fileList]);
  return true;
}));

ipcMain.handle('repo:unstageAll', wrap(async () => {
  const g = ensureGit();
  await g.reset(['HEAD']);
  return true;
}));

// After discarding untracked files, remove any parent directories they leave empty.
// Git doesn't track directories, so deleting the last file in a freshly-added folder
// would otherwise strand the now-empty folder (and its empty ancestors). Walk upward
// from each starting directory toward — but never including or past — the repo root,
// stopping a branch at the first directory that still holds entries. This mirrors the
// cleanup other Git clients get from `git clean -fd`.
function pruneEmptyDirs(startDirs) {
  const root = path.resolve(currentRepoPath);
  for (const start of startDirs) {
    let dir = path.resolve(start);
    while (dir !== root && dir.startsWith(root + path.sep)) {
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch (e) {
        break; // already removed or inaccessible — stop climbing this branch
      }
      if (entries.length > 0) break; // still holds files/other dirs — leave it in place
      try {
        fs.rmdirSync(dir);
      } catch (e) {
        break; // couldn't remove (race, permissions) — stop climbing this branch
      }
      dir = path.dirname(dir);
    }
  }
}

ipcMain.handle('repo:discard', wrap(async (_, files) => {
  const g = ensureGit();
  const fileList = Array.isArray(files) ? files : [files];

  // Get current status to split tracked from untracked files
  const status = await g.status();
  const untrackedSet = new Set(status.not_added || []);
  const tracked = fileList.filter(f => !untrackedSet.has(f));
  const untracked = fileList.filter(f => untrackedSet.has(f));

  // For tracked files: restore from HEAD (or use checkout for older git). Submodules need
  // a second step — `git checkout -- <submodule>` rewrites the outer index entry but leaves
  // the submodule checked out wherever it was, so the change silently survives a "discard".
  // Checking it out from inside is what actually restores the recorded commit.
  const subSet = new Set((await submodulePathList()).map(s => s.path));
  const trackedSubs = tracked.filter(f => subSet.has(f));
  const trackedPlain = tracked.filter(f => !subSet.has(f));
  if (trackedPlain.length) {
    await g.checkout(['--', ...trackedPlain]);
  }
  for (const sp of trackedSubs) {
    await g.checkout(['--', sp]);
    await g.raw(['submodule', 'update', '--init', '--', sp]);
  }
  // For untracked files: physically delete them from disk, then prune any parent
  // directories they leave empty (see pruneEmptyDirs). We collect the parents first and
  // prune only after every file is gone, so a folder holding several discarded files is
  // correctly removed once its last child is deleted, regardless of iteration order.
  if (untracked.length) {
    const parentDirs = [];
    for (const f of untracked) {
      const fullPath = path.join(currentRepoPath, f);
      try {
        const st = fs.statSync(fullPath);
        if (st.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
        else fs.unlinkSync(fullPath);
        parentDirs.push(path.dirname(fullPath));
      } catch (e) {
        // If file is already gone, fine; otherwise report
        if (e.code !== 'ENOENT') throw e;
      }
    }
    pruneEmptyDirs(parentDirs);
  }
  return true;
}));

// Restore one or more files to the version they had in a specific commit, writing that
// content into the current working tree (and staging it, as `git checkout <hash> -- path`
// does). This is "bring this commit's version of the file into my current branch".
ipcMain.handle('repo:restoreFromCommit', wrap(async (_, { hash, files }) => {
  const g = ensureGit();
  const fileList = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!hash || !fileList.length) throw new Error('Nothing to restore');
  await g.checkout([hash, '--', ...fileList]);
  return { restored: fileList.length };
}));

ipcMain.handle('repo:commit', wrap(async (_, { message, description, amend }) => {
  const g = ensureGit();
  if (!message || !message.trim()) throw new Error('Commit message required');
  const fullMsg = description && description.trim() ? `${message}\n\n${description}` : message;
  // Amend rewrites HEAD instead of adding a commit. Unlike a normal commit it is allowed
  // to have nothing staged — editing only the message is a valid use — so we pass
  // --allow-empty to stop git rejecting a message-only amend as an empty commit.
  if (amend) {
    const result = await g.raw(['commit', '--amend', '--allow-empty', '-m', fullMsg]);
    return { amended: true, output: result };
  }
  const result = await g.commit(fullMsg);
  return result;
}));

// Commit only specific paths (stages them first, then commits just those paths). Used by
// the pre-merge dialog so the user can commit a chosen subset of dirty files.
ipcMain.handle('repo:commitPaths', wrap(async (_, { message, paths }) => {
  const g = ensureGit();
  if (!message || !message.trim()) throw new Error('Commit message required');
  if (!Array.isArray(paths) || !paths.length) throw new Error('No files selected to commit');
  await g.add(paths);
  // Restrict the commit to exactly these paths.
  const result = await g.commit(message, paths);
  return result;
}));

ipcMain.handle('repo:push', wrap(async (_, opts) => {
  ensureGit();
  const pg = makeProgressGit(currentRepoPath);
  const args = [];
  // --force-with-lease is the SAFE force: it refuses to overwrite the remote if the
  // remote branch moved since we last fetched (i.e. a coworker pushed in the meantime),
  // unlike a bare --force. Needed after a squash that rewrote already-pushed commits.
  if (opts && opts.force) args.push('--force-with-lease');
  if (opts && opts.setUpstream) args.push('-u');
  // --follow-tags carries annotated tags reachable from what we're pushing. It ignores
  // lightweight tags by design, so repo:pushTag still exists for those.
  if (opts && opts.followTags) args.push('--follow-tags');
  if (opts && opts.remote) args.push(opts.remote);
  if (opts && opts.branch) args.push(opts.branch);
  try {
    const result = await pg.push(args.length ? args : undefined);
    return result;
  } finally {
    emitOpProgress({ active: false, done: true });
  }
}));

ipcMain.handle('repo:pull', wrap(async () => {
  ensureGit();
  const pg = makeProgressGit(currentRepoPath);
  try {
    const result = await pg.pull();
    return result;
  } finally {
    emitOpProgress({ active: false, done: true });
  }
}));

ipcMain.handle('repo:fetch', wrap(async () => {
  ensureGit();
  const pg = makeProgressGit(currentRepoPath);
  // --prune removes remote-tracking branches that no longer exist on the remote
  // --all fetches from all configured remotes (not just origin)
  try {
    const result = await pg.raw(['fetch', '--all', '--prune', '--tags', '--progress']);
    return result;
  } finally {
    emitOpProgress({ active: false, done: true });
  }
}));

ipcMain.handle('repo:checkout', wrap(async (_, branch) => {
  const g = ensureGit();
  await g.checkout(branch);
  return true;
}));

ipcMain.handle('repo:createBranch', wrap(async (_, { name, checkout }) => {
  const g = ensureGit();
  if (!name) throw new Error('Branch name required');
  if (checkout) {
    await g.checkoutLocalBranch(name);
  } else {
    await g.branch([name]);
  }
  return true;
}));

ipcMain.handle('repo:deleteBranch', wrap(async (_, { name, force }) => {
  const g = ensureGit();
  await g.branch([force ? '-D' : '-d', name]);
  return true;
}));

// Delete a branch on the remote. `ref` is like "origin/feature" — we split it into the
// remote name and branch, then run `git push <remote> --delete <branch>`. Also prunes
// the local remote-tracking ref so the UI updates immediately.
ipcMain.handle('repo:deleteRemoteBranch', wrap(async (_, ref) => {
  const g = ensureGit();
  if (!ref) throw new Error('Remote branch ref required');
  const slash = ref.indexOf('/');
  if (slash < 0) throw new Error('Expected "<remote>/<branch>", got: ' + ref);
  const remote = ref.slice(0, slash);
  const branch = ref.slice(slash + 1);
  if (!branch) throw new Error('Could not parse branch from: ' + ref);
  // Push a delete to the remote.
  await g.push([remote, '--delete', branch]);
  // Clean up the local remote-tracking ref (ignore if already gone).
  try { await g.raw(['branch', '-dr', ref]); } catch (e) {}
  return { remote, branch };
}));

ipcMain.handle('repo:merge', wrap(async (_, opts) => {
  const g = ensureGit();
  // opts can be a string (branch name, legacy) or an object: { branch, strategy, message }
  // strategy: 'auto' | 'ff-only' | 'no-ff' | 'squash'
  let branch, strategy = 'auto', message;
  if (typeof opts === 'string') {
    branch = opts;
  } else {
    branch = opts.branch;
    strategy = opts.strategy || 'auto';
    message = opts.message;
  }
  if (!branch) throw new Error('Branch name required');

  const args = ['merge'];
  if (strategy === 'ff-only') args.push('--ff-only');
  else if (strategy === 'no-ff') args.push('--no-ff');
  else if (strategy === 'squash') args.push('--squash');
  // 'auto' = git's default (ff when possible, otherwise merge commit)

  if (message && strategy !== 'squash') {
    args.push('-m', message);
  }
  args.push(branch);

  try {
    const result = await g.raw(args);

    // simple-git's raw() does NOT throw when `git merge` exits non-zero on conflicts —
    // it returns the output text. The most reliable, locale-independent signal is the
    // working tree itself: if any files are unmerged, the merge conflicted.
    const postStatus = await g.status();
    if ((postStatus.conflicted || []).length > 0) {
      const conflicted = postStatus.conflicted;
      const e = new Error(`Merge conflict — ${conflicted.length} file(s) need resolution:\n${conflicted.join('\n')}`);
      e.conflicted = conflicted;
      e.isConflict = true;
      throw e;
    }
    // Also catch the text signal in case a conflict left the tree in an odd state.
    if (/^CONFLICT|CONFLICT \(|Automatic merge failed|fix conflicts/im.test(result || '')) {
      const e = new Error('Merge conflict — resolve the conflicts, stage the files, then commit.');
      e.conflicted = [];
      e.isConflict = true;
      throw e;
    }

    // For squash, the merge stages changes but doesn't commit — we auto-commit with the squash message
    if (strategy === 'squash') {
      const commitMsg = message || `Squashed merge of '${branch}'`;
      try { await g.commit(commitMsg); } catch (e) {
        // Nothing to commit (empty squash) or other — surface it
        return { output: result, note: 'Squash staged but commit failed: ' + (e.message || e) };
      }
    }
    return { output: result };
  } catch (err) {
    // Provide structured conflict info if applicable
    const msg = err.message || String(err);
    if (err.isConflict || /CONFLICT|Automatic merge failed|conflict/i.test(msg)) {
      // Identify conflicted files (may already be on err.conflicted)
      let conflicted = err.conflicted;
      if (!conflicted || !conflicted.length) {
        try { conflicted = (await g.status()).conflicted || []; } catch (e) { conflicted = conflicted || []; }
      }
      const e = new Error(`Merge conflict — ${conflicted.length} file(s) need resolution:\n${conflicted.join('\n')}\n\nResolve the conflicts, stage the files, then commit. Or abort to cancel.`);
      e.conflicted = conflicted;
      throw e;
    }
    throw err;
  }
}));

ipcMain.handle('repo:mergeAbort', wrap(async () => {
  const g = ensureGit();
  await g.raw(['merge', '--abort']);
  return true;
}));

ipcMain.handle('repo:mergePreview', wrap(async (_, branch) => {
  // Tell the user what merging `branch` into the current branch would look like
  const g = ensureGit();
  if (!branch) throw new Error('Branch required');

  // Counts of commits ahead/behind
  let ahead = 0, behind = 0;
  try {
    const rev = await g.raw(['rev-list', '--left-right', '--count', `HEAD...${branch}`]);
    const [a, b] = rev.trim().split(/\s+/).map(n => parseInt(n, 10));
    ahead = a || 0; behind = b || 0;
  } catch (e) {}

  // Can we fast-forward? (HEAD is ancestor of branch)
  let canFastForward = false;
  try {
    await g.raw(['merge-base', '--is-ancestor', 'HEAD', branch]);
    canFastForward = true;
  } catch (e) { canFastForward = false; }

  // Find merge base for visualization
  let mergeBase = '';
  try {
    mergeBase = (await g.raw(['merge-base', 'HEAD', branch])).trim();
  } catch (e) {}

  // Subjects of commits that would be merged in
  let incoming = [];
  try {
    const out = await g.raw(['log', '--pretty=format:%h\x1f%s\x1f%an', `HEAD..${branch}`, '-n', '20']);
    incoming = out.split('\n').filter(Boolean).map(l => {
      const [hash, message, author] = l.split('\x1f');
      return { hash, message, author };
    });
  } catch (e) {}

  return { ahead, behind, canFastForward, mergeBase, incoming };
}));

ipcMain.handle('repo:cherryPick', wrap(async (_, hash) => {
  const g = ensureGit();
  if (!hash) throw new Error('Commit hash required');
  await g.raw(['cherry-pick', hash]);
  return true;
}));

ipcMain.handle('repo:revert', wrap(async (_, hash) => {
  const g = ensureGit();
  if (!hash) throw new Error('Commit hash required');
  await g.raw(['revert', '--no-edit', hash]);
  return true;
}));

ipcMain.handle('repo:reset', wrap(async (_, { hash, mode }) => {
  const g = ensureGit();
  if (!hash) throw new Error('Commit hash required');
  // mode: 'soft' | 'mixed' | 'hard'
  const modeFlag = '--' + (mode || 'mixed');
  await g.raw(['reset', modeFlag, hash]);
  return true;
}));

// Parse `git log` output into plain commit objects. Uses \x1f (unit separator) between
// fields and one line per commit so subjects with spaces survive intact.
async function _listCommits(g, range, maxCount) {
  const fmt = '%H%x1f%h%x1f%s%x1f%an%x1f%aI';
  const args = ['log', '--pretty=format:' + fmt];
  if (maxCount) args.push('--max-count=' + maxCount);
  args.push(range);
  let raw = '';
  try { raw = await g.raw(args); } catch (e) { return []; }
  return (raw || '').split('\n').filter(Boolean).map(line => {
    const [hash, short, subject, author, date] = line.split('\x1f');
    return { hash, short, subject, author, date };
  });
}

// Gather everything the renderer needs to offer a safe squash of the current branch:
// how many commits sit ahead of the upstream (already-pushed detection), the merge-base
// with a likely base branch (main/master/develop), and the recent commit list to preview.
ipcMain.handle('repo:squashPreview', wrap(async () => {
  const g = ensureGit();
  const status = await g.status();
  const branch = status.current;
  if (!branch || status.detached) {
    throw new Error('You are not on a branch (detached HEAD). Check out your feature branch first.');
  }
  const tracking = status.tracking || null;

  // How many commits has HEAD moved ahead of its upstream? If this is LESS than the number
  // we end up combining, then some of those commits were already pushed → force-push needed.
  let aheadOfUpstream = 0;
  if (tracking) {
    try {
      aheadOfUpstream = parseInt((await g.raw(['rev-list', '--count', `${tracking}..HEAD`])).trim(), 10) || 0;
    } catch (e) { /* leave 0 */ }
  }

  // Pick a base branch to measure the feature against: the first conventional default
  // branch that exists and isn't the branch we're on.
  let localNames = [];
  try { localNames = (await g.branchLocal()).all || []; } catch (e) { /* none */ }
  let base = null;
  for (const pref of ['main', 'master', 'develop', 'devel']) {
    if (pref !== branch && localNames.includes(pref)) { base = pref; break; }
  }

  let mergeBase = null;
  let sinceBaseCount = 0;
  if (base) {
    try {
      mergeBase = (await g.raw(['merge-base', base, 'HEAD'])).trim() || null;
      if (mergeBase) {
        sinceBaseCount = parseInt((await g.raw(['rev-list', '--count', `${mergeBase}..HEAD`])).trim(), 10) || 0;
      }
    } catch (e) { mergeBase = null; sinceBaseCount = 0; }
  }

  // Recent commits along HEAD, newest first, to drive the live preview and the "last N" mode.
  const recent = await _listCommits(g, 'HEAD', 100);

  const dirty = (status.files || []).length > 0;

  return { branch, tracking, aheadOfUpstream, base, mergeBase, sinceBaseCount, recent, dirty };
}));

// Perform a non-destructive squash: stamp a backup branch at the current HEAD, then
// `reset --soft` to the combine point and create a single commit. --soft keeps the index
// and working tree, so the combined diff is preserved and committed as one.
ipcMain.handle('repo:squash', wrap(async (_, opts) => {
  const g = ensureGit();
  opts = opts || {};
  const { target, count, summary, description, includeWorkingTree } = opts;
  const makeBackup = opts.backup !== false;

  const status = await g.status();
  const branch = status.current;
  if (!branch || status.detached) throw new Error('You are not on a branch (detached HEAD).');
  if (!summary || !summary.trim()) throw new Error('A commit summary is required.');

  // Resolve the commit we will reset back to.
  let resetTo;
  if (target) resetTo = String(target);
  else if (count && count > 0) resetTo = `HEAD~${count}`;
  else throw new Error('Nothing selected to combine.');

  let resolved;
  try { resolved = (await g.raw(['rev-parse', '--verify', resetTo + '^{commit}'])).trim(); }
  catch (e) { throw new Error('Could not resolve the combine point (' + resetTo + ').'); }

  const head = (await g.raw(['rev-parse', 'HEAD'])).trim();
  if (resolved === head) throw new Error('The combine point is the current commit — there is nothing to combine.');

  // The reset target must be an ancestor of HEAD, or we'd be rewriting unrelated history.
  const isAncestor = await g.raw(['merge-base', '--is-ancestor', resolved, 'HEAD']).then(() => true).catch(() => false);
  if (!isAncestor) throw new Error('The combine point is not an ancestor of the current commit.');

  const combined = parseInt((await g.raw(['rev-list', '--count', `${resolved}..HEAD`])).trim(), 10) || 0;

  // Safety net: a branch holding the pre-squash HEAD so every original commit stays
  // reachable and the operation can be fully undone (in addition to git's reflog).
  let backupRef = null;
  if (makeBackup) {
    const safeBranch = branch.replace(/[^\w.-]+/g, '-');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    backupRef = `gitgood-backup/${safeBranch}/${stamp}`;
    await g.raw(['branch', backupRef, 'HEAD']);
  }

  try {
    await g.raw(['reset', '--soft', resolved]);
    // Optionally fold in any current uncommitted changes so the result is exactly one
    // commit of the latest working state.
    if (includeWorkingTree) await g.raw(['add', '-A']);
    const commitArgs = ['commit', '-m', summary.trim()];
    if (description && description.trim()) commitArgs.push('-m', description.trim());
    await g.raw(commitArgs);
  } catch (e) {
    // Roll back to the pre-squash state so a failure never leaves a half-done reset.
    try { await g.raw(['reset', '--soft', head]); } catch (e2) { /* best effort */ }
    throw e;
  }

  const newHead = (await g.raw(['rev-parse', 'HEAD'])).trim();
  return { branch, backupRef, combined, newHead, aheadOfUpstream: opts.aheadOfUpstream };
}));

ipcMain.handle('repo:moveBranch', wrap(async (_, { branch, hash }) => {
  const g = ensureGit();
  // Move a branch to point at a specific commit. If it's the current branch, use reset.
  // If it's not, use `git branch -f <name> <hash>`.
  if (!branch || !hash) throw new Error('Branch and hash required');
  const status = await g.status();
  if (status.current === branch) {
    await g.raw(['reset', '--hard', hash]);
  } else {
    await g.raw(['branch', '-f', branch, hash]);
  }
  return true;
}));

ipcMain.handle('repo:remotes', wrap(async () => {
  const g = ensureGit();
  const remotes = await g.getRemotes(true);
  return remotes;
}));

ipcMain.handle('repo:addRemote', wrap(async (_, { name, url }) => {
  const g = ensureGit();
  await g.addRemote(name, url);
  return true;
}));

ipcMain.handle('repo:removeRemote', wrap(async (_, name) => {
  const g = ensureGit();
  await g.removeRemote(name);
  return true;
}));

ipcMain.handle('repo:stash', wrap(async (_, opts) => {
  const g = ensureGit();
  // opts can be a string (message, legacy) or an object: { message, paths, includeUntracked, keepIndex }
  let message, paths, includeUntracked, keepIndex;
  if (typeof opts === 'string' || !opts) {
    message = opts || undefined;
  } else {
    message = opts.message;
    paths = Array.isArray(opts.paths) ? opts.paths : (opts.paths ? [opts.paths] : null);
    includeUntracked = !!opts.includeUntracked;
    keepIndex = !!opts.keepIndex;
  }

  const args = ['push'];
  if (includeUntracked) args.push('-u');
  if (keepIndex) args.push('--keep-index');
  if (message) args.push('-m', message);
  if (paths && paths.length) {
    args.push('--');
    args.push(...paths);
  }
  await g.stash(args);
  return true;
}));

ipcMain.handle('repo:stashList', wrap(async () => {
  const g = ensureGit();
  // Use raw so we can include the date and parse reliably
  // Format: <index>\x1f<message>\x1f<hash>\x1f<date>
  const SEP = '\x1f';
  let out = '';
  try {
    out = await g.raw(['stash', 'list', `--pretty=format:%gd${SEP}%s${SEP}%H${SEP}%aI`]);
  } catch (e) {
    return { all: [], total: 0 };
  }
  const all = out.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const [ref, message, hash, date] = line.split(SEP);
    // Extract index from ref like "stash@{0}"
    const m = (ref || '').match(/stash@\{(\d+)\}/);
    const index = m ? parseInt(m[1], 10) : 0;
    return { index, ref, message: message || '', hash: hash || '', date: date || '' };
  });
  return { all, total: all.length };
}));

ipcMain.handle('repo:stashFiles', wrap(async (_, index) => {
  const g = ensureGit();
  const stashRef = `stash@{${index || 0}}`;
  const out = {};

  // Tracked file changes (relative to the stash's base commit)
  let tracked = [];
  try {
    const raw = await g.raw(['diff', '--name-status', `${stashRef}^`, stashRef]);
    tracked = raw.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const status = (parts[0] || 'M')[0]; // first char: A, M, D, R, etc.
      const path = parts[parts.length - 1];
      const renameFrom = parts.length > 2 ? parts[1] : null;
      return { path, status, renameFrom, kind: 'tracked' };
    });
  } catch (e) { /* stash might not exist */ }

  // Untracked files (parent #3 of the stash, if -u was used)
  let untracked = [];
  try {
    const raw = await g.raw(['ls-tree', '-r', '--name-only', `${stashRef}^3`]);
    untracked = raw.split('\n').filter(Boolean).map(path => ({ path, status: '?', kind: 'untracked' }));
  } catch (e) { /* no untracked tree — fine */ }

  return { tracked, untracked };
}));

ipcMain.handle('repo:stashPop', wrap(async (_, index) => {
  const g = ensureGit();
  const stashRef = `stash@{${index || 0}}`;
  await g.stash(['pop', stashRef]);
  return true;
}));

ipcMain.handle('repo:stashApply', wrap(async (_, index) => {
  const g = ensureGit();
  await g.stash(['apply', `stash@{${index || 0}}`]);
  return true;
}));

ipcMain.handle('repo:stashApplyFiles', wrap(async (_, { index, paths, drop }) => {
  // Restore specific files from a stash to the working tree (unstaged).
  // Workflow per file:
  //   1. git checkout stash@{N} -- <path>     → restores content & stages it
  //   2. git reset HEAD -- <path>             → unstages (working-tree only)
  // For untracked files in a stash (parent #3): checkout from stash@{N}^3.
  // After successful per-file apply, optionally drop the stash if all files were restored.
  const g = ensureGit();
  if (!Array.isArray(paths) || !paths.length) throw new Error('No files specified');
  const stashRef = `stash@{${index || 0}}`;

  // Get the file list to figure out tracked vs untracked
  let untrackedSet = new Set();
  try {
    const raw = await g.raw(['ls-tree', '-r', '--name-only', `${stashRef}^3`]);
    raw.split('\n').filter(Boolean).forEach(p => untrackedSet.add(p));
  } catch (e) { /* no untracked tree */ }

  const trackedPaths = paths.filter(p => !untrackedSet.has(p));
  const untrackedPaths = paths.filter(p => untrackedSet.has(p));

  if (trackedPaths.length) {
    await g.raw(['checkout', stashRef, '--', ...trackedPaths]);
    // Unstage
    try { await g.raw(['reset', 'HEAD', '--', ...trackedPaths]); } catch (e) { /* nothing to reset */ }
  }
  if (untrackedPaths.length) {
    await g.raw(['checkout', `${stashRef}^3`, '--', ...untrackedPaths]);
    // Untracked files end up staged — unstage them by removing from index (keeps file)
    try { await g.raw(['reset', 'HEAD', '--', ...untrackedPaths]); } catch (e) { /* okay */ }
  }

  if (drop) {
    // Only safe to drop if we restored every file in the stash
    await g.stash(['drop', stashRef]);
  }
  return { trackedApplied: trackedPaths.length, untrackedApplied: untrackedPaths.length };
}));

ipcMain.handle('repo:stashDrop', wrap(async (_, index) => {
  const g = ensureGit();
  await g.stash(['drop', `stash@{${index || 0}}`]);
  return true;
}));

// Drop every auto-stash (current or legacy marker) bound to a given branch. Used to
// prevent duplicate auto-stashes from accumulating across repeated checkouts. Drops
// from the highest index downward so earlier indices stay valid during removal.
ipcMain.handle('repo:dropAutoStashFor', wrap(async (_, branch) => {
  const g = ensureGit();
  if (!branch) return { dropped: 0 };
  const SEP = '\x1f';
  let listed = '';
  try { listed = await g.raw(['stash', 'list', `--pretty=format:%gd${SEP}%s`]); }
  catch (e) { return { dropped: 0 }; }
  const stale = listed.split('\n').map(s => s.trim()).filter(Boolean)
    .map(line => {
      const [ref, message] = line.split(SEP);
      const m = (ref || '').match(/stash@\{(\d+)\}/);
      return { index: m ? parseInt(m[1], 10) : -1, message: message || '' };
    })
    .filter(s => s.index >= 0 && (
      s.message.includes(`[GitGood auto] on ${branch}`) ||
      s.message.includes(`[GitSouls auto] on ${branch}`)
    ))
    .sort((a, b) => b.index - a.index);
  let dropped = 0;
  for (const s of stale) {
    try { await g.raw(['stash', 'drop', `stash@{${s.index}}`]); dropped++; } catch (e) { /* ignore */ }
  }
  return { dropped };
}));

// Find stashes whose message contains a given marker (used for branch-bound auto-stashes).
// git's stash list shows "On <branch>: <user message>" so we substring-match.
// Returns array of { index, ref, message, hash, date }.
ipcMain.handle('repo:stashFindByPrefix', wrap(async (_, marker) => {
  const g = ensureGit();
  if (!marker) return [];
  const SEP = '\x1f';
  let out = '';
  try {
    out = await g.raw(['stash', 'list', `--pretty=format:%gd${SEP}%s${SEP}%H${SEP}%aI`]);
  } catch (e) {
    return [];
  }
  return out.split('\n').map(s => s.trim()).filter(Boolean)
    .map(line => {
      const [ref, message, hash, date] = line.split(SEP);
      const m = (ref || '').match(/stash@\{(\d+)\}/);
      const index = m ? parseInt(m[1], 10) : 0;
      return { index, ref, message: message || '', hash: hash || '', date: date || '' };
    })
    .filter(s => s.message.includes(marker));
}));

// Checkout with stash safety: detects dirty working tree and returns a structured response
// so the renderer can offer Stash & Switch / Discard & Switch / Cancel.
ipcMain.handle('repo:checkoutSafe', wrap(async (_, { branch, autoStashAll, discardAll }) => {
  const g = ensureGit();
  if (!branch) throw new Error('Branch required');

  // If user explicitly asked to discard, do a hard reset + clean of untracked
  if (discardAll) {
    await g.raw(['reset', '--hard', 'HEAD']);
    await g.raw(['clean', '-fd']);
    await g.checkout(branch);
    return { switched: true, autoStashed: false };
  }

  // If user asked to auto-stash, do that before checkout
  if (autoStashAll) {
    const status = await g.status();
    const dirty = (status.files || []).length > 0;
    if (dirty) {
      const fromBranch = status.current || 'detached';
      const stashMsg = `[GitGood auto] on ${fromBranch}`;
      // Avoid duplicate auto-stashes: if an auto-stash bound to this same branch
      // already exists (e.g. the user previously chose "Apply" which keeps the entry,
      // or "Not Now"), drop it first so we never accumulate multiple copies of the
      // same branch's auto-stash. Drop from the highest index downward so earlier
      // indices stay valid while we remove.
      try {
        const SEP = '\x1f';
        const listed = await g.raw(['stash', 'list', `--pretty=format:%gd${SEP}%s`]);
        const stale = listed.split('\n').map(s => s.trim()).filter(Boolean)
          .map(line => {
            const [ref, message] = line.split(SEP);
            const m = (ref || '').match(/stash@\{(\d+)\}/);
            return { index: m ? parseInt(m[1], 10) : -1, message: message || '' };
          })
          .filter(s => s.index >= 0 && (
            s.message.includes(`[GitGood auto] on ${fromBranch}`) ||
            s.message.includes(`[GitSouls auto] on ${fromBranch}`)
          ))
          .sort((a, b) => b.index - a.index);
        for (const s of stale) {
          try { await g.raw(['stash', 'drop', `stash@{${s.index}}`]); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* non-fatal: proceed to stash anyway */ }
      await g.stash(['push', '-u', '-m', stashMsg]);
    }
    await g.checkout(branch);
    return { switched: true, autoStashed: true };
  }

  // Otherwise: try the checkout. If it fails for dirty-tree reasons, report
  // structured info so the renderer can prompt.
  try {
    await g.checkout(branch);
    return { switched: true, autoStashed: false };
  } catch (err) {
    const msg = err.message || String(err);
    if (/would be overwritten|local changes|untracked working tree files/i.test(msg)) {
      const status = await g.status();
      return {
        switched: false,
        dirty: true,
        currentBranch: status.current,
        modified: (status.modified || []).length,
        untracked: (status.not_added || []).length,
        staged: (status.staged || []).length,
        files: (status.files || []).map(f => f.path),
        error: msg
      };
    }
    throw err;
  }
}));

ipcMain.handle('repo:revParse', wrap(async (_, ref) => {
  const g = ensureGit();
  return (await g.revparse([ref || 'HEAD'])).trim();
}));

ipcMain.handle('repo:fileContent', wrap(async (_, filePath) => {
  const fullPath = path.join(currentRepoPath, filePath);
  if (!fs.existsSync(fullPath)) return null;
  const stats = fs.statSync(fullPath);
  if (stats.isDirectory()) return null;
  if (stats.size > 2 * 1024 * 1024) return '[File too large to display]';
  return fs.readFileSync(fullPath, 'utf8');
}));

ipcMain.handle('repo:openInExplorer', (_, p) => {
  const target = p || currentRepoPath;
  if (target) shell.openPath(target);
  return { ok: true };
});

ipcMain.handle('repo:showCommit', wrap(async (_, opts) => {
  const g = ensureGit();
  // Accept either a hash string (legacy) or an options object { hash, maxBytes, includeDiff }
  const hash = typeof opts === 'string' ? opts : opts && opts.hash;
  const maxBytes = (typeof opts === 'object' && opts && opts.maxBytes) || 2 * 1024 * 1024; // 2 MB default
  if (!hash) throw new Error('Hash required');

  // Stat summary (lightweight)
  const show = await g.show([hash, '--stat']);

  // Per-file changes summary (cheap — just file names and add/del counts)
  let files = [];
  try {
    const raw = await g.raw(['show', '--numstat', '--format=', hash]);
    files = raw.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      if (parts.length < 3) return null;
      const [adds, dels, path] = parts;
      return {
        path,
        adds: adds === '-' ? null : parseInt(adds, 10) || 0,
        dels: dels === '-' ? null : parseInt(dels, 10) || 0,
        binary: adds === '-' && dels === '-'
      };
    }).filter(Boolean);
  } catch (e) {}

  // Full diff (potentially huge). Use raw + maxBuffer guard.
  let diff = '';
  let diffTruncated = false;
  let diffBytes = 0;
  try {
    diff = await g.show([...wsArgs(opts), hash]);
    diffBytes = Buffer.byteLength(diff, 'utf8');
    if (diffBytes > maxBytes) {
      // Truncate at a line boundary
      const cut = diff.lastIndexOf('\n', maxBytes);
      diff = diff.slice(0, cut > 0 ? cut : maxBytes);
      diffTruncated = true;
    }
  } catch (e) {
    diff = '(failed to load diff: ' + (e.message || e) + ')';
  }

  return { show, diff, files, diffTruncated, diffBytes };
}));

// Get the diff for a single file from a commit. Used for lazy-loading per-file
// diffs when the full commit diff is too large to render at once.
ipcMain.handle('repo:showCommitFileDiff', wrap(async (_, { hash, path: filePath, maxBytes, ignoreWhitespace }) => {
  const g = ensureGit();
  if (!hash || !filePath) throw new Error('hash and path required');
  const cap = maxBytes || 1024 * 1024;
  let diff = '';
  let truncated = false;
  try {
    diff = await g.show([...wsArgs({ ignoreWhitespace }), hash, '--', filePath]);
    if (Buffer.byteLength(diff, 'utf8') > cap) {
      const cut = diff.lastIndexOf('\n', cap);
      diff = diff.slice(0, cut > 0 ? cut : cap);
      truncated = true;
    }
  } catch (e) {
    diff = '(failed to load: ' + (e.message || e) + ')';
  }
  return { diff, truncated };
}));

ipcMain.handle('repo:rawCommand', wrap(async (_, args) => {
  const g = ensureGit();
  if (!Array.isArray(args)) throw new Error('Args must be array');
  return await g.raw(args);
}));

ipcMain.handle('shell:openExternal', (_, url) => {
  shell.openExternal(url);
  return { ok: true };
});

// ============================================
// EMBEDDED TERMINAL — a persistent shell session (Git Bash on Windows if present,
// otherwise the system shell). Commands are written to the shell's stdin and output
// is streamed back to the renderer, so cd / env / shell state persist like a real
// terminal. Not a full PTY (no curses/interactive editors), but behaves like Git Bash
// for command-line git work.
// ============================================
let _term = null; // { proc, type }

function _findShell() {
  if (process.platform === 'win32') {
    const candidates = [
      process.env.ProgramW6432 && path.join(process.env.ProgramW6432, 'Git', 'bin', 'bash.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return { cmd: c, args: ['--noprofile', '--norc'], type: 'bash', label: 'Git Bash' }; } catch (e) {}
    }
    return { cmd: process.env.COMSPEC || 'cmd.exe', args: ['/Q'], type: 'cmd', label: 'Command Prompt' };
  }
  const sh = process.env.SHELL || '/bin/bash';
  return { cmd: sh, args: [], type: 'bash', label: path.basename(sh) };
}

ipcMain.handle('term:start', (_e, opts) => {
  const { spawn } = require('child_process');
  if (_term && _term.proc) { try { _term.proc.kill(); } catch (e) {} _term = null; }
  const cwd = (opts && opts.cwd) || currentRepoPath || os.homedir();
  const sh = _findShell();
  // Disable pagers/color so output streams cleanly into a non-TTY pipe.
  const env = Object.assign({}, process.env, {
    TERM: 'dumb', GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0'
  });
  let proc;
  try {
    proc = spawn(sh.cmd, sh.args, { cwd, env, windowsHide: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  _term = { proc, type: sh.type };
  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  };
  proc.stdout.on('data', d => send('term:data', { data: d.toString() }));
  proc.stderr.on('data', d => send('term:data', { data: d.toString() }));
  proc.on('error', (err) => send('term:data', { data: '\n[shell error] ' + err.message + '\n' }));
  proc.on('exit', (code) => {
    // Only report the exit if this is still the active terminal. When restarting,
    // the old process is killed and replaced; its (async) exit must NOT bubble up
    // and tear down the freshly started session.
    if (_term && _term.proc === proc) { _term = null; send('term:exit', { code }); }
  });
  return { ok: true, data: { cwd, shell: sh.cmd, type: sh.type, label: sh.label } };
});

ipcMain.handle('term:input', (_e, text) => {
  if (!_term || !_term.proc) return { ok: false, error: 'No active terminal' };
  try { _term.proc.stdin.write(text); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('term:signal', (_e, sig) => {
  if (!_term || !_term.proc) return { ok: false, error: 'No active terminal' };
  try { _term.proc.kill(sig || 'SIGINT'); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('term:kill', () => {
  if (_term && _term.proc) { try { _term.proc.kill(); } catch (e) {} _term = null; }
  return { ok: true };
});


// ============================================
// CONFLICT RESOLUTION
// ============================================

// Detect any in-progress operation (merge, rebase, cherry-pick, revert) and list conflicts.
// Returns { operation, conflicts: [{ path, indexStatus, workingDir, ours, theirs, base, deletedInOurs, deletedInTheirs, isBinary }] }
ipcMain.handle('repo:conflictState', wrap(async () => {
  const g = ensureGit();

  // What operation is underway?
  let operation = null;
  if (fs.existsSync(path.join(currentRepoPath, '.git', 'MERGE_HEAD'))) operation = 'merge';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'CHERRY_PICK_HEAD'))) operation = 'cherry-pick';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'REVERT_HEAD'))) operation = 'revert';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-merge'))
        || fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-apply'))) operation = 'rebase';

  // Parse `git ls-files --unmerged` for stage info.
  // Output: <mode> <hash> <stage>\t<path>
  // Stage 1 = base, 2 = ours, 3 = theirs.
  let unmerged = '';
  try { unmerged = await g.raw(['ls-files', '--unmerged']); } catch (e) {}
  const byPath = new Map();
  unmerged.split('\n').filter(Boolean).forEach(line => {
    const m = line.match(/^(\d+)\s+([0-9a-f]+)\s+(\d+)\t(.+)$/);
    if (!m) return;
    const [, mode, hash, stage, p] = m;
    if (!byPath.has(p)) byPath.set(p, { path: p });
    const entry = byPath.get(p);
    if (stage === '1') entry.base = hash;
    else if (stage === '2') entry.ours = hash;
    else if (stage === '3') entry.theirs = hash;
  });

  // Cross-reference with status for working dir state
  let status;
  try { status = await g.status(); } catch (e) { status = { files: [] }; }
  const conflicts = [];
  for (const [p, entry] of byPath.entries()) {
    const f = (status.files || []).find(x => x.path === p);
    const idx = f ? f.index : ' ';
    const wt = f ? f.working_dir : ' ';
    entry.indexStatus = idx;
    entry.workingDir = wt;
    entry.deletedInOurs = !entry.ours;        // missing stage 2 = deleted in HEAD
    entry.deletedInTheirs = !entry.theirs;    // missing stage 3 = deleted in incoming

    // Check if file currently has conflict markers
    const fullPath = path.join(currentRepoPath, p);
    let hasMarkers = false;
    let isBinary = false;
    let resolved = false;
    if (fs.existsSync(fullPath)) {
      try {
        const buf = fs.readFileSync(fullPath);
        // Heuristic: any NUL byte = binary
        for (let i = 0; i < Math.min(buf.length, 8192); i++) {
          if (buf[i] === 0) { isBinary = true; break; }
        }
        if (!isBinary) {
          const text = buf.toString('utf8');
          hasMarkers = /^<{7} |^={7}$|^>{7} /m.test(text);
          resolved = !hasMarkers;
        }
      } catch (e) {}
    } else {
      // File doesn't exist — possibly already resolved by deletion
      resolved = entry.deletedInTheirs || entry.deletedInOurs;
    }
    entry.hasMarkers = hasMarkers;
    entry.isBinary = isBinary;
    // "Resolved" means it's no longer in the unmerged index (so it wouldn't be here),
    // but we also flag files that look done (no markers, content exists, both sides have stages)
    entry.looksResolved = resolved;

    conflicts.push(entry);
  }

  return { operation, conflicts };
}));

// Get the three versions of a conflicted file (base / ours / theirs) as text.
ipcMain.handle('repo:conflictVersions', wrap(async (_, filePath) => {
  const g = ensureGit();
  if (!filePath) throw new Error('File path required');

  const getStage = async (n) => {
    try {
      const buf = await g.raw(['show', `:${n}:${filePath}`]);
      return buf;
    } catch (e) {
      return null;
    }
  };

  const [base, ours, theirs] = await Promise.all([getStage(1), getStage(2), getStage(3)]);

  // Also return the current working-tree content (with conflict markers)
  let current = null;
  try {
    const fullPath = path.join(currentRepoPath, filePath);
    if (fs.existsSync(fullPath)) {
      current = fs.readFileSync(fullPath, 'utf8');
    }
  } catch (e) {}

  return { base, ours, theirs, current };
}));

// Resolve a conflict by writing new content to the file (does NOT stage).
ipcMain.handle('repo:writeFile', wrap(async (_, { path: filePath, content }) => {
  if (!filePath) throw new Error('File path required');
  const fullPath = path.join(currentRepoPath, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return true;
}));

// Resolve a conflict by accepting one side wholesale.
// side: 'ours' | 'theirs'
ipcMain.handle('repo:conflictResolveSide', wrap(async (_, { filePath, side }) => {
  const g = ensureGit();
  if (!filePath) throw new Error('File path required');
  if (side !== 'ours' && side !== 'theirs') throw new Error('side must be "ours" or "theirs"');
  await g.raw(['checkout', `--${side}`, '--', filePath]);
  // Stage the result so the conflict is marked resolved
  await g.add(filePath);
  return true;
}));

// Mark a conflicted file as resolved (stages it as-is). Caller should verify markers are gone.
ipcMain.handle('repo:conflictMarkResolved', wrap(async (_, filePath) => {
  const g = ensureGit();
  if (!filePath) throw new Error('File path required');
  // Read the file to verify no markers remain (safety net for the user)
  const fullPath = path.join(currentRepoPath, filePath);
  if (fs.existsSync(fullPath)) {
    const text = fs.readFileSync(fullPath, 'utf8');
    if (/^<{7} |^={7}$|^>{7} /m.test(text)) {
      throw new Error('File still contains conflict markers. Resolve all hunks before marking as resolved.');
    }
  }
  await g.add(filePath);
  return true;
}));

// For modify/delete conflicts: keep the file (the modified side) or delete it.
ipcMain.handle('repo:conflictKeepFile', wrap(async (_, filePath) => {
  const g = ensureGit();
  await g.add(filePath);
  return true;
}));

ipcMain.handle('repo:conflictDeleteFile', wrap(async (_, filePath) => {
  const g = ensureGit();
  // git rm to remove from tree and stage the deletion
  await g.raw(['rm', '-f', '--', filePath]);
  return true;
}));

// Resolve a conflicted file by taking exactly one side. Works for text and binary
// conflicts. Internally: `git checkout --ours/--theirs -- <file>` then stage it.
ipcMain.handle('repo:conflictUseOurs', wrap(async (_, filePath) => {
  const g = ensureGit();
  await g.raw(['checkout', '--ours', '--', filePath]);
  await g.add(filePath);
  return true;
}));
ipcMain.handle('repo:conflictUseTheirs', wrap(async (_, filePath) => {
  const g = ensureGit();
  await g.raw(['checkout', '--theirs', '--', filePath]);
  await g.add(filePath);
  return true;
}));

// Restore conflict markers if the user wants to start over.
ipcMain.handle('repo:conflictRestoreMarkers', wrap(async (_, filePath) => {
  const g = ensureGit();
  await g.raw(['checkout', '-m', '--', filePath]);
  return true;
}));

// Continue / abort the ongoing operation.
ipcMain.handle('repo:operationContinue', wrap(async () => {
  const g = ensureGit();
  // Detect op
  let op = null;
  if (fs.existsSync(path.join(currentRepoPath, '.git', 'MERGE_HEAD'))) op = 'merge';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'CHERRY_PICK_HEAD'))) op = 'cherry-pick';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'REVERT_HEAD'))) op = 'revert';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-merge'))
        || fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-apply'))) op = 'rebase';

  if (!op) throw new Error('No operation in progress');

  if (op === 'merge') {
    // Use git's prepared message
    let msg = '';
    const msgPath = path.join(currentRepoPath, '.git', 'MERGE_MSG');
    try { if (fs.existsSync(msgPath)) msg = fs.readFileSync(msgPath, 'utf8'); } catch (e) {}
    await g.raw(['commit', '--no-edit']);
  } else if (op === 'cherry-pick') {
    await g.raw(['cherry-pick', '--continue']);
  } else if (op === 'revert') {
    await g.raw(['revert', '--continue']);
  } else if (op === 'rebase') {
    await g.raw(['rebase', '--continue']);
  }
  return { operation: op, continued: true };
}));

ipcMain.handle('repo:operationAbort', wrap(async () => {
  const g = ensureGit();
  let op = null;
  if (fs.existsSync(path.join(currentRepoPath, '.git', 'MERGE_HEAD'))) op = 'merge';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'CHERRY_PICK_HEAD'))) op = 'cherry-pick';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'REVERT_HEAD'))) op = 'revert';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-merge'))
        || fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-apply'))) op = 'rebase';

  if (!op) throw new Error('No operation in progress');
  await g.raw([op, '--abort']);
  return { operation: op, aborted: true };
}));

// Inspect things git is intentionally hiding: empty folders (untrackable by design)
// and gitignore'd content. Helps the user understand why their changes don't appear.
ipcMain.handle('repo:inspectHidden', wrap(async () => {
  const g = ensureGit();
  const result = { emptyFolders: [], ignored: [] };

  // Walk the working tree (bounded) and find folders with no tracked or trackable content.
  // Returns true if the folder has any file (not just subdirectories) inside it (recursively).
  function walk(dir, rel, depth) {
    if (depth > 6) return true; // bound recursion; assume non-empty to be safe
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return true; }
    // Skip noise (hidden files, node_modules, .git)
    const visible = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');
    if (visible.length === 0) {
      // Truly empty leaf folder
      if (rel) result.emptyFolders.push(rel);
      return false;
    }
    let hasFile = false;
    for (const e of visible) {
      if (e.isDirectory()) {
        const childHasFile = walk(path.join(dir, e.name), rel ? rel + '/' + e.name : e.name, depth + 1);
        if (childHasFile) hasFile = true;
      } else {
        hasFile = true;
      }
    }
    // If this folder only contains other (empty) folders, it's also effectively empty
    if (!hasFile && rel) result.emptyFolders.push(rel);
    return hasFile;
  }
  try { walk(currentRepoPath, '', 0); } catch (e) {}

  // Ignored content (excluding standard noise)
  try {
    const out = await g.raw(['status', '--porcelain', '--ignored=traditional']);
    // Lines starting with !! are ignored
    result.ignored = out.split('\n').filter(l => l.startsWith('!!')).map(l => l.slice(3));
  } catch (e) {}

  return result;
}));

// Add a .gitkeep file inside a folder so git can track it.
ipcMain.handle('repo:addGitkeep', wrap(async (_, folderRelPath) => {
  if (!folderRelPath) throw new Error('Folder path required');
  const full = path.join(currentRepoPath, folderRelPath, '.gitkeep');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!fs.existsSync(full)) fs.writeFileSync(full, '', 'utf8');
  return { created: full };
}));

// Append one or more paths to the repo-root .gitignore. Each entry is anchored with a
// leading slash (e.g. "/build/out.log") so it ignores exactly that path from the repo
// root rather than any same-named file elsewhere. Paths already present (in either the
// anchored or bare form) are skipped, and the existing newline style is preserved.
ipcMain.handle('repo:addToGitignore', wrap(async (_, paths) => {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) throw new Error('No paths provided');
  const giPath = path.join(currentRepoPath, '.gitignore');
  let content = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  const eol = /\r\n/.test(content) ? '\r\n' : '\n';
  const existing = new Set(content.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
  const toAdd = [];
  for (const p of list) {
    const anchored = '/' + String(p).replace(/\\/g, '/').replace(/^\/+/, '');
    if (existing.has(anchored) || existing.has(anchored.slice(1))) continue;
    existing.add(anchored);
    toAdd.push(anchored);
  }
  if (!toAdd.length) return { added: [], already: list.length };
  // Ensure the file ends with a newline before we append the new block.
  let out = content;
  if (out.length && !/\n$/.test(out)) out += eol;
  out += toAdd.join(eol) + eol;
  fs.writeFileSync(giPath, out, 'utf8');
  return { added: toAdd };
}));
// Returns { hunks: [{ type, lines }] } where type is 'common' | 'conflict'.
// A 'conflict' hunk has { ours: [lines], theirs: [lines], base: [lines | null] }
// (base is present only for diff3-style markers).
ipcMain.handle('repo:parseConflictFile', wrap(async (_, filePath) => {
  const fullPath = path.join(currentRepoPath, filePath);
  if (!fs.existsSync(fullPath)) throw new Error('File not found: ' + filePath);
  const text = fs.readFileSync(fullPath, 'utf8');
  return parseConflictMarkers(text);
}));

function parseConflictMarkers(text) {
  // Detect line-ending style. We preserve it on output (we don't strip \r unless we have to).
  // Split on \n; if lines end with \r we'll strip them only when matching markers,
  // and remember the EOL style so we can reconstruct correctly.
  const usesCRLF = /\r\n/.test(text);
  const lines = text.split('\n');
  const hunks = [];
  let common = [];
  let i = 0;

  // Helper: strip a trailing \r so marker detection works on CRLF files
  const norm = (l) => (l && l.endsWith('\r')) ? l.slice(0, -1) : l;

  while (i < lines.length) {
    const line = norm(lines[i]);
    if (line.startsWith('<<<<<<< ')) {
      if (common.length) {
        hunks.push({ type: 'common', lines: common });
        common = [];
      }
      const oursLabel = line.slice(8);
      const ours = [];
      const theirs = [];
      const base = [];
      let inOurs = true, inBase = false, inTheirs = false;
      let theirsLabel = '';
      i++;
      while (i < lines.length) {
        const raw = lines[i];
        const l = norm(raw);
        if (l.startsWith('|||||||')) {
          // diff3-style ancestor marker
          inOurs = false; inBase = true; inTheirs = false;
          i++; continue;
        }
        if (l === '=======') {
          inOurs = false; inBase = false; inTheirs = true;
          i++; continue;
        }
        if (l.startsWith('>>>>>>> ')) {
          theirsLabel = l.slice(8);
          i++; break;
        }
        // Push the normalized (CR-stripped) content. We'll reattach the right EOL when writing.
        if (inOurs) ours.push(l);
        else if (inBase) base.push(l);
        else if (inTheirs) theirs.push(l);
        i++;
      }
      hunks.push({
        type: 'conflict',
        oursLabel,
        theirsLabel,
        ours,
        theirs,
        base: base.length ? base : null
      });
    } else {
      // Keep normalized content here too
      common.push(line);
      i++;
    }
  }
  if (common.length) hunks.push({ type: 'common', lines: common });
  return { hunks, eol: usesCRLF ? '\r\n' : '\n' };
}

// ============================================
// SSH KEY GENERATOR
// ============================================
const { generateKeyPairSync } = require('crypto');

// OpenSSH key-encoding helpers live in lib/ssh-keys.js
const { sshString, sshMpint, fromB64Url, ed25519PublicSsh, rsaPublicSsh, ecdsaPublicSsh, fingerprintFromPublicLine, defaultKeyName } = require('./lib/ssh-keys');

// Generate a key pair. Options:
//   { type: 'ed25519'|'rsa'|'ecdsa', bits?: 2048|3072|4096, curve?: 'P-256'|'P-384'|'P-521',
//     comment?: string, passphrase?: string }
// Returns: { type, bits, curve, comment, publicLine, privatePem, fingerprint, suggestedName }
ipcMain.handle('ssh:generateKey', wrap(async (_, opts) => {
  opts = opts || {};
  const type = opts.type || 'ed25519';
  const comment = (opts.comment || '').trim();
  const passphrase = opts.passphrase || '';
  let publicLine, privatePem, bits = null, curve = null, suggestedName;

  const privateExportOpts = { type: 'pkcs8', format: 'pem' };
  if (passphrase) {
    privateExportOpts.cipher = 'aes-256-cbc';
    privateExportOpts.passphrase = passphrase;
  }

  if (type === 'ed25519') {
    const kp = generateKeyPairSync('ed25519');
    publicLine = ed25519PublicSsh(kp.publicKey.export({ format: 'jwk' }), comment);
    privatePem = kp.privateKey.export(privateExportOpts);
    suggestedName = 'id_ed25519';
  } else if (type === 'rsa') {
    bits = opts.bits && [2048, 3072, 4096].includes(opts.bits) ? opts.bits : 3072;
    if (bits < 2048) throw new Error('RSA keys must be at least 2048 bits');
    const kp = generateKeyPairSync('rsa', { modulusLength: bits });
    publicLine = rsaPublicSsh(kp.publicKey.export({ format: 'jwk' }), comment);
    privatePem = kp.privateKey.export(privateExportOpts);
    suggestedName = 'id_rsa';
  } else if (type === 'ecdsa') {
    const curveJsName = {
      'P-256': 'prime256v1',
      'P-384': 'secp384r1',
      'P-521': 'secp521r1'
    };
    curve = opts.curve && curveJsName[opts.curve] ? opts.curve : 'P-256';
    const kp = generateKeyPairSync('ec', { namedCurve: curveJsName[curve] });
    publicLine = ecdsaPublicSsh(kp.publicKey.export({ format: 'jwk' }), comment);
    privatePem = kp.privateKey.export(privateExportOpts);
    suggestedName = 'id_ecdsa';
  } else {
    throw new Error('Unsupported key type: ' + type);
  }

  return {
    type, bits, curve, comment,
    publicLine,
    privatePem: typeof privatePem === 'string' ? privatePem : privatePem.toString('utf8'),
    fingerprint: fingerprintFromPublicLine(publicLine),
    suggestedName
  };
}));

// Save a key file. Shows a save dialog with a sensible default location and filename.
// opts: { content, defaultName, kind: 'private'|'public', startDir? }
// Returns: { saved: true, filePath } or { saved: false, canceled: true }
ipcMain.handle('ssh:saveKey', async (_, opts) => {
  opts = opts || {};
  const startDir = opts.startDir || path.join(os.homedir(), '.ssh');
  // Create ~/.ssh if it doesn't exist (helpful default)
  try { fs.mkdirSync(startDir, { recursive: true, mode: 0o700 }); } catch (e) {}

  const defaultPath = path.join(startDir, opts.defaultName || 'id_key');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: opts.kind === 'public' ? 'Save Public Key' : 'Save Private Key',
    defaultPath,
    properties: ['showOverwriteConfirmation']
  });
  if (result.canceled || !result.filePath) return { ok: true, data: { saved: false, canceled: true } };

  try {
    // Ensure parent exists
    fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
    // Write with restrictive perms for private keys (0o600); 0o644 for public
    fs.writeFileSync(result.filePath, opts.content, { mode: opts.kind === 'private' ? 0o600 : 0o644 });
    // Also explicitly chmod on Unix (writeFileSync ignores mode if file exists)
    if (process.platform !== 'win32') {
      try { fs.chmodSync(result.filePath, opts.kind === 'private' ? 0o600 : 0o644); } catch (e) {}
    }
    return { ok: true, data: { saved: true, filePath: result.filePath } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Get a sensible default identity (~/.ssh) — used by the dialog to pre-fill paths.
ipcMain.handle('ssh:defaultIdentity', () => {
  return {
    ok: true,
    data: {
      sshDir: path.join(os.homedir(), '.ssh'),
      username: os.userInfo().username,
      hostname: os.hostname()
    }
  };
});

// ============================================
// DISK MANAGEMENT
// ============================================

const fsp = require('fs').promises;

// Cancellation + progress state. A single inflight scan is allowed; calling
// repo:diskUsage again cancels the previous one.
let _diskScanToken = 0;
function _isCurrentToken(token) { return token === _diskScanToken; }

// Throttle progress emissions to avoid flooding IPC. We send at most ~20/sec.
function makeProgressEmitter(win, token) {
  let lastEmit = 0;
  return function emit(payload) {
    if (!_isCurrentToken(token)) return;
    const now = Date.now();
    // Always emit terminal events ({done:true}); throttle the rest
    if (!payload.done && now - lastEmit < 50) return;
    lastEmit = now;
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('disk:progress', payload); } catch (e) {}
    }
  };
}

// Async directory size walk. Reports bytes + files-seen as it goes.
// Yields to the event loop every CHUNK entries so other IPC handlers can run.
async function dirSizeAsync(dir, opts) {
  const { token, onProgress, depthBudget = 12, label } = opts || {};
  if (depthBudget < 0) return 0;
  if (!_isCurrentToken(token)) throw new Error('cancelled');

  let total = 0;
  let filesSeen = 0;
  // Use an explicit stack to avoid blowing the call stack on deep trees,
  // and to make yielding/cancellation natural.
  const stack = [{ dir, depth: 0 }];
  const CHUNK_YIELD = 200; // yield every N entries
  let sinceYield = 0;

  while (stack.length) {
    if (!_isCurrentToken(token)) throw new Error('cancelled');
    const { dir: cur, depth } = stack.pop();
    if (depth > depthBudget) continue;
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) {
          stack.push({ dir: full, depth: depth + 1 });
        } else if (e.isFile()) {
          const st = await fsp.stat(full);
          total += st.size;
          filesSeen++;
        }
      } catch (err) { /* skip unreadable */ }
      sinceYield++;
      if (sinceYield >= CHUNK_YIELD) {
        sinceYield = 0;
        if (onProgress) onProgress({ phase: label || 'scanning', bytes: total, files: filesSeen });
        // Yield to the event loop so other IPC calls (incl. cancellation) can run
        await new Promise(r => setImmediate(r));
        if (!_isCurrentToken(token)) throw new Error('cancelled');
      }
    }
  }
  if (onProgress) onProgress({ phase: label || 'scanning', bytes: total, files: filesSeen });
  return { bytes: total, files: filesSeen };
}

// Async file count for a directory.
async function countFilesAsync(dir, opts) {
  const { token, depthBudget = 12 } = opts || {};
  if (depthBudget < 0) return 0;
  if (!_isCurrentToken(token)) throw new Error('cancelled');
  let total = 0;
  const stack = [{ dir, depth: 0 }];
  let sinceYield = 0;
  while (stack.length) {
    if (!_isCurrentToken(token)) throw new Error('cancelled');
    const { dir: cur, depth } = stack.pop();
    if (depth > depthBudget) continue;
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const e of entries) {
      try {
        if (e.isDirectory()) stack.push({ dir: path.join(cur, e.name), depth: depth + 1 });
        else if (e.isFile()) total++;
      } catch (err) {}
      sinceYield++;
      if (sinceYield >= 500) {
        sinceYield = 0;
        await new Promise(r => setImmediate(r));
      }
    }
  }
  return total;
}

ipcMain.handle('repo:diskUsageCancel', wrap(async () => {
  // Bumping the token invalidates any in-flight scan
  _diskScanToken++;
  return true;
}));

ipcMain.handle('repo:diskUsage', wrap(async () => {
  const g = ensureGit();
  if (!currentRepoPath) throw new Error('No repository');

  // Claim a new token (cancels any previous scan)
  const myToken = ++_diskScanToken;
  const win = mainWindow;
  const emit = makeProgressEmitter(win, myToken);

  const gitDir = path.join(currentRepoPath, '.git');

  const subdirs = {
    objects: path.join(gitDir, 'objects'),
    objectsPack: path.join(gitDir, 'objects', 'pack'),
    lfs: path.join(gitDir, 'lfs'),
    logs: path.join(gitDir, 'logs'),
    refs: path.join(gitDir, 'refs'),
    hooks: path.join(gitDir, 'hooks'),
    index: path.join(gitDir, 'index'),
    config: path.join(gitDir, 'config')
  };

  const sizes = {
    workingTree: 0, gitTotal: 0, objectsTotal: 0, objectsPacked: 0, objectsLoose: 0,
    lfs: 0, logs: 0, refs: 0, hooks: 0, indexFile: 0, configFile: 0
  };

  // Helper: existsAsync without throwing
  async function exists(p) {
    try { await fsp.access(p); return true; } catch (e) { return false; }
  }

  try {
    // ----- PHASE 1: Working tree -----
    emit({ phase: 'working-tree', label: 'Scanning working tree', bytes: 0, files: 0 });
    try {
      const rootEntries = await fsp.readdir(currentRepoPath, { withFileTypes: true });
      let wtTotal = 0;
      let wtFiles = 0;
      for (const e of rootEntries) {
        if (!_isCurrentToken(myToken)) throw new Error('cancelled');
        if (e.name === '.git') continue;
        const full = path.join(currentRepoPath, e.name);
        if (e.isDirectory()) {
          const sub = await dirSizeAsync(full, {
            token: myToken,
            label: 'working-tree',
            onProgress: (p) => emit({ phase: 'working-tree', label: 'Scanning working tree', bytes: wtTotal + p.bytes, files: wtFiles + p.files })
          });
          wtTotal += sub.bytes;
          wtFiles += sub.files;
        } else if (e.isFile()) {
          try { const st = await fsp.stat(full); wtTotal += st.size; wtFiles++; } catch (er) {}
        }
      }
      sizes.workingTree = wtTotal;
      emit({ phase: 'working-tree', label: 'Working tree done', bytes: wtTotal, files: wtFiles });
    } catch (e) {
      if (e && e.message === 'cancelled') throw e;
    }

    // ----- PHASE 2: .git breakdown -----
    // We walk .git/objects/pack and .git/objects (total) separately so we can
    // derive loose = total - packed without a separate walk.
    if (await exists(gitDir)) {
      // Pack
      if (await exists(subdirs.objectsPack)) {
        emit({ phase: 'objects-pack', label: 'Scanning packed objects', bytes: 0, files: 0 });
        const r = await dirSizeAsync(subdirs.objectsPack, {
          token: myToken, label: 'objects-pack',
          onProgress: (p) => emit({ phase: 'objects-pack', label: 'Scanning packed objects', bytes: p.bytes, files: p.files })
        });
        sizes.objectsPacked = r.bytes;
      }
      // All objects (includes pack + loose). Loose = total - packed.
      if (await exists(subdirs.objects)) {
        emit({ phase: 'objects-total', label: 'Scanning loose objects', bytes: sizes.objectsPacked, files: 0 });
        const r = await dirSizeAsync(subdirs.objects, {
          token: myToken, label: 'objects-total',
          onProgress: (p) => emit({ phase: 'objects-total', label: 'Scanning loose objects', bytes: p.bytes, files: p.files })
        });
        sizes.objectsTotal = r.bytes;
        sizes.objectsLoose = Math.max(0, sizes.objectsTotal - sizes.objectsPacked);
      }
      if (await exists(subdirs.logs)) {
        emit({ phase: 'logs', label: 'Scanning reflog', bytes: 0, files: 0 });
        const r = await dirSizeAsync(subdirs.logs, { token: myToken, label: 'logs', onProgress: (p) => emit({ phase: 'logs', label: 'Scanning reflog', bytes: p.bytes, files: p.files }) });
        sizes.logs = r.bytes;
      }
      if (await exists(subdirs.refs)) {
        const r = await dirSizeAsync(subdirs.refs, { token: myToken, label: 'refs' });
        sizes.refs = r.bytes;
      }
      if (await exists(subdirs.hooks)) {
        const r = await dirSizeAsync(subdirs.hooks, { token: myToken, label: 'hooks' });
        sizes.hooks = r.bytes;
      }
      try { sizes.indexFile = (await fsp.stat(subdirs.index)).size; } catch (e) {}
      try { sizes.configFile = (await fsp.stat(subdirs.config)).size; } catch (e) {}

      // gitTotal — walk the whole .git directory once
      emit({ phase: 'git-total', label: 'Scanning .git directory', bytes: 0, files: 0 });
      const gt = await dirSizeAsync(gitDir, {
        token: myToken, label: 'git-total',
        onProgress: (p) => emit({ phase: 'git-total', label: 'Scanning .git directory', bytes: p.bytes, files: p.files })
      });
      sizes.gitTotal = gt.bytes;
    }

    // ----- PHASE 3: git counts (cheap) -----
    emit({ phase: 'git-counts', label: 'Reading git metadata', bytes: 0, files: 0 });
    let countStats = {};
    try {
      const out = await g.raw(['count-objects', '-v']);
      out.split('\n').forEach(line => {
        const m = line.match(/^([\w-]+):\s*(\d+)/);
        if (m) countStats[m[1]] = parseInt(m[2], 10);
      });
    } catch (e) {}

    const counts = { localBranches: 0, remoteBranches: 0, tags: 0, stashes: 0, reflogEntries: 0 };
    try { const b = await g.branchLocal(); counts.localBranches = (b.all || []).length; } catch (e) {}
    try { const r = await g.branch(['-r']); counts.remoteBranches = (r.all || []).length; } catch (e) {}
    try { const t = await g.raw(['tag', '--list']); counts.tags = t.split('\n').filter(Boolean).length; } catch (e) {}
    try { const s = await g.raw(['stash', 'list']); counts.stashes = s.split('\n').filter(Boolean).length; } catch (e) {}
    try { const rl = await g.raw(['reflog']); counts.reflogEntries = rl.split('\n').filter(Boolean).length; } catch (e) {}

    // ----- PHASE 4: LFS -----
    let lfsInstalled = false;
    let lfsObjectCount = 0;
    let lfsObjectSize = 0;
    let lfsTracked = [];
    if (await exists(subdirs.lfs)) {
      lfsInstalled = true;
      const lfsObjectsDir = path.join(subdirs.lfs, 'objects');
      if (await exists(lfsObjectsDir)) {
        emit({ phase: 'lfs', label: 'Scanning LFS cache', bytes: 0, files: 0 });
        const r = await dirSizeAsync(lfsObjectsDir, {
          token: myToken, label: 'lfs',
          onProgress: (p) => emit({ phase: 'lfs', label: 'Scanning LFS cache', bytes: p.bytes, files: p.files })
        });
        lfsObjectCount = await countFilesAsync(lfsObjectsDir, { token: myToken });
        lfsObjectSize = r.bytes;
        sizes.lfs = lfsObjectSize;
      }
    }
    const gitattrPath = path.join(currentRepoPath, '.gitattributes');
    if (await exists(gitattrPath)) {
      try {
        const content = await fsp.readFile(gitattrPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.includes('filter=lfs')) {
            const pattern = line.split(/\s+/)[0];
            if (pattern) lfsTracked.push(pattern);
          }
        }
        if (lfsTracked.length) lfsInstalled = true;
      } catch (e) {}
    }

    emit({ phase: 'done', label: 'Complete', bytes: sizes.workingTree + sizes.gitTotal, files: 0, done: true });

    return {
      sizes, countStats, counts,
      lfs: { installed: lfsInstalled, objectCount: lfsObjectCount, objectSize: lfsObjectSize, tracked: lfsTracked }
    };
  } catch (err) {
    if (err && err.message === 'cancelled') {
      emit({ phase: 'cancelled', label: 'Cancelled', done: true, cancelled: true });
      // Return a cancelled marker so renderer can show the partial info
      return { cancelled: true };
    }
    throw err;
  }
}));

// List merged branches (safe to delete because their tip commits are in current branch's history)
ipcMain.handle('repo:mergedBranches', wrap(async () => {
  const g = ensureGit();
  let current = '';
  try {
    const b = await g.branchLocal();
    current = b.current || '';
  } catch (e) {}
  let out = '';
  try { out = await g.raw(['branch', '--merged']); } catch (e) {}
  const branches = out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const isCurrent = l.startsWith('*');
    const name = l.replace(/^[\*\s]+/, '').trim();
    return { name, isCurrent };
  }).filter(b => !b.isCurrent && b.name && b.name !== current);

  // Also list branches NOT merged (in case the user wants to review)
  let unmergedOut = '';
  try { unmergedOut = await g.raw(['branch', '--no-merged']); } catch (e) {}
  const unmerged = unmergedOut.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const name = l.replace(/^[\*\s]+/, '').trim();
    return { name };
  }).filter(b => b.name && b.name !== current);

  return { current, merged: branches, unmerged };
}));

// Find largest objects in the repo (commits, trees, blobs)
ipcMain.handle('repo:largestObjects', wrap(async (_, limit) => {
  const g = ensureGit();
  const cap = (limit && limit > 0 && limit < 1000) ? limit : 20;

  let raw;
  try {
    // git rev-list --objects --all gives "<hash> [<path>]"
    // git cat-file --batch-check gives "<hash> <type> <size>"
    // Combine them so we know the path for each object.
    raw = await g.raw([
      'rev-list', '--objects', '--all'
    ]);
  } catch (e) {
    return { objects: [] };
  }

  // Parse: <hash> [<path>]
  const items = raw.split('\n').filter(Boolean).map(line => {
    const sp = line.indexOf(' ');
    if (sp === -1) return { hash: line, path: '' };
    return { hash: line.slice(0, sp), path: line.slice(sp + 1) };
  });

  // Batch-check sizes
  const { spawn } = require('child_process');
  return await new Promise((resolve, reject) => {
    const proc = spawn('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
      cwd: currentRepoPath
    });
    let outBuf = '';
    let errBuf = '';
    proc.stdout.on('data', d => { outBuf += d.toString('utf8'); });
    proc.stderr.on('data', d => { errBuf += d.toString('utf8'); });
    proc.on('error', err => reject(err));
    proc.on('close', () => {
      const byHash = new Map();
      outBuf.split('\n').filter(Boolean).forEach(line => {
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          const [h, t, s] = parts;
          byHash.set(h, { type: t, size: parseInt(s, 10) || 0 });
        }
      });
      const enriched = items.map(it => {
        const info = byHash.get(it.hash);
        return info ? { ...it, type: info.type, size: info.size } : null;
      }).filter(Boolean);
      enriched.sort((a, b) => b.size - a.size);
      resolve({ objects: enriched.slice(0, cap) });
    });
    // Write all hashes then close stdin
    for (const it of items) proc.stdin.write(it.hash + '\n');
    proc.stdin.end();
  });
}));

ipcMain.handle('repo:gc', wrap(async (_, opts) => {
  const g = ensureGit();
  const args = ['gc'];
  if (opts && opts.aggressive) args.push('--aggressive');
  if (opts && opts.auto) args.push('--auto');
  if (opts && opts.prune) args.push('--prune=' + (opts.pruneSpec || 'now'));
  return await g.raw(args);
}));

ipcMain.handle('repo:prune', wrap(async () => {
  const g = ensureGit();
  return await g.raw(['prune']);
}));

ipcMain.handle('repo:repack', wrap(async () => {
  const g = ensureGit();
  return await g.raw(['repack', '-A', '-d']);
}));

ipcMain.handle('repo:reflogExpire', wrap(async (_, opts) => {
  const g = ensureGit();
  const expire = (opts && opts.expire) || 'now';
  const expireUnreachable = (opts && opts.expireUnreachable) || 'now';
  await g.raw(['reflog', 'expire', `--expire=${expire}`, `--expire-unreachable=${expireUnreachable}`, '--all']);
  return true;
}));

ipcMain.handle('repo:lfsPrune', wrap(async () => {
  const g = ensureGit();
  return await g.raw(['lfs', 'prune']);
}));

ipcMain.handle('repo:lfsStatus', wrap(async () => {
  const g = ensureGit();
  try { return await g.raw(['lfs', 'status']); }
  catch (e) { return 'Git LFS is not installed or not initialized in this repository.'; }
}));

// Is git-lfs available on this machine, and is it initialized in this repo?
ipcMain.handle('repo:lfsInfo', wrap(async () => {
  const g = ensureGit();
  const info = { available: false, version: '', initialized: false, patterns: [], trackedFiles: 0 };
  // Check git-lfs availability via version
  try {
    const v = await g.raw(['lfs', 'version']);
    info.available = true;
    info.version = (v || '').trim();
  } catch (e) {
    return info; // git-lfs not installed
  }
  // Initialized? Check for the pre-push hook or lfs filter in config
  try {
    const cfg = await g.raw(['config', '--get', 'filter.lfs.clean']);
    info.initialized = !!(cfg && cfg.trim());
  } catch (e) { info.initialized = false; }
  // Tracked patterns (parse `git lfs track`)
  try {
    const out = await g.raw(['lfs', 'track']);
    // Output looks like: "Listing tracked patterns\n    *.psd (.gitattributes)\n ..."
    info.patterns = out.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.toLowerCase().startsWith('listing') && !l.toLowerCase().startsWith('git lfs'))
      .map(l => {
        // strip the "(.gitattributes)" suffix
        const m = l.match(/^(.+?)\s*\(/);
        return m ? m[1].trim() : l;
      })
      .filter(Boolean);
  } catch (e) {}
  // Count tracked files
  try {
    const files = await g.raw(['lfs', 'ls-files']);
    info.trackedFiles = files.split('\n').filter(Boolean).length;
  } catch (e) {}
  return info;
}));

// Initialize git-lfs in the current repo (installs hooks + filters)
ipcMain.handle('repo:lfsInstall', wrap(async () => {
  const g = ensureGit();
  // --local installs into this repo only; safer than touching global config
  return await g.raw(['lfs', 'install', '--local']);
}));

// Track a pattern (e.g. "*.psd", "assets/**"). Writes to .gitattributes.
ipcMain.handle('repo:lfsTrack', wrap(async (_, pattern) => {
  const g = ensureGit();
  if (!pattern || !pattern.trim()) throw new Error('Pattern required');
  return await g.raw(['lfs', 'track', pattern.trim()]);
}));

// Stop tracking a pattern
ipcMain.handle('repo:lfsUntrack', wrap(async (_, pattern) => {
  const g = ensureGit();
  if (!pattern || !pattern.trim()) throw new Error('Pattern required');
  return await g.raw(['lfs', 'untrack', pattern.trim()]);
}));

// List LFS-managed files: [{ oid, size, path }]
ipcMain.handle('repo:lfsFiles', wrap(async () => {
  const g = ensureGit();
  let out = '';
  try { out = await g.raw(['lfs', 'ls-files', '--long', '--size']); }
  catch (e) {
    // Fall back to basic ls-files
    try { out = await g.raw(['lfs', 'ls-files']); } catch (e2) { return { files: [] }; }
  }
  // Basic format: "<oid short> <*|-> <path>"
  // With --size:  "<oid> <*|-> <path> (<size>)"
  const files = out.split('\n').filter(Boolean).map(line => {
    const m = line.match(/^(\S+)\s+([*-])\s+(.+?)(?:\s+\(([^)]+)\))?$/);
    if (!m) return { oid: '', path: line, size: '', downloaded: false };
    return { oid: m[1], downloaded: m[2] === '*', path: m[3], size: m[4] || '' };
  });
  return { files };
}));

// LFS pull (download all LFS objects for current checkout)
ipcMain.handle('repo:lfsPull', wrap(async (_, remote) => {
  ensureGit();
  const pg = makeProgressGit(currentRepoPath);
  const args = ['lfs', 'pull'];
  if (remote) args.push(remote);
  try { return await pg.raw(args); }
  finally { emitOpProgress({ active: false, done: true }); }
}));

// LFS fetch (download objects without checking out)
ipcMain.handle('repo:lfsFetch', wrap(async (_, opts) => {
  ensureGit();
  const pg = makeProgressGit(currentRepoPath);
  const args = ['lfs', 'fetch'];
  if (opts && opts.all) args.push('--all');
  if (opts && opts.remote) args.push(opts.remote);
  try { return await pg.raw(args); }
  finally { emitOpProgress({ active: false, done: true }); }
}));

// LFS push (upload objects to remote)
ipcMain.handle('repo:lfsPush', wrap(async (_, opts) => {
  ensureGit();
  const pg = makeProgressGit(currentRepoPath);
  const remote = (opts && opts.remote) || 'origin';
  const args = ['lfs', 'push', remote];
  if (opts && opts.all) args.push('--all');
  else if (opts && opts.branch) args.push(opts.branch);
  try { return await pg.raw(args); }
  finally { emitOpProgress({ active: false, done: true }); }
}));

// LFS checkout (populate working copy from local LFS cache)
ipcMain.handle('repo:lfsCheckout', wrap(async () => {
  const g = ensureGit();
  return await g.raw(['lfs', 'checkout']);
}));

// LFS migrate: import existing files matching patterns into LFS (rewrites history).
// opts: { patterns: ['*.bin'], everything: bool, includeRefAll: bool }
ipcMain.handle('repo:lfsMigrateImport', wrap(async (_, opts) => {
  const g = ensureGit();
  const args = ['lfs', 'migrate', 'import'];
  if (opts && opts.everything) {
    args.push('--everything');
  }
  if (opts && Array.isArray(opts.patterns)) {
    for (const p of opts.patterns) {
      if (p && p.trim()) args.push('--include=' + p.trim());
    }
  }
  return await g.raw(args);
}));

ipcMain.handle('repo:deleteBranches', wrap(async (_, opts) => {
  const g = ensureGit();
  const branches = (opts && opts.branches) || [];
  const force = !!(opts && opts.force);
  if (!branches.length) return { deleted: [], failed: [] };
  const deleted = [];
  const failed = [];
  for (const b of branches) {
    try {
      await g.branch([force ? '-D' : '-d', b]);
      deleted.push(b);
    } catch (err) {
      failed.push({ branch: b, error: err.message || String(err) });
    }
  }
  return { deleted, failed };
}));

// ============================================
// SETTINGS — app-level preferences
// ============================================
// Default app settings — only used when settings file doesn't override.
const DEFAULT_APP_SETTINGS = {
  theme: 'crusader',                  // crusader|molecular|biohazard|sweet|monastery|racing
  defaultBranchName: 'main',          // default branch when initializing a new repo
  graphLimit: 300,                    // default commits to load in graph
  graphHideLocal: false,              // hide local-branch ref pills in the graph
  graphStripRemotePrefix: false,      // show remote branches without their "<remote>/" prefix
  graphHideLocalCommits: false,       // hide commits not reachable from any remote (unpushed)
  autoFetchOnFocus: true,             // auto-refresh on window focus
  watchFileSystem: true,              // watch the working tree and refresh when it changes
  diffSyntax: true,                   // syntax-highlight diff content
  autoFetchMinutes: 10,               // background fetch interval in minutes (0 = off)
  confirmDestructive: true,           // extra confirm on discard/force-push/etc.
  defaultSshKeyPath: '',              // pre-fill path for clone SSH key picker
  fontScale: 1.0,                     // UI font scale multiplier
  monoFont: 'default',                // monospace font family (Nerd Font name or 'default')
  uiFont: 'default',                  // interface font family (Nerd Font name or 'default')
  llmAssistant: false,                // local AI git assistant — OFF by default; needs Ollama + a pulled model
  llmModel: 'llama3.2:3b',            // Ollama chat model used by the assistant
  llmEmbedModel: 'nomic-embed-text',  // Ollama embedding model used to index the repo for retrieval
  llmRetrieval: true,                 // feed retrieved diffs/content into answers (needs a built index)
  llmIndexMaxCommits: 300,            // how many recent commits to index for retrieval
};

function getAppSettings() {
  const all = loadSettings();
  // Mix defaults with stored preferences (only the keys we care about)
  const out = { ...DEFAULT_APP_SETTINGS };
  if (all.preferences) {
    for (const k of Object.keys(DEFAULT_APP_SETTINGS)) {
      if (all.preferences[k] !== undefined) out[k] = all.preferences[k];
    }
  }
  return out;
}

function saveAppSettings(prefs) {
  const all = loadSettings();
  all.preferences = { ...(all.preferences || {}), ...prefs };
  saveSettings(all);
}

ipcMain.handle('settings:getApp', wrap(async () => {
  return getAppSettings();
}));

ipcMain.handle('settings:setApp', wrap(async (_, prefs) => {
  if (!prefs || typeof prefs !== 'object') throw new Error('Invalid preferences');
  saveAppSettings(prefs);
  // Apply watcher / auto-fetch preference changes immediately, so toggling them in
  // Settings takes effect without reopening the repository.
  if (currentRepoPath) {
    if ('watchFileSystem' in prefs) {
      try { prefs.watchFileSystem === false ? stopRepoWatcher() : startRepoWatcher(currentRepoPath); } catch (e) {}
    }
    if ('autoFetchMinutes' in prefs) {
      try { restartAutoFetch(); } catch (e) {}
    }
  }
  return getAppSettings();
}));

ipcMain.handle('settings:resetApp', wrap(async () => {
  const all = loadSettings();
  delete all.preferences;
  saveSettings(all);
  return DEFAULT_APP_SETTINGS;
}));

// Path to the settings file (so user can see where it lives)
ipcMain.handle('settings:appSettingsPath', wrap(async () => {
  return settingsPath;
}));

// ============================================
// SETTINGS — git config (read & write)
// ============================================

// Read git config entries. Scope: 'global' | 'local' | 'all'
// Returns: { global: {...}, local: {...}, effective: {...} }
ipcMain.handle('settings:getGitConfig', wrap(async () => {
  const result = { global: {}, local: {}, effective: {} };

  async function readScope(scope) {
    const out = {};
    try {
      // We do this without ensureGit() so it works even when no repo is open
      // (for global config).
      const { execFile } = require('child_process');
      const text = await new Promise((resolve, reject) => {
        const args = ['config', `--${scope}`, '--list'];
        const opts = currentRepoPath && scope === 'local' ? { cwd: currentRepoPath } : {};
        execFile('git', args, opts, (err, stdout) => {
          // Missing config files yield exit code 1 — treat as empty, not error
          if (err && err.code !== 1) return reject(err);
          resolve(stdout || '');
        });
      });
      text.split('\n').filter(Boolean).forEach(line => {
        const eq = line.indexOf('=');
        if (eq < 0) return;
        out[line.slice(0, eq)] = line.slice(eq + 1);
      });
    } catch (e) {
      // Ignore — likely scope unavailable (e.g. local with no repo)
    }
    return out;
  }

  result.global = await readScope('global');
  if (currentRepoPath) {
    result.local = await readScope('local');
  }
  // Effective: local overrides global
  result.effective = { ...result.global, ...result.local };

  return result;
}));

// Set a single git config value.
// scope: 'global' | 'local'
// key: e.g. 'user.email'
// value: string; if empty/undefined, unsets the key in that scope.
ipcMain.handle('settings:setGitConfig', wrap(async (_, { scope, key, value }) => {
  if (!scope || (scope !== 'global' && scope !== 'local')) throw new Error('scope must be "global" or "local"');
  if (!key || typeof key !== 'string') throw new Error('key required');
  if (scope === 'local' && !currentRepoPath) throw new Error('No repository is open — cannot set local config');

  const { execFile } = require('child_process');
  const cwd = (scope === 'local' && currentRepoPath) ? currentRepoPath : undefined;

  // Empty value = unset
  const args = (value === undefined || value === null || value === '')
    ? ['config', `--${scope}`, '--unset', key]
    : ['config', `--${scope}`, key, String(value)];

  await new Promise((resolve, reject) => {
    execFile('git', args, cwd ? { cwd } : {}, (err) => {
      // Git's --unset returns 5 when the key doesn't exist — treat that as success
      if (err && err.code !== 5) return reject(err);
      resolve();
    });
  });
  return { scope, key, value: value || null };
}));

// Set multiple git config entries at once. Useful for the Settings dialog Save button.
// updates: [{ scope, key, value }]
ipcMain.handle('settings:setGitConfigBatch', wrap(async (_, updates) => {
  if (!Array.isArray(updates)) throw new Error('updates must be an array');
  const { execFile } = require('child_process');
  const results = [];
  for (const u of updates) {
    if (!u || (u.scope !== 'global' && u.scope !== 'local')) {
      results.push({ ok: false, error: 'Invalid scope', key: u && u.key });
      continue;
    }
    if (u.scope === 'local' && !currentRepoPath) {
      results.push({ ok: false, error: 'No repo open', key: u.key });
      continue;
    }
    const cwd = (u.scope === 'local' && currentRepoPath) ? currentRepoPath : undefined;
    const args = (u.value === undefined || u.value === null || u.value === '')
      ? ['config', `--${u.scope}`, '--unset', u.key]
      : ['config', `--${u.scope}`, u.key, String(u.value)];
    try {
      await new Promise((resolve, reject) => {
        execFile('git', args, cwd ? { cwd } : {}, (err) => {
          if (err && err.code !== 5) return reject(err);
          resolve();
        });
      });
      results.push({ ok: true, scope: u.scope, key: u.key });
    } catch (err) {
      results.push({ ok: false, scope: u.scope, key: u.key, error: err.message || String(err) });
    }
  }
  return results;
}));

// ============================================
// LOCAL AI ASSISTANT (Ollama) — optional, OFF by default
// ============================================
// This talks ONLY to a local Ollama server on 127.0.0.1:11434. Inference is fully
// offline. The single time anything touches the network is the one-time model
// download ("pull"), which is gated behind an explicit opt-in + confirmation in the
// UI. The model never executes anything — it only ever returns text that we render
// as a chat answer. The whole feature is inert unless the user turns it on.

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const LLM_DEFAULT_MODEL = 'llama3.2:3b';
const LLM_MAX_CONTEXT_CHARS = 14000;   // keep prompts bounded so small models stay responsive

// Tracks the in-flight streaming request so llm:cancel can abort it.
let llmActiveReq = null;
let llmCanceled = false;   // set by llm:cancel so an aborted stream isn't reported as an error

function emitLlmProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('llm:progress', payload); } catch (e) {}
  }
}
function emitLlmToken(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('llm:token', payload); } catch (e) {}
  }
}

// One-shot JSON request to the local Ollama HTTP API (no external deps).
function ollamaRequest(method, pathName, body, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: pathName, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('Ollama request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Streaming POST to Ollama. Ollama replies with newline-delimited JSON objects;
// onChunk is called once per parsed object. `register` receives the request so the
// caller can keep a handle for cancellation.
function ollamaStream(pathName, body, onChunk, { register, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: pathName, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, (res) => {
      let buf = '';
      const consume = (final) => {
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) { try { onChunk(JSON.parse(line)); } catch (e) {} }
        }
        if (final && buf.trim()) { try { onChunk(JSON.parse(buf.trim())); } catch (e) {} buf = ''; }
      };
      res.on('data', (c) => { buf += c.toString(); consume(false); });
      res.on('end', () => { consume(true); resolve(); });
    });
    req.on('error', reject);
    if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('Ollama request timed out')));
    if (register) register(req);
    req.write(payload);
    req.end();
  });
}

// Gather a readable snapshot of the repository for the model to reason over.
// Deliberately read-only: branch/status, remotes, and recent history. When `compact`
// is set (retrieval is supplying the heavy content), we keep this short — just orientation
// plus recent subjects — so the prompt budget goes to the retrieved diffs.
async function gatherGitContext(g, limit, compact) {
  const parts = [];
  try {
    const status = await g.status();
    parts.push(`Current branch: ${status.current || '(unknown)'}`);
    if (status.tracking) {
      parts.push(`Upstream: ${status.tracking} (ahead ${status.ahead || 0}, behind ${status.behind || 0})`);
    }
    const changed = [...new Set([
      ...(status.staged || []), ...(status.modified || []),
      ...(status.not_added || []), ...(status.deleted || []), ...(status.created || [])
    ])];
    if (changed.length) {
      parts.push(`Uncommitted/working-tree changes in: ${changed.slice(0, 50).join(', ')}`);
    } else {
      parts.push('Working tree is clean.');
    }
  } catch (e) { /* empty repo or no HEAD */ }

  try {
    const remotes = await g.getRemotes(true);
    if (remotes && remotes.length) {
      parts.push('Remotes: ' + remotes.map(r => `${r.name} → ${r.refs && r.refs.fetch}`).join('; '));
    }
  } catch (e) {}

  try {
    if (compact) {
      // Just the recent commit subjects, for orientation.
      const log = await g.raw(['log', '-n', String(Math.min(limit, 25)), '--date=short',
        '--pretty=format:%h %ad %an: %s']);
      if (log && log.trim()) parts.push('Recent commits (newest first):\n' + log.trim());
    } else {
      // Full recent history with author/date/subject/body and a per-commit diffstat.
      const log = await g.raw(['log', '-n', String(limit), '--date=short', '--stat',
        '--pretty=format:%n=== commit %h ===%nAuthor: %an <%ae>%nDate: %ad%nSubject: %s%n%b']);
      if (log && log.trim()) parts.push('Recent commit history (newest first):\n' + log.trim());
    }
  } catch (e) {}

  let ctx = parts.join('\n\n');
  const cap = compact ? 4000 : LLM_MAX_CONTEXT_CHARS;
  if (ctx.length > cap) ctx = ctx.slice(0, cap) + '\n…(context truncated)…';
  return ctx;
}

function buildLlmPrompt(meta, retrieved, fileCtx, question) {
  const lines = [
    'You are a helpful assistant embedded in a Git desktop app called GitGood.',
    'Answer the user\'s question about this repository using ONLY the context provided below.',
    'When you reference a commit, include its short hash. Cite authors, files, and dates where relevant.',
    'File contents below are shown with leading line numbers; use them for exact line counts and quoting.',
    'If the answer is not present in the provided context, say so plainly instead of guessing.',
    'Be concise. Never invent commits, files, authors, or dates.',
    '',
    '=== REPOSITORY OVERVIEW ===',
    meta || '(no history available)',
    '=== END OVERVIEW ==='
  ];
  if (fileCtx && fileCtx.trim()) {
    lines.push(
      '',
      '=== FILE CONTENTS (current working tree) ===',
      fileCtx,
      '=== END FILE CONTENTS ==='
    );
  }
  if (retrieved && retrieved.trim()) {
    lines.push(
      '',
      '=== RELEVANT CHANGES (retrieved from indexed commit diffs) ===',
      retrieved,
      '=== END RELEVANT CHANGES ==='
    );
  }
  lines.push('', 'Question: ' + question, 'Answer:');
  return lines.join('\n');
}

// Deterministically gather actual file contents/line counts for the question. Embeddings
// cannot count lines or reproduce exact text — only a real read can — so when the user
// names a file, or asks about line counts/sizes/contents, we read the working tree directly.
async function gatherFileContext(g, repoPath, question) {
  let tracked = [];
  try { tracked = (await g.raw(['ls-files'])).split('\n').map(s => s.trim()).filter(Boolean); }
  catch (e) { return null; }
  if (!tracked.length) return null;

  const qLower = question.toLowerCase();
  const wantsStats = /\b(how many|number of|count|line|lines|loc|length|size|content|contents|what'?s in|show me|list)\b/.test(qLower);

  const readFile = (f) => {
    try {
      const abs = path.join(repoPath, f);
      if (fs.existsSync(abs)) return fs.readFileSync(abs, 'utf8');
    } catch (e) {}
    return null;
  };
  const isBinary = (s) => s.indexOf('\u0000') >= 0;

  // Files explicitly named in the question (full path, or basename with an extension).
  const named = [];
  for (const f of tracked) {
    const base = f.split('/').pop();
    const hasExt = base.includes('.');
    if (qLower.includes(f.toLowerCase()) || (hasExt && base.length >= 4 && qLower.includes(base.toLowerCase()))) {
      named.push(f);
    }
  }

  const blocks = [];
  const MAX_LINES = 500, MAX_CHARS = 16000;

  // Inject line-numbered content + exact total line count for up to 3 named files.
  for (const f of named.slice(0, 3)) {
    const content = readFile(f);
    if (content == null) continue;
    if (isBinary(content)) { blocks.push(`File: ${f} — binary, not shown.`); continue; }
    const allLines = content.split('\n');
    let body = allLines.slice(0, MAX_LINES).map((l, i) => `${i + 1}\t${l}`).join('\n');
    if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + '\n…(truncated)…';
    blocks.push(`File: ${f}\nTotal lines: ${allLines.length}\n--- content${allLines.length > MAX_LINES ? ` (first ${MAX_LINES} lines)` : ''} ---\n${body}`);
  }

  // If the question is about counts/sizes/contents generally, add a file map with per-file
  // line counts and the project total. Deterministic and exact (capped for big repos).
  if (wantsStats && blocks.length < 3) {
    const stats = [];
    let total = 0, counted = 0;
    const LIMIT = 500;
    for (const f of tracked) {
      if (counted >= LIMIT) break;
      const content = readFile(f);
      if (content == null || isBinary(content)) continue;
      const n = content.length ? content.split('\n').length : 0;
      total += n; counted++;
      stats.push(`${n}\t${f}`);
    }
    if (stats.length) {
      const more = tracked.length > counted ? ` (+${tracked.length - counted} more files not counted)` : '';
      blocks.push(`Tracked text files — line count then path:\n${stats.join('\n')}\n\nProject total: ${total} lines across ${counted} files${more}.`);
    }
  }

  if (!blocks.length) return null;
  let ctx = blocks.join('\n\n');
  if (ctx.length > 16000) ctx = ctx.slice(0, 16000) + '\n…(file context truncated)…';
  return ctx;
}

// ---- Retrieval index (local embeddings) ----------------------------------------
// Per-repo vector index stored as JSON in userData. We embed commit diffs (one chunk
// per changed file, large diffs split) plus each commit message with a LOCAL embedding
// model via Ollama, then answer questions by cosine-similarity retrieval. No network,
// no native deps — a plain in-memory scan is plenty for a few thousand chunks.

const LLM_DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const LLM_CHUNK_CHARS = 3000;           // max characters per embedded chunk
const LLM_MAX_CHUNKS_PER_COMMIT = 12;   // guard against giant commits exploding the index

function llmIndexDir() {
  const dir = path.join(app.getPath('userData'), 'llm-index');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}
function llmIndexPathFor(repoPath) {
  const h = require('crypto').createHash('sha1').update(repoPath).digest('hex').slice(0, 16);
  return path.join(llmIndexDir(), h + '.json');
}
function loadLlmIndex(repoPath) {
  try {
    const p = llmIndexPathFor(repoPath);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {}
  return null;
}
function saveLlmIndex(repoPath, index) {
  try { fs.writeFileSync(llmIndexPathFor(repoPath), JSON.stringify(index)); } catch (e) {}
}

// Embed a single string with the local model. /api/embeddings is the broadly-supported
// endpoint and returns { embedding: [...] }.
async function ollamaEmbed(model, text) {
  const res = await ollamaRequest('POST', '/api/embeddings', { model, prompt: text }, { timeout: 60000 });
  if (res.status !== 200) throw new Error('Embedding request failed (HTTP ' + res.status + ')');
  const parsed = JSON.parse(res.body || '{}');
  if (!Array.isArray(parsed.embedding)) throw new Error(parsed.error || 'No embedding returned (is the embed model pulled?)');
  return parsed.embedding;
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Split a `git show` diff into per-file chunks, splitting very large file diffs further.
function splitDiffIntoChunks(diff) {
  if (!diff) return [];
  const out = [];
  const parts = diff.split(/^diff --git /m).map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const firstNl = p.indexOf('\n');
    const head = firstNl >= 0 ? p.slice(0, firstNl) : p;
    const m = head.match(/a\/(.+?) b\//);
    const file = m ? m[1] : head.trim();
    const text = 'diff --git ' + p;
    if (text.length > LLM_CHUNK_CHARS) {
      for (let i = 0; i < text.length; i += LLM_CHUNK_CHARS) {
        out.push({ file, text: text.slice(i, i + LLM_CHUNK_CHARS) });
        if (out.length >= LLM_MAX_CHUNKS_PER_COMMIT) break;
      }
    } else {
      out.push({ file, text });
    }
    if (out.length >= LLM_MAX_CHUNKS_PER_COMMIT) break;
  }
  return out;
}

// Build (or incrementally update) the retrieval index for a repo.
async function buildLlmIndexImpl(g, repoPath, opts) {
  const embedModel = (opts && opts.embedModel) || LLM_DEFAULT_EMBED_MODEL;
  const maxCommits = Math.min(Math.max(parseInt(opts && opts.maxCommits, 10) || 300, 1), 5000);
  let index = (opts && opts.rebuild) ? null : loadLlmIndex(repoPath);
  // If the embedding model changed, dimensions won't match — start fresh.
  if (index && index.embedModel !== embedModel) index = null;
  if (!index) index = { repoPath, embedModel, dim: 0, createdAt: Date.now(), indexedHashes: [], chunks: [] };
  const already = new Set(index.indexedHashes);

  const logRaw = await g.raw(['log', '-n', String(maxCommits), '--date=short',
    '--pretty=format:%H%x1f%an%x1f%ad%x1f%s']);
  const commits = logRaw.split('\n').filter(Boolean).map(line => {
    const [hash, author, date, subject] = line.split('\x1f');
    return { hash, author, date, subject };
  });
  const todo = commits.filter(c => !already.has(c.hash));

  emitLlmProgress({ status: todo.length ? `Indexing ${todo.length} new commit(s)…` : 'Index is up to date', progress: 0, active: true });

  let done = 0;
  for (const c of todo) {
    if (llmCanceled) break;
    const header = `commit ${c.hash.slice(0, 10)} by ${c.author} on ${c.date}\nSubject: ${c.subject}`;
    const toEmbed = [{ file: '(message)', text: header }];
    try {
      const diff = await g.raw(['show', c.hash, '--no-color', '--format=', '--unified=2']);
      for (const fc of splitDiffIntoChunks(diff)) {
        toEmbed.push({ file: fc.file, text: `${header}\nFile: ${fc.file}\n${fc.text}` });
      }
    } catch (e) { /* merge/binary/odd commit — message chunk still indexed */ }

    for (const ch of toEmbed) {
      if (llmCanceled) break;
      try {
        const vector = await ollamaEmbed(embedModel, ch.text.slice(0, LLM_CHUNK_CHARS));
        if (!index.dim) index.dim = vector.length;
        index.chunks.push({
          hash: c.hash, file: ch.file, author: c.author, date: c.date,
          subject: c.subject, text: ch.text.slice(0, LLM_CHUNK_CHARS), vector
        });
      } catch (e) {
        // First failure usually means the embed model isn't pulled — surface it.
        if (!index.dim && index.chunks.length === 0) throw e;
      }
    }
    index.indexedHashes.push(c.hash);
    done++;
    emitLlmProgress({ status: `Indexing ${done}/${todo.length} commits`, progress: Math.round((done / todo.length) * 100), active: true });
  }

  index.updatedAt = Date.now();
  saveLlmIndex(repoPath, index);
  return { chunks: index.chunks.length, commits: index.indexedHashes.length, added: done, canceled: llmCanceled };
}

// Retrieve the most relevant indexed chunks for a question.
async function retrieveContext(repoPath, embedModel, question, topK) {
  const index = loadLlmIndex(repoPath);
  if (!index || !index.chunks || !index.chunks.length) return null;
  const qvec = await ollamaEmbed(embedModel || index.embedModel || LLM_DEFAULT_EMBED_MODEL, question);
  const scored = index.chunks.map(c => ({ c, s: cosineSim(qvec, c.vector) }));
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, Math.max(1, topK || 8)).filter(x => x.s > 0);
  if (!top.length) return null;
  let out = top.map(({ c }) => `--- ${c.file} @ ${c.hash.slice(0, 10)} (${c.author}, ${c.date}) — "${c.subject}" ---\n${c.text}`).join('\n\n');
  if (out.length > 12000) out = out.slice(0, 12000) + '\n…(retrieved context truncated)…';
  return out;
}

// Is Ollama reachable, and is the requested model already pulled?
ipcMain.handle('llm:info', wrap(async (_, model) => {
  const want = model || LLM_DEFAULT_MODEL;
  const info = { available: false, models: [], hasModel: false, model: want };
  try {
    const res = await ollamaRequest('GET', '/api/tags', null, { timeout: 4000 });
    if (res.status !== 200) return info;
    info.available = true;
    const parsed = JSON.parse(res.body || '{}');
    info.models = (parsed.models || []).map(m => m.name);
    const base = want.split(':')[0];
    info.hasModel = info.models.some(n => n === want || n.split(':')[0] === base);
  } catch (e) {
    // Ollama not installed or its server isn't running — leave available=false.
  }
  return info;
}));

// Download (pull) a model. This is the only step that uses the network; it streams
// progress to the renderer via the llm:progress channel.
ipcMain.handle('llm:pull', wrap(async (_, model) => {
  const name = model || LLM_DEFAULT_MODEL;
  let streamErr = null;
  emitLlmProgress({ status: 'starting', progress: 0, active: true });
  try {
    await ollamaStream('/api/pull', { name, stream: true }, (chunk) => {
      if (chunk.error) { streamErr = chunk.error; return; }
      let progress = 0;
      if (chunk.total && chunk.completed) progress = Math.round((chunk.completed / chunk.total) * 100);
      emitLlmProgress({
        status: chunk.status || '', progress,
        total: chunk.total || 0, completed: chunk.completed || 0, active: true
      });
    }, { register: (req) => { llmActiveReq = req; } });
  } finally {
    llmActiveReq = null;
    emitLlmProgress({ active: false, done: true });
  }
  if (streamErr) throw new Error(streamErr);
  return { pulled: name };
}));

// Ask a question about the current repository. Streams the answer back token-by-token
// over llm:token ({ text } per chunk, { done:true } at the end).
ipcMain.handle('llm:ask', wrap(async (_, opts) => {
  const { question, model, historyLimit, useRetrieval, embedModel, topK } = opts || {};
  if (!question || !String(question).trim()) throw new Error('Question is empty.');
  const q = String(question).trim();
  const g = ensureGit();

  // Retrieve relevant diffs/content first (if enabled and an index exists). When we have
  // retrieved content, keep the overview compact so the prompt budget goes to real code.
  let retrieved = null;
  if (useRetrieval) {
    try { retrieved = await retrieveContext(currentRepoPath, embedModel || LLM_DEFAULT_EMBED_MODEL, q, topK || 8); }
    catch (e) { /* no index yet, or embed model missing — fall back to overview only */ }
  }
  // Actual file contents / exact line counts when the question is about files (deterministic).
  let fileCtx = null;
  try { fileCtx = await gatherFileContext(g, currentRepoPath, q); } catch (e) {}

  const meta = await gatherGitContext(g, Math.min(Math.max(parseInt(historyLimit, 10) || 120, 10), 500), !!(retrieved || fileCtx));
  const prompt = buildLlmPrompt(meta, retrieved, fileCtx, q);

  let answer = '';
  let streamErr = null;
  llmCanceled = false;
  try {
    await ollamaStream('/api/generate', {
      model: model || LLM_DEFAULT_MODEL,
      prompt, stream: true,
      // Ollama defaults num_ctx to ~2048, which silently truncates the context we build.
      // Raise it so the file contents / retrieved diffs actually reach the model, with
      // headroom left for the generated answer.
      options: { temperature: 0.2, num_ctx: 12288 }
    }, (chunk) => {
      if (chunk.error) { streamErr = chunk.error; return; }
      if (chunk.response) { answer += chunk.response; emitLlmToken({ text: chunk.response }); }
    }, { register: (req) => { llmActiveReq = req; } });
  } catch (e) {
    // A user-initiated cancel destroys the socket — that's expected, not an error.
    if (!llmCanceled) throw e;
  } finally {
    llmActiveReq = null;
    emitLlmToken({ done: true });
  }
  if (streamErr) throw new Error(streamErr);
  return { answer, canceled: llmCanceled, usedRetrieval: !!retrieved };
}));

// Abort an in-flight answer, download, or index build.
ipcMain.handle('llm:cancel', wrap(async () => {
  llmCanceled = true;
  if (llmActiveReq) { try { llmActiveReq.destroy(); } catch (e) {} llmActiveReq = null; }
  return { canceled: true };
}));

// Status of the retrieval index for the current repo.
ipcMain.handle('llm:indexStatus', wrap(async () => {
  if (!currentRepoPath) return { exists: false };
  const index = loadLlmIndex(currentRepoPath);
  if (!index) return { exists: false };
  return {
    exists: true,
    chunks: (index.chunks || []).length,
    commits: (index.indexedHashes || []).length,
    embedModel: index.embedModel,
    updatedAt: index.updatedAt || index.createdAt || null
  };
}));

// Build or update the retrieval index. Streams progress over llm:progress.
ipcMain.handle('llm:buildIndex', wrap(async (_, opts) => {
  const g = ensureGit();
  llmCanceled = false;
  try {
    return await buildLlmIndexImpl(g, currentRepoPath, opts || {});
  } finally {
    emitLlmProgress({ active: false, done: true });
  }
}));

// Delete the retrieval index for the current repo.
ipcMain.handle('llm:clearIndex', wrap(async () => {
  if (!currentRepoPath) return { cleared: false };
  try {
    const p = llmIndexPathFor(currentRepoPath);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
  return { cleared: true };
}));

// ============================================
// PARTIAL STAGING — hunk & line level
// ============================================
// The renderer builds a synthetic unified patch containing only the hunks/lines the
// user selected (see buildPartialPatch in 04-diff.js) and sends it here to be applied
// with `git apply`. Three combinations are used:
//   stage hunk    → { cached: true,  reverse: false }  patch built from `git diff`
//   unstage hunk  → { cached: true,  reverse: true  }  patch built from `git diff --cached`
//   discard hunk  → { cached: false, reverse: true  }  patch built from `git diff`
//
// The patch is written to a temp file byte-for-byte (no line-ending translation) because
// `git apply` matches context exactly — a CRLF file's diff carries the CR inside each
// line, and rewriting it would make every hunk fail to apply.
ipcMain.handle('repo:applyPatch', wrap(async (_, { patch, cached, reverse }) => {
  const g = ensureGit();
  if (!patch || !patch.trim()) throw new Error('Empty patch — nothing selected.');
  const tmp = path.join(os.tmpdir(), `gitgood-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.diff`);
  // Git requires the patch to end with a newline.
  const body = patch.endsWith('\n') ? patch : patch + '\n';
  fs.writeFileSync(tmp, body, { encoding: 'utf8' });
  try {
    // --recount lets git derive the hunk line counts from the body instead of trusting
    // our arithmetic. Our counts are computed correctly, but a hand-built patch is
    // exactly what --recount exists for, so it costs nothing and removes a whole class
    // of "corrupt patch at line N" failures.
    const args = ['apply', '--whitespace=nowarn', '--recount', '--unidiff-zero'];
    if (cached) args.push('--cached');
    if (reverse) args.push('-R');
    args.push(tmp);
    await g.raw(args);
    return { applied: true };
  } catch (err) {
    const msg = err.message || String(err);
    if (/patch does not apply|corrupt patch/i.test(msg)) {
      throw new Error(
        'The selection could not be applied — the file changed since this diff was loaded. ' +
        'Refresh and try again.\n\nOriginal error: ' + msg
      );
    }
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
  }
}));

// Make an untracked file diffable so its hunks can be staged individually. `git add -N`
// records the path in the index with an empty blob, which makes `git diff` emit a normal
// "new file" diff for it without actually staging any content.
ipcMain.handle('repo:intentToAdd', wrap(async (_, files) => {
  const g = ensureGit();
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return { added: 0 };
  await g.raw(['add', '-N', '--', ...list]);
  return { added: list.length };
}));

// ============================================
// AMEND
// ============================================
// Details of HEAD, used to prefill the commit box when Amend is toggled on and to warn
// when the commit being rewritten has already been published.
ipcMain.handle('repo:headCommit', wrap(async () => {
  const g = ensureGit();
  let raw;
  try {
    raw = await g.raw(['log', '-1', '--pretty=format:%H%x1f%s%x1f%b']);
  } catch (e) {
    // No commits yet (unborn HEAD) — nothing to amend.
    return { exists: false };
  }
  const [hash, subject, body] = (raw || '').split('\x1f');
  if (!hash) return { exists: false };

  // "Published" = some remote-tracking ref contains this commit. Amending then requires a
  // force-push, so the UI warns first.
  let pushed = false;
  try {
    const contains = await g.raw(['branch', '-r', '--contains', hash.trim()]);
    pushed = !!(contains && contains.trim());
  } catch (e) { /* no remotes / detached — treat as unpublished */ }

  return {
    exists: true,
    hash: hash.trim(),
    subject: subject || '',
    body: (body || '').replace(/\s+$/, ''),
    pushed
  };
}));

// ============================================
// REBASE
// ============================================
// The commits that a rebase onto `onto` would replay, oldest first — the same set and
// order git would put in the interactive todo file.
ipcMain.handle('repo:rebaseTodo', wrap(async (_, { onto }) => {
  const g = ensureGit();
  if (!onto) throw new Error('A target to rebase onto is required');

  const status = await g.status();
  const current = status.current;

  let base = '';
  try { base = (await g.raw(['merge-base', 'HEAD', onto])).trim(); } catch (e) {}
  if (!base) throw new Error(`No common ancestor between HEAD and "${onto}" — these histories are unrelated.`);

  const ontoHash = (await g.revparse([onto])).trim();
  const headHash = (await g.revparse(['HEAD'])).trim();
  if (base === headHash) {
    return { commits: [], base, current, alreadyUpToDate: true, upToDateReason: 'behind' };
  }
  if (base === ontoHash) {
    // HEAD already contains everything on `onto`; a rebase would be a no-op.
    return { commits: [], base, current, alreadyUpToDate: true, upToDateReason: 'ahead' };
  }

  const SEP = '\x1f';
  const raw = await g.raw([
    'log', '--reverse', '--no-merges',
    `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI%x1e`,
    `${base}..HEAD`
  ]);
  const commits = (raw || '').split(/\x1e\r?\n?/).map(s => s.trim()).filter(Boolean).map(line => {
    const [hash, short, subject, author, date] = line.split(SEP);
    return { hash, short, subject, author, date };
  });

  // Merges are excluded from the list above (a default rebase drops them), so tell the
  // UI if any exist between base and HEAD — they will not survive the rebase.
  let mergeCount = 0;
  try {
    const m = await g.raw(['rev-list', '--count', '--merges', `${base}..HEAD`]);
    mergeCount = parseInt((m || '0').trim(), 10) || 0;
  } catch (e) {}

  return { commits, base, current, mergeCount, alreadyUpToDate: false };
}));

// Write the helper used as GIT_SEQUENCE_EDITOR / GIT_EDITOR during an interactive rebase.
// Git invokes the editor as `<editor> <file>` through its own shell; we point it at
// Electron running in plain-Node mode (ELECTRON_RUN_AS_NODE) so we don't depend on a
// `node` or `cp` being on PATH inside a packaged app.
function writeRebaseEditorScript(todoPath, messagesPath) {
  const script = path.join(os.tmpdir(), `gitgood-rebase-editor-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  const lines = [
    "'use strict';",
    '// GitGood interactive-rebase editor shim.',
    '// Git calls this once for the rebase todo list, then once per reword/squash step for',
    '// the commit message. We tell them apart by the filename git hands us.',
    "const fs = require('fs');",
    'const target = process.argv[process.argv.length - 1];',
    'const TODO = ' + JSON.stringify(todoPath) + ';',
    'const MESSAGES = ' + JSON.stringify(messagesPath) + ';',
    '',
    "if (/git-rebase-todo$/.test(target.replace(/\\\\/g, '/'))) {",
    "  fs.writeFileSync(target, fs.readFileSync(TODO, 'utf8'), 'utf8');",
    '  process.exit(0);',
    '}',
    '',
    '// Commit-message editor (COMMIT_EDITMSG). Consume the next queued message, if any;',
    "// otherwise leave git's prepared message untouched.",
    'try {',
    "  const queue = JSON.parse(fs.readFileSync(MESSAGES, 'utf8'));",
    '  if (Array.isArray(queue) && queue.length) {',
    '    const next = queue.shift();',
    "    fs.writeFileSync(MESSAGES, JSON.stringify(queue), 'utf8');",
    "    if (typeof next === 'string') fs.writeFileSync(target, /\\n$/.test(next) ? next : next + '\\n', 'utf8');",
    '  }',
    "} catch (e) { /* fall back to git's own message */ }",
    'process.exit(0);',
    ''
  ];
  fs.writeFileSync(script, lines.join('\n'), 'utf8');
  return script;
}

// Environment variables that simple-git refuses to pass through, because an editor,
// pager, askpass or ssh command taken from the environment is arbitrary code execution.
// A rebase inherits the whole ambient environment (it needs PATH, SystemRoot, HOME…),
// so any of these that merely happen to be set on the user's machine would abort the
// rebase before it started. Strip them: a local rebase needs none of them, and we set
// GIT_TERMINAL_PROMPT=0 so there is nothing for an askpass helper to answer anyway.
const GIT_UNSAFE_ENV_VARS = [
  'GIT_ASKPASS', 'SSH_ASKPASS',
  'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR',
  'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND',
  'GIT_EXTERNAL_DIFF', 'GIT_PAGER',
  'GIT_CONFIG', 'GIT_CONFIG_COUNT'
];

function rebaseSafeEnv() {
  const env = Object.assign({}, process.env);
  for (const key of GIT_UNSAFE_ENV_VARS) delete env[key];
  return env;
}

// Run a rebase. Two modes:
//   plain       → git rebase <onto>
//   interactive → git rebase -i <onto> with a todo list supplied by the UI
// `todo` is [{ hash, subject, action, message? }] in the final (possibly reordered) order.
// Actions: pick | reword | squash | fixup | drop.
ipcMain.handle('repo:rebase', wrap(async (_, opts) => {
  ensureGit();
  const { onto, todo, autostash } = opts || {};
  if (!onto) throw new Error('A target to rebase onto is required');

  const args = ['rebase'];
  if (autostash) args.push('--autostash');

  const env = Object.assign({}, rebaseSafeEnv(), { GIT_TERMINAL_PROMPT: '0' });
  let todoPath = null, messagesPath = null, scriptPath = null;

  if (Array.isArray(todo) && todo.length) {
    const kept = todo.filter(t => t && t.hash && t.action);
    if (!kept.length) throw new Error('The rebase plan is empty.');
    if (kept.every(t => t.action === 'drop')) {
      throw new Error('The plan drops every commit — that would leave nothing to rebase.');
    }
    const firstKept = kept.find(t => t.action !== 'drop');
    if (firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')) {
      throw new Error('The first commit in the plan cannot be a squash or fixup — there is nothing before it to squash into.');
    }

    // Todo file: one "<action> <hash> <subject>" line per commit, oldest first.
    const todoBody = kept
      .map(t => `${t.action} ${t.hash} ${(t.subject || '').replace(/\r?\n/g, ' ')}`)
      .join('\n') + '\n';

    // Message queue: git opens the commit-message editor once per reword, and once per
    // squash group (a fixup never opens one). Walking the todo in order therefore queues
    // the messages in exactly the order the editor shim will be asked for them.
    const messages = [];
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i];
      if (t.action === 'reword') {
        messages.push(typeof t.message === 'string' ? t.message : (t.subject || ''));
      } else if (t.action === 'pick') {
        // Does a squash group start here? Look ahead across the following squash/fixups.
        const group = [];
        for (let j = i + 1; j < kept.length; j++) {
          if (kept[j].action === 'squash' || kept[j].action === 'fixup') group.push(kept[j]);
          else break;
        }
        if (group.some(gg => gg.action === 'squash')) {
          // The UI may attach a combined message to the pick that leads the group;
          // otherwise join the subjects the way git's default squash message would.
          if (typeof t.message === 'string' && t.message.trim()) messages.push(t.message);
          else {
            const parts = [t.subject || ''].concat(
              group.filter(gg => gg.action === 'squash').map(gg => gg.subject || '')
            );
            messages.push(parts.filter(Boolean).join('\n\n'));
          }
        }
      }
    }

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    todoPath = path.join(os.tmpdir(), `gitgood-rebase-todo-${stamp}`);
    messagesPath = path.join(os.tmpdir(), `gitgood-rebase-msgs-${stamp}.json`);
    fs.writeFileSync(todoPath, todoBody, 'utf8');
    fs.writeFileSync(messagesPath, JSON.stringify(messages), 'utf8');
    scriptPath = writeRebaseEditorScript(todoPath, messagesPath);

    // Git runs the editor through a shell, so quote the Electron path (it usually has
    // spaces on Windows).
    const editor = `"${process.execPath}" "${scriptPath}"`;
    env.ELECTRON_RUN_AS_NODE = '1';
    env.GIT_SEQUENCE_EDITOR = editor;
    env.GIT_EDITOR = editor;
    args.push('-i');
  }

  args.push(onto);

  // A dedicated instance so the interactive-rebase env doesn't leak into other commands.
  //
  // simple-git blocks GIT_EDITOR / GIT_SEQUENCE_EDITOR by default, because an editor
  // pulled from untrusted env is arbitrary code execution. That reasoning doesn't apply
  // here: the editor is a script this process just wrote to its own temp dir, invoked
  // through our own Electron binary, with nothing user-supplied in the command. The
  // exemption is scoped to this one instance — the module-level `git` keeps the guard.
  const rg = simpleGit(currentRepoPath, { unsafe: { allowUnsafeEditor: true } }).env(env);
  try {
    const output = await rg.raw(args);
    return { rebased: true, output, conflicted: false };
  } catch (err) {
    const msg = err.message || String(err);
    // A conflict is an expected outcome, not a failure — the conflict resolver takes over.
    const inProgress = fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-merge'))
                    || fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-apply'));
    if (inProgress) return { rebased: false, conflicted: true, output: msg };
    if (/unstaged changes|please commit or stash/i.test(msg)) {
      throw new Error('You have uncommitted changes. Commit or stash them first, or enable "Stash changes automatically".\n\nOriginal error: ' + msg);
    }
    throw err;
  } finally {
    for (const p of [todoPath, messagesPath, scriptPath]) {
      if (p) { try { fs.unlinkSync(p); } catch (e) { /* best effort */ } }
    }
  }
}));

// Skip the current commit in an in-progress rebase or cherry-pick. (Merge and revert have
// no --skip; continue/abort are handled by repo:operationContinue / repo:operationAbort.)
ipcMain.handle('repo:operationSkip', wrap(async () => {
  const g = ensureGit();
  let op = null;
  if (fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-merge'))
   || fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-apply'))) op = 'rebase';
  else if (fs.existsSync(path.join(currentRepoPath, '.git', 'CHERRY_PICK_HEAD'))) op = 'cherry-pick';

  if (!op) throw new Error('Nothing to skip — no rebase or cherry-pick in progress.');
  await g.raw([op, '--skip']);
  return { operation: op, skipped: true };
}));

// ============================================
// BLAME & FILE HISTORY
// ============================================
// `git blame --porcelain` output, parsed into one entry per line. The porcelain format
// emits a full commit header the first time a commit appears and only the hash on
// subsequent lines, so we keep a map of commits seen so far and back-fill from it.
ipcMain.handle('repo:blame', wrap(async (_, { path: filePath, rev }) => {
  const g = ensureGit();
  if (!filePath) throw new Error('A file path is required');

  const args = ['blame', '--porcelain'];
  if (rev) args.push(rev);
  args.push('--', filePath);

  let raw;
  try {
    raw = await g.raw(args);
  } catch (err) {
    const msg = err.message || String(err);
    if (/no such path|does not exist|no such file/i.test(msg)) {
      throw new Error(`"${filePath}" is not tracked at this revision, so it cannot be blamed.`);
    }
    if (/binary/i.test(msg)) throw new Error(`"${filePath}" is a binary file — there are no lines to blame.`);
    throw err;
  }

  const parsed = parseBlamePorcelain(raw, filePath);
  return { file: filePath, rev: rev || 'HEAD', lines: parsed.lines, commitCount: parsed.commitCount };
}));

// Parse `git blame --porcelain` into one entry per line. Split out from the handler so
// it can be exercised directly against recorded git output.
function parseBlamePorcelain(raw, filePath) {
  const commits = {};   // hash -> { author, authorMail, authorTime, summary, ... }
  const lines = [];
  const src = (raw || '').split('\n');
  let i = 0;
  while (i < src.length) {
    // "<sha> <origLine> <finalLine> [<numLinesInGroup>]"
    const m = src[i].match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
    if (!m) { i++; continue; }
    const hash = m[1];
    const origLine = parseInt(m[2], 10);
    const finalLine = parseInt(m[3], 10);
    i++;

    const info = commits[hash] || (commits[hash] = {});
    // Consume the key/value header block up to the TAB-prefixed content line.
    while (i < src.length && !src[i].startsWith('\t')) {
      const line = src[i];
      const sp = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const value = sp === -1 ? '' : line.slice(sp + 1);
      if (key === 'author') info.author = value;
      else if (key === 'author-mail') info.authorMail = value.replace(/^<|>$/g, '');
      else if (key === 'author-time') info.authorTime = parseInt(value, 10);
      else if (key === 'summary') info.summary = value;
      else if (key === 'previous') info.previous = value.split(' ')[0];
      else if (key === 'filename') info.filename = value;
      i++;
    }
    // The content line itself (TAB-prefixed); strip the single leading TAB.
    const content = i < src.length ? src[i].slice(1) : '';
    i++;

    lines.push({
      hash,
      short: hash.slice(0, 7),
      origLine,
      line: finalLine,
      content,
      author: info.author || '',
      authorMail: info.authorMail || '',
      authorTime: info.authorTime || 0,
      summary: info.summary || '',
      filename: info.filename || filePath,
      // An all-zero sha is git's marker for a line that isn't committed yet.
      uncommitted: /^0+$/.test(hash)
    });
  }

  return { lines, commitCount: Object.keys(commits).length };
}

// Commits that touched a single file, newest first. `--follow` traces the file across
// renames (git only supports it for one path, which is all we ever pass).
ipcMain.handle('repo:fileHistory', wrap(async (_, { path: filePath, limit, follow }) => {
  const g = ensureGit();
  if (!filePath) throw new Error('A file path is required');
  const max = Math.max(1, Math.min(1000, limit || 200));

  const SEP = '\x1f';
  const args = [
    'log', `--max-count=${max}`,
    // The record separator goes at the START of the format, not the end: with
    // --name-status git prints the file list *after* the pretty output, so a trailing
    // separator would cut each record between its metadata and its own file list,
    // attaching every commit's status block to the next commit.
    `--pretty=format:%x1e%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ae${SEP}%aI`,
    '--name-status'
  ];
  if (follow !== false) args.push('--follow');
  args.push('--', filePath);

  const raw = await g.raw(args);
  const entries = (raw || '').split(/\x1e\r?\n?/).map(s => s.trim()).filter(Boolean);
  const commits = entries.map(entry => {
    const nl = entry.indexOf('\n');
    const metaLine = nl === -1 ? entry : entry.slice(0, nl);
    const rest = nl === -1 ? '' : entry.slice(nl + 1);
    const [hash, short, subject, author, email, date] = metaLine.split(SEP);
    // The name-status block says how this commit touched the file and, for a rename,
    // what it used to be called — which is how the view can show the path changing.
    let status = 'M', oldPath = null, newPath = null;
    for (const line of rest.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split('\t');
      const code = parts[0];
      if (/^R/.test(code) && parts.length >= 3) { status = 'R'; oldPath = parts[1]; newPath = parts[2]; }
      else if (parts.length >= 2) { status = code[0]; newPath = parts[1]; }
      break;
    }
    return { hash, short, subject, author, email, date, status, oldPath, newPath };
  });

  return { file: filePath, commits };
}));

// The diff one commit made to one file — used by the file-history view so clicking a
// commit shows just that file's change rather than the whole commit.
ipcMain.handle('repo:fileDiffAtCommit', wrap(async (_, { hash, path: filePath, ignoreWhitespace }) => {
  const g = ensureGit();
  if (!hash || !filePath) throw new Error('A commit and a file path are required');
  // `<hash>^!` means "this commit against its first parent", and still works for a root
  // commit (where it degenerates to the full tree).
  return await g.raw(['show', '--format=', '--patch', ...wsArgs({ ignoreWhitespace }), `${hash}^!`, '--', filePath]);
}));

// ============================================
// REFLOG / UNDO
// ============================================
// The reflog is git's record of every value HEAD has held, which makes it the app's undo
// stack: entry N is the state HEAD was left in by operation N, so restoring entry 1 undoes
// the most recent operation. Everything the UI needs to *act* on an entry already exists
// (reset / branch), so these handlers only have to read and classify.

// Turn a reflog subject ("commit (amend): fix typo", "reset: moving to HEAD~1") into a
// coarse operation type plus a human-readable detail. The type drives the icon and colour
// in the panel; the detail is what the user reads.
function classifyReflogSubject(gs) {
  const s = String(gs || '');
  const after = (prefix) => s.slice(prefix.length).trim();

  if (s.startsWith('commit (amend):')) return { type: 'amend', detail: after('commit (amend):') };
  if (s.startsWith('commit (initial):')) return { type: 'commit', detail: after('commit (initial):') };
  if (s.startsWith('commit (merge):')) return { type: 'merge', detail: after('commit (merge):') };
  if (s.startsWith('commit (cherry-pick):')) return { type: 'cherry-pick', detail: after('commit (cherry-pick):') };
  if (s.startsWith('commit:')) return { type: 'commit', detail: after('commit:') };
  if (s.startsWith('reset:')) return { type: 'reset', detail: after('reset:') };
  if (s.startsWith('checkout:')) return { type: 'checkout', detail: after('checkout:') };
  if (s.startsWith('clone:')) return { type: 'clone', detail: after('clone:') };
  if (s.startsWith('pull')) return { type: 'pull', detail: s };
  if (s.startsWith('merge ')) return { type: 'merge', detail: s };
  if (s.startsWith('revert:')) return { type: 'revert', detail: after('revert:') };
  if (s.startsWith('cherry-pick')) return { type: 'cherry-pick', detail: s };
  // Rebase entries come in many shapes: "rebase (start)", "rebase -i (pick)",
  // "rebase (finish): returning to refs/heads/main", "rebase (squash)"…
  if (/^rebase\b/.test(s)) return { type: 'rebase', detail: s };
  if (/^branch:/.test(s)) return { type: 'branch', detail: after('branch:') };
  if (/^Branch:/.test(s)) return { type: 'branch', detail: after('Branch:') };
  if (/^stash|^applying stash|^WIP on/i.test(s)) return { type: 'stash', detail: s };
  return { type: 'other', detail: s || '(unknown)' };
}

// HEAD's reflog, newest first. The ordinal is the array position, which is exactly the N
// in HEAD@{N} because `git log -g` walks the entries in order — we don't try to parse it
// out of %gd, since --date=iso replaces the index with a timestamp there.
ipcMain.handle('repo:reflog', wrap(async (_, opts) => {
  const g = ensureGit();
  const limit = Math.max(1, Math.min(1000, (opts && opts.limit) || 200));

  const SEP = '\x1f';
  let raw = '';
  try {
    raw = await g.raw([
      'log', '-g', '--date=iso',
      `--pretty=format:%H${SEP}%gd${SEP}%gs${SEP}%gn${SEP}%s%x1e`,
      `-n`, String(limit)
    ]);
  } catch (e) {
    // A repo with no commits yet has no reflog at all.
    return { entries: [], current: null, headHash: null };
  }

  const entries = (raw || '').split(/\x1e\r?\n?/).map(s => s.trim()).filter(Boolean).map((line, i) => {
    const [hash, selector, gs, who, subject] = line.split(SEP);
    const { type, detail } = classifyReflogSubject(gs);
    // %gd under --date=iso looks like "HEAD@{2026-07-27 17:56:09 +0300}".
    const m = /@\{(.+)\}$/.exec(selector || '');
    const date = m ? m[1] : '';
    return {
      ordinal: i,
      selector: `HEAD@{${i}}`,
      hash,
      short: (hash || '').slice(0, 7),
      date,
      raw: gs || '',
      type,
      detail,
      who: who || '',
      subject: subject || ''
    };
  });

  const status = await g.status();
  let headHash = null;
  try { headHash = (await g.revparse(['HEAD'])).trim(); } catch (e) {}

  return {
    entries,
    current: status.current || null,
    detached: !!status.detached,
    headHash,
    dirty: (status.files || []).length > 0
  };
}));

// Move the current branch to a commit from the reflog. This is a reset, so it is the one
// genuinely destructive action in the panel — hence the optional backup branch, stamped at
// the current HEAD before anything moves, using the same naming scheme as squash so both
// features leave recognisable escape hatches.
ipcMain.handle('repo:reflogRestore', wrap(async (_, { hash, mode, backup }) => {
  const g = ensureGit();
  if (!hash) throw new Error('A commit to restore to is required');
  const resetMode = ['hard', 'mixed', 'soft'].includes(mode) ? mode : 'hard';

  // Refuse mid-operation: resetting during a rebase or merge leaves a mess that is much
  // harder to explain than the error.
  const inProgress =
    fs.existsSync(path.join(currentRepoPath, 'MERGE_HEAD')) ||
    fs.existsSync(path.join(currentRepoPath, '.git', 'MERGE_HEAD')) ||
    fs.existsSync(path.join(currentRepoPath, '.git', 'CHERRY_PICK_HEAD')) ||
    fs.existsSync(path.join(currentRepoPath, '.git', 'REVERT_HEAD')) ||
    fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-merge')) ||
    fs.existsSync(path.join(currentRepoPath, '.git', 'rebase-apply'));
  if (inProgress) {
    throw new Error('An operation (merge, rebase, cherry-pick or revert) is in progress. Finish or abort it before restoring from the reflog.');
  }

  const status = await g.status();
  let backupRef = null;
  if (backup) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const safeBranch = (status.current || 'detached').replace(/[^A-Za-z0-9._-]/g, '-');
    backupRef = `gitgood-backup/${safeBranch}/${stamp}`;
    await g.raw(['branch', backupRef, 'HEAD']);
  }

  await g.raw(['reset', `--${resetMode}`, hash]);
  let newHead = null;
  try { newHead = (await g.revparse(['HEAD'])).trim(); } catch (e) {}
  return { restored: true, mode: resetMode, backupRef, newHead };
}));

// ============================================
// WORKING-TREE WATCHER
// ============================================
// Until now the app only refreshed when the window regained focus, so edits made by a
// build, a script, or another terminal stayed invisible until you alt-tabbed. That got
// more costly with partial staging, where people sit inside the diff pane for minutes and
// a stale diff makes `git apply` reject their hunks.
//
// One recursive fs.watch covers the working tree. Most of the work here is deciding what
// to IGNORE: .git/objects churns on every operation, .git/logs churns on every ref update,
// and node_modules can be enormous — watching those produces a storm of useless events.

let _watcher = null;
let _watcherRepo = null;
let _watchDebounce = null;
let _watchPending = { worktree: false, gitDir: false };
let _watcherDisabled = false;   // set after an unrecoverable watch error (e.g. inotify limits)

// Directory names never worth watching. `.git` is handled separately — some paths inside
// it matter a great deal (HEAD, refs, index) and others are pure noise.
const WATCH_IGNORE_DIRS = new Set([
  'node_modules', '.gitgood-tmp', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.turbo', '.cache', '.gradle', '.idea', '.vs', '__pycache__',
  // Unity-shaped repos live under this project's parent folder; these are generated and
  // change constantly during an editor session.
  'Library', 'Temp', 'Obj', 'Logs'
]);

// Inside .git, only these tell us something the UI cares about: which branch we're on,
// where refs point, what's staged, and whether an operation is mid-flight.
function gitDirPathMatters(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p === '.git' || p === '.git/') return false;
  if (/^\.git\/(objects|logs|lfs|modules|hooks|info|filter-repo)\//.test(p)) return false;
  if (/^\.git\/(COMMIT_EDITMSG|index\.lock|\S*\.lock)$/.test(p)) return false;
  return /^\.git\/(HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index|packed-refs)$/.test(p)
      || /^\.git\/refs\//.test(p)
      || /^\.git\/(rebase-merge|rebase-apply)(\/|$)/.test(p);
}

function shouldIgnoreWatchPath(rel) {
  if (!rel) return true;
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('.git/') || p === '.git') return !gitDirPathMatters(p);
  // Any ignored directory anywhere in the path.
  for (const seg of p.split('/')) {
    if (WATCH_IGNORE_DIRS.has(seg)) return true;
  }
  // Editor scratch files that appear and vanish.
  if (/(^|\/)(\.#|~\$)/.test(p)) return true;
  if (/\.(swp|swx|tmp|temp|partial)$/i.test(p)) return true;
  if (/(^|\/)4913$/.test(p)) return true;   // vim's atomic-write probe file
  return false;
}

function emitFsChanged(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repo:fsChanged', payload);
  }
}

function stopRepoWatcher() {
  if (_watcher) {
    try { _watcher.close(); } catch (e) { /* already gone */ }
  }
  _watcher = null;
  _watcherRepo = null;
  clearTimeout(_watchDebounce);
  _watchDebounce = null;
  _watchPending = { worktree: false, gitDir: false };
}

function startRepoWatcher(repoPath) {
  stopRepoWatcher();
  if (_watcherDisabled || !repoPath) return;
  const prefs = getAppSettings();
  if (prefs.watchFileSystem === false) return;

  try {
    // recursive:true is supported on Windows and macOS, and on Linux from Node 20 (which
    // is what Electron 31 ships). If the platform refuses, we fall back below.
    _watcher = fs.watch(repoPath, { recursive: true, persistent: false }, (eventType, filename) => {
      if (!filename) return;
      const rel = String(filename).replace(/\\/g, '/');
      if (shouldIgnoreWatchPath(rel)) return;
      if (rel.startsWith('.git/')) _watchPending.gitDir = true;
      else _watchPending.worktree = true;
      scheduleWatchFlush();
    });
  } catch (err) {
    // Common causes: inotify watch limit on Linux, or recursive watching unavailable.
    // Fall back to watching just the repo root and .git (non-recursive) so branch
    // switches and top-level edits are still noticed, and never retry the recursive form.
    try {
      _watcher = fs.watch(repoPath, { persistent: false }, (eventType, filename) => {
        const rel = String(filename || '').replace(/\\/g, '/');
        if (shouldIgnoreWatchPath(rel)) return;
        _watchPending.worktree = true;
        scheduleWatchFlush();
      });
    } catch (err2) {
      _watcherDisabled = true;
      emitFsChanged({ unavailable: true, error: err2.message || String(err2) });
      return;
    }
  }

  if (_watcher) {
    _watcher.on('error', (err) => {
      // A watcher that has errored is not coming back; stop rather than leak events.
      _watcherDisabled = true;
      stopRepoWatcher();
      emitFsChanged({ unavailable: true, error: err.message || String(err) });
    });
  }
  _watcherRepo = repoPath;
}

// Coalesce a burst of events into one notification. Builds and checkouts touch hundreds of
// files; the renderer only needs to know that *something* changed.
function scheduleWatchFlush() {
  if (_watchDebounce) return;
  _watchDebounce = setTimeout(() => {
    _watchDebounce = null;
    const payload = { worktree: _watchPending.worktree, gitDir: _watchPending.gitDir };
    _watchPending = { worktree: false, gitDir: false };
    if (payload.worktree || payload.gitDir) emitFsChanged(payload);
  }, 500);
}

// ============================================
// PERIODIC AUTO-FETCH
// ============================================
// A quiet background `git fetch` so the ahead/behind counts mean something without the
// user having to remember to fetch. Deliberately silent: no progress bar, no toast on
// success, and it gives up for the session after repeated failures rather than retrying a
// broken remote (or a credential prompt) every few minutes.
let _autoFetchTimer = null;
let _autoFetchFailures = 0;
let _autoFetchSuspended = false;
const AUTO_FETCH_MAX_FAILURES = 2;

function stopAutoFetch() {
  if (_autoFetchTimer) clearInterval(_autoFetchTimer);
  _autoFetchTimer = null;
}

function restartAutoFetch() {
  stopAutoFetch();
  _autoFetchSuspended = false;
  _autoFetchFailures = 0;
  const prefs = getAppSettings();
  const minutes = Number(prefs.autoFetchMinutes);
  if (!minutes || minutes <= 0) return;
  const ms = Math.max(1, Math.min(180, minutes)) * 60 * 1000;
  _autoFetchTimer = setInterval(runAutoFetch, ms);
}

async function runAutoFetch() {
  if (_autoFetchSuspended || !git || !currentRepoPath) return;

  // Never fetch in the middle of an operation — the user is mid-conflict and a fetch
  // moving remote refs underneath them is at best confusing.
  const gitDir = path.join(currentRepoPath, '.git');
  const midOperation = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
    .some(f => fs.existsSync(path.join(gitDir, f)));
  if (midOperation) return;

  try {
    const remotes = await git.getRemotes(false);
    if (!remotes || !remotes.length) return;   // nothing to fetch from
  } catch (e) { return; }

  try {
    // A plain instance with prompting disabled: no progress events, so the status-bar
    // widget stays quiet for a fetch the user didn't ask for.
    const qg = simpleGit(currentRepoPath).env(
      Object.assign({}, rebaseSafeEnv(), { GIT_TERMINAL_PROMPT: '0' })
    );
    await qg.raw(['fetch', '--all', '--prune', '--tags']);
    _autoFetchFailures = 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('repo:autoFetched', { at: Date.now() });
    }
  } catch (err) {
    _autoFetchFailures++;
    if (_autoFetchFailures >= AUTO_FETCH_MAX_FAILURES) {
      _autoFetchSuspended = true;
      stopAutoFetch();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('repo:autoFetched', {
          suspended: true,
          error: err.message || String(err)
        });
      }
    }
  }
}

// Repo lifecycle hooks. repo:open / repo:init / repo:clone all end up switching
// currentRepoPath, so the renderer calls this once the repo is actually open.
ipcMain.handle('repo:startWatching', wrap(async () => {
  if (!currentRepoPath) return { watching: false };
  startRepoWatcher(currentRepoPath);
  restartAutoFetch();
  const prefs = getAppSettings();
  return {
    watching: !!_watcher,
    watcherDisabled: _watcherDisabled,
    autoFetchMinutes: Number(prefs.autoFetchMinutes) || 0
  };
}));

ipcMain.handle('repo:stopWatching', wrap(async () => {
  stopRepoWatcher();
  stopAutoFetch();
  return { stopped: true };
}));

// ============================================
// FILE BLOBS (image diff)
// ============================================
// Binary files previously showed only "Binary files ... differ". For images that's a
// wasted opportunity, so the renderer asks for both sides as data URIs and shows them.
// `rev` null/'WORKTREE' means the file on disk; anything else is resolved as <rev>:<path>.
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml',
  avif: 'image/avif'
};

// Cap what we're willing to inline. A data URI is ~33% larger than the bytes, and this
// crosses the IPC boundary as a string, so a huge asset would stall the renderer.
const MAX_BLOB_BYTES = 12 * 1024 * 1024;

ipcMain.handle('repo:fileBlob', wrap(async (_, { rev, path: filePath }) => {
  const g = ensureGit();
  if (!filePath) throw new Error('A file path is required');
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const mime = IMAGE_MIME[ext] || 'application/octet-stream';

  let buf = null;
  if (!rev || rev === 'WORKTREE') {
    const abs = path.join(currentRepoPath, filePath);
    if (!fs.existsSync(abs)) return { exists: false };
    const stat = fs.statSync(abs);
    if (stat.size > MAX_BLOB_BYTES) return { exists: true, tooLarge: true, bytes: stat.size, mime };
    buf = fs.readFileSync(abs);
  } else {
    // `git show <rev>:<path>` writes raw bytes; simple-git hands back a string, so go
    // through a binary-safe spawn instead of letting it decode as UTF-8 and corrupt them.
    try {
      buf = await gitShowBinary(rev, filePath);
    } catch (e) {
      return { exists: false };   // the file didn't exist at that revision
    }
    if (!buf) return { exists: false };
    if (buf.length > MAX_BLOB_BYTES) return { exists: true, tooLarge: true, bytes: buf.length, mime };
  }

  return {
    exists: true,
    mime,
    bytes: buf.length,
    dataUri: `data:${mime};base64,${buf.toString('base64')}`
  };
}));

// ============================================
// SUBMODULES
// ============================================
// A submodule is a "gitlink": a mode-160000 index entry holding one commit hash. Left to
// itself the app treated it as an ordinary modified file, which produces a diff of two raw
// 40-character SHAs and no way to see what actually moved. Worse, line-level discard on a
// gitlink reported success while changing nothing — `git apply -R` cannot check out a
// commit inside a submodule, but it exits 0 anyway.

function gitmodulesFile() {
  return path.join(currentRepoPath, '.gitmodules');
}

// The configured submodule paths. Gated on .gitmodules existing so a repo without
// submodules pays nothing but one stat() call.
async function submodulePathList() {
  if (!currentRepoPath || !fs.existsSync(gitmodulesFile())) return [];
  const g = ensureGit();
  try {
    // --get-regexp exits 1 when nothing matches, which simple-git turns into a throw.
    const raw = await g.raw(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
    return String(raw || '').split('\n').filter(Boolean).map(line => {
      const sp = line.indexOf(' ');
      return { key: line.slice(0, sp), path: line.slice(sp + 1).trim() };
    }).filter(e => e.path);
  } catch (e) {
    return [];
  }
}

// "<prefix><sha1> <path> (<describe>)" — prefix is '-' uninitialised, '+' checked out at a
// different commit than the index records, 'U' merge conflicts, ' ' in sync.
function parseSubmoduleStatus(raw) {
  const out = {};
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([-+U ])([0-9a-f]{7,40})\s+(.+?)(?:\s+\((.*)\))?$/);
    if (!m) continue;
    out[m[3]] = { state: m[1], hash: m[2], describe: m[4] || null };
  }
  return out;
}

const SUBMODULE_STATE_LABEL = {
  '-': 'uninitialized', '+': 'pointer-moved', 'U': 'conflicted', ' ': 'in-sync'
};

ipcMain.handle('repo:submodules', wrap(async () => {
  const g = ensureGit();
  const configured = await submodulePathList();
  if (!configured.length) return [];

  const statusMap = parseSubmoduleStatus(await g.raw(['submodule', 'status']));

  // Whether each submodule has uncommitted work inside it, from the outer repo in one call.
  // porcelain=v2 carries a dedicated submodule field "S<c><m><u>": commit changed, modified
  // content, untracked content. That distinguishes "the pointer moved" from "there are
  // uncommitted files in there", which the v1 format conflates into a single " M" entry.
  const insideDirty = new Set();
  try {
    const raw = await g.raw(['status', '--porcelain=v2']);
    for (const line of String(raw || '').split('\n')) {
      if (!line.startsWith('1 ')) continue;        // ordinary change; submodules aren't renames
      const parts = line.split(' ');
      const sub = parts[2] || '';
      if (sub[0] !== 'S') continue;                // not a submodule
      const subPath = parts.slice(8).join(' ').replace(/^"|"$/g, '');
      if (sub[2] === 'M' || sub[3] === 'U') insideDirty.add(subPath);
    }
  } catch (e) { /* dirtiness is a nicety; the rest of the entry still stands */ }

  return Promise.all(configured.map(async ({ key, path: subPath }) => {
    const name = key.replace(/^submodule\./, '').replace(/\.path$/, '');
    let url = null, branch = null;
    try { url = (await g.raw(['config', '-f', '.gitmodules', `submodule.${name}.url`])).trim(); } catch (e) {}
    try { branch = (await g.raw(['config', '-f', '.gitmodules', `submodule.${name}.branch`])).trim(); } catch (e) {}
    const st = statusMap[subPath] || { state: '-', hash: null, describe: null };
    return {
      name, path: subPath, url, branch,
      state: SUBMODULE_STATE_LABEL[st.state] || 'unknown',
      initialized: st.state !== '-' && fs.existsSync(path.join(currentRepoPath, subPath, '.git')),
      hash: st.hash,
      describe: st.describe,
      contentDirty: insideDirty.has(subPath)
    };
  }));
}));

// Everything needed to render one submodule's change as something a human can read: which
// way the pointer moved, and the commits it moved across.
ipcMain.handle('repo:submoduleSummary', wrap(async (_, opts) => {
  const g = ensureGit();
  const subPath = opts && opts.path;
  if (!subPath) throw new Error('A submodule path is required');
  const abs = path.join(currentRepoPath, subPath);
  const sub = (args) => makeGit(abs).raw(args);

  const initialized = fs.existsSync(path.join(abs, '.git'));

  // Three versions of the pointer: what HEAD committed, what the index has staged, and
  // what the checked-out submodule is actually on.
  const readGitlink = async (rev) => {
    try {
      const out = await g.raw(['ls-tree', rev, '--', subPath]);
      const m = String(out || '').match(/^160000 commit ([0-9a-f]{40})/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  };
  const headHash = await readGitlink('HEAD');
  let indexHash = null;
  try {
    const out = await g.raw(['ls-files', '-s', '--', subPath]);
    const m = String(out || '').match(/^160000 ([0-9a-f]{40})/);
    indexHash = m ? m[1] : null;
  } catch (e) {}
  let workHash = null;
  if (initialized) {
    try { workHash = (await sub(['rev-parse', 'HEAD'])).trim(); } catch (e) {}
  }

  // Commits between two pointers, read from inside the submodule. Either end can be
  // missing locally (the submodule was never fetched that far), which is not an error —
  // it just means we can describe the move without listing it.
  const commitsBetween = async (from, to) => {
    if (!initialized || !from || !to || from === to) return { commits: [], truncated: false, unavailable: false };
    const F = '\x1f';
    try {
      const raw = await sub(['log', '--no-merges', '-n', '51',
        `--pretty=format:%H${F}%h${F}%s${F}%an${F}%aI`, `${from}..${to}`]);
      const lines = String(raw || '').split('\n').filter(Boolean);
      const truncated = lines.length > 50;
      return {
        commits: lines.slice(0, 50).map(l => {
          const [hash, short, subject, author, date] = l.split(F);
          return { hash, short, subject, author, date };
        }),
        truncated,
        unavailable: false
      };
    } catch (e) {
      return { commits: [], truncated: false, unavailable: true };
    }
  };

  // How far apart the two pointers are, in each direction.
  //
  // Deliberately NOT `merge-base --is-ancestor`: that command answers entirely through its
  // exit code, and simple-git RESOLVES rather than rejects when git exits non-zero without
  // writing to stderr — so the answer is lost and every comparison looks true. (Same trap
  // as `rev-parse --verify --quiet` earlier in this file.) rev-list --count puts the answer
  // on stdout, where it can actually be read.
  const countBetween = async (a, b) => {
    if (!initialized || !a || !b) return null;
    try {
      const out = await sub(['rev-list', '--count', `${a}..${b}`]);
      const n = parseInt(String(out || '').trim(), 10);
      return Number.isNaN(n) ? null : n;
    } catch (e) {
      return null;      // one of the commits isn't in this clone
    }
  };

  const from = indexHash || headHash;
  const to = workHash;
  let direction = 'unchanged';
  let ahead = null, behind = null;
  if (from && to && from !== to) {
    ahead = await countBetween(from, to);    // commits this move brings in
    behind = await countBetween(to, from);   // commits this move drops
    if (ahead === null || behind === null) direction = 'unknown';
    else if (ahead > 0 && behind === 0) direction = 'ahead';
    else if (behind > 0 && ahead === 0) direction = 'behind';
    else if (ahead > 0 && behind > 0) direction = 'diverged';
  }

  const log = direction === 'behind'
    ? await commitsBetween(to, from)      // list what would be lost, newest first
    : await commitsBetween(from, to);

  // Uncommitted work inside the submodule is invisible from the outer repo's diff.
  let dirtyFiles = [];
  if (initialized) {
    try {
      const raw = await sub(['status', '--porcelain']);
      dirtyFiles = String(raw || '').split('\n').filter(Boolean).slice(0, 100)
        .map(l => ({ code: l.slice(0, 2).trim(), path: l.slice(3).trim() }));
    } catch (e) {}
  }

  return {
    path: subPath, initialized, headHash, indexHash, workHash,
    direction, ahead, behind,
    commits: log.commits, truncated: log.truncated, commitsUnavailable: log.unavailable,
    dirtyFiles,
    staged: !!(headHash && indexHash && headHash !== indexHash)
  };
}));

ipcMain.handle('repo:submoduleUpdate', wrap(async (_, opts) => {
  ensureGit();
  const pg = makeProgressGit(currentRepoPath);
  const args = ['submodule', 'update'];
  if (!opts || opts.init !== false) args.push('--init');
  if (opts && opts.recursive) args.push('--recursive');
  // --remote moves the pointer to the branch tip instead of restoring the recorded commit;
  // they are opposite intentions, so the caller has to ask for it explicitly.
  if (opts && opts.remote) args.push('--remote');
  if (opts && opts.path) args.push('--', opts.path);
  try {
    return await pg.raw(args);
  } finally {
    emitOpProgress({ active: false, done: true });
  }
}));

// ============================================
// TAGS — PUBLISHING
// ============================================
// Creating and deleting tags was always local-only: a tag forged here never reached the
// remote, and deleting one left it on the server for everyone else. Publishing a tag is a
// separate refspec push, and `git push --follow-tags` deliberately carries only ANNOTATED
// tags reachable from the pushed commits — so lightweight tags still need an explicit
// push. Both paths exist below for that reason.
//
// Every push here goes through --porcelain. Plain `git push` writes its summary to
// STDERR, which simple-git's raw() discards, so we could not tell "pushed" from "already
// there". --porcelain puts a machine-readable line per ref on STDOUT with a leading flag.

// Prefer "origin", else the first remote. Mirrors what the renderer's push flow picks, so
// a tag lands on the same remote the branch did.
async function defaultRemoteName(explicit) {
  if (explicit) return explicit;
  const g = ensureGit();
  const remotes = await g.getRemotes(false);
  if (!remotes.length) throw new Error('No remote is configured for this repository.');
  return (remotes.find(r => r.name === 'origin') || remotes[0]).name;
}

// One line per ref: "<flag>\t<from>:<to>\t<summary>". The flag is the interesting part:
//   ' ' fast-forward   '+' forced   '-' deleted   '*' new   '=' up to date   '!' rejected
const PUSH_FLAG_MEANING = {
  ' ': 'pushed', '+': 'force-pushed', '-': 'deleted', '*': 'new', '=': 'up-to-date', '!': 'rejected'
};

function parsePushPorcelain(stdout) {
  const refs = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line || /^To /.test(line) || /^Done$/.test(line)) continue;
    const flag = line[0];
    if (!(flag in PUSH_FLAG_MEANING)) continue;
    const parts = line.slice(1).split('\t');
    refs.push({
      flag,
      result: PUSH_FLAG_MEANING[flag],
      refspec: (parts[0] || '').trim(),
      summary: (parts[1] || '').trim()
    });
  }
  return refs;
}

// List local tags, newest first. objecttype tells annotated ("tag") from lightweight
// ("commit"); for an annotated tag `objectname` is the tag object, so the commit it points
// at comes from the dereferenced `*objectname`.
ipcMain.handle('repo:tags', wrap(async () => {
  const g = ensureGit();
  const F = '\x1f';
  const raw = await g.raw(['for-each-ref', '--sort=-creatordate',
    `--format=%(refname:short)${F}%(objecttype)${F}%(objectname)${F}%(*objectname)${F}%(creatordate:iso8601-strict)${F}%(contents:subject)`,
    'refs/tags']);
  return String(raw || '').split('\n').filter(Boolean).map(line => {
    const [name, objectType, objectName, derefName, date, subject] = line.split(F);
    return {
      name,
      annotated: objectType === 'tag',
      hash: derefName || objectName,     // the commit, either way
      tagObject: objectType === 'tag' ? objectName : null,
      date: date || null,
      subject: subject || ''
    };
  });
}));

// Which tags the remote already has. This is a network call (there is no local record of
// remote tags — fetched tags land in the same refs/tags namespace as your own), so the
// renderer asks for it explicitly rather than on every refresh.
ipcMain.handle('repo:remoteTags', wrap(async (_, remote) => {
  const g = ensureGit();
  const name = await defaultRemoteName(remote);
  // --refs drops the "^{}" peeled duplicates annotated tags would otherwise add.
  const raw = await g.raw(['ls-remote', '--tags', '--refs', name]);
  const tags = String(raw || '').split('\n').filter(Boolean).map(line => {
    const [hash, ref] = line.split('\t');
    return { name: (ref || '').replace(/^refs\/tags\//, ''), hash: (hash || '').trim() };
  }).filter(t => t.name);
  return { remote: name, tags };
}));

ipcMain.handle('repo:pushTag', wrap(async (_, opts) => {
  ensureGit();
  const tag = opts && opts.tag;
  if (!tag) throw new Error('A tag name is required');
  const remote = await defaultRemoteName(opts && opts.remote);
  const pg = makeProgressGit(currentRepoPath);
  const args = ['push', '--porcelain'];
  if (opts && opts.force) args.push('--force');
  args.push(remote, `refs/tags/${tag}`);
  try {
    const out = await pg.raw(args);
    const refs = parsePushPorcelain(out);
    const ref = refs[0] || null;
    return { remote, tag, result: ref ? ref.result : 'pushed', summary: ref ? ref.summary : '', refs };
  } catch (e) {
    // The remote already has this name pointing somewhere else. Say so plainly — the
    // renderer offers a force push from here, which is the only thing that can fix it.
    const msg = String(e && e.message || e);
    if (/already exists|cannot lock ref|stale info|non-fast-forward|rejected/i.test(msg)) {
      const conflict = new Error(
        `The remote "${remote}" already has a tag named "${tag}" pointing at a different commit.`);
      conflict.tagConflict = true;
      throw conflict;
    }
    throw e;
  } finally {
    emitOpProgress({ active: false, done: true });
  }
}));

ipcMain.handle('repo:deleteRemoteTag', wrap(async (_, opts) => {
  const g = ensureGit();
  const tag = opts && opts.tag;
  if (!tag) throw new Error('A tag name is required');
  const remote = await defaultRemoteName(opts && opts.remote);

  // Check the remote actually has it first. Deleting a ref that isn't there only makes git
  // print "warning: deleting a non-existent ref" and exit 0, reporting "[deleted]" in the
  // porcelain output — so without this we would tell the user we deleted something that
  // was never there. Worth one extra round trip on a deliberate, destructive action.
  const existing = await g.raw(['ls-remote', '--tags', '--refs', remote, `refs/tags/${tag}`]);
  if (!String(existing || '').trim()) {
    const gone = new Error(`The remote "${remote}" has no tag named "${tag}".`);
    gone.tagMissing = true;
    throw gone;
  }

  const pg = makeProgressGit(currentRepoPath);
  try {
    const out = await pg.raw(['push', '--porcelain', remote, '--delete', `refs/tags/${tag}`]);
    const refs = parsePushPorcelain(out);
    return { remote, tag, result: refs[0] ? refs[0].result : 'deleted', refs };
  } finally {
    emitOpProgress({ active: false, done: true });
  }
}));

// Read a blob at a revision as raw bytes. simple-git decodes stdout as text, which
// mangles binary content, so this spawns git directly and collects Buffers.
function gitShowBinary(rev, filePath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('git', ['show', `${rev}:${filePath}`], {
      cwd: currentRepoPath,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
    });
    const chunks = [];
    let err = '';
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `git show exited ${code}`));
      resolve(Buffer.concat(chunks));
    });
  });
}
