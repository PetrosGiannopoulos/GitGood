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

  return { ...status, detached, headHash, ahead, behind, upstreamMissing };
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
ipcMain.handle('repo:searchDiffContent', wrap(async (_, opts) => {
  const query = ((opts && opts.query) || '').trim();
  if (!query) return [];
  const g = ensureGit();
  const limit = (opts && opts.limit) || 2000;
  // `-S<string>` glued into one arg; passed as an array element, so no shell parsing and
  // a leading '-' in the query can't be mistaken for a separate flag.
  const raw = await g.raw([
    'log', '--all', `--max-count=${limit}`,
    '--format=%H',
    '-S' + query
  ]);
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

ipcMain.handle('repo:diff', wrap(async (_, filePath) => {
  const g = ensureGit();
  if (!filePath) return await g.diff();
  // Try staged first; if empty, get unstaged
  const staged = await g.diff(['--cached', '--', filePath]);
  if (staged && staged.trim()) return staged;
  return await g.diff(['--', filePath]);
}));

ipcMain.handle('repo:diffUnstaged', wrap(async (_, filePath) => {
  const g = ensureGit();
  return await g.diff(['--', filePath]);
}));

ipcMain.handle('repo:diffStaged', wrap(async (_, filePath) => {
  const g = ensureGit();
  return await g.diff(['--cached', '--', filePath]);
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

ipcMain.handle('repo:discard', wrap(async (_, files) => {
  const g = ensureGit();
  const fileList = Array.isArray(files) ? files : [files];

  // Get current status to split tracked from untracked files
  const status = await g.status();
  const untrackedSet = new Set(status.not_added || []);
  const tracked = fileList.filter(f => !untrackedSet.has(f));
  const untracked = fileList.filter(f => untrackedSet.has(f));

  // For tracked files: restore from HEAD (or use checkout for older git)
  if (tracked.length) {
    await g.checkout(['--', ...tracked]);
  }
  // For untracked files: physically delete them from disk
  if (untracked.length) {
    for (const f of untracked) {
      const fullPath = path.join(currentRepoPath, f);
      try {
        const st = fs.statSync(fullPath);
        if (st.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
        else fs.unlinkSync(fullPath);
      } catch (e) {
        // If file is already gone, fine; otherwise report
        if (e.code !== 'ENOENT') throw e;
      }
    }
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

ipcMain.handle('repo:commit', wrap(async (_, { message, description }) => {
  const g = ensureGit();
  if (!message || !message.trim()) throw new Error('Commit message required');
  const fullMsg = description && description.trim() ? `${message}\n\n${description}` : message;
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
    diff = await g.show([hash]);
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
ipcMain.handle('repo:showCommitFileDiff', wrap(async (_, { hash, path: filePath, maxBytes }) => {
  const g = ensureGit();
  if (!hash || !filePath) throw new Error('hash and path required');
  const cap = maxBytes || 1024 * 1024;
  let diff = '';
  let truncated = false;
  try {
    diff = await g.show([hash, '--', filePath]);
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
  autoFetchOnFocus: true,             // auto-refresh on window focus
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
