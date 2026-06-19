const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // Dialogs & app
  selectDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectFolder: (title) => ipcRenderer.invoke('dialog:selectFolder', title),
  selectFile: (title) => ipcRenderer.invoke('dialog:selectFile', title),
  getRecentRepos: () => ipcRenderer.invoke('app:getRecentRepos'),
  removeRecentRepo: (p) => ipcRenderer.invoke('app:removeRecentRepo', p),
  clearRecentRepos: () => ipcRenderer.invoke('app:clearRecentRepos'),
  getHome: () => ipcRenderer.invoke('app:getHome'),

  // Repo lifecycle
  openRepo: (p) => ipcRenderer.invoke('repo:open', p),
  initRepo: (p) => ipcRenderer.invoke('repo:init', p),
  cloneRepo: (opts) => ipcRenderer.invoke('repo:clone', opts),
  currentRepo: () => ipcRenderer.invoke('repo:current'),
  closeRepo: () => ipcRenderer.invoke('repo:close'),

  // Status & history
  status: () => ipcRenderer.invoke('repo:status'),
  branches: () => ipcRenderer.invoke('repo:branches'),
  log: (opts) => ipcRenderer.invoke('repo:log', opts),
  commitFiles: (opts) => ipcRenderer.invoke('repo:commitFiles', opts),
  remotes: () => ipcRenderer.invoke('repo:remotes'),
  stashList: () => ipcRenderer.invoke('repo:stashList'),

  // Diffs
  diff: (file) => ipcRenderer.invoke('repo:diff', file),
  diffUnstaged: (file) => ipcRenderer.invoke('repo:diffUnstaged', file),
  diffStaged: (file) => ipcRenderer.invoke('repo:diffStaged', file),

  // Staging
  stage: (files) => ipcRenderer.invoke('repo:stage', files),
  stageAll: () => ipcRenderer.invoke('repo:stageAll'),
  unstage: (files) => ipcRenderer.invoke('repo:unstage', files),
  unstageAll: () => ipcRenderer.invoke('repo:unstageAll'),
  discard: (files) => ipcRenderer.invoke('repo:discard', files),
  restoreFromCommit: (hash, files) => ipcRenderer.invoke('repo:restoreFromCommit', { hash, files }),

  // Commit / sync
  commit: (msg) => ipcRenderer.invoke('repo:commit', msg),
  commitPaths: (opts) => ipcRenderer.invoke('repo:commitPaths', opts),
  push: (opts) => ipcRenderer.invoke('repo:push', opts),
  pull: () => ipcRenderer.invoke('repo:pull'),
  fetch: () => ipcRenderer.invoke('repo:fetch'),

  // Branches
  checkout: (b) => ipcRenderer.invoke('repo:checkout', b),
  createBranch: (opts) => ipcRenderer.invoke('repo:createBranch', opts),
  deleteBranch: (opts) => ipcRenderer.invoke('repo:deleteBranch', opts),
  deleteRemoteBranch: (ref) => ipcRenderer.invoke('repo:deleteRemoteBranch', ref),
  merge: (opts) => ipcRenderer.invoke('repo:merge', opts),
  mergePreview: (b) => ipcRenderer.invoke('repo:mergePreview', b),
  mergeAbort: () => ipcRenderer.invoke('repo:mergeAbort'),
  cherryPick: (h) => ipcRenderer.invoke('repo:cherryPick', h),
  revert: (h) => ipcRenderer.invoke('repo:revert', h),
  reset: (opts) => ipcRenderer.invoke('repo:reset', opts),
  moveBranch: (opts) => ipcRenderer.invoke('repo:moveBranch', opts),

  // Graph
  graphLog: (opts) => ipcRenderer.invoke('repo:graphLog', opts),

  // Remotes
  addRemote: (opts) => ipcRenderer.invoke('repo:addRemote', opts),
  removeRemote: (name) => ipcRenderer.invoke('repo:removeRemote', name),

  // Stash
  stash: (opts) => ipcRenderer.invoke('repo:stash', opts),
  stashPop: (i) => ipcRenderer.invoke('repo:stashPop', i),
  stashApply: (i) => ipcRenderer.invoke('repo:stashApply', i),
  stashDrop: (i) => ipcRenderer.invoke('repo:stashDrop', i),
  dropAutoStashFor: (branch) => ipcRenderer.invoke('repo:dropAutoStashFor', branch),
  stashFiles: (i) => ipcRenderer.invoke('repo:stashFiles', i),
  stashApplyFiles: (opts) => ipcRenderer.invoke('repo:stashApplyFiles', opts),
  stashFindByPrefix: (prefix) => ipcRenderer.invoke('repo:stashFindByPrefix', prefix),

  // Safe checkout (detects dirty tree)
  checkoutSafe: (opts) => ipcRenderer.invoke('repo:checkoutSafe', opts),

  // Conflict resolution
  conflictState: () => ipcRenderer.invoke('repo:conflictState'),
  conflictVersions: (filePath) => ipcRenderer.invoke('repo:conflictVersions', filePath),
  conflictResolveSide: (opts) => ipcRenderer.invoke('repo:conflictResolveSide', opts),
  conflictMarkResolved: (filePath) => ipcRenderer.invoke('repo:conflictMarkResolved', filePath),
  conflictKeepFile: (filePath) => ipcRenderer.invoke('repo:conflictKeepFile', filePath),
  conflictDeleteFile: (filePath) => ipcRenderer.invoke('repo:conflictDeleteFile', filePath),
  conflictUseOurs: (filePath) => ipcRenderer.invoke('repo:conflictUseOurs', filePath),
  conflictUseTheirs: (filePath) => ipcRenderer.invoke('repo:conflictUseTheirs', filePath),
  conflictRestoreMarkers: (filePath) => ipcRenderer.invoke('repo:conflictRestoreMarkers', filePath),
  parseConflictFile: (filePath) => ipcRenderer.invoke('repo:parseConflictFile', filePath),
  writeFile: (opts) => ipcRenderer.invoke('repo:writeFile', opts),
  operationContinue: () => ipcRenderer.invoke('repo:operationContinue'),
  operationAbort: () => ipcRenderer.invoke('repo:operationAbort'),
  inspectHidden: () => ipcRenderer.invoke('repo:inspectHidden'),
  addGitkeep: (folder) => ipcRenderer.invoke('repo:addGitkeep', folder),

  // SSH key generator
  sshGenerateKey: (opts) => ipcRenderer.invoke('ssh:generateKey', opts),
  sshSaveKey: (opts) => ipcRenderer.invoke('ssh:saveKey', opts),
  sshDefaultIdentity: () => ipcRenderer.invoke('ssh:defaultIdentity'),

  // Disk management
  diskUsage: () => ipcRenderer.invoke('repo:diskUsage'),
  diskUsageCancel: () => ipcRenderer.invoke('repo:diskUsageCancel'),
  onDiskProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('disk:progress', handler);
    return () => ipcRenderer.removeListener('disk:progress', handler);
  },
  mergedBranches: () => ipcRenderer.invoke('repo:mergedBranches'),
  largestObjects: (limit) => ipcRenderer.invoke('repo:largestObjects', limit),
  gc: (opts) => ipcRenderer.invoke('repo:gc', opts),
  prune: () => ipcRenderer.invoke('repo:prune'),
  repack: () => ipcRenderer.invoke('repo:repack'),
  reflogExpire: (opts) => ipcRenderer.invoke('repo:reflogExpire', opts),
  lfsPrune: () => ipcRenderer.invoke('repo:lfsPrune'),
  lfsStatus: () => ipcRenderer.invoke('repo:lfsStatus'),
  lfsInfo: () => ipcRenderer.invoke('repo:lfsInfo'),
  lfsInstall: () => ipcRenderer.invoke('repo:lfsInstall'),
  lfsTrack: (pattern) => ipcRenderer.invoke('repo:lfsTrack', pattern),
  lfsUntrack: (pattern) => ipcRenderer.invoke('repo:lfsUntrack', pattern),
  lfsFiles: () => ipcRenderer.invoke('repo:lfsFiles'),
  lfsPull: (remote) => ipcRenderer.invoke('repo:lfsPull', remote),
  lfsFetch: (opts) => ipcRenderer.invoke('repo:lfsFetch', opts),
  lfsPush: (opts) => ipcRenderer.invoke('repo:lfsPush', opts),
  lfsCheckout: () => ipcRenderer.invoke('repo:lfsCheckout'),
  lfsMigrateImport: (opts) => ipcRenderer.invoke('repo:lfsMigrateImport', opts),
  deleteBranches: (opts) => ipcRenderer.invoke('repo:deleteBranches', opts),

  // Settings
  getAppSettings: () => ipcRenderer.invoke('settings:getApp'),
  setAppSettings: (prefs) => ipcRenderer.invoke('settings:setApp', prefs),
  resetAppSettings: () => ipcRenderer.invoke('settings:resetApp'),
  appSettingsPath: () => ipcRenderer.invoke('settings:appSettingsPath'),
  getGitConfig: () => ipcRenderer.invoke('settings:getGitConfig'),
  setGitConfig: (opts) => ipcRenderer.invoke('settings:setGitConfig', opts),
  setGitConfigBatch: (updates) => ipcRenderer.invoke('settings:setGitConfigBatch', updates),

  // Misc
  fileContent: (p) => ipcRenderer.invoke('repo:fileContent', p),
  openInExplorer: (p) => ipcRenderer.invoke('repo:openInExplorer', p),
  showCommit: (opts) => ipcRenderer.invoke('repo:showCommit', opts),
  showCommitFileDiff: (opts) => ipcRenderer.invoke('repo:showCommitFileDiff', opts),
  rawCommand: (args) => ipcRenderer.invoke('repo:rawCommand', args),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Embedded terminal
  termStart: (opts) => ipcRenderer.invoke('term:start', opts),
  termInput: (text) => ipcRenderer.invoke('term:input', text),
  termSignal: (sig) => ipcRenderer.invoke('term:signal', sig),
  termKill: () => ipcRenderer.invoke('term:kill'),
  onTermData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('term:data', handler);
    return () => ipcRenderer.removeListener('term:data', handler);
  },
  onTermExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('term:exit', handler);
    return () => ipcRenderer.removeListener('term:exit', handler);
  },

  // Menu events from main process
  onMenu: (channel, cb) => {
    const valid = ['menu-open-repo', 'menu-clone-repo', 'menu-about'];
    if (valid.includes(channel)) ipcRenderer.on(channel, () => cb());
  },

  // Window focus event — used to auto-refresh repo state
  onWindowFocus: (cb) => {
    ipcRenderer.on('window-focused', () => cb());
  },

  // Git operation progress (clone/pull/push/fetch/lfs) — { method, stage, progress, active, done }
  onOpProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('op:progress', handler);
    return () => ipcRenderer.removeListener('op:progress', handler);
  }
};

contextBridge.exposeInMainWorld('gs', api);
