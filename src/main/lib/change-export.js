'use strict';

// "Export changes" in the commit preview: some files of a commit, written out so a teammate
// who cannot merge the commit can redo the edits by hand. Pure — main runs `git show` and
// hands the text here; this parses it and writes it as Markdown (chat, issues) or plain text
// (email). Kept out of main.js so it can be tested without Electron.

// git's C-style path quoting: "a/caf\303\251.txt" → a/café.txt. Octal escapes are bytes of
// UTF-8, so they are collected and decoded together, not one character each.
function unquoteGitPath(s) {
  if (!s || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const body = s.slice(1, -1);
  const bytes = [];
  const SIMPLE = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { for (const b of Buffer.from(c, 'utf8')) bytes.push(b); continue; }
    const n = body[i + 1];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.substr(i + 1, 3), 8)); i += 3; }
    else { bytes.push(SIMPLE[n] !== undefined ? SIMPLE[n] : n.charCodeAt(0)); i += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}

// "a/path" / "b/path" (possibly quoted) → path. /dev/null stays null.
function headerPath(raw) {
  const p = unquoteGitPath(String(raw || '').replace(/\t$/, '').trim());
  if (!p || p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// Parse `git show --format= <hash> -- <paths>` output into files and hunks.
function parseExportDiff(text) {
  const files = [];
  let f = null;
  let h = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { path: '', oldPath: null, status: 'modified', binary: false, oldMode: null, newMode: null,
            hunks: [], adds: 0, dels: 0 };
      h = null;
      // Best effort from the header; the ---/+++ and rename lines below are unambiguous.
      const q = line.match(/ ("b\/(?:[^"\\]|\\.)*")$/);
      const m = line.match(/ b\/(.+)$/);
      f.path = q ? headerPath(q[1]) : (m ? m[1] : '');
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (h) {
      const c = line[0];
      if (c === '+' || c === '-' || c === ' ') {
        h.lines.push({ t: c, s: line.slice(1) });
        if (c === '+') f.adds++;
        if (c === '-') f.dels++;
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      if (line === '') continue; // the trailing newline of the whole output
      h = null; // anything else ends the hunk
    }
    const hm = line.match(HUNK_RE);
    if (hm) {
      h = { oldStart: +hm[1], oldCount: hm[2] === undefined ? 1 : +hm[2],
            newStart: +hm[3], newCount: hm[4] === undefined ? 1 : +hm[4],
            func: (hm[5] || '').trim(), lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (line.startsWith('new file mode')) { f.status = 'added'; f.newMode = line.slice(14).trim(); }
    else if (line.startsWith('deleted file mode')) { f.status = 'deleted'; f.oldMode = line.slice(18).trim(); }
    else if (line.startsWith('old mode ')) f.oldMode = line.slice(9).trim();
    else if (line.startsWith('new mode ')) f.newMode = line.slice(9).trim();
    else if (line.startsWith('rename from ')) { f.status = 'renamed'; f.oldPath = unquoteGitPath(line.slice(12)); }
    else if (line.startsWith('rename to ')) { f.status = 'renamed'; f.path = unquoteGitPath(line.slice(10)); }
    else if (line.startsWith('copy from ')) { f.status = 'copied'; f.oldPath = unquoteGitPath(line.slice(10)); }
    else if (line.startsWith('copy to ')) { f.status = 'copied'; f.path = unquoteGitPath(line.slice(8)); }
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') f.binary = true;
    else if (line.startsWith('+++ ')) { const p = headerPath(line.slice(4)); if (p) f.path = p; }
    else if (line.startsWith('--- ')) {
      const p = headerPath(line.slice(4));
      if (p && f.status === 'deleted') f.path = p;
    }
  }
  return files;
}

// An LFS-tracked file's diff is its pointer: every changed line is version/oid/size.
function isLfsPointerDiff(f) {
  let changed = 0;
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.t === ' ') continue;
      changed++;
      if (!/^(version https:\/\/git-lfs\.github\.com\/spec\/|oid sha256:[0-9a-f]{64}$|size \d+$)/.test(l.s)) return false;
    }
  }
  return changed > 0;
}

// Unity's text-serialized assets: the raw YAML is in the export, but nobody should hand-edit
// fileIDs from it — the note says to redo the change in the Editor.
const UNITY_YAML_RE = /\.(unity|prefab|asset|mat|anim|controller|overrideController|mask|physicMaterial|physicsMaterial2D|lighting|playable|signal|spriteatlas|guiskin|fontsettings|terrainlayer|mixer|renderTexture|cubemap|flare|preset)$/i;

// A fenced code block's language, from the extension. Only what chat apps highlight.
const LANG_BY_EXT = {
  cs: 'csharp', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  tsx: 'tsx', jsx: 'jsx', json: 'json', py: 'python', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', go: 'go', rs: 'rust', rb: 'ruby',
  php: 'php', swift: 'swift', sh: 'bash', bash: 'bash', ps1: 'powershell', html: 'html',
  css: 'css', scss: 'scss', xml: 'xml', yml: 'yaml', yaml: 'yaml', sql: 'sql', lua: 'lua',
  shader: 'hlsl', hlsl: 'hlsl', cginc: 'hlsl', compute: 'hlsl', glsl: 'glsl', md: 'markdown',
  uss: 'css', uxml: 'xml', asmdef: 'json', unity: 'yaml', prefab: 'yaml', mat: 'yaml', asset: 'yaml'
};
function langOf(path) {
  const m = /\.([^./\\]+)$/.exec(path || '');
  return m ? (LANG_BY_EXT[m[1].toLowerCase()] || '') : '';
}

// Where a hunk's first change is, as a line number in the file *after* the commit — the
// hunk header's start is the first context line, up to N lines earlier.
function hunkLine(h) {
  let n = h.newStart;
  for (const l of h.lines) {
    if (l.t !== ' ') return Math.max(n, 1);
    n++;
  }
  return Math.max(h.newStart, 1);
}

// A fence longer than any backtick run in the content, so code containing ``` survives.
function fenceFor(text) {
  let longest = 0;
  for (const m of String(text).matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

const STATUS_WORD = { added: 'new file', deleted: 'deleted', modified: 'modified', renamed: 'renamed', copied: 'copied' };

// What one file amounts to, independent of the output format: a heading, notes, and blocks
// of either code (whole new file) or diff (hunks).
function describeFile(f, short) {
  const lfs = !f.binary && isLfsPointerDiff(f);
  const notes = [];
  const blocks = [];
  if (f.oldPath && f.status === 'renamed') notes.push(`Renamed from ${f.oldPath}`);
  if (f.oldPath && f.status === 'copied') notes.push(`Copied from ${f.oldPath}`);
  if (f.oldMode && f.newMode && f.oldMode !== f.newMode) notes.push(`File mode changed ${f.oldMode} → ${f.newMode}`);

  if (f.status === 'deleted') {
    notes.push('Delete this file' + (/\.meta$/i.test(f.path) ? '' : ' (and its .meta, if it has one)') + '.');
  } else if (f.binary || lfs) {
    notes.push(`${lfs ? 'Stored in Git LFS' : 'Binary file'} — it can't be written out as text. ` +
               `Take it from commit ${short} instead (Restore or Zip in GitGood).`);
  } else if (f.status === 'added' && f.hunks.length) {
    const code = f.hunks.flatMap(h => h.lines.filter(l => l.t === '+').map(l => l.s)).join('\n');
    if (UNITY_YAML_RE.test(f.path)) notes.push('Unity asset — take it from the commit rather than retyping this.');
    else notes.push('New file — full contents:');
    blocks.push({ kind: 'code', lang: langOf(f.path), text: code });
  } else if (f.hunks.length) {
    if (UNITY_YAML_RE.test(f.path)) {
      notes.push('Unity serialized asset — this is the raw YAML. Easier to redo the change in the Editor than to edit these lines.');
    }
    for (const h of f.hunks) {
      const line = hunkLine(h);
      blocks.push({ kind: 'diff', line, func: h.func,
        text: h.lines.map(l => l.t + l.s).join('\n') });
    }
  } else if (!notes.length) {
    notes.push(f.status === 'added' ? 'New empty file.' : 'No content changes.');
  }
  return { lfs, notes, blocks };
}

function statLabel(f, plain) {
  const word = STATUS_WORD[f.status] || 'modified';
  if (f.binary || f.status === 'deleted') return word;
  if (!f.adds && !f.dels) return word;
  return plain ? `${word}, +${f.adds} / -${f.dels}` : `${word}, +${f.adds} −${f.dels}`;
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

function dateOnly(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso || '');
  return m ? m[1] : (iso || '');
}

// Lines shared by both formats: who/what/how much, and the caveats.
function summary(exp) {
  const c = exp.commit || {};
  const files = exp.files || [];
  const adds = files.reduce((a, f) => a + (f.binary ? 0 : f.adds), 0);
  const dels = files.reduce((a, f) => a + (f.binary ? 0 : f.dels), 0);
  const of = exp.totalInCommit && exp.totalInCommit > files.length ? ` of ${exp.totalInCommit} in the commit` : '';
  const caveats = [];
  if (exp.ignoreWhitespace) caveats.push('Whitespace-only changes are left out.');
  if (exp.truncated) caveats.push('This export hit its size limit — the last file is cut short and any file listed under "Not included" was left out.');
  return { c, files, adds, dels, of, caveats };
}

function formatMarkdown(exp) {
  const { c, files, adds, dels, of, caveats } = summary(exp);
  const out = [];
  out.push(`## Changes from \`${c.short || ''}\`${c.subject ? ' — ' + c.subject : ''}`);
  out.push('');
  const meta = [];
  if (c.author) meta.push(`**Author:** ${c.author}${c.date ? ' · ' + dateOnly(c.date) : ''}`);
  meta.push(`**Files:** ${files.length}${of} · +${adds} −${dels}`);
  out.push(meta.join('  \n'));
  for (const cv of caveats) { out.push(''); out.push(`> ${cv}`); }

  // A file list up front, so a reader can see the scope before scrolling.
  if (files.length > 1) {
    out.push('');
    files.forEach((f, i) => out.push(`${i + 1}. \`${f.path}\` — ${statLabel(f)}`));
  }

  files.forEach((f, i) => {
    const d = describeFile(f, c.short || 'this commit');
    out.push('');
    out.push('---');
    out.push('');
    out.push(`### ${i + 1}. \`${f.path}\``);
    out.push(`*${statLabel(f)}*`);
    for (const n of d.notes) { out.push(''); out.push(n); }
    for (const b of d.blocks) {
      out.push('');
      if (b.kind === 'diff') {
        // "near", not "in": git labels a hunk with the nearest function line *above* it,
        // which for code added after a method is that method.
        out.push(`**Around line ${b.line}**${b.func ? ` — near \`${b.func.replace(/`/g, "'")}\`` : ''}`);
      }
      const fence = fenceFor(b.text);
      out.push(fence + (b.kind === 'diff' ? 'diff' : b.lang));
      out.push(b.text);
      out.push(fence);
    }
    if (f.cut) { out.push(''); out.push('*…the rest of this file\'s changes were cut off by the size limit.*'); }
  });

  if (exp.missing && exp.missing.length) {
    out.push('');
    out.push('---');
    out.push('');
    out.push(exp.truncated ? '**Not included (size limit):**' : '**No text changes to show:**');
    for (const p of exp.missing) out.push(`- \`${p}\``);
  }
  return out.join('\n') + '\n';
}

const RULE = '='.repeat(72);
const THIN = '-'.repeat(72);

function formatText(exp) {
  const { c, files, adds, dels, of, caveats } = summary(exp);
  const out = [];
  out.push(`CHANGES FROM COMMIT ${c.short || ''}${c.subject ? ' — ' + c.subject : ''}`);
  if (c.author) out.push(`Author: ${c.author}${c.date ? ', ' + dateOnly(c.date) : ''}`);
  out.push(`Files:  ${files.length}${of}  (+${adds} / -${dels})`);
  for (const cv of caveats) out.push(`Note:   ${cv}`);
  out.push('');
  out.push('Lines starting with "-" were removed, "+" were added; the rest is unchanged context.');
  if (files.length > 1) {
    out.push('');
    files.forEach((f, i) => out.push(`  ${i + 1}. ${f.path}  (${statLabel(f, true)})`));
  }
  out.push(RULE);

  files.forEach((f, i) => {
    const d = describeFile(f, c.short || 'this commit');
    out.push('');
    out.push(`[${i + 1}/${files.length}] ${f.path}  (${statLabel(f, true)})`);
    out.push(THIN);
    for (const n of d.notes) out.push(n);
    d.blocks.forEach((b, bi) => {
      if (b.kind === 'diff') {
        if (bi > 0 || d.notes.length) out.push('');
        out.push(`>> Around line ${b.line}${b.func ? `, near: ${b.func}` : ''}`);
      }
      out.push(b.text);
    });
    if (f.cut) out.push('...the rest of this file\'s changes were cut off by the size limit.');
    out.push('');
    out.push(RULE);
  });

  if (exp.missing && exp.missing.length) {
    out.push('');
    out.push(exp.truncated ? 'Not included (size limit):' : 'No text changes to show:');
    for (const p of exp.missing) out.push(`  - ${p}`);
  }
  return out.join('\n') + '\n';
}

// Selected paths → pathspecs. A renamed file needs its old path too, or git sees no source
// to pair it with and reports it as added (same rule as repo:showCommitFileDiff). Each pair
// stays adjacent so a chunked run keeps the two halves together in all but the rarest case.
function exportPathspecs(selected, nameStatus) {
  const oldOf = new Map();
  for (const r of nameStatus || []) if (r && r.oldPath && r.path) oldOf.set(r.path, r.oldPath);
  const seen = new Set();
  const out = [];
  for (const p of selected || []) {
    for (const q of [oldOf.get(p), p]) {
      if (q && !seen.has(q)) { seen.add(q); out.push(q); }
    }
  }
  return out;
}

module.exports = {
  unquoteGitPath, parseExportDiff, isLfsPointerDiff, hunkLine, fenceFor,
  formatMarkdown, formatText, exportPathspecs
};
