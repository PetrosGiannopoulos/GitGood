// ============================================
// LOCAL AI ASSISTANT (Ollama) — optional, OFF by default
// ============================================
// A lightweight, text-only assistant that answers questions about the open repo's
// commits and history. It is disabled until the user turns it on in Settings and
// accepts the prompt. All inference runs locally via Ollama; the model only ever
// returns text we render (it cannot run commands), and nothing touches the network
// except the one-time model download.

const LLM_DEFAULT_MODEL_UI = 'llama3.2:3b';
const LLM_DEFAULT_EMBED_MODEL_UI = 'nomic-embed-text';

// Curated chat models offered in Settings. Coder models reason far better over actual
// code; the trade-off is download size and RAM. Users can still type a custom tag.
const LLM_MODEL_CHOICES = [
  { id: 'llama3.2:3b',        label: 'Llama 3.2 3B — light & fast, good for quick questions (~2 GB)' },
  { id: 'qwen2.5-coder:7b',   label: 'Qwen2.5-Coder 7B — recommended for code (~5 GB, ~6 GB RAM)' },
  { id: 'qwen2.5-coder:14b',  label: 'Qwen2.5-Coder 14B — stronger reasoning (~9 GB, ~10 GB RAM)' },
  { id: 'deepseek-coder-v2:16b', label: 'DeepSeek-Coder-V2 16B — fast MoE, strong on code (~9 GB)' }
];

// Mirror of the saved toggle so the toolbar button can show/hide without a round-trip.
// Populated by applySavedAppSettings() at startup (see 08-lfs-settings.js wiring below).
if (typeof state !== 'undefined' && state.llmEnabled === undefined) state.llmEnabled = false;

function getLlmModel() {
  return (state && state.llmModel) || LLM_DEFAULT_MODEL_UI;
}
function getEmbedModel() {
  return (state && state.llmEmbedModel) || LLM_DEFAULT_EMBED_MODEL_UI;
}
function getRetrieval() {
  return !(state && state.llmRetrieval === false);
}

// Reflect enabled state on the toolbar button (hidden when off).
function updateAssistantButton() {
  const btn = document.getElementById('btn-assistant');
  if (!btn) return;
  btn.classList.toggle('hidden', !(state && state.llmEnabled));
}

