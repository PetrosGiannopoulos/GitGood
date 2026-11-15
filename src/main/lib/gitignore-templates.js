'use strict';
// .gitignore templates for the Initialize Repository dialog. One base template (the
// project type, like GitHub's dropdown) plus any number of add-ons (OS, editor, art tool
// leftovers), merged into one file with duplicate patterns dropped.
//
// Unity gets more than GitHub's template: the paths Unity owns (Library, Temp, Logs…)
// are anchored to the *Unity project's* folder, which is often not the repository root
// — GitHub's `/[Ll]ibrary/` silently matches nothing when the project lives in `Game/`,
// and the first push then uploads gigabytes of import cache. findUnityProjects locates
// those folders so the block can be written once per project, anchored correctly.

const fs = require('fs');
const path = require('path');

// `{root}` is replaced by the anchor of each Unity project ('' at the repo root, so
// `{root}/[Ll]ibrary/` becomes `/[Ll]ibrary/`, or `/Game/[Ll]ibrary/` in a subfolder).
const UNITY_PROJECT = `
# Folders Unity regenerates. Library is the import cache: never commit it.
{root}/[Ll]ibrary/
{root}/[Tt]emp/
{root}/[Oo]bj/
{root}/[Ll]ogs/
{root}/[Uu]ser[Ss]ettings/

# Profiler, Memory Profiler and Recorder output
{root}/[Mm]emoryCaptures/
{root}/[Rr]ecordings/
{root}/CodeCoverage/

# Player builds, AssetBundle Browser and Addressables (remote) build output
{root}/[Bb]uild/
{root}/[Bb]uilds/
{root}/AssetBundles/
{root}/ServerData/

# Addressables' local build, copied into StreamingAssets on every player build
{root}/[Aa]ssets/[Ss]treamingAssets/aa/*
{root}/[Aa]ssets/[Ss]treamingAssets/aa.meta

# Scenes the Test Runner leaves in Assets when a run is interrupted
{root}/[Aa]ssets/[Ii]nitTestScene*.unity*

# Asset Store publishing tools and the old Rider plugin copy
{root}/[Aa]ssets/AssetStoreTools*
{root}/[Aa]ssets/Plugins/Editor/JetBrains*
`;

// Patterns that hold anywhere in the repository — written once however many Unity
// projects there are.
const UNITY_SHARED = `
# IDE project files: Unity regenerates them from the Assets folder
.vs/
.gradle/
.consulo/
.utmp/
ExportedObj/
*.csproj
*.unityproj
*.sln
*.slnx
*.suo
*.tmp
*.user
*.userprefs
*.pidb
*.booproj
*.svd
*.pdb
*.mdb
*.opendb
*.VC.db

# .meta files Unity writes for debug symbols
*.pidb.meta
*.pdb.meta
*.mdb.meta

# Crash and diagnostics files
sysinfo.txt
mono_crash.*
crashlytics-build.properties

# IL2CPP and Burst write these next to a player build; they must not ship
*_BackUpThisFolder_ButDontShipItWithYourGame/
*_BurstDebugInformation_DoNotShip/

# Built players and exported packages (delete *.unitypackage if you commit packages on purpose)
*.apk
*.aab
*.ipa
*.app
*.unitypackage

# DO commit: every .meta file, Assets/, Packages/manifest.json, Packages/packages-lock.json
# and ProjectSettings/. Large binaries (textures, audio, models) belong in Git LFS.
`;

