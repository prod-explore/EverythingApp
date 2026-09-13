import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-fg text-bg hover:opacity-90 disabled:opacity-40',
  ghost: 'bg-transparent text-fg border border-border hover:border-border-hover disabled:opacity-40',
  danger: 'bg-transparent text-danger border border-danger/40 hover:bg-danger/10 disabled:opacity-40',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`rounded-button px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