// Modal shown when Ollama isn't reachable, with a link to install it.
function showOllamaMissing() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="lfs-status-banner not-available">
      <div class="lfs-status-icon">⚠</div>
      <div>
        <div class="lfs-status-title">Ollama not found</div>
        <div class="lfs-status-text">
          The assistant runs on <strong>Ollama</strong>, a free local model runner. It isn't
          installed (or its background service isn't running) on this machine.
          Install it, make sure it's running, then enable the assistant again.
        </div>
      </div>
    </div>
    <p class="modal-text text-muted" style="font-size:12px;margin-top:10px">
      Ollama runs entirely on your computer — models are downloaded once and then work offline.
    </p>
  `;
  const dl = document.createElement('button');
  dl.className = 'btn-medieval primary';
  dl.innerHTML = '<span class="btn-icon">↗</span> Get Ollama';
  dl.onclick = () => gs.openExternal('https://ollama.com/download');
  const close = document.createElement('button');
  close.className = 'btn-medieval'; close.textContent = 'Close';
  close.onclick = () => modal.hide();
  modal.show({ title: '⚜ Local AI Assistant', body, footer: [close, dl] });
}

// Run a long, progress-reporting LLM job (download or index build) behind a modal with
// a live progress bar and a Cancel button. `job` is a function returning the IPC result.
// Resolves the IPC result ({ ok, ... }) or null if the user cancelled.
function runLlmProgress({ title, intro, job }) {
  return new Promise(async (resolve) => {
    const body = document.createElement('div');
    body.className = 'llm-pull';
    body.innerHTML = `
      <p class="modal-text">${intro}</p>
      <div class="llm-progress-track"><div class="llm-progress-bar" id="llm-prog-bar" style="width:0%"></div></div>
      <div class="llm-progress-status text-mono" id="llm-prog-status">Starting…</div>
    `;
    let finished = false;
    const off = gs.onLlmProgress((p) => {
      const bar = body.querySelector('#llm-prog-bar');
      const st = body.querySelector('#llm-prog-status');
      if (bar && typeof p.progress === 'number') bar.style.width = Math.max(0, Math.min(100, p.progress)) + '%';
      if (st) st.textContent = p.status ? (p.progress ? `${p.status} — ${p.progress}%` : p.status) : 'Working…';
    });
    const cancel = document.createElement('button');
    cancel.className = 'btn-medieval'; cancel.textContent = 'Cancel';
    cancel.onclick = () => { if (!finished) gs.llmCancel(); off(); modal.hide(); resolve(null); };
    modal.show({ title, body, footer: [cancel] });

    const r = await job();
    finished = true; off();
    modal.hide();
    resolve(r);
  });
}

// Download a model with a live progress bar. Resolves true on success.
async function pullModelWithProgress(model) {
  const r = await runLlmProgress({
    title: '⇣ Downloading Model',
    intro: `Downloading <strong>${escapeHtml(model)}</strong>. This is a one-time download and may take several minutes depending on your connection.`,
    job: () => gs.llmPull(model)
  });
  if (r === null) return false;            // cancelled
  if (r && r.ok) return true;
  showToast('Download failed: ' + (r && r.error), 'error', 8000);
  return false;
}

// Build/update the per-repo retrieval index. Ensures Ollama + the embed model are present
// first (pulling the embed model on demand). Resolves true if the index was (re)built.
async function buildRepoIndex() {
  if (!(state.repo && state.repo.path)) { showToast('Open a repository first', 'error'); return false; }
  const embed = getEmbedModel();

  const infoR = await withLoading('Checking Ollama', () => gs.llmInfo(embed));
  const info = (infoR && infoR.ok) ? infoR.data : { available: false };
  if (!info.available) { showOllamaMissing(); return false; }
  if (!info.hasModel) {
    const ok = await modal.confirm({
      title: 'Download embedding model',
      message: `Indexing needs the embedding model "${embed}" (a small one-time download, ~270 MB). Download it now?`,
      confirmText: 'Download'
    });
    if (!ok) return false;
    if (!(await pullModelWithProgress(embed))) return false;
  }

  const maxCommits = (state && state.llmIndexMaxCommits) || 300;
  const r = await runLlmProgress({
    title: '⚜ Indexing Repository',
    intro: `Reading and embedding recent commit diffs (up to ${maxCommits} commits). This runs locally and may take a little while the first time.`,
    job: () => gs.llmBuildIndex({ embedModel: embed, maxCommits })
  });
  if (r === null) { showToast('Indexing cancelled', 'info'); return false; }
  if (!r || !r.ok) { showToast('Indexing failed: ' + (r && r.error), 'error', 8000); return false; }
  const d = r.data || {};
  showToast(d.added ? `Indexed ${d.added} commit(s) · ${d.chunks} chunks total` : 'Index already up to date', 'success');
  return true;
}

// The enable flow: confirm → check Ollama → pull model if needed → persist.
// Returns true if the assistant ends up enabled.
async function enableAssistant(model) {
  model = model || getLlmModel();
  const ok = await modal.confirm({
    title: '⚜ Enable Local AI Assistant',
    message:
      'This adds an optional assistant that answers questions about your commits and history.\n\n' +
      '• Runs 100% locally via Ollama — nothing leaves your machine.\n' +
      '• Needs a one-time model download (~2 GB) and a few GB of RAM.\n' +
      '• It only reads your Git history and replies with text — it cannot run commands or reach the internet (beyond that one-time download).\n\n' +
      'Enable it now?',
    confirmText: 'Enable'
  });
  if (!ok) return false;

  const infoR = await withLoading('Checking for Ollama', () => gs.llmInfo(model));
  const info = (infoR && infoR.ok) ? infoR.data : { available: false };
  if (!info.available) { showOllamaMissing(); return false; }

  if (!info.hasModel) {
    const proceed = await modal.confirm({
      title: 'Download model',
      message: `The model "${model}" isn't installed yet. Download it now? This is a one-time download of roughly 2 GB.`,
      confirmText: 'Download'
    });
    if (!proceed) return false;
    const pulled = await pullModelWithProgress(model);
    if (!pulled) return false;
  }

  const r = await gs.setAppSettings({ llmAssistant: true, llmModel: model });
  if (!r || !r.ok) { showToast('Failed to save setting: ' + (r && r.error), 'error', 6000); return false; }
  state.llmEnabled = true;
  state.llmModel = model;
  updateAssistantButton();
  showToast('AI assistant enabled', 'success');
  return true;
}

async function disableAssistant() {
  const r = await gs.setAppSettings({ llmAssistant: false });
  if (r && r.ok) { state.llmEnabled = false; updateAssistantButton(); showToast('AI assistant disabled', 'success'); }
}

// ---- Chat dialog ---------------------------------------------------------------
const LLM_EXAMPLES = [
  'Who made the most recent change, and in which commit?',
  'Summarize what changed in the last 5 commits.',
  'How many lines are in preload.js and what does it do?',
  'What has this branch been working on lately?'
];

