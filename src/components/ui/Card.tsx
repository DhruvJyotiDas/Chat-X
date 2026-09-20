import type { HTMLAttributes } from 'react';

/**
 * DESIGN_SYSTEM.md §8 — Card.
 *
 * White fill, a real border (matters on pure white — a shadow alone at
 * --ib-shadow-md's intensity can read as invisible on a white-on-white
 * page without one), soft two-layer shadow.
 */
export default function Card({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`bg-[var(--ib-surface-raised)] rounded-[var(--ib-radius-lg)] border border-[var(--ib-gray-100)]
        shadow-[var(--ib-shadow-md)] ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
