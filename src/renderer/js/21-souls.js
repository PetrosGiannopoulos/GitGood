// ============================================
// THE SOUL WORLD — the graveyard realm
// ============================================
// Where discarded work goes when git kept it anyway. Three realms:
//
//   Spirit Branches — branches that were deleted, with the tip they held when you left them.
//   Shades          — commits no ref can reach any more: the far side of a reset, a
//                     pre-amend commit, a rebase casualty, a dropped stash.
//   Relics          — file contents that were staged and then discarded. A blob with no tree
//                     above it has no name and no date anywhere, so the preview *is* its
//                     identity: it is the only way anyone recognises which file this was.
//
// Two depths. The panel opens on the reflog alone, which is a file read and answers most
// questions instantly. **Commune Deeper** runs `git fsck` over the whole object database —
// the only way to reach what the reflog has already forgotten, and the only source of
// Relics — and it is a button, never a refresh, because on a heavy repository it is a wait.
// The two are disjoint by construction (see the fsck flag notes in main), so the deep pass
// only ever adds; anything marked "beyond the reflog" came from it.
//
// The panel's one hard rule is that it never lists something it cannot actually return.
// Every hash here was confirmed present by main before it was sent; a soul gc has already
// collected is dropped rather than shown greyed out, because a graveyard whose names are
// sometimes fiction is worse than no graveyard.
//
// And the honest half, which the footer says out loud: staging is what gives a change a
// soul. Anything ever staged survives as a Relic even if it was never committed. A change
// discarded *before* staging was never handed to git at all, and no depth of search can
// return it.

const soulView = {
  spirits: [],
  shades: [],
  relics: [],
  expiry: null,
  loading: false,
  loaded: false,
  tab: 'spirits',
  empty: false,
  deep: false,        // has the fsck pass run for this repository?
  deepFor: null,      // …for which one. A new repo has not been searched, whatever this one was.
  communing: false
};

// `deep` runs the fsck pass. It is never automatic: fsck walks the whole object database,
// and on a repository with a heavy binary history that is a wait, not a blink. The fast
// pass answers most questions on its own — this is for when it did not.
async function openSoulWorld(deep) {
  if (!state.repo) { showToast('Open a repository first', 'error'); return; }
  // "Already searched" belongs to a repository, not to the panel: carrying the flag across
  // an open would tell someone their new repo's empty Relics tab was an answer.
  if (soulView.deepFor !== state.repo.path) {
    soulView.deep = false;
    soulView.deepFor = state.repo.path;
    soulView.loaded = false;
    soulView.spirits = []; soulView.shades = []; soulView.relics = [];
  }
  soulView.loading = true;
  soulView.communing = !!deep;
  if (!soulView.loaded) soulView.tab = 'spirits';
  renderSoulModal();

  const run = () => gs.soulSurvey({ deep: !!deep });
  const r = deep ? await withLoading('Communing with the dead', run) : await run();

  soulView.loading = false;
  soulView.communing = false;
  if (!r || !r.ok) {
    renderSoulBody(r && r.error);
    return;
  }
  soulView.spirits = r.data.spirits || [];
  soulView.shades = r.data.shades || [];
  soulView.relics = r.data.relics || [];
  soulView.expiry = r.data.expiry || null;
  soulView.empty = !!r.data.empty;
  // Sticky: once the deep pass has run, the panel keeps showing what it found rather than
  // quietly narrowing back to the reflog on the next open.
  soulView.deep = soulView.deep || !!r.data.deep;
  soulView.loaded = true;
  // Land on whichever realm actually has anyone in it, so the panel does not greet a
  // desperate user with an empty tab while the thing they lost sits one click away.
  if (!soulView.spirits.length) {
    if (soulView.shades.length) soulView.tab = 'shades';
    else if (soulView.relics.length) soulView.tab = 'relics';
  }
  if (deep && soulView.relics.length) soulView.tab = 'relics';
  renderSoulBody();
}

