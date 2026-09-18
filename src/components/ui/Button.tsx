import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * DESIGN_SYSTEM.md §8 — Button.
 *
 * Three variants, one shape family (pill, per the reference pages). This is
 * a new shared primitive, not a reskin of an existing one — see
 * UI_REDESIGN_PLAN.md §1: no Button component existed anywhere before this;
 * every screen hand-rolled its own <button className="...">. Migrating a
 * call site onto this one is the actual redesign work for that screen, not
 * a separate step afterward.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--ib-blue-500)] text-white shadow-[var(--ib-shadow-sm)] ' +
    'hover:bg-[var(--ib-blue-600)] active:scale-[0.98] ' +
    'disabled:bg-[var(--ib-gray-200)] disabled:text-[var(--ib-gray-400)] disabled:shadow-none',
  secondary:
    'bg-white text-[var(--ib-gray-800)] border border-[var(--ib-gray-200)] ' +
    'hover:bg-[var(--ib-gray-50)] active:scale-[0.98] ' +
    'disabled:text-[var(--ib-gray-400)] disabled:bg-[var(--ib-gray-50)]',
  ghost:
    'bg-transparent text-[var(--ib-blue-500)] hover:bg-[var(--ib-blue-50)] active:scale-[0.98] ' +
    'disabled:text-[var(--ib-gray-400)]',
};

// Heights/text/padding per size — sm/md/lg per §8. Padding is horizontal only;
// height is fixed so icon-only and text buttons of the same size line up.
const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-[var(--ib-radius-pill)]',
  md: 'h-10 px-4 text-[15px] gap-2 rounded-[var(--ib-radius-pill)]',
  lg: 'h-12 px-6 text-[18px] gap-2 rounded-[var(--ib-radius-pill)]',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Rendered before the label — pass a lucide-react icon element, e.g. <Plus className="w-4 h-4" />. */
  icon?: ReactNode;
  /** Rendered after the label, for e.g. a chevron. */
  iconAfter?: ReactNode;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon, iconAfter, className = '', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center font-semibold whitespace-nowrap
        transition-all duration-150 cursor-pointer disabled:cursor-not-allowed
        ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
      {iconAfter}
    </button>
  );
});

export default Button;
