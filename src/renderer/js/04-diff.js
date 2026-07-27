// DIFF RENDERING
// ============================================
// Maximum diff lines to render at once. Beyond this we truncate with a notice;
// the user can still see the rest by switching to git CLI or by viewing per-file.
const DIFF_LINE_CAP = 20000;

function renderDiff(diffText, opts) {
  opts = opts || {};
  if (!diffText || !diffText.trim()) {
    return '<div class="empty-state"><p>No differences.</p></div>';
  }
  // Persist the last diff so the view-mode toggle can re-render without refetching.
  _lastDiff = { text: diffText, opts };
  return state.diffMode === 'split'
    ? renderDiffSplit(diffText, opts)
    : renderDiffUnified(diffText, opts);
}

// Remember the most recently rendered diff so toggling unified/split re-renders instantly.
let _lastDiff = null;
// Last commit-detail diff data for the History tab, so the toggle can re-render it.
let _historyDetailDiff = null;

// Returns HTML for a unified/split toggle reflecting the current mode. Used in the
// Changes pane header and the Graph/History commit-detail "Changes" headers. Clicks
// are handled by a single delegated listener (see below).
function diffModeToggleHtml() {
  const u = state.diffMode === 'split' ? '' : ' active';
  const s = state.diffMode === 'split' ? ' active' : '';
  const w = state.diffIgnoreWhitespace ? ' active' : '';
  return `<span class="diff-view-toggle">` +
    `<button class="diff-view-btn${u}" data-diffmode="unified" title="Unified view">☰ Unified</button>` +
    `<button class="diff-view-btn${s}" data-diffmode="split" title="Side-by-side view">◫ Split</button>` +
    `<button class="diff-view-btn${w}" data-diffws="1" title="Ignore whitespace-only changes (partial staging is unavailable while this is on)">⇥ Whitespace</button>` +
    `<button class="diff-view-btn diff-popout-btn" data-diffpopout="1" title="Pop the diff out into a large window">⤢ Pop Out</button>` +
  `</span>`;
}

// ============================================
// UNIFIED-DIFF PARSER
// ============================================
// Both renderers and the partial-staging patch builder work from this structure rather
// than re-scanning raw text, so what you see selected is exactly what gets patched.

// Git plumbing lines that carry no content for a human reader. They are hidden from the
// rendered output but kept in the file's headerLines, because a synthesized patch needs
// them verbatim to be applicable.
function isDiffPlumbingLine(raw) {
  return raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') ||
    raw.startsWith('old mode ') || raw.startsWith('new mode ') ||
    raw.startsWith('deleted file mode ') || raw.startsWith('new file mode ') ||
    raw.startsWith('similarity index ') || raw.startsWith('dissimilarity index ') ||
    raw.startsWith('rename from ') || raw.startsWith('rename to ') ||
    raw.startsWith('copy from ') || raw.startsWith('copy to ');
}

// Parse a (possibly multi-file) unified diff.
// Returns { preamble, files: [{ path, headerLines, hunks, binary, isNew, isDeleted }] }
// where each hunk is { heading, oldStart, oldCount, newStart, newCount, lines } and each
// line is { type: ' '|'+'|'-', text, raw, noNewline }.
function parseUnifiedDiff(diffText) {
  const src = String(diffText || '').split('\n');
  const preamble = [];
  const files = [];
  let file = null;
  let hunk = null;

  const startFile = (raw) => {
    // Best-effort path from "diff --git a/X b/Y"; refined below from the +++/--- lines,
    // which each carry a single unambiguous path.
    const m = raw.match(/ b\/(.+)$/);
    file = {
      path: m ? m[1] : raw.replace('diff --git ', ''),
      pathLocked: false,
      headerLines: [raw],
      hunks: [],
      binary: false,
      isNew: false,
      isDeleted: false
    };
    files.push(file);
    hunk = null;
  };

  for (let i = 0; i < src.length; i++) {
    const raw = src[i];

    if (raw.startsWith('diff --git')) { startFile(raw); continue; }

    if (!file) {
      // Content before the first "diff --git" — for `git show` this is the commit
      // metadata. Keep it so callers can display it if they want to.
      preamble.push(raw);
      continue;
    }

    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      hunk = {
        raw,
        heading: m ? (m[5] || '') : '',
        oldStart: m ? parseInt(m[1], 10) : 0,
        oldCount: m ? (m[2] === undefined ? 1 : parseInt(m[2], 10)) : 0,
        newStart: m ? parseInt(m[3], 10) : 0,
        newCount: m ? (m[4] === undefined ? 1 : parseInt(m[4], 10)) : 0,
        lines: []
      };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      // Still in the file header block.
      if (raw.startsWith('new file mode')) file.isNew = true;
      else if (raw.startsWith('deleted file mode')) file.isDeleted = true;
      else if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) {
        file.binary = true;
        file.binaryNotice = raw;
        continue;
      }
      // Lock the path from the unambiguous +++ / --- lines.
      if (!file.pathLocked && raw.startsWith('+++ ')) {
        const p = raw.slice(4).replace(/^b\//, '').trim();
        if (p && p !== '/dev/null') { file.path = p; file.pathLocked = true; }
      } else if (!file.pathLocked && raw.startsWith('--- ')) {
        const p = raw.slice(4).replace(/^a\//, '').trim();
        if (p && p !== '/dev/null') file.path = p;
      }
      if (isDiffPlumbingLine(raw) || raw.startsWith('diff ')) file.headerLines.push(raw);
      continue;
    }

    // Inside a hunk body.
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line just before it.
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    if (raw.startsWith('+')) { hunk.lines.push({ type: '+', text: raw.slice(1), raw }); continue; }
    if (raw.startsWith('-')) { hunk.lines.push({ type: '-', text: raw.slice(1), raw }); continue; }
    if (raw.startsWith(' ')) { hunk.lines.push({ type: ' ', text: raw.slice(1), raw }); continue; }
    if (raw === '') {
      // A trailing empty string from the final split — only meaningful mid-hunk, where
      // git emits a bare empty line for an empty context line.
      if (i < src.length - 1) hunk.lines.push({ type: ' ', text: '', raw: ' ' });
      continue;
    }
    // Anything else (e.g. "Binary files ... differ" after a hunk) ends the hunk body.
    if (raw.startsWith('Binary files')) { file.binary = true; file.binaryNotice = raw; }
    hunk = null;
  }

  return { preamble, files };
}

// Total rendered line count for a parsed diff — used for the truncation cap.
function parsedDiffLineCount(parsed) {
  let n = parsed.preamble.length;
  for (const f of parsed.files) {
    n += 1;
    for (const h of f.hunks) n += 1 + h.lines.length;
  }
  return n;
}

// ============================================
// WORD-LEVEL (INTRA-LINE) DIFF
// ============================================
// When a removed line is paired with an added line, highlighting only the tokens that
// actually changed makes the edit readable at a glance instead of forcing a character
// hunt across two near-identical lines.
//
// This produces CHARACTER RANGES rather than HTML, because syntax highlighting needs to
// mark the same text at the same time. Both range sets are merged in renderCodeLine, so a
// changed keyword can be both "keyword" and "changed" without either wrapper losing out.

// Split into word-ish tokens, keeping each token's offset. Whitespace is its own token so
// indentation changes show up instead of being folded into the neighbouring word.
function tokenizeForWordDiff(s) {
  const re = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// Above this many tokens on either side we skip the pairwise LCS and fall back to marking
// the whole changed span — the cost isn't worth it on machine-generated lines.
const WORD_DIFF_MAX_TOKENS = 200;
const WORD_DIFF_LCS_MAX = 60;
// Lines sharing less than this fraction of their tokens are treated as unrelated rewrites;
// marking every token would be pure noise, so we mark nothing.
const WORD_DIFF_MIN_SIMILARITY = 0.25;

// Merge touching/overlapping ranges so the renderer emits one span per run.
function mergeRanges(ranges) {
  if (!ranges.length) return ranges;
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [ranges[0].slice()];
  for (let i = 1; i < ranges.length; i++) {
    const last = out[out.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else out.push(ranges[i].slice());
  }
  return out;
}

// Compare two lines and return { oldRanges, newRanges } of changed character spans, or
// null when intra-line highlighting shouldn't apply at all.
function wordDiffRanges(oldText, newText) {
  if (oldText === newText) return null;
  const a = tokenizeForWordDiff(oldText);
  const b = tokenizeForWordDiff(newText);
  if (!a.length || !b.length) return null;
  if (a.length > WORD_DIFF_MAX_TOKENS || b.length > WORD_DIFF_MAX_TOKENS) return null;

  // Trim the common head and tail first. For a typical edit this leaves a tiny middle,
  // which is what keeps the LCS below affordable.
  let head = 0;
  while (head < a.length && head < b.length && a[head].text === b[head].text) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head &&
         a[a.length - 1 - tail].text === b[b.length - 1 - tail].text) tail++;

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);

  const commonTokens = head + tail;
  const maxLen = Math.max(a.length, b.length);
  if (commonTokens / maxLen < WORD_DIFF_MIN_SIMILARITY) return null;

  let aMarks, bMarks;
  if (!aMid.length && !bMid.length) {
    return null;
  } else if (!aMid.length || !bMid.length ||
             aMid.length > WORD_DIFF_LCS_MAX || bMid.length > WORD_DIFF_LCS_MAX) {
    // Pure insertion/deletion in the middle, or a middle too large to align cheaply —
    // mark the whole middle on each side.
    aMarks = aMid.map(() => true);
    bMarks = bMid.map(() => true);
  } else {
    const aligned = lcsMarks(aMid.map(t => t.text), bMid.map(t => t.text));
    aMarks = aligned.aMarks;
    bMarks = aligned.bMarks;
  }

  const toRanges = (mid, marks) => {
    const r = [];
    for (let i = 0; i < mid.length; i++) if (marks[i]) r.push([mid[i].start, mid[i].end]);
    return mergeRanges(r);
  };

  return { oldRanges: toRanges(aMid, aMarks), newRanges: toRanges(bMid, bMarks) };
}

