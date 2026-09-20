/**
 * The IB three-dot mark — DESIGN_SYSTEM.md §7.
 *
 * Did not exist anywhere in this codebase before this file (checked: no
 * asset, no CSS, no reference by any name — see UI_REDESIGN_PLAN.md §1).
 * Not to be confused with BrandMark.tsx, the existing IB lettermark (a
 * raster PNG always inside a blue tile) — a different element entirely.
 *
 * Built as three real circles (not a raster image) specifically so it can
 * be recolored, resized, and animated purely with CSS — a PNG can't do any
 * of that. Uses the same red/amber/green tokens as the status Badge
 * component, deliberately: the mark and the status system read as the same
 * idea wherever both appear, not two unrelated uses of the same three hues.
 *
 * [X] This is my own default design, not a real icebrkr brand asset — I
 * have not seen the actual marketing site's version of this mark. If one
 * exists, it should replace this rather than this becoming the source of
 * truth by default.
 */

interface BrandDotsProps {
  /** 'static' = brand context, all three dots at rest. 'loading' = cycling
   *  pulse, one dot "lit" at a time — see the animation in index.css. */
  mode?: 'static' | 'loading';
  size?: number;
  className?: string;
}

const COLORS = ['var(--ib-bad-dot)', 'var(--ib-warn-dot)', 'var(--ib-good-dot)'];

export default function BrandDots({ mode = 'static', size = 10, className = '' }: BrandDotsProps) {
  const gap = size * 0.6;
  return (
    <div
      className={`inline-flex items-center ${className}`}
      style={{ gap }}
      role="img"
      aria-label="IB Connect"
    >
      {COLORS.map((color, i) => (
        <span
          key={i}
          className={mode === 'loading' ? 'ib-brand-dot rounded-full shrink-0' : 'rounded-full shrink-0'}
          style={{ width: size, height: size, backgroundColor: color }}
        />
      ))}
    </div>
  );
}