// Re-show the panel from what is already loaded. This is what every "Back" out of a
// sub-dialog uses, and it has to exist: a plain openSoulWorld() there would run the shallow
// survey, which returns no relics — quietly emptying the Relics tab of a repository that had
// just been searched. Re-running the deep pass instead would spend an fsck on a button press
// that changed nothing.
function reopenSoulWorld() {
  if (!soulView.loaded) { openSoulWorld(); return; }
  renderSoulModal();
  renderSoulBody();
}

function renderSoulModal() {
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Work you let go of, that git kept regardless. Everything listed here
      is still in this repository — confirmed, not guessed — and can be brought back.</p>
    <div class="soul-tabs" id="soul-tabs"></div>
    <div class="soul-body" id="soul-body">
      <div class="empty-state"><span class="loading"></span></div>
    </div>
    <p class="modal-text text-muted soul-note">
      <strong>Staging is what gives a change a soul.</strong> Anything you ever staged survives here
      as a Relic even if you never committed it — the bytes went to git the moment you added them.
      A change discarded <em>before</em> staging was never handed over at all, so nothing can return
      it: not this panel, not any tool, at any depth.
    </p>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-medieval';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => modal.hide();

  // The deep pass is a button and never a refresh, for the same reason the Forge tab's is:
  // it is the expensive call, and the user should be the one who decides to spend it.
  const communeBtn = document.createElement('button');
  communeBtn.className = 'btn-medieval primary';
  communeBtn.id = 'soul-commune-btn';
  communeBtn.innerHTML = '<span class="btn-icon">☾</span> Commune Deeper';
  communeBtn.title = 'Search the whole object database with git fsck — finds what the reflog has ' +
    'already forgotten, and file contents that were staged and then discarded. Slow on a large repository.';
  communeBtn.onclick = () => openSoulWorld(true);

  modal.show({ title: '☠ The Soul World', body, footer: [closeBtn, communeBtn] });
}

function renderSoulTabs() {
  const host = document.getElementById('soul-tabs');
  if (!host) return;
  const tabs = [
    ['spirits', '⑂ Spirit Branches', soulView.spirits.length],
    ['shades', '☁ Shades', soulView.shades.length],
    ['relics', '⚱ Relics', soulView.relics.length]
  ];
  host.innerHTML = tabs.map(([id, label, n]) =>
    `<button class="mini-btn${soulView.tab === id ? ' active' : ''}" data-soul-tab="${id}">${label}${
      n ? ` <span class="forge-num">${n}</span>` : ''}</button>`).join('');

  const btn = document.getElementById('soul-commune-btn');
  if (btn) {
    btn.disabled = soulView.communing;
    // Nothing stops a second pass — objects keep being orphaned — but saying it has already
    // run is what tells the user an empty Relics tab is an answer rather than a not-yet.
    btn.innerHTML = soulView.deep
      ? '<span class="btn-icon">☾</span> Commune Again'
      : '<span class="btn-icon">☾</span> Commune Deeper';
  }
}

function renderSoulBody(error) {
  renderSoulTabs();
  const host = document.getElementById('soul-body');
  if (!host) return;                       // the modal was closed while loading

  if (error) {
    host.innerHTML = `<div class="empty-state"><p class="text-red">${escapeHtml(error)}</p></div>`;
    return;
  }
  if (soulView.loading) {
    host.innerHTML = `<div class="empty-state"><span class="loading"></span>${
      soulView.communing ? '<p class="text-muted">Walking the whole object database. This can take a while on a large repository.</p>' : ''}</div>`;
    return;
  }

  host.innerHTML = soulView.tab === 'relics' ? soulRelicsHtml()
    : soulView.tab === 'shades' ? soulShadesHtml()
    : soulSpiritsHtml();
}

// A prompt, not an empty answer. Until the deep pass has run, an empty realm means "not
// looked" rather than "nothing there", and the two must not read the same.
function soulDeepHintHtml(what) {
  if (soulView.deep) return '';
  return `<p class="text-muted">Only the reflog has been read so far. <strong>Commune Deeper</strong>
    searches the whole object database for ${escapeHtml(what)}.</p>`;
}