const TEMPLATES = [
  // ---- Base templates: the project type ----
  {
    id: 'unity', kind: 'base', label: 'Unity',
    description: 'Library/Temp/Logs anchored to each Unity project found, Addressables and Burst/IL2CPP output, Test Runner leftovers, crash dumps.',
    text: UNITY_SHARED, unity: true
  },
  {
    id: 'unreal', kind: 'base', label: 'Unreal Engine',
    description: 'Binaries, DerivedDataCache, Intermediate, Saved, plugin build output.',
    text: `
/Binaries/
/DerivedDataCache/
/Intermediate/
/Saved/
/Plugins/**/Binaries/
/Plugins/**/Intermediate/

# Build/ holds packaging output, except the per-platform settings kept in it
/Build/*
!/Build/*/
/Build/*/**
!/Build/*/PakBlacklist*.txt
!/Build/**/*.ico

# Generated IDE project files
.vs/
*.sln
*.suo
*.opensdf
*.sdf
*.VC.db
*.VC.opendb
*.xcodeproj
*.xcworkspace
`
  },
  {
    id: 'godot', kind: 'base', label: 'Godot',
    description: 'The .godot import cache (4.x) and .import (3.x), Mono/C# output, export presets.',
    text: `
.godot/
.import/
/android/
.mono/
data_*/
mono_crash.*.json
*.translation

# Export presets can contain signing credentials
export.cfg
export_presets.cfg
`
  },
  {
    id: 'dotnet', kind: 'base', label: 'C# / .NET',
    description: 'bin/obj, Visual Studio state, NuGet packages, test results.',
    text: `
[Bb]in/
[Oo]bj/
[Dd]ebug/
[Rr]elease/
x64/
x86/
[Ll]og/
[Ll]ogs/
artifacts/
.vs/
*.user
*.suo
*.rsuser
*.userprefs
*.binlog
TestResults/
*.trx
*.nupkg
*.snupkg
project.lock.json
`
  },
  {
    id: 'node', kind: 'base', label: 'Node',
    description: 'node_modules, package-manager logs and caches, build and coverage output, .env.',
    text: `
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
.npm/
.yarn/cache/
.pnp.*
.eslintcache
dist/
coverage/
.env
.env.*.local
.env.local
`
  },
  {
    id: 'python', kind: 'base', label: 'Python',
    description: 'Bytecode, virtual environments, packaging output, tool caches.',
    text: `
__pycache__/
*.py[cod]
*.so
.venv/
venv/
env/
build/
dist/
*.egg-info/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.ipynb_checkpoints/
.coverage
htmlcov/
.env
`
  },
  {
    id: 'cpp', kind: 'base', label: 'C / C++',
    description: 'Object files, libraries, executables, CMake build trees.',
    text: `
*.o
*.obj
*.a
*.lib
*.so
*.dylib
*.dll
*.exe
*.out
*.pch
*.gch
build/
cmake-build-*/
CMakeFiles/
CMakeCache.txt
.cache/
`
  },
  {
    id: 'java', kind: 'base', label: 'Java / Gradle',
    description: 'Class files, Gradle and Maven output, keeping the Gradle wrapper.',
    text: `
*.class
*.jar
!gradle/wrapper/gradle-wrapper.jar
.gradle/
build/
out/
target/
local.properties
hs_err_pid*
`
  },
  {
    id: 'rust', kind: 'base', label: 'Rust',
    description: 'Cargo target directory and rustfmt backups.',
    text: `
/target/
**/*.rs.bk
*.pdb
`
  },
  {
    id: 'go', kind: 'base', label: 'Go',
    description: 'Built binaries, test output, workspace files.',
    text: `
*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
go.work
go.work.sum
.env
`
  },

  // ---- Add-ons ----
  {
    id: 'windows', kind: 'addon', label: 'Windows',
    description: 'Thumbs.db, Desktop.ini, recycle bin.',
    text: `
Thumbs.db
Thumbs.db:encryptable
ehthumbs.db
ehthumbs_vista.db
[Dd]esktop.ini
$RECYCLE.BIN/
*.stackdump
`
  },
  {
    id: 'macos', kind: 'addon', label: 'macOS',
    description: '.DS_Store, resource forks, Spotlight and Trash folders.',
    text: `
.DS_Store
.AppleDouble
.LSOverride
._*
.Spotlight-V100
.Trashes
.fseventsd
.DocumentRevisions-V100
.TemporaryItems
`
  },
  {
    id: 'linux', kind: 'addon', label: 'Linux',
    description: 'Editor backups (~), .directory, trash and NFS files.',
    text: `
*~
.fuse_hidden*
.directory
.Trash-*
.nfs*
`
  },
  {
    id: 'rider', kind: 'addon', label: 'JetBrains Rider',
    description: '.idea folder and module files.',
    text: `
.idea/
*.sln.iml
`
  },
  {
    id: 'vscode', kind: 'addon', label: 'VS Code',
    description: 'Personal .vscode files, keeping shared settings, tasks, launch and extensions.',
    text: `
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json
!.vscode/*.code-snippets
.history/
*.vsix
`
  },
  {
    id: 'visualstudio', kind: 'addon', label: 'Visual Studio',
    description: '.vs folder, per-user option files, IntelliSense databases.',
    text: `
.vs/
*.user
*.suo
*.rsuser
*.userprefs
*.VC.db
*.VC.opendb
`
  },
  {
    id: 'arttools', kind: 'addon', label: 'Art tool backups',
    description: 'Blender .blend1 backups, Maya swatches, Krita and Photoshop temp files: the clutter artists leave inside Assets/.',
    text: `
*.blend[0-9]
*.blend[0-9][0-9]
.mayaSwatches/
*.ma.swatches
*.mb.swatches
*.kra~
*.psd.tmp
`
  }
];

