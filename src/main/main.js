const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
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
  return { ...status, detached, headHash };
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

ipcMain.handle('repo:push', wrap(async (_, opts) => {
  ensureGit();
  const pg = makeProgressGit(currentRepoPath);
  const args = [];
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
    if (/CONFLICT|Automatic merge failed|conflict/i.test(msg)) {
      // Identify conflicted files
      const status = await g.status();
      const conflicted = status.conflicted || [];
      const e = new Error(`Merge conflict — ${conflicted.length} file(s) need resolution:\n${conflicted.join('\n')}\n\nResolve the conflicts, stage the files, then commit. Or run "git merge --abort" to cancel.`);
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

// OpenSSH wire-format helper: each component is preceded by a 4-byte BE length
function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

// OpenSSH mpint: leading zero stripped, but a leading zero byte added back if the
// high bit is set (so it doesn't get interpreted as a negative number).
function sshMpint(buf) {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  buf = buf.slice(start);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return sshString(buf);
}

// Decode base64url (JWK uses this; replace -→+, _→/, repad)
function fromB64Url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='), 'base64');
}

function ed25519PublicSsh(jwk, comment) {
  const type = Buffer.from('ssh-ed25519');
  const x = fromB64Url(jwk.x);
  const body = Buffer.concat([sshString(type), sshString(x)]);
  return 'ssh-ed25519 ' + body.toString('base64') + (comment ? ' ' + comment : '');
}

function rsaPublicSsh(jwk, comment) {
  const type = Buffer.from('ssh-rsa');
  const e = fromB64Url(jwk.e);
  const n = fromB64Url(jwk.n);
  const body = Buffer.concat([sshString(type), sshMpint(e), sshMpint(n)]);
  return 'ssh-rsa ' + body.toString('base64') + (comment ? ' ' + comment : '');
}

function ecdsaPublicSsh(jwk, comment) {
  const curveMap = {
    'P-256': { id: 'nistp256', sshName: 'ecdsa-sha2-nistp256', size: 32 },
    'P-384': { id: 'nistp384', sshName: 'ecdsa-sha2-nistp384', size: 48 },
    'P-521': { id: 'nistp521', sshName: 'ecdsa-sha2-nistp521', size: 66 }
  };
  const c = curveMap[jwk.crv];
  if (!c) throw new Error('Unsupported ECDSA curve: ' + jwk.crv);
  const type = Buffer.from(c.sshName);
  const idBuf = Buffer.from(c.id);
  const x = fromB64Url(jwk.x);
  const y = fromB64Url(jwk.y);
  const padX = Buffer.concat([Buffer.alloc(Math.max(0, c.size - x.length)), x]);
  const padY = Buffer.concat([Buffer.alloc(Math.max(0, c.size - y.length)), y]);
  const point = Buffer.concat([Buffer.from([0x04]), padX, padY]);
  const body = Buffer.concat([sshString(type), sshString(idBuf), sshString(point)]);
  return c.sshName + ' ' + body.toString('base64') + (comment ? ' ' + comment : '');
}

// Compute an SSH-style fingerprint (SHA256:<base64>) of a public key line.
function fingerprintFromPublicLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return '';
  try {
    const keyData = Buffer.from(parts[1], 'base64');
    const { createHash } = require('crypto');
    const hash = createHash('sha256').update(keyData).digest('base64').replace(/=+$/, '');
    return 'SHA256:' + hash;
  } catch (e) {
    return '';
  }
}

// Suggested default filename for a key (based on type/bits)
function defaultKeyName(type, bits, curve) {
  if (type === 'ed25519') return 'id_ed25519';
  if (type === 'rsa') return 'id_rsa';
  if (type === 'ecdsa') return 'id_ecdsa';
  return 'id_key';
}

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