async function showAssistantChat() {
  if (!(state.repo && state.repo.path)) { showToast('Open a repository first', 'error'); return; }

  // Confirm the engine is up before opening the chat.
  const infoR = await withLoading('Checking assistant', () => gs.llmInfo(getLlmModel()));
  const info = (infoR && infoR.ok) ? infoR.data : { available: false, hasModel: false };
  if (!info.available) { showOllamaMissing(); return; }
  if (!info.hasModel) {
    const proceed = await modal.confirm({
      title: 'Model missing',
      message: `The model "${getLlmModel()}" isn't downloaded. Download it now (one-time, ~2 GB)?`,
      confirmText: 'Download'
    });
    if (!proceed) return;
    if (!(await pullModelWithProgress(getLlmModel()))) return;
  }

  // Retrieval status — if it's on but the repo isn't indexed, offer to build it now.
  const useRetrieval = getRetrieval();
  let indexed = false;
  if (useRetrieval) {
    const sR = await gs.llmIndexStatus();
    indexed = !!(sR && sR.ok && sR.data && sR.data.exists && sR.data.chunks > 0);
    if (!indexed) {
      const build = await modal.confirm({
        title: 'Index this repository?',
        message: 'For content-aware answers (about the actual code in your changes), the assistant works best with a local index of your commit diffs. Build it now? You can also skip and answer from the commit log only.',
        confirmText: 'Build index', cancelText: 'Skip'
      });
      if (build) indexed = await buildRepoIndex();
    }
  }

  const body = document.createElement('div');
  body.className = 'llm-chat';
  body.innerHTML = `
    <div class="llm-chat-log" id="llm-chat-log">
      <div class="llm-msg assistant">
        <div class="llm-msg-role">Assistant</div>
        <div class="llm-msg-text">Ask me about this repository's commits, history and changes. I read your repo locally and answer in plain text — I can't run commands. Try one of these:</div>
        <div class="llm-examples">${LLM_EXAMPLES.map(q => `<button class="llm-example" type="button">${escapeHtml(q)}</button>`).join('')}</div>
      </div>
    </div>
    <div class="llm-chat-input">
      <textarea id="llm-q" class="modal-input" rows="2" placeholder="Ask about commits, authors, code changes…"></textarea>
      <button class="btn-medieval primary" id="llm-send" type="button"><span class="btn-icon">➤</span> Ask</button>
    </div>
    <div class="llm-chat-foot text-muted">Model: <span class="text-mono">${escapeHtml(getLlmModel())}</span> · ${useRetrieval && indexed ? 'using indexed diffs' : 'commit log only'} · runs locally</div>
  `;

  const logEl = body.querySelector('#llm-chat-log');
  const qEl = body.querySelector('#llm-q');
  const sendBtn = body.querySelector('#llm-send');
  let busy = false;

  const addMsg = (role, text) => {
    const el = document.createElement('div');
    el.className = 'llm-msg ' + role;
    el.innerHTML = `<div class="llm-msg-role">${role === 'user' ? 'You' : 'Assistant'}</div><div class="llm-msg-text"></div>`;
    el.querySelector('.llm-msg-text').textContent = text || '';
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
    return el.querySelector('.llm-msg-text');
  };

  async function ask(question) {
    question = (question || '').trim();
    if (!question || busy) return;
    busy = true;
    qEl.value = '';
    sendBtn.innerHTML = '<span class="btn-icon">■</span> Stop';

    addMsg('user', question);
    const out = addMsg('assistant', '');
    out.classList.add('streaming');

    let got = false;
    const off = gs.onLlmToken((p) => {
      if (p && p.text) { got = true; out.textContent += p.text; logEl.scrollTop = logEl.scrollHeight; }
    });
    // While a request is in flight, the button cancels it.
    const stop = () => { gs.llmCancel(); };
    sendBtn.onclick = stop;

    const r = await gs.llmAsk({
      question, model: getLlmModel(),
      useRetrieval: useRetrieval && indexed,
      embedModel: getEmbedModel()
    });
    off();
    out.classList.remove('streaming');
    if (!r || !r.ok) {
      out.textContent = (got ? out.textContent + '\n\n' : '') + '⚠ ' + ((r && r.error) || 'Request failed');
    } else if (!got && r.data && r.data.answer) {
      out.textContent = r.data.answer;
    }
    busy = false;
    sendBtn.innerHTML = '<span class="btn-icon">➤</span> Ask';
    sendBtn.onclick = () => ask(qEl.value);
    qEl.focus();
  }

  sendBtn.onclick = () => ask(qEl.value);
  qEl.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(qEl.value); }
  };
  body.querySelectorAll('.llm-example').forEach(b => {
    b.onclick = () => ask(b.textContent);
  });

  const close = document.createElement('button');
  close.className = 'btn-medieval'; close.textContent = 'Close';
  close.onclick = () => { gs.llmCancel(); modal.hide(); };
  modal.show({ title: '⚜ AI Assistant', body, footer: [close] });
  setTimeout(() => qEl.focus(), 50);
}

// Wire the toolbar button.
(() => {
  const btn = document.getElementById('btn-assistant');
  if (btn) btn.onclick = () => showAssistantChat();
})();