// Classic LCS table over two short token arrays. Returns a boolean per token saying
// "this token is NOT part of the common subsequence", i.e. it changed.
function lcsMarks(a, b) {
  const n = a.length, m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const at = (i, j) => dp[i * (m + 1) + j];
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const aMarks = new Array(n).fill(true);
  const bMarks = new Array(m).fill(true);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { aMarks[i] = false; bMarks[j] = false; i++; j++; }
    else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return { aMarks, bMarks };
}

// Pair a run of removed lines with a run of added lines inside one hunk. Pairing is
// positional (the k-th removal with the k-th addition), which is what a reader expects for
// an edited block and what the split view already does structurally.
function computeWordDiffs(delLines, addLines) {
  const n = Math.min(delLines.length, addLines.length);
  const pairs = new Array(n);
  for (let k = 0; k < n; k++) {
    pairs[k] = wordDiffRanges(delLines[k].text, addLines[k].text);
  }
  return pairs;
}

// ============================================
// SYNTAX HIGHLIGHTING
// ============================================
// Self-contained on purpose: the renderer has no bundler and no network, so pulling in a
// highlighting library isn't an option. This is a single-pass, per-line lexer — good enough
// to make code readable, and deliberately not a parser. Being line-local means a block
// comment's interior lines aren't dimmed (a diff shows discontiguous lines, so carrying
// state across them would be wrong as often as it was right).

// Longest extension match wins, so ".d.ts" style suffixes resolve sensibly.
const SYNTAX_LANG_BY_EXT = {
  js: 'clike', mjs: 'clike', cjs: 'clike', jsx: 'clike', ts: 'clike', tsx: 'clike',
  c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike', cxx: 'clike', hpp: 'clike',
  cs: 'clike', java: 'clike', go: 'clike', rs: 'clike', swift: 'clike', kt: 'clike',
  kts: 'clike', scala: 'clike', php: 'clike', m: 'clike', mm: 'clike', dart: 'clike',
  glsl: 'clike', hlsl: 'clike', shader: 'clike', cginc: 'clike', compute: 'clike',
  py: 'python', pyw: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'shell',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', xaml: 'markup',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml', cfg: 'yaml',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql'
};

function detectLanguage(filePath) {
  if (!filePath) return null;
  const base = String(filePath).split('/').pop().toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return SYNTAX_LANG_BY_EXT[ext] || null;
}

const CLIKE_KEYWORDS = 'abstract|as|async|await|base|break|case|catch|class|const|constexpr|continue|def|default|defer|delegate|delete|do|dynamic|elif|else|enum|event|explicit|export|extends|extern|final|finally|fn|for|foreach|friend|from|func|function|get|go|goto|if|impl|implements|import|in|inline|instanceof|interface|internal|is|lateinit|let|lock|loop|match|mod|module|mut|mutable|namespace|new|noexcept|object|operator|out|override|package|params|private|protected|pub|public|range|readonly|record|ref|register|return|sealed|select|set|sizeof|stackalloc|static|struct|super|switch|synchronized|template|throw|throws|trait|transient|try|type|typedef|typename|typeof|union|unsafe|use|using|var|virtual|void|volatile|when|where|while|with|yield';
const CLIKE_TYPES = 'bool|boolean|byte|char|decimal|double|float|int|int8|int16|int32|int64|long|sbyte|short|signed|size_t|string|uint|uint8|uint16|uint32|uint64|ulong|unsigned|ushort|usize|isize|str|String|Vec|Option|Result|List|Dictionary|Map|Set|Array|Task|Promise|number|any|unknown|never|object|symbol|bigint|Vector2|Vector3|Vector4|Quaternion|GameObject|Transform|MonoBehaviour';
const CLIKE_LITERALS = 'true|false|null|nullptr|undefined|NaN|Infinity|this|self|nil|None|True|False|base';

const PY_KEYWORDS = 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case';
const SHELL_KEYWORDS = 'if|then|elif|else|fi|for|while|until|do|done|case|esac|function|return|in|select|time|coproc|local|export|readonly|declare|typeset|unset|shift|source|alias|trap|set|echo|exit|cd';
const SQL_KEYWORDS = 'add|all|alter|and|as|asc|begin|between|by|case|cast|check|column|commit|constraint|create|cross|database|default|delete|desc|distinct|drop|else|end|exists|foreign|from|full|group|having|if|in|index|inner|insert|into|is|join|key|left|like|limit|not|null|offset|on|or|order|outer|primary|references|right|rollback|select|set|table|then|transaction|truncate|union|unique|update|values|view|when|where|with';

