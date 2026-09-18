// Forge list paging (pure, extracted from main.js).
//
// Neither forge puts paging in the body. GitHub sends a Link header with rel="next"/"last"
// and no count at all; GitLab sends X-Total and X-Total-Pages *and* a Link header. GitHub's
// search endpoint is the one exception — total_count is in the body, and it is the only
// place a GitHub total is ever available, which is why the caller may pass one in.
//
// `total` is legitimately null for GitHub's list endpoints, and the footer has to keep
// "of 213" apart from "50 loaded" rather than invent a number — so null must survive.
const FORGE_PAGE_SIZE = 50;

function forgeLinkPage(link, rel) {
  const seg = String(link || '').split(',').find(s => s.includes(`rel="${rel}"`));
  const m = seg && seg.match(/[?&]page=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function forgePageInfo(res, count, page, bodyTotal) {
  const h = res.headers || {};
  const link = String(h.link || '');
  const glTotal = parseInt(h['x-total'], 10);
  const glPages = parseInt(h['x-total-pages'], 10);

  const total = typeof bodyTotal === 'number' ? bodyTotal : (isNaN(glTotal) ? null : glTotal);
  const totalPages = !isNaN(glPages) ? glPages : (forgeLinkPage(link, 'last') || null);

  let hasMore;
  if (forgeLinkPage(link, 'next')) hasMore = true;
  else if (link) hasMore = false;                       // a Link header that has no next is the end
  else if (total !== null) hasMore = total > page * FORGE_PAGE_SIZE;
  else hasMore = count >= FORGE_PAGE_SIZE;             // nothing to go on but a full page

  return { page, perPage: FORGE_PAGE_SIZE, total, totalPages, hasMore };
}

module.exports = { FORGE_PAGE_SIZE, forgeLinkPage, forgePageInfo };
