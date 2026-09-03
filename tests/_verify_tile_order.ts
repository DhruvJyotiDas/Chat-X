/**
 * Unit checks for `orderTiles` — the speaker-ranked, visually-stable tile ordering.
 *
 * Run with `npx tsx _verify_tile_order.ts`. Not a Playwright script: this is a pure
 * function and the properties that matter (stability, promotion, the hold window) are
 * far easier to pin down here than by choreographing browsers. The browser-level proof
 * that it is actually wired up lives in `_verify_speaker_promotion.mjs`.
 */
import { orderTiles, rankTiles, PROMOTE_HOLD_MS, type TileRankInput } from '../src/lib/tileOrder';

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const NOW = 1_000_000;

function tile(id: string, over: Partial<TileRankInput> = {}): TileRankInput {
  return {
    id,
    isLocal: false,
    isPresenting: false,
    isSpeaking: false,
    lastSpokeAt: 0,
    hasVideo: true,
    joinIndex: 0,
    ...over,
  };
}

/** Peers p1..pN plus a local tile, in arrival order. */
function room(n: number, over: Record<string, Partial<TileRankInput>> = {}) {
  const peers = Array.from({ length: n }, (_, i) =>
    tile(`p${i + 1}`, { joinIndex: i, ...(over[`p${i + 1}`] ?? {}) }));
  return [...peers, tile('me', { isLocal: true, joinIndex: n })];
}

const base = { currentPage: 0, promotedAt: new Map<string, number>(), now: NOW };

console.log('\n── Ranking ──');
{
  const ranked = rankTiles([
    tile('quiet', { joinIndex: 0 }),
    tile('talking', { joinIndex: 1, isSpeaking: true }),
    tile('spokeRecently', { joinIndex: 2, lastSpokeAt: NOW - 2000 }),
    tile('presenting', { joinIndex: 3, isPresenting: true }),
  ]);
  check('presenting outranks everything', ranked[0] === 'presenting', ranked.join(' > '));
  check('speaking outranks having spoken', ranked[1] === 'talking', ranked.join(' > '));
  check('recent speech outranks silence', ranked[2] === 'spokeRecently', ranked.join(' > '));
}
{
  const ranked = rankTiles([
    tile('noCam', { joinIndex: 0, hasVideo: false }),
    tile('withCam', { joinIndex: 1, hasVideo: true }),
  ]);
  check('a camera beats an avatar when nothing else separates them', ranked[0] === 'withCam');
}
{
  const a = rankTiles([tile('b', { joinIndex: 1 }), tile('a', { joinIndex: 0 })]);
  const b = rankTiles([tile('a', { joinIndex: 0 }), tile('b', { joinIndex: 1 })]);
  check('ranking is deterministic (join order breaks ties)', a.join() === b.join(), a.join());
}

console.log('\n── The local tile ──');
{
  // 20 peers + self, 16 per page. Before this change `[...peers, local]` put self at
  // index 20, i.e. page 2 — you could not see yourself at all.
  const { order } = orderTiles(room(20), { ...base, maxTiles: 16, previous: [] });
  const selfIndex = order.indexOf('me');
  check('self is on the first page in a large call', selfIndex >= 0 && selfIndex < 16,
    `index ${selfIndex} of ${order.length}`);
  check('self takes the last slot of the first page', selfIndex === 15, `index ${selfIndex}`);
}
{
  // Small call: "last" and "last on page 1" are the same slot, so nothing changes.
  const { order } = orderTiles(room(1), { ...base, maxTiles: 16, previous: [] });
  check('a 2-person call is unchanged (peer then self)', order.join() === 'p1,me', order.join());
}
{
  const { order } = orderTiles(room(3), { ...base, maxTiles: 4, previous: [] });
  check('a full first page still ends with self', order.join() === 'p1,p2,p3,me', order.join());
}

console.log('\n── Visual stability ──');
{
  // Nobody speaking, order carried forward: must not reshuffle just because ranks tie.
  const prev = ['p3', 'p1', 'p2'];
  const { order } = orderTiles(room(3), { ...base, maxTiles: 4, previous: prev });
  check('an existing order is preserved when nothing changed',
    order.filter((id) => id !== 'me').join() === 'p3,p1,p2', order.join());
}
{
  // Someone already visible starts talking: no reordering, because they are already seen.
  const prev = ['p1', 'p2', 'p3'];
  const tiles = room(3, { p3: { isSpeaking: true } });
  const { order, promoted } = orderTiles(tiles, { ...base, maxTiles: 4, previous: prev });
  check('a visible speaker does not cause a shuffle',
    order.filter((id) => id !== 'me').join() === 'p1,p2,p3' && promoted.length === 0,
    `${order.join()} promoted=[${promoted.join()}]`);
}
{
  const prev = ['p1', 'p2', 'p3', 'p4'];
  const tiles = room(4);
  // A peer leaves; the rest must keep their relative positions.
  const remaining = tiles.filter((t) => t.id !== 'p2');
  const { order } = orderTiles(remaining, { ...base, maxTiles: 4, previous: prev });
  check('a departure does not reshuffle the survivors',
    order.filter((id) => id !== 'me').join() === 'p1,p3,p4', order.join());
}
{
  const prev = ['p1', 'p2'];
  const { order } = orderTiles(room(3), { ...base, maxTiles: 4, previous: prev });
  check('a joiner is appended rather than inserted',
    order.filter((id) => id !== 'me').join() === 'p1,p2,p3', order.join());
}

