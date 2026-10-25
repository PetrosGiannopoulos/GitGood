// Settings → About → "Update GitGood". The pure half — main.js does the network, the
// download and the hand-off to the installer; this decides what the answers mean.
//
// "Latest" is whatever version `main`'s package.json declares. An installed copy cannot
// run main's source, so it updates to the GitHub release built from that version
// (tags are `release_<version>`, each holding the NSIS installer, zipped).

// -1 / 0 / 1 for dotted numeric versions ("1.1.24" vs "1.1.9" compares as numbers, not
// strings). A pre-release suffix is ignored rather than guessed at.
function compareVersions(a, b) {
  const pa = String(a || '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The release for `version` and its Windows installer, from the GitHub releases list.
// A release matches when its tag or name holds the version as a whole token, so
// "1.1.2" does not pick up "1.1.24". A bare .exe is preferred over the zip that wraps
// it (a quarter of the download); drafts are skipped. Returns null when main is ahead
// of the published releases.
function pickReleaseAsset(releases, version) {
  const v = String(version || '').replace(/\./g, '\\.');
  if (!v) return null;
  const re = new RegExp(`(^|[^0-9.])v?${v}($|[^0-9.])`);
  for (const r of releases || []) {
    if (!r || r.draft) continue;
    if (!re.test(r.tag_name || '') && !re.test(r.name || '')) continue;
    const assets = (r.assets || []).filter(a => a && a.browser_download_url);
    const exe = assets.find(a => /setup.*\.exe$/i.test(a.name) || /\.exe$/i.test(a.name));
    const zip = assets.find(a => /\.zip$/i.test(a.name));
    const a = exe || zip;
    if (!a) continue;
    return { tag: r.tag_name, name: a.name, url: a.browser_download_url, size: a.size || 0, zipped: !exe, page: r.html_url || '' };
  }
  return null;
}

// The installer inside an extracted release zip: a Setup .exe, never something under
// win-unpacked/ (that is the bare app, which would just run the old-style copy).
function findInstallerIn(paths) {
  return (paths || [])
    .filter(p => /\.exe$/i.test(p) && !/[\\/]win-unpacked[\\/]/i.test(p))
    .sort((a, b) => (/setup/i.test(b) ? 1 : 0) - (/setup/i.test(a) ? 1 : 0))[0] || null;
}

module.exports = { compareVersions, pickReleaseAsset, findInstallerIn };
