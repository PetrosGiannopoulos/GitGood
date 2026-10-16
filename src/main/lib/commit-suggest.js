// Commit-message suggestions from the local model: the pure half. main.js gathers the diff
// and talks to Ollama; this file decides what the model is shown and how its answer is read.
//
// Two things are deliberate:
// - The diff is budgeted *per file*, not cut at a character count. A single regenerated
//   asset or lockfile would otherwise fill the whole prompt and the model would describe
//   only that, while the stat block (always included, whole) still tells it every file
//   that moved.
// - The answer is asked for as JSON but read leniently. Small models wrap JSON in prose or
//   code fences, or ignore the format entirely; a reply we can make *something* of is
//   better than an error for a feature whose output the user edits anyway.

const COMMIT_SUMMARY_MAX = 72;
const SUGGEST_DIFF_BUDGET = 9000;
const SUGGEST_FILE_MIN = 1200;

// Split a unified diff into per-file chunks and shrink each to its share of the budget.
// Returns the trimmed text; files beyond the budget are named, not silently dropped.
function trimDiffForPrompt(diff, budget = SUGGEST_DIFF_BUDGET) {
  const text = String(diff || '');
  if (text.length <= budget) return text;
  const chunks = text.split(/(?=^diff --git )/m).filter(c => c.trim());
  const share = Math.max(SUGGEST_FILE_MIN, Math.floor(budget / Math.max(chunks.length, 1)));
  const out = [];
  const skipped = [];
  let used = 0;
  for (const c of chunks) {
    const head = c.split('\n', 1)[0];
    if (used >= budget) { skipped.push(head.replace(/^diff --git a\//, '').replace(/ b\/.*$/, '')); continue; }
    const room = Math.min(share, budget - used);
    const piece = c.length > room ? c.slice(0, room).replace(/\n[^\n]*$/, '') + '\n… (rest of this file\'s diff omitted)\n' : c;
    out.push(piece);
    used += piece.length;
  }
  if (skipped.length) out.push(`\n… diffs omitted for ${skipped.length} more file(s): ${skipped.slice(0, 30).join(', ')}${skipped.length > 30 ? ', …' : ''}\n`);
  return out.join('');
}

function buildCommitSuggestPrompt({ stat, diff, amend, previousMessage, recentSubjects, source }) {
  const parts = [
    'You write git commit messages. Read the changes below and write one commit message for them.',
    '',
    'Rules:',
    `- "summary": one line, imperative mood ("Add", "Fix", "Rename"…), at most ${COMMIT_SUMMARY_MAX} characters, no trailing period.`,
    '- "description": what changed and why, as a few short "- " bullet lines. Mention only things visible in the diff. Use an empty string if the summary already says everything.',
    '- Do not invent ticket numbers, names or reasons that the diff does not show.',
    '- Reply with ONLY a JSON object: {"summary": "...", "description": "..."}',
  ];
  if (recentSubjects && recentSubjects.trim()) {
    parts.push('', 'Recent commit subjects in this repository, for matching its style:', recentSubjects.trim());
  }
  if (amend && previousMessage && previousMessage.trim()) {
    parts.push('', 'This replaces the message of the previous commit, which was:', previousMessage.trim(),
      'The changes below are that commit plus anything newly staged into it.');
  }
  if (source === 'unstaged') {
    parts.push('', 'Note: nothing is staged yet, so these are the working-tree changes.');
  }
  parts.push('', 'Files changed:', (stat || '').trim() || '(none)', '', 'Diff:', (diff || '').trim() || '(no textual diff — binary or new files only)');
  return parts.join('\n');
}

function cleanSummary(s) {
  let t = String(s || '').split(/\r?\n/)[0].trim();
  t = t.replace(/^(summary|subject|title)\s*:\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  t = t.replace(/\.$/, '');
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '');
  return t;
}

function cleanDescription(d) {
  let t = Array.isArray(d) ? d.map(x => (/^\s*[-*]/.test(x) ? x : '- ' + x)).join('\n') : String(d || '');
  t = t.replace(/^(description|body)\s*:\s*/i, '').replace(/\r\n/g, '\n').trim();
  return t;
}

// Read whatever the model said into { summary, description }. Throws only when nothing
// usable came back at all.
function parseCommitSuggestion(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('The model returned nothing.');
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(unfenced.slice(start, end + 1));
      const summary = cleanSummary(obj.summary || obj.subject || obj.title);
      if (summary) return { summary, description: cleanDescription(obj.description || obj.body || '') };
    } catch (e) { /* fall through to plain text */ }
  }
  // Plain text: first non-empty line is the summary, the rest the description.
  const lines = unfenced.split(/\r?\n/);
  const first = lines.findIndex(l => l.trim());
  const summary = cleanSummary(lines[first]);
  if (!summary) throw new Error('The model\'s reply could not be read as a commit message.');
  return { summary, description: cleanDescription(lines.slice(first + 1).join('\n')) };
}

module.exports = {
  COMMIT_SUMMARY_MAX, trimDiffForPrompt, buildCommitSuggestPrompt, parseCommitSuggestion
};
