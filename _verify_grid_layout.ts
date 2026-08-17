/**
 * Property checks for `selectGridLayout` and `computeTileSize`.
 *
 * Run with `npx tsx _verify_grid_layout.ts`.
 *
 * The container sizes below were MEASURED from a real browser at each viewport, not
 * estimated — `minWidth` in GRID_LAYOUTS is compared against the grid container, which
 * is the viewport minus the stage padding, and guessing that offset is exactly how the
 * 360px-phone bug survived (the 2x3 layout required 360 against a 344px container).
 */
import { selectGridLayout, GRID_LAYOUTS, type GridLayoutInfo } from './src/lib/gridLayout';
import { computeTileSize } from './src/hooks/useGridLayout';

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** viewport label -> measured grid container size. */
const CONTAINERS: [string, number, number][] = [
  ['phone 360x740',            344, 652],
  ['phone 390x844',            374, 756],
  ['phone 430x932',            414, 844],
  ['phone landscape 844x390',  812, 278],
  ['tablet 768x1024',          736, 912],
  ['tablet 1024x768',          992, 656],
  ['laptop 1280x800',         1248, 688],
  ['laptop 1440x900',         1408, 788],
  ['desktop 1920x1080',       1888, 968],
];

console.log('\n── Ceiling per container (regression lock on measured sizes) ──');
{
  const expected: Record<string, number> = {
    'phone 360x740': 6,
    'phone 390x844': 6,
    'phone 430x932': 6,
    'phone landscape 844x390': 9,
    'tablet 768x1024': 12,
    'tablet 1024x768': 12,
    'laptop 1280x800': 16,
    'laptop 1440x900': 16,
    'desktop 1920x1080': 16,
  };
  for (const [name, w, h] of CONTAINERS) {
    const l = selectGridLayout(100, w, h, GRID_LAYOUTS);
    check(`${name} tops out at ${expected[name]}`, l.maxTiles === expected[name],
      `${l.columns}x${l.rows} = ${l.maxTiles}`);
  }
  const ceiling = Math.max(...GRID_LAYOUTS.map((d) => d.columns * d.rows));
  check('the absolute ceiling across every layout is 16', ceiling === 16, String(ceiling));
}

console.log('\n── Monotonicity ──');
{
  // The bug this locks: on a 374px container, 3 people used to get a 2-tile layout
  // (and therefore pagination) while 6 people got a 6-tile layout. Capacity must never
  // shrink as the call grows.
  let allMonotonic = true;
  const offenders: string[] = [];
  for (const [name, w, h] of CONTAINERS) {
    let prev = 0;
    for (let n = 1; n <= 40; n++) {
      const { maxTiles } = selectGridLayout(n, w, h, GRID_LAYOUTS);
      if (maxTiles < prev) {
        allMonotonic = false;
        offenders.push(`${name} @ ${n}: ${prev} -> ${maxTiles}`);
      }
      prev = maxTiles;
    }
  }
  check('capacity never decreases as participants are added', allMonotonic,
    offenders.slice(0, 3).join('; ') || 'none');

  let pagesMonotonic = true;
  const pageOffenders: string[] = [];
  for (const [name, w, h] of CONTAINERS) {
    let prevPages = 0;
    for (let n = 1; n <= 40; n++) {
      const { maxTiles } = selectGridLayout(n, w, h, GRID_LAYOUTS);
      const pages = Math.ceil(n / Math.max(1, maxTiles));
      if (pages < prevPages) { pagesMonotonic = false; pageOffenders.push(`${name} @ ${n}`); }
      prevPages = pages;
    }
  }
  check('page count never decreases as participants are added', pagesMonotonic,
    pageOffenders.slice(0, 3).join('; ') || 'none');
}
{
  // Specific: three people on a phone must fit on one page.
  const l = selectGridLayout(3, 374, 756, GRID_LAYOUTS);
  check('3 people on a 390px phone fit on one page', l.maxTiles >= 3,
    `${l.columns}x${l.rows} = ${l.maxTiles}`);
  const small = selectGridLayout(3, 344, 652, GRID_LAYOUTS);
  check('3 people on a 360px phone fit on one page', small.maxTiles >= 3,
    `${small.columns}x${small.rows} = ${small.maxTiles}`);
}
{
  // Widening the container must never cost the user a page.
  //
  // Note this is deliberately about PAGES, not raw capacity. Capacity can legitimately
  // fall as a container widens — the algorithm picks the smallest layout that still holds
  // everyone, so at 460px wide 4 people get 2x3 (capacity 6) and at 480px they get 2x2
  // (capacity 4). Both render two rows of two and both are one page, so nothing is lost.
  let ok = true;
  const bad: string[] = [];
  for (const n of [2, 4, 8, 16, 30]) {
    let prevPages = 0;
    for (let w = 200; w <= 2000; w += 20) {
      const { maxTiles } = selectGridLayout(n, w, 900, GRID_LAYOUTS);
      const pages = Math.ceil(n / Math.max(1, maxTiles));
      if (pages > prevPages && prevPages > 0) { ok = false; bad.push(`n=${n} w=${w}: ${prevPages} -> ${pages} pages`); }
      prevPages = pages;
    }
  }
  check('widening the container never costs a page', ok, bad.slice(0, 3).join('; ') || 'none');
}