console.log('\n── Promotion ──');
{
  // 3 peers + self, 2 per page. Page 1 holds one remote + self, so p2 and p3 are hidden.
  // p3 talking must be swapped onto the visible page.
  const prev = ['p1', 'p2', 'p3'];
  const tiles = room(3, { p3: { isSpeaking: true } });
  const { order, promoted } = orderTiles(tiles, { ...base, maxTiles: 2, previous: prev });
  const page1 = order.slice(0, 2);
  check('a hidden speaker is promoted onto the visible page', page1.includes('p3'),
    `page1=[${page1.join()}] promoted=[${promoted.join()}]`);
  check('the promotion is reported so the hold can be recorded', promoted.includes('p3'),
    promoted.join());
  check('self keeps its slot through a promotion', page1.includes('me'), page1.join());
  check('nobody is lost in the swap', order.length === 4 && new Set(order).size === 4, order.join());
}
{
  // The demoted tile must be the least interesting one, not simply the first.
  const prev = ['p1', 'p2', 'p3', 'p4'];
  const tiles = room(4, {
    p1: { lastSpokeAt: NOW - 1000 },   // spoke a second ago — worth keeping
    p2: { lastSpokeAt: 0 },            // never spoke — the one to drop
    p4: { isSpeaking: true },
  });
  const { order } = orderTiles(tiles, { ...base, maxTiles: 3, previous: prev });
  const page1 = order.slice(0, 3);
  check('promotion evicts the least recently active visible tile',
    page1.includes('p4') && page1.includes('p1') && !page1.includes('p2'),
    `page1=[${page1.join()}]`);
}
{
  // A presenter must never be evicted to make room for a speaker.
  const prev = ['p1', 'p2', 'p3'];
  const tiles = room(3, { p1: { isPresenting: true }, p3: { isSpeaking: true } });
  const { order } = orderTiles(tiles, { ...base, maxTiles: 2, previous: prev });
  check('a presenter is never demoted', order.slice(0, 2).includes('p1'), order.slice(0, 2).join());
}
{
  // Promotion targets the page the user is LOOKING at, not always page 1.
  const prev = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const tiles = room(5, { p1: { isSpeaking: true } });
  const { order } = orderTiles(tiles, { ...base, maxTiles: 2, currentPage: 1, previous: prev });
  // Slice the way `usePagination` actually does — page p is [p*maxTiles, +maxTiles).
  // The promotion pass works on the pre-insertion list and offsets its window by one
  // to account for the local tile that gets spliced in afterwards; asserting on the
  // real post-insertion page is what proves those two agree.
  const visible = order.slice(1 * 2, 1 * 2 + 2);
  check('promotion follows the page being viewed', visible.includes('p1'),
    `order=[${order.join()}] visible=[${visible.join()}]`);
}
{
  // Nobody worth promoting: order must be untouched.
  const prev = ['p1', 'p2', 'p3'];
  const { order, promoted } = orderTiles(room(3), { ...base, maxTiles: 2, previous: prev });
  check('silence causes no churn', promoted.length === 0 && order.slice(0, 2).includes('p1'),
    `${order.join()} promoted=[${promoted.join()}]`);
}

console.log('\n── The hold window (anti-flicker) ──');
{
  // p3 was promoted a moment ago; p2 now speaks. p3 must NOT be evicted immediately —
  // without this, two people talking over each other trade the same slot several times
  // a second and the grid becomes unreadable.
  const promotedAt = new Map([['p3', NOW - 500]]);
  const prev = ['p3', 'p2', 'p1'];
  const tiles = room(3, { p1: { isSpeaking: true } });
  const { order } = orderTiles(tiles, { ...base, maxTiles: 2, previous: prev, promotedAt });
  check('a tile inside its hold window is not evicted', order.slice(0, 2).includes('p3'),
    `page1=[${order.slice(0, 2).join()}]`);
}
{
  // Same setup, but the hold has expired — now the swap is allowed.
  const promotedAt = new Map([['p3', NOW - PROMOTE_HOLD_MS - 1]]);
  const prev = ['p3', 'p2', 'p1'];
  const tiles = room(3, { p1: { isSpeaking: true } });
  const { order } = orderTiles(tiles, { ...base, maxTiles: 2, previous: prev, promotedAt });
  check('the hold expires and the swap then happens', order.slice(0, 2).includes('p1'),
    `page1=[${order.slice(0, 2).join()}]`);
}
{
  // Someone who spoke 5 minutes ago is not "recent" and must not displace anyone.
  const prev = ['p1', 'p2', 'p3'];
  const tiles = room(3, { p3: { lastSpokeAt: NOW - 300_000 } });
  const { order, promoted } = orderTiles(tiles, { ...base, maxTiles: 2, previous: prev, promotedAt: new Map() });
  check('stale speech does not trigger promotion', promoted.length === 0, `promoted=[${promoted.join()}]`);
  void order;
}

console.log('\n── Degenerate inputs ──');
{
  const { order } = orderTiles([tile('me', { isLocal: true })], { ...base, maxTiles: 1, previous: [] });
  check('a call with only yourself works', order.join() === 'me', order.join());
}
{
  const { order } = orderTiles(room(2), { ...base, maxTiles: 0, previous: [] });
  check('maxTiles 0 (container not yet measured) does not throw or drop anyone',
    order.length === 3 && new Set(order).size === 3, order.join());
}
{
  // A stale previous order naming people who have left must not resurrect them.
  const { order } = orderTiles(room(2), { ...base, maxTiles: 4, previous: ['ghost1', 'p1', 'ghost2'] });
  check('ids from a previous room are dropped',
    order.join() === 'p1,p2,me' || order.join() === 'p1,me,p2',
    order.join());
  check('no ghost survives', !order.includes('ghost1') && !order.includes('ghost2'), order.join());
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall tile-order checks passed');
process.exit(failures ? 1 : 0);
