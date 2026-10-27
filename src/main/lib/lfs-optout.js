'use strict';

// Taking individual files out of Git LFS without rewriting history: a later line in the
// root .gitattributes overrides the pattern that tracked them (`*.unity filter=lfs ...`) for
// exactly those paths, and re-adding them stores the real content as an ordinary blob.
// Only commits from then on change; older ones still point at their LFS objects.
//
// `!attr` makes an attribute *unspecified* — as if the LFS line had never matched. `-diff`
// would be wrong: it means "binary", and the scene's diffs would read "Binary files differ".
// `-text` from the LFS line is deliberately left alone: content stays byte-exact, so the
// re-add stores precisely what LFS stored and no line endings are renormalised.
const OPT_OUT_ATTRS = '!filter !diff !merge';
const OPT_OUT_HEADER = '# Stored as plain git, not LFS (GitGood: LFS manager)';

// A gitattributes pattern matching exactly one repo-relative path. .gitattributes has no
// quoting (verified: a "quoted pattern" is split at its first space and the rest read as
// attribute names), so whitespace is written as the class [[:space:]] and the glob
// characters are backslash-escaped. Unity paths routinely contain both spaces and [ ].
// The leading "/" anchors it to the repository root.
function lfsOptOutPattern(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p) throw new Error('A path is required');
  if (/[\r\n]/.test(p)) throw new Error('A path containing a line break cannot be written to .gitattributes');
  let out = '/';
  for (const ch of p) {
    if (ch === ' ' || ch === '\t') out += '[[:space:]]';
    else if ('*?[]\\'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return out;
}

// The .gitattributes text with an opt-out line for each path appended, keeping the file's
// own line ending. Paths that already have one are not written twice.
function appendLfsOptOuts(text, paths) {
  const src = String(text || '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const existing = new Set(src.split(/\r?\n/).map(l => l.trim()));
  const lines = [];
  for (const p of paths) {
    const line = `${lfsOptOutPattern(p)} ${OPT_OUT_ATTRS}`;
    if (!existing.has(line) && !lines.includes(line)) lines.push(line);
  }
  if (!lines.length) return src;
  let out = src;
  if (out && !/\r?\n$/.test(out)) out += eol;
  if (!existing.has(OPT_OUT_HEADER)) out += (out ? eol : '') + OPT_OUT_HEADER + eol;
  return out + lines.join(eol) + eol;
}

module.exports = { lfsOptOutPattern, appendLfsOptOuts, OPT_OUT_ATTRS, OPT_OUT_HEADER };