// How long a soul has left before gc collects it. Reported from the repository's own
// gc settings rather than the documented defaults, because a repo that has turned expiry
// off keeps these forever and saying "30 days" at it would be wrong.
function soulFadeHtml(at) {
  const days = soulView.expiry && soulView.expiry.reflogDays;
  if (!days || !at) return '';
  const age = Math.floor((Date.now() - at) / 86400000);
  const left = days - age;
  if (left > 14) return '';                // plenty of time; saying so is just noise
  const cls = left <= 3 ? ' soul-fading-soon' : '';
  return left <= 0
    ? `<span class="soul-fade${cls}" title="Past this repository's reflog expiry — the next gc may collect it">fading now</span>`
    : `<span class="soul-fade${cls}" title="Roughly when this repository's gc settings would let it go">fades in ~${left}d</span>`;
}

function soulSpiritsHtml() {
  if (!soulView.spirits.length) {
    return `<div class="empty-state">
      <div class="empty-icon">⑂</div>
      <p>No deleted branches the reflog remembers.</p>
      <p class="text-muted">A branch created and deleted without ever being checked out leaves no
        trace in HEAD's reflog — its commits may still appear under Shades.</p>
    </div>`;
  }
  return `<div class="soul-list">${soulView.spirits.map(s => `
    <div class="soul-row">
      <div class="soul-row-main">
        <span class="soul-icon">⑂</span>
        <span class="soul-name">${escapeHtml(s.name)}</span>
        <span class="commit-hash" data-soul-hash="${escapeHtml(s.sha)}" title="Copy hash">${escapeHtml(s.sha.slice(0, 7))}</span>
        ${s.reachable
          ? '<span class="soul-tag-ok" title="These commits are still reachable from a living branch — the work survived, only the name was lost">work survives</span>'
          : '<span class="soul-tag-lost" title="No living branch can reach these commits — this name is the only way back to them">only way back</span>'}
        ${soulFadeHtml(s.at)}
      </div>
      <div class="soul-row-meta">
        last seen ${escapeHtml(soulWhen(s.at))}${s.leftFor ? ' · you left it for ' + escapeHtml(s.leftFor) : ''}
      </div>
      <div class="soul-row-acts">
        <button class="mini-btn" data-soul-act="resurrect" data-soul-name="${escapeHtml(s.name)}" data-soul-sha="${escapeHtml(s.sha)}">↑ Resurrect</button>
        <button class="mini-btn" data-soul-act="anchor" data-soul-sha="${escapeHtml(s.sha)}" title="Tag it so gc can never collect it">⚓ Anchor</button>
      </div>
    </div>`).join('')}</div>`;
}

function soulShadesHtml() {
  if (!soulView.shades.length) {
    return `<div class="empty-state">
      <div class="empty-icon">☁</div>
      <p>Nothing orphaned that ${soulView.deep ? 'this repository holds' : 'the reflog remembers'}.</p>
      ${soulDeepHintHtml('commits the reflog has already forgotten')}
    </div>`;
  }
  return `<div class="soul-list">${soulView.shades.map(s => `
    <div class="soul-row">
      <div class="soul-row-main">
        <span class="soul-icon">☁</span>
        <span class="soul-subject">${escapeHtml(s.subject || '(no message)')}</span>
        <span class="commit-hash" data-soul-hash="${escapeHtml(s.sha)}" title="Copy hash">${escapeHtml(s.short)}</span>
        ${soulIsStash(s) ? '<span class="soul-tag-lost" title="A stash that was dropped. Branching here gives you its contents.">dropped stash</span>' : ''}
        ${s.forgotten
          ? '<span class="soul-tag-deep" title="Found by searching the object database — the reflog no longer has any record of this commit, so there is no telling what removed it">beyond the reflog</span>'
          : soulFadeHtml(s.at)}
      </div>
      <div class="soul-row-meta">
        ${s.author ? escapeHtml(s.author) + ' · ' : ''}${s.forgotten
          ? 'written ' + escapeHtml(soulWhen(s.authoredAt)) + ' · no record of how it was lost'
          : 'lost ' + escapeHtml(soulWhen(s.at)) +
            ' · <span class="soul-reason" title="The last thing the reflog saw happen to it">' + escapeHtml(s.lastAction || '') + '</span>'}
      </div>
      <div class="soul-row-acts">
        <button class="mini-btn" data-soul-act="resurrect" data-soul-sha="${escapeHtml(s.sha)}">⑂ Branch here</button>
        <button class="mini-btn" data-soul-act="anchor" data-soul-sha="${escapeHtml(s.sha)}" title="Tag it so gc can never collect it">⚓ Anchor</button>
      </div>
    </div>`).join('')}</div>`;
}

