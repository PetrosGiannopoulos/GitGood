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
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),

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
  searchDiffContent: (opts) => ipcRenderer.invoke('repo:searchDiffContent', opts),
  cancelDiffSearch: () => ipcRenderer.invoke('repo:cancelDiffSearch'),
  localOnlyCommits: () => ipcRenderer.invoke('repo:localOnlyCommits'),
  onSearchProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('search:progress', handler);
    return () => ipcRenderer.removeListener('search:progress', handler);
  },
  remotes: () => ipcRenderer.invoke('repo:remotes'),
  stashList: () => ipcRenderer.invoke('repo:stashList'),

  // Diffs. `opts.ignoreWhitespace` adds -w; note that a -w diff cannot be applied, so
  // the renderer turns partial staging off while it is active.
  diff: (file, opts) => ipcRenderer.invoke('repo:diff', file, opts),
  diffUnstaged: (file, opts) => ipcRenderer.invoke('repo:diffUnstaged', file, opts),
  diffStaged: (file, opts) => ipcRenderer.invoke('repo:diffStaged', file, opts),
  fileBlob: (opts) => ipcRenderer.invoke('repo:fileBlob', opts),

  // Staging
  stage: (files) => ipcRenderer.invoke('repo:stage', files),
  // Partial staging — apply a synthetic patch of only the selected hunks/lines
  applyPatch: (opts) => ipcRenderer.invoke('repo:applyPatch', opts),
  intentToAdd: (files) => ipcRenderer.invoke('repo:intentToAdd', files),
  stageAll: () => ipcRenderer.invoke('repo:stageAll'),
  unstage: (files) => ipcRenderer.invoke('repo:unstage', files),
  unstageAll: () => ipcRenderer.invoke('repo:unstageAll'),
  discard: (files) => ipcRenderer.invoke('repo:discard', files),
  restoreFromCommit: (hash, files) => ipcRenderer.invoke('repo:restoreFromCommit', { hash, files }),

  // Commit / sync
  commit: (msg) => ipcRenderer.invoke('repo:commit', msg),
  headCommit: () => ipcRenderer.invoke('repo:headCommit'),
  commitPaths: (opts) => ipcRenderer.invoke('repo:commitPaths', opts),
  push: (opts) => ipcRenderer.invoke('repo:push', opts),
  pull: () => ipcRenderer.invoke('repo:pull'),
  fetch: () => ipcRenderer.invoke('repo:fetch'),

  // Submodules. A gitlink is one commit hash in the index, so the useful information
  // (which way it moved, over which commits) has to be read from inside the submodule.
  submodules: () => ipcRenderer.invoke('repo:submodules'),
  submoduleSummary: (opts) => ipcRenderer.invoke('repo:submoduleSummary', opts),
  submoduleUpdate: (opts) => ipcRenderer.invoke('repo:submoduleUpdate', opts),

  // Tags. Creation/deletion still go through rawCommand from the graph; these are the
  // remote half — a tag is not shared until it is pushed as its own refspec.
  tags: () => ipcRenderer.invoke('repo:tags'),
  remoteTags: (remote) => ipcRenderer.invoke('repo:remoteTags', remote),
  pushTag: (opts) => ipcRenderer.invoke('repo:pushTag', opts),
  deleteRemoteTag: (opts) => ipcRenderer.invoke('repo:deleteRemoteTag', opts),

  // Forge (GitHub / GitLab). Tokens live in the main process only — nothing here returns
  // one, and `hasToken` is the most the renderer ever learns.
  forgeInfo: (opts) => ipcRenderer.invoke('forge:info', opts),
  forgeSetToken: (opts) => ipcRenderer.invoke('forge:setToken', opts),
  forgeClearToken: (opts) => ipcRenderer.invoke('forge:clearToken', opts),
  forgePullRequests: (opts) => ipcRenderer.invoke('forge:pullRequests', opts),
  forgeIssues: (opts) => ipcRenderer.invoke('forge:issues', opts),
  forgeCreatePullRequest: (opts) => ipcRenderer.invoke('forge:createPullRequest', opts),
  forgeChecks: (opts) => ipcRenderer.invoke('forge:checks', opts),
  // Reading a request or issue in the app. One pane per call: the detail view only asks
  // for the tab you are looking at.
  forgeDetail: (opts) => ipcRenderer.invoke('forge:detail', opts),
  forgeTimeline: (opts) => ipcRenderer.invoke('forge:timeline', opts),
  forgeComment: (opts) => ipcRenderer.invoke('forge:comment', opts),
  forgeRequestCommits: (opts) => ipcRenderer.invoke('forge:requestCommits', opts),
  forgeRequestFiles: (opts) => ipcRenderer.invoke('forge:requestFiles', opts),
  forgeSetState: (opts) => ipcRenderer.invoke('forge:setState', opts),
  forgeLabels: (opts) => ipcRenderer.invoke('forge:labels', opts),
  forgeSetLabels: (opts) => ipcRenderer.invoke('forge:setLabels', opts),
  forgeMerge: (opts) => ipcRenderer.invoke('forge:merge', opts),
  forgeCheckoutRequest: (opts) => ipcRenderer.invoke('forge:checkoutRequest', opts),
  // Boards & work items. GitHub Projects v2 (GraphQL) and GitLab issue boards (REST) are
  // flattened to one columns-and-cards shape before they get here.
  forgeBoards: (opts) => ipcRenderer.invoke('forge:boards', opts),
  forgeBoard: (opts) => ipcRenderer.invoke('forge:board', opts),
  forgeMoveBoardItem: (opts) => ipcRenderer.invoke('forge:moveBoardItem', opts),

  // Worktrees. Opening one is just openRepo(path) — a linked worktree is a repository as
  // far as every other handler is concerned.
  worktreeList: () => ipcRenderer.invoke('worktree:list'),
  worktreeAdd: (opts) => ipcRenderer.invoke('worktree:add', opts),
  worktreeRemove: (opts) => ipcRenderer.invoke('worktree:remove', opts),
  worktreeLock: (opts) => ipcRenderer.invoke('worktree:lock', opts),
  worktreePrune: () => ipcRenderer.invoke('worktree:prune'),

  // Commit & tag signing. Verification is per-commit and on demand — never in bulk, since
  // every check spawns gpg/ssh-keygen (see the signing section in main.js).
  signingStatus: () => ipcRenderer.invoke('signing:status'),
  signingConfigure: (opts) => ipcRenderer.invoke('signing:configure', opts),
  signingTest: () => ipcRenderer.invoke('signing:test'),
  signingAddAllowedSigner: (opts) => ipcRenderer.invoke('signing:addAllowedSigner', opts),
  verifyCommit: (opts) => ipcRenderer.invoke('repo:verifyCommit', opts),

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
  squashPreview: () => ipcRenderer.invoke('repo:squashPreview'),
  squash: (opts) => ipcRenderer.invoke('repo:squash', opts),
  rebaseTodo: (opts) => ipcRenderer.invoke('repo:rebaseTodo', opts),
  rebase: (opts) => ipcRenderer.invoke('repo:rebase', opts),

  // Working-tree watcher + background fetch
  startWatching: () => ipcRenderer.invoke('repo:startWatching'),
  stopWatching: () => ipcRenderer.invoke('repo:stopWatching'),
  onFsChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('repo:fsChanged', handler);
    return () => ipcRenderer.removeListener('repo:fsChanged', handler);
  },
  onAutoFetched: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('repo:autoFetched', handler);
    return () => ipcRenderer.removeListener('repo:autoFetched', handler);
  },

  // Reflog / undo
  reflog: (opts) => ipcRenderer.invoke('repo:reflog', opts),
  reflogRestore: (opts) => ipcRenderer.invoke('repo:reflogRestore', opts),

  // Blame & file history
  blame: (opts) => ipcRenderer.invoke('repo:blame', opts),
  fileHistory: (opts) => ipcRenderer.invoke('repo:fileHistory', opts),
  fileDiffAtCommit: (opts) => ipcRenderer.invoke('repo:fileDiffAtCommit', opts),

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
  operationSkip: () => ipcRenderer.invoke('repo:operationSkip'),
  inspectHidden: () => ipcRenderer.invoke('repo:inspectHidden'),
  addGitkeep: (folder) => ipcRenderer.invoke('repo:addGitkeep', folder),
  addToGitignore: (paths) => ipcRenderer.invoke('repo:addToGitignore', paths),

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
  },

  // Local AI assistant (Ollama) — optional, off by default
  llmInfo: (model) => ipcRenderer.invoke('llm:info', model),
  llmPull: (model) => ipcRenderer.invoke('llm:pull', model),
  llmAsk: (opts) => ipcRenderer.invoke('llm:ask', opts),
  llmCancel: () => ipcRenderer.invoke('llm:cancel'),
  llmIndexStatus: () => ipcRenderer.invoke('llm:indexStatus'),
  llmBuildIndex: (opts) => ipcRenderer.invoke('llm:buildIndex', opts),
  llmClearIndex: () => ipcRenderer.invoke('llm:clearIndex'),
  onLlmProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('llm:progress', handler);
    return () => ipcRenderer.removeListener('llm:progress', handler);
  },
  onLlmToken: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('llm:token', handler);
    return () => ipcRenderer.removeListener('llm:token', handler);
  }
};

contextBridge.exposeInMainWorld('gs', api);
