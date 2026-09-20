import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes } from 'react';

/**
 * DESIGN_SYSTEM.md §8 — Input.
 *
 * Filled at rest (matches ib-account's existing input pattern — a grey fill,
 * not a bare border, see UI_REDESIGN_PLAN.md §3), border+ring on focus.
 * Replaces the one local Input that only existed inside SettingsModal.tsx
 * (UI_REDESIGN_PLAN.md §1) with something every form can share.
 *
 * Phase 3, sub-unit 1 (foundations): text-base (16px) below md, text-sm
 * (14px, was a custom 15px) at md+ -- 16px is the iOS Safari threshold below
 * which focusing a field zooms the whole page in. touch-manipulation removes
 * the ~300ms tap delay on touch browsers that still have it. Height bumped
 * h-10 (40px) -> h-11 (44px) below md, unchanged 40px at md+ -- was under
 * this batch's 44px mobile tap-target floor.
 * autoCapitalize/autoCorrect/enterKeyHint already pass through via `...rest`
 * (valid InputHTMLAttributes) -- no change needed to support them, callers
 * set them per field (e.g. autoCapitalize="none" on an email input).
 */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, id, className = '', ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-[13px] font-medium text-[var(--ib-gray-600)]">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={!!error}
        className={`h-11 md:h-10 px-3.5 rounded-[var(--ib-radius-md)] text-base md:text-sm text-[var(--ib-gray-900)]
          bg-[var(--ib-gray-50)] border transition-colors placeholder:text-[var(--ib-gray-400)]
          outline-none touch-manipulation
          ${error
            ? 'border-[var(--ib-bad-dot)] focus:shadow-[0_0_0_3px_var(--ib-bad-fill)]'
            : 'border-[var(--ib-gray-200)] focus:bg-[var(--ib-surface-raised)] focus:border-[var(--ib-blue-500)] focus:shadow-[var(--ib-shadow-focus)]'
          } ${className}`}
        {...rest}
      />
      {error && <span className="text-[12px] text-[var(--ib-bad-text)]">{error}</span>}
    </div>
  );
});

export default Input;
