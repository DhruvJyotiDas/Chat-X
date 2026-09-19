import { useReducedMotion } from '../../hooks/useReducedMotion';

/**
 * Shared boolean-switch primitive (bug-batch 2026-09-19, section 3).
 *
 * Built because every existing toggle in the app was its own hand-rolled
 * `role="switch"` button — see the same commit's inventory in
 * CHANGELOG.md for the full list. The live bug report ("Translate from
 * English" in Live Captions rendering with a washed-out track/knob) traced
 * to a real, shared design gap none of them had: an off-state track relying
 * only on a subtle fill-color difference from the surrounding surface, with
 * no border to fall back on when that difference isn't enough contrast.
 * This component is the fix, applied once here instead of per call site.
 *
 * Visual track is 44x24 (`w-11 h-6`) regardless of the actual clickable
 * area, which is padded out to a 44x44 minimum — a switch this physically
 * small would otherwise fail the mobile tap-target floor used everywhere
 * else in this redesign.
 */
interface SwitchProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  /** Alternate callback name some call sites already use; either works. */
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

// Off-track border: --ib-gray-600, not the closer --ib-gray-400 -- computed
// WCAG relative-luminance contrast against a white/raised surface came out
// to ~2.5:1 for gray-400 (fails the 3:1 non-text-contrast floor) vs ~5.9:1
// for gray-600, and ~7.6:1 against the dark-mode surface. Checked, not
// eyeballed, since this exact "looks fine but doesn't measure" gap is what
// produced the live bug this component fixes.
export default function Switch({
  checked, onChange, onCheckedChange, disabled = false, className = '', ...aria
}: SwitchProps) {
  const reduceMotion = useReducedMotion();

  const toggle = () => {
    if (disabled) return;
    onChange?.(!checked);
    onCheckedChange?.(!checked);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      disabled={disabled}
      onClick={toggle}
      className={`relative inline-flex h-11 w-11 shrink-0 items-center justify-center
        disabled:opacity-40 disabled:cursor-not-allowed
        ${disabled ? '' : 'cursor-pointer'}
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ib-focus)]
        rounded-full ${className}`}
    >
      <span
        className={`relative h-6 w-11 rounded-full border ${reduceMotion ? '' : 'transition-colors duration-150'} ${
          checked
            ? 'bg-[var(--ib-blue-500)] border-[var(--ib-blue-500)]'
            : 'bg-[var(--ib-gray-200)] border-[var(--ib-gray-600)]'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white
            shadow-[0_1px_2px_rgba(18,22,29,0.18),0_1px_1px_rgba(18,22,29,0.08)]
            ${reduceMotion ? '' : 'transition-transform duration-150'}
            ${checked ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </span>
    </button>
  );
}