// Each language is one ordered alternation. Order matters: comments and strings come first
// so a keyword inside a string is never highlighted as a keyword.
const SYNTAX_PATTERNS = {
  clike: [
    ['com', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/],
    ['str', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/],
    ['ann', /@[A-Za-z_]\w*|#\s*(?:include|define|ifdef|ifndef|endif|pragma|if|else|elif|undef|region|endregion)\b/],
    ['num', /\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[fFdDlLuUmM]?\b/],
    ['lit', new RegExp('\\b(?:' + CLIKE_LITERALS + ')\\b')],
    ['kw', new RegExp('\\b(?:' + CLIKE_KEYWORDS + ')\\b')],
    ['typ', new RegExp('\\b(?:' + CLIKE_TYPES + ')\\b')],
    ['fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/],
    ['typ', /\b[A-Z][A-Za-z0-9_]*\b/]
  ],
  python: [
    ['com', /#[^\n]*/],
    ['str', /[fFrRbBuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/],
    ['ann', /@[A-Za-z_][\w.]*/],
    ['num', /\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?j?\b/],
    ['lit', /\b(?:True|False|None|self|cls)\b/],
    ['kw', new RegExp('\\b(?:' + PY_KEYWORDS + ')\\b')],
    ['fn', /\b[A-Za-z_]\w*(?=\s*\()/],
    ['typ', /\b(?:int|float|str|bool|bytes|list|dict|tuple|set|frozenset|object|type)\b|\b[A-Z][A-Za-z0-9_]*\b/]
  ],
  shell: [
    ['com', /#[^\n]*/],
    ['str', /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/],
    ['var', /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]/],
    ['num', /\b\d+\b/],
    ['kw', new RegExp('\\b(?:' + SHELL_KEYWORDS + ')\\b')],
    ['ann', /(?:^|\s)-{1,2}[A-Za-z][\w-]*/]
  ],
  css: [
    ['com', /\/\*[\s\S]*?(?:\*\/|$)/],
    ['str', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/],
    ['ann', /@[\w-]+/],
    ['lit', /#[0-9a-fA-F]{3,8}\b/],
    ['num', /\b\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|pt|ch|ex)?\b/],
    ['prop', /[-a-zA-Z]+(?=\s*:)/],
    ['fn', /\b[a-zA-Z-]+(?=\()/],
    ['typ', /[.#][-\w]+|::?[-\w]+/]
  ],
  markup: [
    ['com', /<!--[\s\S]*?(?:-->|$)/],
    ['str', /"(?:[^"]*)"|'(?:[^']*)'/],
    ['kw', /<\/?[A-Za-z][\w:.-]*|\/?>/],
    ['prop', /\b[A-Za-z_:][\w:.-]*(?==)/],
    ['ann', /&[a-zA-Z#]\w*;/]
  ],
  json: [
    ['prop', /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/],
    ['str', /"(?:\\[\s\S]|[^"\\])*"/],
    ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
    ['lit', /\b(?:true|false|null)\b/]
  ],
  yaml: [
    ['com', /#[^\n]*/],
    ['str', /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/],
    ['prop', /^\s*-?\s*[\w.$-]+(?=\s*:)|^\s*\[[\w.$-]+\]/],
    ['num', /\b-?\d+(?:\.\d+)?\b/],
    ['lit', /\b(?:true|false|null|yes|no|on|off|~)\b/],
    ['ann', /^\s*-\s/]
  ],
  markdown: [
    ['kw', /^#{1,6}\s.*$/],
    ['str', /`[^`]*`|```.*$/],
    ['ann', /^\s*(?:[-*+]|\d+\.)\s|^\s*>\s?/],
    ['fn', /\[[^\]]*\]\([^)]*\)/],
    ['lit', /\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_/]
  ],
  sql: [
    ['com', /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/],
    ['str', /'(?:''|[^'])*'|"(?:[^"])*"/],
    ['num', /\b\d+(?:\.\d+)?\b/],
    ['kw', new RegExp('\\b(?:' + SQL_KEYWORDS + ')\\b', 'i')],
    ['fn', /\b[A-Za-z_]\w*(?=\s*\()/]
  ]
};

// One combined regex per language, built lazily and cached. Group N+1 corresponds to
// pattern N, so the matching class is found by asking which group is defined.
const _syntaxRegexCache = new Map();
function syntaxRegexFor(lang) {
  if (_syntaxRegexCache.has(lang)) return _syntaxRegexCache.get(lang);
  const patterns = SYNTAX_PATTERNS[lang];
  if (!patterns) { _syntaxRegexCache.set(lang, null); return null; }
  // `i` is only wanted where the language declares it (SQL); combining is simpler if we
  // apply it uniformly to languages whose patterns are all case-insensitive-safe.
  const anyInsensitive = patterns.some(([, re]) => re.flags.includes('i'));
  const source = patterns.map(([, re]) => '(' + re.source + ')').join('|');
  const combined = { re: new RegExp(source, 'gm' + (anyInsensitive ? 'i' : '')), classes: patterns.map(p => p[0]) };
  _syntaxRegexCache.set(lang, combined);
  return combined;
}

// Lines longer than this skip highlighting: minified bundles and data blobs are where the
// regex cost blows up, and they're unreadable either way.
const SYNTAX_MAX_LINE = 400;

// Token ranges for one line: [[start, end, className], ...], non-overlapping, in order.
function syntaxRanges(text, lang) {
  const combined = syntaxRegexFor(lang);
  if (!combined || !text || text.length > SYNTAX_MAX_LINE) return [];
  const out = [];
  const re = combined.re;
  re.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    if (guard++ > 500) break;                 // pathological line; stop tokenizing
    if (m[0] === '') { re.lastIndex++; continue; }
    // Which alternative matched?
    let cls = null;
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) { cls = combined.classes[i - 1]; break; }
    }
    if (cls) out.push([m.index, m.index + m[0].length, 'tk-' + cls]);
  }
  return out;
}

// ============================================
// CODE LINE RENDERING
// ============================================
// The one place where syntax tokens and word-diff ranges are combined. Both are expressed
// as character ranges over the same text, so we walk the line once and emit a span per run
// of characters that share the same (syntax class, changed) pair. That's what lets a
// changed keyword be styled as both, instead of one wrapper clobbering the other.
function renderCodeLine(text, changedRanges, lang) {
  const n = text.length;
  if (!n) return '';
  const useSyntax = lang && state.diffSyntax !== false;
  const syn = useSyntax ? syntaxRanges(text, lang) : [];
  const hasChanged = changedRanges && changedRanges.length;

  // Fast path: nothing to mark at all.
  if (!syn.length && !hasChanged) return escapeHtml(text);

  const cls = new Array(n).fill('');
  for (const [s, e, c] of syn) {
    for (let i = Math.max(0, s); i < Math.min(e, n); i++) cls[i] = c;
  }
  const chg = new Array(n).fill(false);
  if (hasChanged) {
    for (const [s, e] of changedRanges) {
      for (let i = Math.max(0, s); i < Math.min(e, n); i++) chg[i] = true;
    }
  }

  let out = '';
  let i = 0;
  while (i < n) {
    const c = cls[i], k = chg[i];
    let j = i + 1;
    while (j < n && cls[j] === c && chg[j] === k) j++;
    const seg = escapeHtml(text.slice(i, j));
    if (c && k) out += `<span class="${c} wd">${seg}</span>`;
    else if (c) out += `<span class="${c}">${seg}</span>`;
    else if (k) out += `<span class="wd">${seg}</span>`;
    else out += seg;
    i = j;
  }
  return out;
}

// ============================================
// PARTIAL STAGING — selection state
// ============================================
// Only one diff at a time is ever stageable (the Changes tab's selected file), so a
// single module-level record is enough. `selected` holds "<hunkIndex>:<lineIndex>" keys
// pointing into `parsedFile.hunks`, which is the same structure buildPartialPatch walks.
const partialStaging = {
  fileKey: null,      // "staged:path" / "unstaged:path"
  path: null,
  staged: false,
  parsedFile: null,
  // Fingerprint of the diff the selection was made against. Selections are hunk/line
  // indices, so a changed diff invalidates them (see partialStagingBind).
  diffHash: null,
  selected: new Set(),
  // Flat list of "<h>:<l>" keys in visual order, for shift-click range selection.
  order: [],
  lastClicked: null
};

function partialStagingReset() {
  partialStaging.selected.clear();
  partialStaging.lastClicked = null;
}

// A cheap, order-sensitive string hash. Only used to notice that a diff's *content*
// changed between renders — not for anything security-related.
function cheapHash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + str.length;
}

// Prepare the selection state for a newly rendered stageable diff. Clears the selection
// when the file (or its staged/unstaged side) changed, and keeps it otherwise so a
// re-render — e.g. flipping unified/split — doesn't lose what you had ticked.
//
// It also clears when the diff TEXT changed for the same file. Selections are stored as
// hunk/line indices, so if the file was edited underneath us those indices now address
// different lines and acting on them would stage something the user never picked. The
// working-tree watcher makes that a routine occurrence rather than a rare one.
function partialStagingBind(parsedFile, opts, diffText) {
  const fileKey = (opts.staged ? 'staged:' : 'unstaged:') + opts.filePath;
  const diffHash = cheapHash(diffText);
  if (partialStaging.fileKey !== fileKey) {
    partialStaging.fileKey = fileKey;
    partialStagingReset();
  } else if (partialStaging.diffHash && partialStaging.diffHash !== diffHash) {
    const had = partialStaging.selected.size;
    partialStagingReset();
    if (had) showToast('The file changed on disk — line selection cleared', 'info', 4000);
  }
  partialStaging.diffHash = diffHash;
  partialStaging.path = opts.filePath;
  partialStaging.staged = !!opts.staged;
  partialStaging.parsedFile = parsedFile;
  partialStaging.order = [];
  parsedFile.hunks.forEach((h, hi) => {
    h.lines.forEach((l, li) => { if (l.type !== ' ') partialStaging.order.push(hi + ':' + li); });
  });
  // Drop selections that no longer exist (the diff shrank since they were made).
  const valid = new Set(partialStaging.order);
  for (const k of [...partialStaging.selected]) if (!valid.has(k)) partialStaging.selected.delete(k);
}

// The action bar shown above a stageable diff.
function partialBarHtml(staged) {
  const primary = staged
    ? `<button class="dpartial-btn" data-partial-action="unstage">⇣ Unstage lines</button>`
    : `<button class="dpartial-btn" data-partial-action="stage">⇡ Stage lines</button>` +
      `<button class="dpartial-btn danger" data-partial-action="discard">✕ Discard lines</button>`;
  return `<div class="dpartial-bar" id="dpartial-bar">` +
    `<span class="dpartial-count" id="dpartial-count">0 lines selected</span>` +
    `<span class="dpartial-actions">${primary}` +
    `<button class="dpartial-btn" data-partial-action="clear">Clear</button></span>` +
  `</div>`;
}

// Reflect the current selection size in the bar without re-rendering the whole diff.
function updatePartialBar() {
  const bar = document.getElementById('dpartial-bar');
  if (!bar) return;
  const n = partialStaging.selected.size;
  bar.classList.toggle('active', n > 0);
  const count = document.getElementById('dpartial-count');
  if (count) count.textContent = n === 0
    ? 'Click lines to stage part of a change'
    : `${n} line${n === 1 ? '' : 's'} selected`;
}

// ============================================
// PARTIAL STAGING — patch synthesis
// ============================================
// Build a unified patch containing only the selected lines, suitable for `git apply`.
//
// `reverse` says the patch will be applied with -R, which flips which side of the diff
// git reads as the source and therefore how unselected lines must be treated:
//
//   forward (stage)              reverse (unstage / discard)
//   ------------------------     -----------------------------
//   source is the OLD side       source is the NEW side
//   unselected '+' → drop        unselected '+' → keep as context
//   unselected '-' → context     unselected '-' → drop
//
// Getting this backwards produces a patch whose context doesn't match the file, which is
// the classic "patch does not apply" failure in hand-rolled partial staging.
function buildPartialPatch(parsedFile, selectedKeys, options) {
  const reverse = !!(options && options.reverse);
  const out = [];
  const hunkTexts = [];
  let runningDelta = 0;

  parsedFile.hunks.forEach((hunk, hi) => {
    const body = [];
    let oldCount = 0, newCount = 0, changed = 0;

    hunk.lines.forEach((line, li) => {
      const selected = selectedKeys.has(hi + ':' + li);
      let emitType = null;

      if (line.type === ' ') emitType = ' ';
      else if (line.type === '+') {
        if (selected) { emitType = '+'; changed++; }
        else emitType = reverse ? ' ' : null;
      } else if (line.type === '-') {
        if (selected) { emitType = '-'; changed++; }
        else emitType = reverse ? null : ' ';
      }

      if (emitType === null) return;
      body.push(emitType + line.text);
      if (line.noNewline) body.push('\\ No newline at end of file');
      if (emitType === ' ') { oldCount++; newCount++; }
      else if (emitType === '+') newCount++;
      else if (emitType === '-') oldCount++;
    });

    // A hunk with nothing selected contributes nothing — skip it entirely so the patch
    // stays as small as possible (fewer chances for context to drift).
    if (!changed) return;

    // Anchor the side git reads as the source to its original position, and derive the
    // other side from the drift accumulated by the hunks emitted before this one.
    const oldStart = reverse ? Math.max(1, hunk.newStart - runningDelta) : hunk.oldStart;
    const newStart = reverse ? hunk.newStart : hunk.oldStart + runningDelta;
    runningDelta += (newCount - oldCount);

    hunkTexts.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.heading}\n` + body.join('\n')
    );
  });

  if (!hunkTexts.length) return '';

  // Header. For a deleted file whose deletion is only partially selected, the patch is no
  // longer a deletion — strip the marker and point +++ back at the real path, otherwise
  // git rejects a "deleted" patch that still leaves content behind.
  let header = parsedFile.headerLines.slice();
  const totalRemovals = parsedFile.hunks.reduce(
    (n, h) => n + h.lines.filter(l => l.type === '-').length, 0);
  const selectedRemovals = parsedFile.hunks.reduce(
    (n, h, hi) => n + h.lines.filter((l, li) => l.type === '-' && selectedKeys.has(hi + ':' + li)).length, 0);
  if (parsedFile.isDeleted && selectedRemovals < totalRemovals) {
    header = header
      .filter(l => !l.startsWith('deleted file mode '))
      .map(l => l.startsWith('+++ ') ? `+++ b/${parsedFile.path}` : l);
  }

  out.push(header.join('\n'));
  out.push(hunkTexts.join('\n'));
  return out.join('\n') + '\n';
}

// Every line of a hunk, as selection keys — used by the whole-hunk buttons.
function hunkLineKeys(parsedFile, hunkIndex) {
  const hunk = parsedFile.hunks[hunkIndex];
  if (!hunk) return [];
  const keys = [];
  hunk.lines.forEach((l, li) => { if (l.type !== ' ') keys.push(hunkIndex + ':' + li); });
  return keys;
}

// ============================================
// UNIFIED VIEW
// ============================================
function renderDiffUnified(diffText, opts) {
  opts = opts || {};
  if (!diffText || !diffText.trim()) {
    return '<div class="empty-state"><p>No differences.</p></div>';
  }
  const parsed = parseUnifiedDiff(diffText);
  const cap = opts.lineCap || DIFF_LINE_CAP;
  const totalLines = parsedDiffLineCount(parsed);
  const truncatedByCap = totalLines > cap;

  // Partial staging only makes sense for a single working-tree file.
  const stageable = !!(opts.stageable && parsed.files.length === 1 && !parsed.files[0].binary);
  if (stageable) partialStagingBind(parsed.files[0], opts, diffText);

  const out = [];
  if (stageable) out.push(partialBarHtml(!!opts.staged));

  let emitted = 0;
  let stop = false;

  for (const file of parsed.files) {
    if (stop) break;
    out.push(`<div class="diff-file-header">⚔ ${escapeHtml(file.path)}</div>`);
    emitted++;
    if (file.binary) {
      // Images get a real comparison instead of a "binary files differ" dead end.
      out.push(isImagePath(file.path)
        ? imageDiffPlaceholderHtml(file.path, opts.imageRevs)
        : `<div class="diff-notice">${escapeHtml(file.binaryNotice || 'Binary file differs')}</div>`);
      continue;
    }

    const lang = detectLanguage(file.path);
    file.hunks.forEach((hunk, hi) => {
      if (stop) return;
      const actions = stageable
        ? `<span class="dhunk-actions">` +
            (opts.staged
              ? `<button class="dhunk-btn" data-hunk-action="unstage" data-hunk="${hi}" title="Unstage this hunk">⇣ Unstage</button>`
              : `<button class="dhunk-btn" data-hunk-action="stage" data-hunk="${hi}" title="Stage this hunk">⇡ Stage</button>` +
                `<button class="dhunk-btn danger" data-hunk-action="discard" data-hunk="${hi}" title="Discard this hunk">✕ Discard</button>`) +
            `<button class="dhunk-btn" data-hunk-action="select" data-hunk="${hi}" title="Select every line in this hunk">☑ Select</button>` +
          `</span>`
        : '';
      out.push(
        `<div class="diff-line hunk${stageable ? ' has-actions' : ''}" data-hunk="${hi}">` +
          `<div class="diff-gutter"></div><div class="diff-gutter"></div>` +
          `<div class="diff-text">${escapeHtml(hunk.raw)}</div>${actions}` +
        `</div>`);
      emitted++;

      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;

      // Walk the hunk in runs so a block of removals followed by a block of additions can
      // be paired up for intra-line highlighting.
      let i = 0;
      while (i < hunk.lines.length) {
        if (emitted >= cap) { stop = true; return; }
        const line = hunk.lines[i];

        if (line.type === ' ') {
          out.push(
            `<div class="diff-line">` +
              `<div class="diff-gutter">${oldLine}</div><div class="diff-gutter">${newLine}</div>` +
              `<div class="diff-text"> ${renderCodeLine(line.text, null, lang)}</div>` +
            `</div>`);
          oldLine++; newLine++; emitted++; i++;
          continue;
        }

        // Collect the run of removals, then the run of additions that follows it.
        const delRun = [];
        while (i < hunk.lines.length && hunk.lines[i].type === '-') { delRun.push({ line: hunk.lines[i], idx: i }); i++; }
        const addRun = [];
        while (i < hunk.lines.length && hunk.lines[i].type === '+') { addRun.push({ line: hunk.lines[i], idx: i }); i++; }

        const pairs = (delRun.length && addRun.length)
          ? computeWordDiffs(delRun.map(d => d.line), addRun.map(a => a.line))
          : [];

        delRun.forEach((d, k) => {
          const key = hi + ':' + d.idx;
          const sel = stageable && partialStaging.selected.has(key);
          const html = renderCodeLine(d.line.text, pairs[k] ? pairs[k].oldRanges : null, lang);
          out.push(
            `<div class="diff-line del${stageable ? ' dsel' : ''}${sel ? ' selected' : ''}"` +
              (stageable ? ` data-dkey="${key}"` : '') + `>` +
              `<div class="diff-gutter">${oldLine + k}</div><div class="diff-gutter"></div>` +
              `<div class="diff-text">-${html}</div>` +
            `</div>`);
          emitted++;
        });
        oldLine += delRun.length;

        addRun.forEach((a, k) => {
          const key = hi + ':' + a.idx;
          const sel = stageable && partialStaging.selected.has(key);
          const html = renderCodeLine(a.line.text, pairs[k] ? pairs[k].newRanges : null, lang);
          out.push(
            `<div class="diff-line add${stageable ? ' dsel' : ''}${sel ? ' selected' : ''}"` +
              (stageable ? ` data-dkey="${key}"` : '') + `>` +
              `<div class="diff-gutter"></div><div class="diff-gutter">${newLine + k}</div>` +
              `<div class="diff-text">+${html}</div>` +
            `</div>`);
          emitted++;
        });
        newLine += addRun.length;

        // Neither a context line nor a +/- run: guard against an infinite loop.
        if (!delRun.length && !addRun.length) i++;
      }
    });
  }

  let html = out.join('');
  const truncated = truncatedByCap || opts.diffTruncated;
  if (truncated) {
    const reason = truncatedByCap
      ? `Showing first ${cap.toLocaleString()} of ${totalLines.toLocaleString()} lines.`
      : `Diff was truncated to ${Math.round((opts.diffBytes || 0) / 1024 / 1024 * 10) / 10} MB.`;
    html += `<div class="diff-notice">⚔ ${escapeHtml(reason)} The diff is too large to render fully.</div>`;
  }
  return html;
}

// ============================================
// SPLIT (SIDE-BY-SIDE) VIEW
// ============================================
// Deleted lines pair with added lines on the same row; context lines appear on both
// sides. Word-level highlighting uses the same pairing, so a row reads as one edit.
function renderDiffSplit(diffText, opts) {
  opts = opts || {};
  if (!diffText || !diffText.trim()) {
    return '<div class="empty-state"><p>No differences.</p></div>';
  }
  const parsed = parseUnifiedDiff(diffText);
  const cap = opts.lineCap || DIFF_LINE_CAP;
  const totalLines = parsedDiffLineCount(parsed);
  const truncatedByCap = totalLines > cap;

  const stageable = !!(opts.stageable && parsed.files.length === 1 && !parsed.files[0].binary);
  if (stageable) partialStagingBind(parsed.files[0], opts, diffText);

  const parts = [];
  let emitted = 0;
  let stop = false;

  for (const file of parsed.files) {
    if (stop) break;
    parts.push(`<div class="dsplit-row meta"><div class="dsplit-file">⚔ ${escapeHtml(file.path)}</div></div>`);
    emitted++;
    if (file.binary) {
      parts.push(isImagePath(file.path)
        ? `<div class="dsplit-row meta">${imageDiffPlaceholderHtml(file.path, opts.imageRevs)}</div>`
        : `<div class="dsplit-row meta"><div class="dsplit-meta">${escapeHtml(file.binaryNotice || 'Binary file differs')}</div></div>`);
      continue;
    }

    const lang = detectLanguage(file.path);
    file.hunks.forEach((hunk, hi) => {
      if (stop) return;
      const actions = stageable
        ? `<span class="dhunk-actions">` +
            (opts.staged
              ? `<button class="dhunk-btn" data-hunk-action="unstage" data-hunk="${hi}" title="Unstage this hunk">⇣ Unstage</button>`
              : `<button class="dhunk-btn" data-hunk-action="stage" data-hunk="${hi}" title="Stage this hunk">⇡ Stage</button>` +
                `<button class="dhunk-btn danger" data-hunk-action="discard" data-hunk="${hi}" title="Discard this hunk">✕ Discard</button>`) +
            `<button class="dhunk-btn" data-hunk-action="select" data-hunk="${hi}" title="Select every line in this hunk">☑ Select</button>` +
          `</span>`
        : '';
      parts.push(
        `<div class="dsplit-row meta${stageable ? ' has-actions' : ''}">` +
          `<div class="dsplit-meta">${escapeHtml(hunk.raw)}</div>${actions}` +
        `</div>`);
      emitted++;

      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      let i = 0;

      while (i < hunk.lines.length) {
        if (emitted >= cap) { stop = true; return; }
        const line = hunk.lines[i];

        if (line.type === ' ') {
          parts.push(
            `<div class="dsplit-row">` +
              `<div class="dsplit-side"><span class="dsplit-num">${oldLine}</span><span class="dsplit-text">${renderCodeLine(line.text, null, lang)}</span></div>` +
              `<div class="dsplit-side"><span class="dsplit-num">${newLine}</span><span class="dsplit-text">${renderCodeLine(line.text, null, lang)}</span></div>` +
            `</div>`);
          oldLine++; newLine++; emitted++; i++;
          continue;
        }

        const delRun = [];
        while (i < hunk.lines.length && hunk.lines[i].type === '-') { delRun.push({ line: hunk.lines[i], idx: i }); i++; }
        const addRun = [];
        while (i < hunk.lines.length && hunk.lines[i].type === '+') { addRun.push({ line: hunk.lines[i], idx: i }); i++; }
        if (!delRun.length && !addRun.length) { i++; continue; }

        const pairs = (delRun.length && addRun.length)
          ? computeWordDiffs(delRun.map(d => d.line), addRun.map(a => a.line))
          : [];

        const rows = Math.max(delRun.length, addRun.length);
        for (let k = 0; k < rows; k++) {
          if (emitted >= cap) { stop = true; return; }
          const d = delRun[k];
          const a = addRun[k];

          let left;
          if (d) {
            const key = hi + ':' + d.idx;
            const sel = stageable && partialStaging.selected.has(key);
            const html = renderCodeLine(d.line.text, pairs[k] ? pairs[k].oldRanges : null, lang);
            left = `<div class="dsplit-side del${stageable ? ' dsel' : ''}${sel ? ' selected' : ''}"` +
              (stageable ? ` data-dkey="${key}"` : '') + `>` +
              `<span class="dsplit-num">${oldLine + k}</span><span class="dsplit-text">${html}</span></div>`;
          } else {
            left = `<div class="dsplit-side empty"><span class="dsplit-num"></span><span class="dsplit-text"></span></div>`;
          }

          let right;
          if (a) {
            const key = hi + ':' + a.idx;
            const sel = stageable && partialStaging.selected.has(key);
            const html = renderCodeLine(a.line.text, pairs[k] ? pairs[k].newRanges : null, lang);
            right = `<div class="dsplit-side add${stageable ? ' dsel' : ''}${sel ? ' selected' : ''}"` +
              (stageable ? ` data-dkey="${key}"` : '') + `>` +
              `<span class="dsplit-num">${newLine + k}</span><span class="dsplit-text">${html}</span></div>`;
          } else {
            right = `<div class="dsplit-side empty"><span class="dsplit-num"></span><span class="dsplit-text"></span></div>`;
          }

          parts.push(`<div class="dsplit-row">${left}${right}</div>`);
          emitted++;
        }
        oldLine += delRun.length;
        newLine += addRun.length;
      }
    });
  }

  let html = (stageable ? partialBarHtml(!!opts.staged) : '') + `<div class="dsplit">${parts.join('')}</div>`;
  const truncated = truncatedByCap || opts.diffTruncated;
  if (truncated) {
    const reason = truncatedByCap
      ? `Showing first ${cap.toLocaleString()} of ${totalLines.toLocaleString()} lines.`
      : `Diff was truncated to ${Math.round((opts.diffBytes || 0) / 1024 / 1024 * 10) / 10} MB.`;
    html += `<div class="diff-notice">⚔ ${escapeHtml(reason)} The diff is too large to render fully.</div>`;
  }
  return html;
}

// ============================================
// PARTIAL STAGING — interaction
// ============================================
// Clicking a changed line toggles it; shift-click extends from the last click. Because
// the diff HTML is rebuilt wholesale on every render, all of this is delegated from the
// document rather than bound per line.
document.addEventListener('click', (e) => {
  // Whole-hunk buttons.
  const hunkBtn = e.target.closest('[data-hunk-action]');
  if (hunkBtn) {
    e.preventDefault();
    e.stopPropagation();
    const hi = parseInt(hunkBtn.dataset.hunk, 10);
    const action = hunkBtn.dataset.hunkAction;
    if (action === 'select') {
      const keys = hunkLineKeys(partialStaging.parsedFile, hi);
      // Toggle: if the hunk is already fully selected, clicking clears it.
      const allSelected = keys.length && keys.every(k => partialStaging.selected.has(k));
      keys.forEach(k => allSelected ? partialStaging.selected.delete(k) : partialStaging.selected.add(k));
      syncPartialSelectionDom();
      return;
    }
    applyHunk(hi, action);
    return;
  }

  // Selection-bar buttons.
  const barBtn = e.target.closest('[data-partial-action]');
  if (barBtn) {
    e.preventDefault();
    e.stopPropagation();
    const action = barBtn.dataset.partialAction;
    if (action === 'clear') { partialStagingReset(); syncPartialSelectionDom(); return; }
    applySelectedLines(action);
    return;
  }

  // Line toggle. Ignore the click when the user is actually selecting text.
  const row = e.target.closest('.dsel[data-dkey]');
  if (!row) return;
  const sel = window.getSelection();
  if (sel && sel.toString().length) return;

  const key = row.dataset.dkey;
  if (e.shiftKey && partialStaging.lastClicked) {
    const order = partialStaging.order;
    const a = order.indexOf(partialStaging.lastClicked);
    const b = order.indexOf(key);
    if (a !== -1 && b !== -1) {
      const [lo, hi2] = a <= b ? [a, b] : [b, a];
      // Extend using the anchor's resulting state so a shift-drag reads as one gesture.
      const turnOn = !partialStaging.selected.has(key);
      for (let i = lo; i <= hi2; i++) {
        if (turnOn) partialStaging.selected.add(order[i]);
        else partialStaging.selected.delete(order[i]);
      }
    }
  } else {
    if (partialStaging.selected.has(key)) partialStaging.selected.delete(key);
    else partialStaging.selected.add(key);
  }
  partialStaging.lastClicked = key;
  syncPartialSelectionDom();
});

// Repaint selection highlighting in place — far cheaper than re-rendering the diff, and
// it keeps the scroll position steady while you tick lines.
function syncPartialSelectionDom() {
  document.querySelectorAll('.dsel[data-dkey]').forEach(el => {
    el.classList.toggle('selected', partialStaging.selected.has(el.dataset.dkey));
  });
  updatePartialBar();
}

// Map an action to the (cached, reverse) pair `git apply` needs. See buildPartialPatch
// for why the reverse flag also changes how unselected lines are emitted.
const PARTIAL_APPLY_MODES = {
  stage:   { cached: true,  reverse: false, verb: 'Staging',    done: 'Staged' },
  unstage: { cached: true,  reverse: true,  verb: 'Unstaging',  done: 'Unstaged' },
  discard: { cached: false, reverse: true,  verb: 'Discarding', done: 'Discarded' }
};

async function applyHunk(hunkIndex, action) {
  const parsedFile = partialStaging.parsedFile;
  if (!parsedFile) return;
  const keys = new Set(hunkLineKeys(parsedFile, hunkIndex));
  if (!keys.size) { showToast('That hunk has no changed lines', 'error'); return; }
  await runPartialApply(keys, action, 'hunk');
}

async function applySelectedLines(action) {
  if (!partialStaging.selected.size) { showToast('Select some lines first', 'error'); return; }
  await runPartialApply(new Set(partialStaging.selected), action, 'lines');
}

async function runPartialApply(keys, action, what) {
  const mode = PARTIAL_APPLY_MODES[action];
  const parsedFile = partialStaging.parsedFile;
  if (!mode || !parsedFile) return;

  const count = keys.size;
  if (action === 'discard') {
    const confirmed = await modal.confirm({
      title: what === 'hunk' ? 'Discard Hunk' : 'Discard Selected Lines',
      message: what === 'hunk'
        ? `Permanently discard this hunk's changes in "${partialStaging.path}"? This rewrites the file on disk and cannot be undone.`
        : `Permanently discard ${count} selected line${count === 1 ? '' : 's'} in "${partialStaging.path}"? This rewrites the file on disk and cannot be undone.`,
      danger: true,
      confirmText: 'Discard'
    });
    if (!confirmed) return;
  }

  const patch = buildPartialPatch(parsedFile, keys, { reverse: mode.reverse });
  if (!patch) { showToast('Nothing to apply', 'error'); return; }

  const r = await withLoading(mode.verb, () => gs.applyPatch({
    patch, cached: mode.cached, reverse: mode.reverse
  }));
  if (!r.ok) { showToast(r.error || `${mode.verb} failed`, 'error', 8000); return; }

  showToast(`${mode.done} ${what === 'hunk' ? '1 hunk' : count + ' line' + (count === 1 ? '' : 's')}`, 'success');
  partialStagingReset();
  await refreshStatus();
  // Re-read the file's diff so the pane reflects what's left to stage.
  if (state.selectedFile === partialStaging.path) {
    await selectFile(partialStaging.path, partialStaging.staged);
  }
}

// ============================================
// PER-FILE COMMIT DIFF BROWSER
// Splits a full multi-file unified diff into per-file chunks and shows a file list;
// clicking a file renders only that file's diff (so we don't paint everything at once).
// ============================================

// Split a unified diff into [{path, status, diff}] chunks, one per file.
function splitDiffByFile(diffText) {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  const files = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('diff --git')) {
      if (cur) files.push(cur);
      // Best-effort path from the "diff --git a/X b/Y" header. This can be ambiguous
      // when paths contain " b/", so we refine it below from the +++ / --- lines, which
      // carry a single unambiguous path.
      const m = raw.match(/ b\/(.+)$/);
      const path = m ? m[1] : raw.replace('diff --git ', '');
      cur = { path, status: 'modified', lines: [], pathLocked: false };
      continue;
    }
    if (!cur) {
      // Content before the first "diff --git" header — for `git show` this is the commit
      // metadata (hash, Author, Date, message). It's not a file, so mark it synthetic and
      // drop it below rather than surfacing a bogus "(diff)" entry in the file list.
      cur = { path: '(diff)', status: 'modified', lines: [], pathLocked: false, synthetic: true };
    }
    if (raw.startsWith('new file mode')) cur.status = 'added';
    else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (raw.startsWith('rename from') || raw.startsWith('rename to')) cur.status = 'renamed';
    else if (raw.startsWith('Binary files')) cur.binary = true;
    // Refine the path unambiguously: prefer "+++ b/path"; fall back to "--- a/path"
    // for deletions (where +++ is /dev/null).
    else if (!cur.pathLocked && raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '').trim();
      if (p && p !== '/dev/null') { cur.path = p; cur.pathLocked = true; }
    } else if (!cur.pathLocked && raw.startsWith('--- ')) {
      const p = raw.slice(4).replace(/^a\//, '').trim();
      if (p && p !== '/dev/null') cur.path = p; // may be overridden by +++ next line
    }
    cur.lines.push(raw);
  }
  if (cur) files.push(cur);
  return files
    .filter(f => !f.synthetic)
    .map(f => ({ path: f.path, status: f.status, binary: !!f.binary, diff: f.lines.join('\n') }));
}

