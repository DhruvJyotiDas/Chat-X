/**
 * The Icebrkr "IB" monogram, white on transparency.
 *
 * Every call site already wraps this in a #0066FF tile, so the mark itself
 * carries no background — keep it that way, or you get blue on blue.
 */
export default function BrandMark({ className = '' }: { className?: string }) {
  return (
    <img
      src="/logo-mark-white.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`object-contain select-none ${className}`}
    />
  );
}
