// Passing a large list of paths to git (pure helpers extracted from main.js).
//
// Windows caps a process command line at 32767 characters, and Node reports the overflow
// as a spawn error (ENAMETOOLONG) *before* git runs — so the operation fails with nothing
// done, and the message names no file. A Unity-shaped repo hits the cap at around 150
// files, because one asset path is easily 200 characters, which makes "select all →
// discard" a realistic way to reach it. Every handler that hands git a user-sized list of
// paths goes through one of the two helpers here.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The room the paths themselves may take, kept well under the real cap to leave space for
// git's own executable path, the subcommand, its flags, and the quoting Windows adds
// around each argument.
const PATHSPEC_BUDGET = 24000;

function chunkPaths(paths, budget = PATHSPEC_BUDGET) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const p of paths) {
    const cost = String(p).length + 3; // separator + the quotes Windows may add
    if (current.length && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += cost;
  }
  if (current.length) chunks.push(current);
  // A single path longer than the entire budget still gets its own chunk: git handles a
  // path far longer than this, and refusing it here would fail a file that would work.
  return chunks;
}

function pathspecFits(paths) {
  return chunkPaths(paths).length <= 1;
}

// Run an operation once per chunk. Only for commands where several passes are equivalent
// to one: stage, unstage, checkout -- <paths>, add -N. NOT for commit or stash push,
// where N invocations would mean N commits or N stash entries — those use
// withPathspecFile instead.
async function forEachPathChunk(paths, fn) {
  for (const chunk of chunkPaths(paths)) await fn(chunk);
}

// Hand git the paths in a file instead of on the command line, so an operation that must
// stay a *single* invocation has no length limit at all. NUL-separated, so nothing needs
// escaping and even a path containing a newline survives. Callers reach for this only
// once the list would actually overflow (see pathspecFits), which keeps the ordinary case
// on plain argv — `--pathspec-from-file` needs git 2.25+ (2.26 for stash), and there is no
// reason to require that of a user committing five files.
async function withPathspecFile(paths, fn) {
  const file = path.join(os.tmpdir(), `gitgood-pathspec-${process.pid}-${Date.now()}.nul`);
  fs.writeFileSync(file, paths.map(String).join('\0') + '\0');
  try {
    return await fn([`--pathspec-from-file=${file}`, '--pathspec-file-nul']);
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
  }
}

module.exports = { PATHSPEC_BUDGET, chunkPaths, pathspecFits, forEachPathChunk, withPathspecFile };