const FILE_STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

// Render a commit's changes as a file list + a single-file diff pane into `panelEl`.
// `opts` carries diffTruncated/diffBytes for the truncation notice, and `opts.hash`
// (the commit) so files can be restored from it.
// Per-commit file-browser view state, preserved across re-renders (e.g. the auto-refresh
// on window focus) so a background refresh doesn't reset the file you're viewing, the
// per-commit file filter, your checkbox selection, or the scroll position. Keyed by
// panel id + commit hash; a commit's diff is immutable, so restoring by file path/index
// is always valid. Capped (LRU-ish) so browsing many commits can't grow it unbounded.
const _cfileBrowserState = new Map();
const _CFILE_STATE_MAX = 60;

function renderCommitFileBrowser(panelEl, diffText, opts) {
  opts = opts || {};
  if (!panelEl) return;
  const files = splitDiffByFile(diffText);
  if (!files.length) {
    panelEl.innerHTML = '<div class="empty-state"><p>No differences.</p></div>';
    return;
  }

  const listHtml = files.map((f, idx) =>
    `<div class="cfile-item${idx === 0 ? ' active' : ''}" data-cfile="${idx}" title="${escapeHtml(f.path)}">` +
      `<input type="checkbox" class="cfile-check" data-cfile-check="${idx}" title="Select file">` +
      `<span class="cfile-status ${f.status}">${FILE_STATUS_LETTER[f.status] || 'M'}</span>` +
      `<span class="cfile-path">${escapeHtml(f.path)}</span>` +
    `</div>`
  ).join('');

  panelEl.innerHTML =
    `<div class="cfile-browser">` +
      `<div class="cfile-toolbar">` +
        `<label class="cfile-selall"><input type="checkbox" class="cfile-selall-check"> Select all</label>` +
        `<span class="cfile-selcount" aria-live="polite"></span>` +
        `<button class="cfile-restore-btn" type="button" disabled>↩ Restore selected</button>` +
      `</div>` +
      `<div class="cfile-searchbar">` +
        `<input type="search" class="cfile-search" placeholder="Filter by path or content…" title="Filter files in this commit by path or diff content" />` +
      `</div>` +
      `<div class="cfile-list">${listHtml}</div>` +
      `<div class="cfile-diff diff-content" id="cfile-diff"></div>` +
    `</div>`;

  const diffEl = panelEl.querySelector('#cfile-diff');
  // Stash state on the panel so the diff-mode toggle can re-render the *current* file
  // in place, preserving the selected file and scroll positions.
  panelEl._cfiles = files;
  panelEl._cfileOpts = opts;
  panelEl._cfileActive = 0;
  panelEl._cfileHash = opts.hash || null;

  // Restore/track view state across re-renders (see _cfileBrowserState above). Re-insert
  // the entry so it counts as most-recently-used, then evict the oldest beyond the cap.
  const browserKey = (panelEl.id || 'cfile') + ' ' + (opts.hash || '');
  const saved = _cfileBrowserState.get(browserKey);
  const store = saved || {};
  _cfileBrowserState.delete(browserKey);
  _cfileBrowserState.set(browserKey, store);
  while (_cfileBrowserState.size > _CFILE_STATE_MAX) {
    _cfileBrowserState.delete(_cfileBrowserState.keys().next().value);
  }
  // Snapshot the current UI into the store. Called after every interaction so a later
  // re-render (refresh) can put the pane back exactly as the user left it.
  const persist = () => {
    store.active = panelEl._cfileActive || 0;
    store.filter = fileSearch ? fileSearch.value : '';
    store.checked = checkedPaths();
    store.scroll = diffEl ? diffEl.scrollTop : 0;
  };

  const renderOne = (idx) => {
    const f = files[idx];
    if (!f || !diffEl) return;
    panelEl._cfileActive = idx;
    try {
      diffEl.innerHTML = renderDiff(f.diff, Object.assign({}, opts, {
        // A commit's image is compared against its first parent.
        imageRevs: opts.hash ? { oldRev: opts.hash + '^', newRev: opts.hash } : undefined
      }));
      hydrateImageDiffs(diffEl);
    } catch (err) {
      diffEl.innerHTML = `<div class="empty-state"><p style="color:var(--crusader-red-bright)">⚔ Failed to render diff: ${escapeHtml(err.message || String(err))}</p></div>`;
    }
    diffEl.scrollTop = 0; // new file → start at top
    persist();
  };

  // --- checkbox / selection plumbing ---
  const list = panelEl.querySelector('.cfile-list');
  const selAll = panelEl.querySelector('.cfile-selall-check');
  const count = panelEl.querySelector('.cfile-selcount');
  const restoreBtn = panelEl.querySelector('.cfile-restore-btn');

  const checkedPaths = () => Array.from(panelEl.querySelectorAll('.cfile-check:checked'))
    .map(cb => files[parseInt(cb.dataset.cfileCheck, 10)]).filter(Boolean).map(f => f.path);

  const syncSelectionUI = () => {
    const checks = Array.from(panelEl.querySelectorAll('.cfile-check'));
    const checkedCount = checks.filter(c => c.checked).length;
    if (count) count.textContent = checkedCount ? `${checkedCount} selected` : '';
    if (restoreBtn) restoreBtn.disabled = checkedCount === 0;
    if (selAll) {
      selAll.checked = checkedCount > 0 && checkedCount === checks.length;
      selAll.indeterminate = checkedCount > 0 && checkedCount < checks.length;
    }
  };

  list.addEventListener('click', (e) => {
    // Clicking the checkbox toggles selection without changing the previewed file.
    if (e.target.closest('.cfile-check')) { syncSelectionUI(); persist(); return; }
    const item = e.target.closest('.cfile-item');
    if (!item) return;
    panelEl.querySelectorAll('.cfile-item').forEach(el => el.classList.toggle('active', el === item));
    renderOne(parseInt(item.dataset.cfile, 10));
  });

  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.cfile-item');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = parseInt(item.dataset.cfile, 10);
    const rightClickedPath = files[idx] && files[idx].path;
    // Operate on the checked set if any; otherwise the right-clicked file.
    let targets = checkedPaths();
    if (!targets.length && rightClickedPath) targets = [rightClickedPath];
    showCommitFileContextMenu(panelEl._cfileHash, targets, rightClickedPath, e.pageX, e.pageY);
  });

  if (selAll) selAll.addEventListener('change', () => {
    panelEl.querySelectorAll('.cfile-check').forEach(c => { c.checked = selAll.checked; });
    syncSelectionUI();
    persist();
  });

  if (restoreBtn) restoreBtn.addEventListener('click', () => {
    const paths = checkedPaths();
    if (paths.length) restoreFilesFromCommit(panelEl._cfileHash, paths);
  });

  // File filter — show only items whose path matches the query (all terms must match).
  const fileSearch = panelEl.querySelector('.cfile-search');
  let applyFileFilter = () => {};
  if (fileSearch) {
    let ft = null;
    applyFileFilter = () => {
      const q = fileSearch.value.trim().toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      let visible = 0;
      panelEl.querySelectorAll('.cfile-item').forEach(item => {
        const idx = parseInt(item.dataset.cfile, 10);
        const f = files[idx] || {};
        const path = (f.path || '').toLowerCase();
        // Match the file path OR the file's diff content, so you can locate a file by a
        // function/identifier inside its changes — not just by its name.
        const body = (f.diff || '').toLowerCase();
        const show = !terms.length || terms.every(t => path.includes(t) || body.includes(t));
        item.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      fileSearch.classList.toggle('has-no-matches', !!q && visible === 0);
      return visible;
    };
    fileSearch.oninput = () => { clearTimeout(ft); ft = setTimeout(() => { applyFileFilter(); persist(); }, 120); };
    fileSearch.onkeydown = (e) => {
      if (e.key === 'Escape') { fileSearch.value = ''; applyFileFilter(); persist(); }
    };
  }

  // Restore the view state saved from a previous render of this same commit (file
  // filter, checkbox selection, the active file, and the diff scroll position) so a
  // background refresh — e.g. the auto-refresh on window focus — doesn't disrupt what
  // you're looking at. Capture the saved scroll first: renderOne() calls persist(),
  // which would otherwise overwrite store.scroll before we restore it.
  let initialIdx = 0;
  const savedScroll = (saved && typeof saved.scroll === 'number') ? saved.scroll : 0;
  if (saved) {
    if (fileSearch && saved.filter) { fileSearch.value = saved.filter; applyFileFilter(); }
    if (saved.checked && saved.checked.length) {
      const checkedSet = new Set(saved.checked);
      panelEl.querySelectorAll('.cfile-check').forEach(cb => {
        const f = files[parseInt(cb.dataset.cfileCheck, 10)];
        if (f && checkedSet.has(f.path)) cb.checked = true;
      });
    }
    if (typeof saved.active === 'number' && files[saved.active]) initialIdx = saved.active;
  } else if (fileSearch && opts.fileFilter) {
    // First time opening this commit while a diff-content filter is active: seed the
    // per-commit file filter with the same query so the files that changed it surface
    // immediately (and persist() will remember it from here on). If the query matched
    // nothing literally — e.g. it was a regex with metacharacters that the substring
    // filter can't reproduce — fall back to showing every file rather than an empty list.
    fileSearch.value = opts.fileFilter;
    if (!applyFileFilter()) { fileSearch.value = ''; applyFileFilter(); }
  }

  // Highlight and render the active file (restored, or the first one by default).
  panelEl.querySelectorAll('.cfile-item').forEach(el =>
    el.classList.toggle('active', parseInt(el.dataset.cfile, 10) === initialIdx));
  renderOne(initialIdx);
  if (savedScroll) diffEl.scrollTop = savedScroll;
  syncSelectionUI();

  // Track the diff scroll position as the user scrolls so a later refresh restores it.
  if (diffEl) diffEl.addEventListener('scroll', () => { store.scroll = diffEl.scrollTop; });
}

// Context menu for a file (or selected files) within a commit preview.
function showCommitFileContextMenu(hash, targetPaths, rightClickedPath, x, y) {
  const many = targetPaths.length > 1;
  const label = many ? `Restore ${targetPaths.length} files to working tree`
                      : `Restore “${shortenPath(rightClickedPath || targetPaths[0])}” to working tree`;
  const focus = rightClickedPath || targetPaths[0];
  const items = [
    { label, icon: '↩', action: () => restoreFilesFromCommit(hash, targetPaths) },
    'sep',
    { label: 'File history…', icon: '⌛', action: () => openFileHistory(focus) },
    { label: 'Blame at this commit…', icon: '⚔', action: () => openBlame(focus, { rev: hash }) },
    'sep',
    { label: 'Copy path' + (many ? 's' : ''), icon: '⎘', action: () => {
        navigator.clipboard.writeText(targetPaths.join('\n'));
        showToast('Path' + (many ? 's' : '') + ' copied', 'success');
      } }
  ];
  showContextMenu(items, x, y);
}

function shortenPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// Restore files from a commit into the current working tree (git checkout <hash> -- paths).
async function restoreFilesFromCommit(hash, paths) {
  if (!hash || !paths || !paths.length) return;
  const many = paths.length > 1;
  const confirmed = await modal.confirm({
    title: many ? `Restore ${paths.length} Files` : 'Restore File',
    message: many
      ? `Overwrite ${paths.length} files in your working tree with their version from commit ${hash.slice(0,7)}? This changes your working files.`
      : `Overwrite “${paths[0]}” in your working tree with its version from commit ${hash.slice(0,7)}? This changes your working file.`,
    confirmText: 'Restore',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;
  const r = await withLoading('Restoring', () => gs.restoreFromCommit(hash, paths));
  if (!r.ok) { showToast(r.error || 'Restore failed', 'error', 6000); return; }
  showToast(many ? `Restored ${paths.length} files` : 'File restored', 'success');
  await refreshAll();
}

// Re-render only the currently-selected file's diff in the active browser(s) — used by
// the unified/split toggle so it doesn't rebuild the whole pane (which would reset the
// selected file and scroll position).
function rerenderActiveCommitFile(panelEl) {
  if (!panelEl || !panelEl._cfiles) return false;
  const diffEl = panelEl.querySelector('#cfile-diff');
  if (!diffEl) return false;
  const f = panelEl._cfiles[panelEl._cfileActive || 0];
  if (!f) return false;
  const prevScroll = diffEl.scrollTop;
  try {
    const rrOpts = panelEl._cfileOpts || {};
    diffEl.innerHTML = renderDiff(f.diff, Object.assign({}, rrOpts, {
      imageRevs: rrOpts.hash ? { oldRev: rrOpts.hash + '^', newRev: rrOpts.hash } : undefined
    }));
    hydrateImageDiffs(diffEl);
  } catch (err) {
    diffEl.innerHTML = `<div class="empty-state"><p style="color:var(--crusader-red-bright)">⚔ ${escapeHtml(err.message || String(err))}</p></div>`;
  }
  diffEl.scrollTop = prevScroll; // keep the diff scroll position across mode switch
  return true;
}
function classifyFile(file) {
  // Returns { status, letter, staged }
  const idx = (file.index || ' ').trim();
  const wt = (file.working_dir || ' ').trim();

  if (file.path && state.status && state.status.not_added && state.status.not_added.includes(file.path)) {
    return { status: 'untracked', letter: 'U', staged: false };
  }
  if (idx === '?' || wt === '?') return { status: 'untracked', letter: 'U', staged: false };

  const map = {
    A: { status: 'added', letter: 'A' },
    M: { status: 'modified', letter: 'M' },
    D: { status: 'deleted', letter: 'D' },
    R: { status: 'renamed', letter: 'R' },
    C: { status: 'renamed', letter: 'C' },
    U: { status: 'conflicted', letter: 'U' }
  };
  if (idx && idx !== ' ' && map[idx]) return { ...map[idx], staged: true };
  if (wt && wt !== ' ' && map[wt]) return { ...map[wt], staged: false };
  return { status: 'modified', letter: '?', staged: false };
}

// ============================================

// ============================================
// IGNORE-WHITESPACE NOTICE
// ============================================
// Partial staging is unavailable while -w is on, and silently missing buttons is worse
// than a one-line explanation of why.
function whitespaceNoticeHtml() {
  return `<div class="diff-notice ws-notice">` +
    `⇥ Whitespace-only changes are hidden. Hunk and line staging are unavailable in this mode, ` +
    `because a whitespace-ignoring diff doesn't describe the real byte changes. ` +
    `<button class="dhunk-btn" data-diffws="1">Show whitespace</button>` +
  `</div>`;
}

// ============================================
// IMAGE DIFF
// ============================================
// Binary files used to render as nothing but "Binary files … differ". For images that
// throws away the one thing the user actually wants, so we show both versions instead —
// side by side, as an opacity blend, or under a swipe divider.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif']);

function isImagePath(p) {
  if (!p) return false;
  const ext = String(p).split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

// Emitted synchronously by the renderers in place of the binary notice; the actual bytes
// are fetched afterwards by hydrateImageDiffs, because renderDiff has to stay synchronous.
function imageDiffPlaceholderHtml(filePath, revs) {
  const oldRev = (revs && revs.oldRev) || 'HEAD';
  const newRev = (revs && revs.newRev) || 'WORKTREE';
  return `<div class="imgdiff" data-imgdiff="1"` +
    ` data-path="${escapeHtml(filePath)}"` +
    ` data-oldrev="${escapeHtml(oldRev)}"` +
    ` data-newrev="${escapeHtml(newRev)}">` +
    `<div class="imgdiff-loading"><span class="loading"></span> Loading image…</div>` +
  `</div>`;
}

// Fetch both sides for every un-hydrated image-diff container inside `root`. Safe to call
// after any innerHTML assignment; containers already loaded are skipped.
async function hydrateImageDiffs(root) {
  if (!root) return;
  const nodes = Array.from(root.querySelectorAll('.imgdiff[data-imgdiff="1"]:not(.loaded)'));
  for (const node of nodes) {
    node.classList.add('loaded');   // claim it before awaiting, so a re-entrant call skips it
    const filePath = node.dataset.path;
    const oldRev = node.dataset.oldrev;
    const newRev = node.dataset.newrev;
    try {
      const [oldR, newR] = await Promise.all([
        gs.fileBlob({ rev: oldRev, path: filePath }),
        gs.fileBlob({ rev: newRev, path: filePath })
      ]);
      renderImageDiff(node, {
        path: filePath,
        before: oldR && oldR.ok ? oldR.data : null,
        after: newR && newR.ok ? newR.data : null
      });
    } catch (err) {
      node.innerHTML = `<div class="imgdiff-error">Could not load the image: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function renderImageDiff(node, data) {
  const before = data.before && data.before.exists ? data.before : null;
  const after = data.after && data.after.exists ? data.after : null;

  if (!before && !after) {
    node.innerHTML = `<div class="imgdiff-error">Neither version of this image could be read.</div>`;
    return;
  }
  const tooLarge = (before && before.tooLarge) || (after && after.tooLarge);
  if (tooLarge) {
    node.innerHTML = `<div class="imgdiff-error">This image is too large to preview ` +
      `(${escapeHtml(formatBytes((after || before).bytes))}).</div>`;
    return;
  }

  // Added / deleted images only have one side, so the comparison modes are meaningless —
  // show the single version with a clear label instead of an empty pane beside it.
  const single = !before || !after;
  const kind = !before ? 'added' : (!after ? 'deleted' : 'changed');

  const beforeImg = before ? `<img class="imgdiff-img" src="${before.dataUri}" alt="before" />` : '';
  const afterImg = after ? `<img class="imgdiff-img" src="${after.dataUri}" alt="after" />` : '';

  const modeBar = single ? '' : `
    <div class="imgdiff-modes">
      <button class="imgdiff-mode active" data-imgmode="side">◫ Side by side</button>
      <button class="imgdiff-mode" data-imgmode="blend">◐ Blend</button>
      <button class="imgdiff-mode" data-imgmode="swipe">⇹ Swipe</button>
      <label class="imgdiff-slider-wrap">
        <input type="range" class="imgdiff-slider" min="0" max="100" value="50" />
      </label>
    </div>`;

  node.innerHTML = `
    <div class="imgdiff-head">
      <span class="imgdiff-kind ${kind}">${kind}</span>
      <span class="imgdiff-name">${escapeHtml(data.path)}</span>
      <span class="imgdiff-meta" id="imgdiff-dims"></span>
    </div>
    ${modeBar}
    <div class="imgdiff-stage mode-side">
      <div class="imgdiff-pane before">
        <div class="imgdiff-pane-label">before ${before ? '· ' + escapeHtml(formatBytes(before.bytes)) : '· absent'}</div>
        <div class="imgdiff-frame">${beforeImg || '<div class="imgdiff-absent">did not exist</div>'}</div>
      </div>
      <div class="imgdiff-pane after">
        <div class="imgdiff-pane-label">after ${after ? '· ' + escapeHtml(formatBytes(after.bytes)) : '· absent'}</div>
        <div class="imgdiff-frame">${afterImg || '<div class="imgdiff-absent">deleted</div>'}</div>
      </div>
    </div>`;

  const stage = node.querySelector('.imgdiff-stage');
  const slider = node.querySelector('.imgdiff-slider');
  const dims = node.querySelector('#imgdiff-dims');

  // Report the pixel dimensions once the images decode — a resize is often the whole
  // point of the change and is invisible otherwise.
  const measured = {};
  const report = () => {
    const parts = [];
    if (measured.before) parts.push(`before ${measured.before}`);
    if (measured.after) parts.push(`after ${measured.after}`);
    if (dims) dims.textContent = parts.join('  →  ');
  };
  node.querySelectorAll('.imgdiff-img').forEach(img => {
    const which = img.getAttribute('alt');
    const done = () => {
      measured[which] = `${img.naturalWidth}×${img.naturalHeight}`;
      report();
    };
    if (img.complete && img.naturalWidth) done();
    else img.addEventListener('load', done, { once: true });
  });

  if (single) return;

  const applyMode = (mode) => {
    stage.classList.remove('mode-side', 'mode-blend', 'mode-swipe');
    stage.classList.add('mode-' + mode);
    applySlider();
  };

  // In blend mode the slider is the "after" layer's opacity; in swipe mode it's the
  // position of the reveal edge. Side-by-side ignores it.
  const applySlider = () => {
    if (!slider) return;
    const v = Number(slider.value);
    const afterPane = node.querySelector('.imgdiff-pane.after');
    if (stage.classList.contains('mode-blend')) {
      afterPane.style.opacity = String(v / 100);
      afterPane.style.clipPath = '';
    } else if (stage.classList.contains('mode-swipe')) {
      afterPane.style.opacity = '1';
      afterPane.style.clipPath = `inset(0 0 0 ${v}%)`;
    } else {
      afterPane.style.opacity = '';
      afterPane.style.clipPath = '';
    }
  };

  node.querySelectorAll('.imgdiff-mode').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.querySelectorAll('.imgdiff-mode').forEach(b => b.classList.toggle('active', b === btn));
      applyMode(btn.dataset.imgmode);
    };
  });
  if (slider) slider.oninput = applySlider;
  applyMode('side');
}
