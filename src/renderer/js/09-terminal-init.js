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

  async open() {
    const { overlay, input } = this.els();
    if (!overlay) return;
    overlay.classList.remove('hidden');
    if (!this.started) await this.start();
    setTimeout(() => input && input.focus(), 30);
  },

  close() {
    const { overlay } = this.els();
    if (overlay) overlay.classList.add('hidden');
    // Keep the session alive in the background so state persists if reopened.
  },

  async start() {
    const { output, label, prompt } = this.els();
    if (output) output.textContent = '';
    // Bump the session id; any data/exit event from an older session is ignored.
    const mySession = (this.session = (this.session || 0) + 1);

    // Tear down old subscriptions before starting a new backend session.
    if (this.unsubData) { this.unsubData(); this.unsubData = null; }
    if (this.unsubExit) { this.unsubExit(); this.unsubExit = null; }

    const cwd = (state.repo && state.repo.path) || undefined;
    let r;
    try {
      r = await gs.termStart({ cwd });
    } catch (e) {
      this.write('Failed to start shell: ' + (e.message || e) + '\n', 'term-err');
      return;
    }
    if (mySession !== this.session) return;  // superseded by a newer start()
    if (!r || !r.ok) {
      this.write('Failed to start shell: ' + ((r && r.error) || 'unknown') + '\n', 'term-err');
      this.started = false;
      return;
    }
    this.started = true;
    this.running = false;
    if (label) label.textContent = r.data.label || 'Terminal';
    if (prompt) prompt.textContent = (r.data.type === 'cmd') ? '>' : '$';
    this.write(`${r.data.label} — ${r.data.shell}\n`, 'term-dim');
    this.write(`${r.data.cwd}\n\n`, 'term-dim');

    // Subscribe to streamed output, gated on this session id.
    this.unsubData = gs.onTermData(({ data }) => {
      if (mySession === this.session) this.write(this.clean(data));
    });
    this.unsubExit = gs.onTermExit(({ code }) => {
      if (mySession !== this.session) return;
      this.write(`\n[shell exited${code != null ? ' with code ' + code : ''}] — press Restart to start a new session.\n`, 'term-dim');
      this.started = false;
      this.running = false;
    });
  },

  async restart() {
    // start() already replaces the backend session (term:start kills any existing
    // shell). The session-id guard ensures the old shell's exit event is ignored.
    this.write('\n[restarting shell…]\n', 'term-dim');
    this.started = false;
    await this.start();
  },

  send(line) {
    if (!this.started) { this.write('No active shell. Press Restart.\n', 'term-err'); return; }
    // Echo the command with a prompt, like a real terminal.
    const { prompt } = this.els();
    this.write((prompt ? prompt.textContent : '$') + ' ', 'term-prompt-echo');
    this.write(line + '\n', 'term-cmd');
    gs.termInput(line + '\n');
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