const BY_ID = new Map(TEMPLATES.map(t => [t.id, t]));

// What the renderer needs to draw the picker — never the text itself.
function templateList() {
  return TEMPLATES.map(({ id, kind, label, description }) => ({ id, kind, label, description }));
}

// A folder name inside a pattern: gitignore has no quoting, so glob characters and a
// leading/trailing space are escaped instead. '' means the repository root.
function anchorFor(root) {
  const clean = String(root || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) return '';
  const escaped = clean.replace(/[\\*?[\]]/g, m => '\\' + m).replace(/(^| ) /g, '$1\\ ').replace(/ $/, '\\ ');
  return '/' + escaped;
}

function isPattern(line) {
  const t = line.trim();
  return t !== '' && !t.startsWith('#');
}

// Build the generated .gitignore.
//   base:      a base template id, or '' / 'none'
//   addons:    add-on ids
//   unityRoots: repo-relative Unity project folders ('' = root); defaults to [''] for Unity
//   existing:  current .gitignore text, if any. Patterns already in it are not repeated,
//              and the result is the existing text with the new sections appended.
// Returns { text, added } — text is the whole file to write, added the number of new
// patterns (0 = nothing to write).
function buildGitignore({ base, addons, unityRoots, existing } = {}) {
  const ids = [];
  if (base && base !== 'none' && BY_ID.has(base)) ids.push(base);
  for (const a of addons || []) if (BY_ID.has(a) && !ids.includes(a)) ids.push(a);

  const seen = new Set();
  const had = typeof existing === 'string' && existing.length > 0;
  if (had) for (const l of existing.split(/\r?\n/)) if (isPattern(l)) seen.add(l.trim());

  let added = 0;
  const sections = [];
  // Keep a section's comments only when at least one of its patterns survives the dedupe,
  // and drop a comment block whose patterns were all duplicates.
  const emit = (title, body) => {
    const out = [];
    let pending = [];
    let any = false;
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (line === '') { pending = ['']; continue; }       // a block's comment dies with it
      if (!isPattern(line)) { pending.push(line); continue; }
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(...pending, line);
      pending = [];
      any = true;
      added++;
    }
    if (!any) return;
    while (out.length && out[0] === '') out.shift();
    sections.push(`# ===== ${title} =====\n` + out.join('\n'));
  };

  for (const id of ids) {
    const t = BY_ID.get(id);
    if (t.unity) {
      const roots = (unityRoots && unityRoots.length) ? unityRoots : [''];
      for (const r of roots) {
        const anchor = anchorFor(r);
        const where = anchor ? anchor.slice(1).replace(/\\/g, '') + '/' : 'repository root';
        emit(`Unity project (${where})`, UNITY_PROJECT.split('{root}').join(anchor));
      }
    }
    emit(t.label, t.text);
  }

  if (!added) return { text: had ? existing : '', added: 0 };
  const generated = sections.join('\n\n') + '\n';
  if (!had) {
    const labels = ids.map(id => BY_ID.get(id).label).join(', ');
    return { text: `# Generated by GitGood: ${labels}\n\n` + generated, added };
  }
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return { text: existing + sep + '# ----- Added by GitGood -----\n' + generated, added };
}

// Unity projects under `dir`, as repo-relative '/' paths ('' = dir itself). A Unity
// project is a folder holding both ProjectSettings/ProjectVersion.txt and Assets/.
// Bounded: a few levels deep, and never into folders that cannot hold one but can hold
// a great many files (another project's Library, node_modules, .git).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'library', 'temp', 'obj', 'logs', 'build', 'builds',
  'assets', 'packages', 'projectsettings', 'usersettings', '.vs', '.idea', '.godot']);

function findUnityProjects(dir, maxDepth = 3) {
  const found = [];
  const walk = (abs, rel, depth) => {
    if (fs.existsSync(path.join(abs, 'ProjectSettings', 'ProjectVersion.txt')) &&
        fs.existsSync(path.join(abs, 'Assets'))) {
      found.push(rel);
      return;                                  // a Unity project does not nest another
    }
    if (depth >= maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      walk(path.join(abs, e.name), rel ? rel + '/' + e.name : e.name, depth + 1);
    }
  };
  walk(dir, '', 0);
  return found.sort();
}

module.exports = { templateList, buildGitignore, findUnityProjects, anchorFor, TEMPLATES };