console.log('\n── The container is always respected ──');
{
  let respected = true;
  const bad: string[] = [];
  for (const [name, w, h] of CONTAINERS) {
    for (let n = 1; n <= 40; n++) {
      const l = selectGridLayout(n, w, h, GRID_LAYOUTS);
      if (l.maxTiles === 1) continue;               // 1x1 is the universal fallback
      if (w < l.minWidth || h < l.minHeight) {
        respected = false;
        bad.push(`${name} n=${n} picked ${l.columns}x${l.rows} needing ${l.minWidth}x${l.minHeight}`);
      }
    }
  }
  check('a layout is never chosen that the container cannot accommodate', respected,
    bad.slice(0, 3).join('; ') || 'none');
}
{
  let ok = true;
  const bad: string[] = [];
  for (const [name, w, h] of CONTAINERS) {
    const orientation = w / h > 1 ? 'landscape' : 'portrait';
    for (let n = 1; n <= 40; n++) {
      const l = selectGridLayout(n, w, h, GRID_LAYOUTS) as GridLayoutInfo;
      if (l.orientation && l.orientation !== orientation) {
        ok = false;
        bad.push(`${name} (${orientation}) picked a ${l.orientation}-only ${l.columns}x${l.rows}`);
      }
    }
  }
  check('an orientation-restricted layout is never used in the wrong orientation', ok,
    bad.slice(0, 3).join('; ') || 'none');
}

console.log('\n── Degenerate inputs ──');
{
  const unmeasured = selectGridLayout(5, 0, 0, GRID_LAYOUTS);
  check('an unmeasured container falls back to 1x1 rather than throwing',
    unmeasured.columns === 1 && unmeasured.rows === 1, `${unmeasured.columns}x${unmeasured.rows}`);
  const none = selectGridLayout(0, 1248, 688, GRID_LAYOUTS);
  check('zero tiles returns a valid layout', none.maxTiles >= 1, String(none.maxTiles));
  const empty = selectGridLayout(4, 1248, 688, []);
  check('an empty definition table returns 1x1', empty.maxTiles === 1, String(empty.maxTiles));
}

console.log('\n── Tile sizing ──');
{
  // A layout with more rows than it needs must not shrink tiles: in those cases the
  // tile is bounded by column width, never by row height. See the note on
  // computeTileSize for why that holds rather than being luck.
  const layout = selectGridLayout(3, 374, 756, GRID_LAYOUTS);
  const t = computeTileSize({ width: 374, height: 756 }, layout, 8);
  const boundedByWidth = !!t && Math.abs(t.width - (374 - 8) / layout.columns) < 0.01;
  check('an over-provisioned layout is bounded by column width, not row height',
    layout.rows > Math.ceil(3 / layout.columns) && boundedByWidth,
    `${layout.columns}x${layout.rows}, tile ${t ? `${t.width.toFixed(0)}x${t.height.toFixed(0)}` : 'null'}`);
}
{
  let allSixteenByNine = true;
  const bad: string[] = [];
  for (const [name, w, h] of CONTAINERS) {
    for (const n of [1, 2, 3, 5, 9, 16]) {
      const layout = selectGridLayout(n, w, h, GRID_LAYOUTS);
      const t = computeTileSize({ width: w, height: h }, layout, 8);
      if (!t) continue;
      if (Math.abs(t.width / t.height - 16 / 9) > 0.001) {
        allSixteenByNine = false;
        bad.push(`${name} n=${n}: ${t.width.toFixed(1)}x${t.height.toFixed(1)}`);
      }
    }
  }
  check('every tile is exactly 16:9 (never stretched, so object-cover cannot crop)',
    allSixteenByNine, bad.slice(0, 3).join('; ') || 'none');
}
{
  let fitsContainer = true;
  const bad: string[] = [];
  for (const [name, w, h] of CONTAINERS) {
    for (let n = 1; n <= 16; n++) {
      const layout = selectGridLayout(n, w, h, GRID_LAYOUTS);
      const t = computeTileSize({ width: w, height: h }, layout, 8);
      if (!t) continue;
      const shown = Math.min(n, layout.maxTiles);
      const rows = Math.max(1, Math.ceil(shown / layout.columns));
      const usedW = layout.columns * t.width + 8 * (layout.columns - 1);
      const usedH = rows * t.height + 8 * (rows - 1);
      // 1px of slack for floating point.
      if (usedW > w + 1 || usedH > h + 1) {
        fitsContainer = false;
        bad.push(`${name} n=${n}: needs ${Math.round(usedW)}x${Math.round(usedH)} in ${w}x${h}`);
      }
    }
  }
  check('the laid-out grid never overflows its container', fitsContainer,
    bad.slice(0, 3).join('; ') || 'none');
}
{
  const t = computeTileSize({ width: 0, height: 0 }, selectGridLayout(2, 0, 0, GRID_LAYOUTS), 8);
  check('an unmeasured container yields no tile size rather than NaN', t === null, JSON.stringify(t));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall grid-layout checks passed');
process.exit(failures ? 1 : 0);
