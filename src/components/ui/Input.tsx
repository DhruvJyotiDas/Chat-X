import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes } from 'react';

/**
 * DESIGN_SYSTEM.md §8 — Input.
 *
 * Filled at rest (matches ib-account's existing input pattern — a grey fill,
 * not a bare border, see UI_REDESIGN_PLAN.md §3), border+ring on focus.
 * Replaces the one local Input that only existed inside SettingsModal.tsx
 * (UI_REDESIGN_PLAN.md §1) with something every form can share.
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
        className={`h-10 px-3.5 rounded-[var(--ib-radius-md)] text-[15px] text-[var(--ib-gray-900)]
          bg-[var(--ib-gray-50)] border transition-colors placeholder:text-[var(--ib-gray-400)]
          outline-none
          ${error
            ? 'border-[var(--ib-bad-dot)] focus:shadow-[0_0_0_3px_var(--ib-bad-fill)]'
            : 'border-[var(--ib-gray-200)] focus:bg-white focus:border-[var(--ib-blue-500)] focus:shadow-[var(--ib-shadow-focus)]'
          } ${className}`}
        {...rest}
      />
      {error && <span className="text-[12px] text-[var(--ib-bad-text)]">{error}</span>}
    </div>
  );
});

export default Input;
