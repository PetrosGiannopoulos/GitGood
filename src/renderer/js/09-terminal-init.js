(async function init() {
  try {
    // Apply saved theme/font before anything else so there's no flash
    await applySavedAppSettings();
    // Check if a repo is already open (e.g. on reload)
    const cur = await gs.currentRepo();
    if (cur && cur.ok && cur.data) {
      state.repo = cur.data;
      $('#welcome-screen').classList.add('hidden');
      $('#app-screen').classList.remove('hidden');
      updateRepoInfo();
      await refreshAll();
    } else {
      await showWelcome();
    }
  } catch (err) {
    console.error('[GitGood init error]', err);
    // Show welcome screen even if init had an issue
    try { await showWelcome(); } catch (e) { console.error(e); }
    showToast('Init warning: ' + (err.message || err), 'error', 6000);
  }
})();


// ============================================
// EMBEDDED GIT TERMINAL — front-end controller for the persistent shell session.
// Streams output from the backend shell, sends typed commands, supports history
// and Ctrl+C. Behaves like Git Bash for command-line git work.
// ============================================
const terminal = {
  started: false,
  unsubData: null,
  unsubExit: null,
  history: [],
  histIdx: -1,
  running: false,
  // Current shell-side state, refreshed after each command via a probe suffix.
  shellType: 'bash',       // 'bash' | 'cmd'
  shellCwd: '',
  shellBranch: '',
  // Output accumulator used to detect marker lines in streamed data without breaking
  // mid-line chunks. We strip the marker chunk before writing the visible output.
  _outBuf: '',

  els() {
    return {
      overlay: document.getElementById('terminal-overlay'),
      output: document.getElementById('terminal-output'),
      input: document.getElementById('terminal-input'),
      prompt: document.getElementById('terminal-prompt'),
      label: document.getElementById('terminal-shell-label')
    };
  },

  // Strip ANSI escape / control sequences so the plain console stays readable.
  clean(s) {
    return s
      .replace(/\x1b\][^\x07]*\x07/g, '')             // OSC sequences
      .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')     // CSI sequences
      .replace(/\x1b[@-Z\\-_]/g, '')                  // other escapes
      .replace(/\r/g, '');                            // carriage returns
  },

  write(text, cls) {
    const { output } = this.els();
    if (!output) return;
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    output.appendChild(span);
    if (atBottom) output.scrollTop = output.scrollHeight;
  },

  // Compute the user-facing prompt string. Format mirrors Git Bash:
  //   <cwd> (<branch>) $   when on a branch
  //   <cwd> $              when not
  // Cmd shows just <cwd>>.
  promptString() {
    const cwd = this.shellCwd || '~';
    if (this.shellType === 'cmd') return cwd + '>';
    const branch = this.shellBranch ? ` (${this.shellBranch})` : '';
    return cwd + branch + ' $';
  },

  // Write a prompt line to the output, used both immediately after a command's output
  // and at startup. This is the "after" prompt the user sees; the next command (if any)
  // is echoed on its own line below.
  writePromptLine() {
    this.write(this.promptString() + '\n', 'term-prompt-line');
  },

  async open() {
    const { overlay, input } = this.els();
    if (!overlay) return;
    overlay.classList.remove('hidden');
    if (!this.started) {
      await this.start();
    } else {
      // Session is alive; the bottom prompt may be stale (you may have changed branch
      // or cwd from outside this terminal — e.g. via the app's checkout). Strip the
      // last prompt line and re-probe so a fresh one prints at the bottom.
      this._dropTrailingPromptLine();
      this._sendProbeOnly();
    }
    setTimeout(() => input && input.focus(), 30);
  },

  // Remove the last <span class="term-prompt-line"> from the output (and any blank
  // trailing nodes after it). Used on re-open so a fresh prompt can take its place.
  _dropTrailingPromptLine() {
    const { output } = this.els();
    if (!output) return;
    let n = output.lastChild;
    // Walk back over empty text nodes or pure newlines.
    while (n && ((n.nodeType === 3 && /^\s*$/.test(n.nodeValue || '')) ||
                 (n.nodeType === 1 && n.tagName === 'SPAN' && !n.textContent.trim()))) {
      const prev = n.previousSibling; output.removeChild(n); n = prev;
    }
    if (n && n.nodeType === 1 && n.classList && n.classList.contains('term-prompt-line')) {
      output.removeChild(n);
    }
  },

  close() {
    const { overlay } = this.els();
    if (overlay) overlay.classList.add('hidden');
    // Keep the session alive in the background so state persists if reopened.
  },

  async start() {
    const { output, label } = this.els();
    if (output) output.textContent = '';
    const mySession = (this.session = (this.session || 0) + 1);

    if (this.unsubData) { this.unsubData(); this.unsubData = null; }
    if (this.unsubExit) { this.unsubExit(); this.unsubExit = null; }

    const cwd = (state.repo && state.repo.path) || undefined;
    let r;
    try { r = await gs.termStart({ cwd }); }
    catch (e) {
      this.write('Failed to start shell: ' + (e.message || e) + '\n', 'term-err');
      return;
    }
    if (mySession !== this.session) return;
    if (!r || !r.ok) {
      this.write('Failed to start shell: ' + ((r && r.error) || 'unknown') + '\n', 'term-err');
      this.started = false;
      return;
    }
    this.started = true;
    this.running = false;
    this.shellType = r.data.type === 'cmd' ? 'cmd' : 'bash';
    this.shellCwd = r.data.cwd || '';
    this.shellBranch = '';
    this._outBuf = '';
    if (label) label.textContent = r.data.label || 'Terminal';
    this.write(`${r.data.label} — ${r.data.shell}\n`, 'term-dim');

    this.unsubData = gs.onTermData(({ data }) => {
      if (mySession === this.session) this._consume(this.clean(data));
    });
    this.unsubExit = gs.onTermExit(({ code }) => {
      if (mySession !== this.session) return;
      this.write(`\n[shell exited${code != null ? ' with code ' + code : ''}] — press Restart to start a new session.\n`, 'term-dim');
      this.started = false;
      this.running = false;
    });

    // Prime the prompt by running a silent probe — when its marker comes back, the
    // first prompt line is printed via _consume → writePromptLine.
    this._sendProbeOnly();
  },

  async restart() {
    this.write('\n[restarting shell…]\n', 'term-dim');
    this.started = false;
    await this.start();
  },

  // Consume streamed output, looking for our prompt-probe markers and updating shell
  // state from them. Marker lines are removed from the visible output.
  _consume(chunk) {
    this._outBuf += chunk;
    let nl;
    while ((nl = this._outBuf.indexOf('\n')) !== -1) {
      const line = this._outBuf.slice(0, nl);
      this._outBuf = this._outBuf.slice(nl + 1);
      // Marker line: __GGPROMPT__|<cwd>|<branch>
      const m = line.match(/^__GGPROMPT__\|(.*?)\|(.*)$/);
      if (m) {
        // Update shell state THEN print a fresh prompt line. The marker arrives AFTER
        // the command's output, so this is the "after" prompt — reflecting the new
        // branch/path immediately, even when the user just ran `git checkout`.
        this.shellCwd = m[1];
        this.shellBranch = m[2];
        this.writePromptLine();
        continue;   // don't write the marker itself to the visible output
      }
      this.write(line + '\n');
    }
    // Buffer any partial trailing chunk until the next newline arrives. If it can't be
    // a marker (which always has a trailing newline), flush so output doesn't stall.
    if (this._outBuf.length && !this._outBuf.startsWith('__GGPROMPT__')) {
      this.write(this._outBuf);
      this._outBuf = '';
    }
  },

  // Build the probe suffix that prints the marker line. Suffix is shell-specific and
  // intentionally quiet — it prints exactly one line then a newline.
  _probeSuffix() {
    if (this.shellType === 'cmd') {
      // cmd: branch via `git branch --show-current`; cwd via `cd` (with no args prints).
      // We swallow stderr and tolerate missing git.
      return ' & for /f "delims=" %d in (\'cd\') do @set "__ggd=%d" & set "__ggb=" & for /f "delims=" %b in (\'git branch --show-current 2^>nul\') do @set "__ggb=%b" & echo __GGPROMPT__^|!__ggd!^|!__ggb!';
    }
    // bash: %s twice, branch may be empty. printf adds the trailing newline.
    return '; printf \'__GGPROMPT__|%s|%s\\n\' "$(pwd)" "$(git branch --show-current 2>/dev/null)"';
  },

  // Send a probe with no preceding user command (used at startup to populate prompt).
  _sendProbeOnly() {
    if (this.shellType === 'cmd') {
      gs.termInput('setlocal enabledelayedexpansion' + this._probeSuffix() + '\r\n');
    } else {
      gs.termInput('true' + this._probeSuffix() + '\n');
    }
  },

  send(line) {
    if (!this.started) { this.write('No active shell. Press Restart.\n', 'term-err'); return; }
    // Echo just the command — the prompt for THIS command was already printed on its own
    // line by the previous probe response (or by start()). The next prompt will be
    // printed AFTER this command's output, reflecting any state change it caused (cd,
    // git checkout, etc.).
    this.write(line + '\n', 'term-cmd');
    const suffix = this._probeSuffix();
    const wrapped = this.shellType === 'cmd'
      ? `setlocal enabledelayedexpansion & ${line}${suffix}\r\n`
      : `${line}${suffix}\n`;
    gs.termInput(wrapped);
    if (line.trim()) {
      this.history.push(line);
      if (this.history.length > 200) this.history.shift();
    }
    this.histIdx = this.history.length;
  },

  interrupt() {
    if (this.started) { gs.termSignal('SIGINT'); this.write('^C\n', 'term-dim'); }
  }
};

