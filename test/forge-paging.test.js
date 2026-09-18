// Forge list paging. `total` being legitimately null for GitHub is the load-bearing part:
// the footer has to say "50 loaded" rather than invent a count.
const test = require('node:test');
const assert = require('node:assert');

const { FORGE_PAGE_SIZE, forgeLinkPage, forgePageInfo } = require('../src/main/lib/forge-paging');

const res = (headers) => ({ headers });

test('forgeLinkPage: pulls the page number out of a Link header', () => {
  const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
  assert.strictEqual(forgeLinkPage(link, 'next'), 2);
  assert.strictEqual(forgeLinkPage(link, 'last'), 5);
  assert.strictEqual(forgeLinkPage(link, 'prev'), 0);
  assert.strictEqual(forgeLinkPage('', 'next'), 0);
});

test('GitHub: a Link header with rel=next means there is more, and total stays null', () => {
  const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
  const info = forgePageInfo(res({ link }), FORGE_PAGE_SIZE, 1);
  assert.strictEqual(info.hasMore, true);
  assert.strictEqual(info.totalPages, 5);
  assert.strictEqual(info.total, null, 'GitHub list endpoints never report a count');
});

test('GitHub: a Link header without rel=next is the end of the list', () => {
  const link = '<https://api.github.com/x?page=4>; rel="prev", <https://api.github.com/x?page=1>; rel="first"';
  assert.strictEqual(forgePageInfo(res({ link }), FORGE_PAGE_SIZE, 5).hasMore, false);
});

test('GitLab: X-Total and X-Total-Pages are used directly', () => {
  const info = forgePageInfo(res({ 'x-total': '213', 'x-total-pages': '5' }), FORGE_PAGE_SIZE, 1);
  assert.strictEqual(info.total, 213);
  assert.strictEqual(info.totalPages, 5);
  assert.strictEqual(info.hasMore, true);
});

test('GitLab: the last page reports no more', () => {
  const info = forgePageInfo(res({ 'x-total': '60', 'x-total-pages': '2' }), 10, 2);
  assert.strictEqual(info.hasMore, false, '60 items over two pages ends at page 2');
});

test('GitHub search: a body total wins over any header', () => {
  const info = forgePageInfo(res({ 'x-total': '999' }), 30, 1, 30);
  assert.strictEqual(info.total, 30);
  assert.strictEqual(info.hasMore, false);
});

test('no paging information at all: a full page implies more', () => {
  assert.strictEqual(forgePageInfo(res({}), FORGE_PAGE_SIZE, 1).hasMore, true);
  assert.strictEqual(forgePageInfo(res({}), 12, 1).hasMore, false);
  assert.strictEqual(forgePageInfo(res({}), 12, 1).total, null);
});

test('a response with no headers object does not throw', () => {
  const info = forgePageInfo({}, 0, 1);
  assert.strictEqual(info.total, null);
  assert.strictEqual(info.perPage, FORGE_PAGE_SIZE);
});