// A dropped stash is still just a commit, so it takes the same actions — but saying what it
// is turns an unrecognisable "WIP on main: 9315c68" into something you know you lost.
function soulIsStash(s) {
  return /^(WIP on |On )\S+:/.test(s.subject || '');
}

// Relics are the answer to "I staged it, then threw it away". A blob with no tree above it
// has no name and no date anywhere in the repository — the content *is* the identity, which
// is why every row leads with a preview rather than a hash.
function soulRelicsHtml() {
  if (!soulView.relics.length) {
    return `<div class="empty-state">
      <div class="empty-icon">⚱</div>
      <p>${soulView.deep ? 'No orphaned file contents in this repository.' : 'Not searched yet.'}</p>
      ${soulDeepHintHtml('file contents that were staged and then discarded')}
      ${soulView.deep ? '<p class="text-muted">Content that was only ever committed is not here — it belongs to a commit, so it comes back with one, under Shades.</p>' : ''}
    </div>`;
  }
  return `<div class="soul-list">${soulView.relics.map(r => `
    <div class="soul-row">
      <div class="soul-row-main">
        <span class="soul-icon">⚱</span>
        <span class="soul-name">${escapeHtml(soulBytes(r.size))}</span>
        <span class="commit-hash" data-soul-hash="${escapeHtml(r.sha)}" title="Copy hash">${escapeHtml(r.short)}</span>
      </div>
      <div class="soul-row-meta">staged once, never committed — it has no name and no date, only content</div>
      <div class="soul-row-acts">
        <button class="mini-btn" data-soul-act="view" data-soul-sha="${escapeHtml(r.sha)}">👁 View</button>
        <button class="mini-btn" data-soul-act="save" data-soul-sha="${escapeHtml(r.sha)}">⤓ Save As…</button>
      </div>
    </div>`).join('')}</div>`;
}

function soulBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// The preview is the whole point: it is how somebody recognises which of their files this
// was. Binary content is reported as binary rather than rendered as mojibake, which would
// make a recoverable file look like garbage.
async function soulViewRelic(sha) {
  const r = await withLoading('Reading', () => gs.soulRelic({ sha }));
  if (!r || !r.ok) { showToast((r && r.error) || 'Could not read it.', 'error', 6000); return; }
  const d = r.data;

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">
      <span class="text-mono">${escapeHtml(sha.slice(0, 7))}</span> · ${escapeHtml(soulBytes(d.size))}
      ${d.binary ? ' · <strong>binary</strong>' : ''}${d.truncated ? ' · showing the first 64 KB' : ''}
    </p>
    ${d.binary
      ? `<p class="modal-text text-muted">This is binary content, so there is nothing readable to show —
         but the bytes are intact. Save it under the name it should have had and it is exactly the
         file you staged.</p>`
      : `<pre class="soul-preview">${escapeHtml(d.text)}</pre>`}`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-medieval';
  closeBtn.textContent = 'Back';
  closeBtn.onclick = () => reopenSoulWorld();

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-medieval primary';
  saveBtn.innerHTML = '<span class="btn-icon">⤓</span> Save As…';
  saveBtn.onclick = () => soulSaveRelic(sha);

  modal.show({ title: '⚱ Relic', body, footer: [closeBtn, saveBtn] });
}

async function soulSaveRelic(sha) {
  const r = await withLoading('Saving', () => gs.soulSaveRelic({ sha }));
  if (!r || !r.ok) { showToast((r && r.error) || 'Could not save it.', 'error', 6000); return; }
  if (r.data.canceled) { reopenSoulWorld(); return; }
  showToast(`Recovered ${soulBytes(r.data.bytes)} to ${r.data.path}`, 'success', 6000);
  // The file lands in the working tree far more often than not, so the status is now stale.
  await refreshAll();
}

function soulWhen(ms) {
  if (!ms) return 'at some point';
  return typeof relativeTime === 'function' ? relativeTime(new Date(ms).toISOString()) : new Date(ms).toLocaleString();
}

// Resurrection needs a name. A spirit branch offers the one it had; a shade never had one,
// so it gets a suggestion built from its hash rather than an empty box.
async function soulResurrect(sha, suggested) {
  const proposed = suggested || `recovered/${sha.slice(0, 7)}`;
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">Create a branch at <span class="text-mono">${escapeHtml(sha.slice(0, 7))}</span>.
      Nothing else moves — your current branch and working tree are untouched.</p>
    <div class="modal-field">
      <label>Branch name</label>
      <input class="modal-input" id="soul-branch-name" value="${escapeHtml(proposed)}" autocomplete="off" />
    </div>`;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-medieval';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.hide();

  const goBtn = document.createElement('button');
  goBtn.className = 'btn-medieval primary';
  goBtn.innerHTML = '<span class="btn-icon">↑</span> Resurrect';
  goBtn.onclick = async () => {
    const name = body.querySelector('#soul-branch-name').value.trim();
    if (!name) { showToast('A branch name is required', 'error'); return; }
    modal.hide();
    const r = await withLoading('Resurrecting', () => gs.soulResurrect({ name, sha }));
    if (!handleResult(r, `${name} walks again`)) { reopenSoulWorld(); return; }
    await refreshAll();
  };

  modal.show({ title: '↑ Resurrect', body, footer: [cancelBtn, goBtn] });
  setTimeout(() => { const el = body.querySelector('#soul-branch-name'); if (el) el.select(); }, 0);
}

// Anchoring writes a tag, which is the only permanent mark this panel leaves — so it says
// so before doing it rather than after.
async function soulAnchor(sha) {
  const proposed = `souls/${sha.slice(0, 7)}`;
  const ok = await modal.confirm({
    title: '⚓ Anchor This Soul',
    message: `Tag ${sha.slice(0, 7)} as "${proposed}".\n\n` +
      `A tag is a real reference, so git stops counting this commit as unreachable and gc can ` +
      `never collect it. It stops fading — permanently, until you delete the tag yourself.`,
    confirmText: 'Anchor It'
  });
  if (!ok) return;
  const r = await withLoading('Anchoring', () => gs.soulAnchor({ sha, name: proposed }));
  if (!handleResult(r, `Anchored as ${proposed}`)) { reopenSoulWorld(); return; }
  await refreshAll();
  // Back into the realm: anchoring tends to come in threes, and the anchored soul leaving
  // the list is the confirmation — it is reachable from a tag now, so it is no longer lost.
  await openSoulWorld(soulView.deep);
}

// One delegated listener, because the panel's body is rebuilt on every tab change.
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-soul-tab]');
  if (tab) { soulView.tab = tab.dataset.soulTab; renderSoulBody(); return; }

  const hash = e.target.closest('[data-soul-hash]');
  if (hash) { copyText(hash.dataset.soulHash, 'Hash copied'); return; }

  const act = e.target.closest('[data-soul-act]');
  if (!act) return;
  const sha = act.dataset.soulSha;
  switch (act.dataset.soulAct) {
    case 'resurrect': soulResurrect(sha, act.dataset.soulName || ''); break;
    case 'anchor': soulAnchor(sha); break;
    case 'view': soulViewRelic(sha); break;
    case 'save': soulSaveRelic(sha); break;
  }
});

// Toolbar button, alongside Undo — the two are the same instinct at different depths.
(() => {
  const btn = document.getElementById('btn-souls');
  if (btn) btn.onclick = () => openSoulWorld();
})();