function openTerminal() { terminal.open(); }

// Wire terminal controls once the DOM exists.
(function wireTerminal() {
  const input = document.getElementById('terminal-input');
  const overlay = document.getElementById('terminal-overlay');
  if (!input || !overlay) return;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = input.value;
      input.value = '';
      terminal.send(line);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (terminal.history.length) {
        terminal.histIdx = Math.max(0, terminal.histIdx - 1);
        input.value = terminal.history[terminal.histIdx] || '';
        setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (terminal.history.length) {
        terminal.histIdx = Math.min(terminal.history.length, terminal.histIdx + 1);
        input.value = terminal.history[terminal.histIdx] || '';
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      // Ctrl+C interrupts the running command (only when no text is selected to copy)
      if (!window.getSelection().toString()) {
        e.preventDefault();
        terminal.interrupt();
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      const out = document.getElementById('terminal-output');
      if (out) out.textContent = '';
    }
  });

  const closeBtn = document.getElementById('terminal-close');
  const clearBtn = document.getElementById('terminal-clear');
  const restartBtn = document.getElementById('terminal-restart');
  if (closeBtn) closeBtn.onclick = () => terminal.close();
  if (clearBtn) clearBtn.onclick = () => { const o = document.getElementById('terminal-output'); if (o) o.textContent = ''; };
  if (restartBtn) restartBtn.onclick = () => terminal.restart();

  // Click anywhere in the output focuses the input (terminal feel)
  const output = document.getElementById('terminal-output');
  if (output) output.addEventListener('mouseup', () => {
    if (!window.getSelection().toString()) input.focus();
  });

  // Esc closes the terminal (only when it's the active surface)
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); terminal.close(); }
  });
})();
