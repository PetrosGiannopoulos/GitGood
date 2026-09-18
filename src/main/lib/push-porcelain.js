// `git push --porcelain` output parsing (pure, extracted from main.js).
//
// Every remote-facing push uses --porcelain because plain `git push` writes its summary to
// stderr, which simple-git's raw() discards — without it there is no way to tell "pushed"
// from "already there".
//
// One line per ref: "<flag>\t<from>:<to>\t<summary>". The flag is the interesting part:
//   ' ' fast-forward   '+' forced   '-' deleted   '*' new   '=' up to date   '!' rejected
const PUSH_FLAG_MEANING = {
  ' ': 'pushed', '+': 'force-pushed', '-': 'deleted', '*': 'new', '=': 'up-to-date', '!': 'rejected'
};

function parsePushPorcelain(stdout) {
  const refs = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line || /^To /.test(line) || /^Done$/.test(line)) continue;
    const flag = line[0];
    if (!(flag in PUSH_FLAG_MEANING)) continue;
    // The real shape is "<flag>\t<refspec>\t<summary>" — a TAB follows the flag, so
    // dropping only the flag character leaves an empty first field. Stripping that one tab
    // is what puts the refspec and summary in the right places; without it `refspec` is
    // always '' and `summary` silently carries the refspec instead.
    const parts = line.slice(1).replace(/^\t/, '').split('\t');
    refs.push({
      flag,
      result: PUSH_FLAG_MEANING[flag],
      refspec: (parts[0] || '').trim(),
      summary: (parts[1] || '').trim()
    });
  }
  return refs;
}

module.exports = { PUSH_FLAG_MEANING, parsePushPorcelain };
