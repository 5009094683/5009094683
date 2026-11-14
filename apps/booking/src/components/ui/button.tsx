import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { LinkPending } from './link-pending';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';
type Size = 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg text-center font-semibold transition-colors select-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress! aria-busy:opacity-75! ' +
  // For a link, while the page it leads to is being fetched: see `LinkPending`.
  'has-[[data-pending]]:animate-pulse has-[[data-pending]]:cursor-progress has-[[data-pending]]:opacity-75';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-on-brand shadow-sm hover:bg-brand-700 active:bg-brand-800',
  secondary:
    'border border-line-strong bg-surface text-ink shadow-sm hover:bg-sunken active:bg-line',
  quiet: 'text-ink-soft underline-offset-4 hover:bg-sunken hover:text-ink',
  danger: 'bg-danger-600 text-white shadow-sm hover:bg-danger-700',
};

/** Every size is at least 44 px tall: a comfortable target for a thumb. */
const SIZES: Record<Size, string> = {
  md: 'min-h-11 px-4 py-2 text-[15px]',
  lg: 'min-h-12 px-5 py-2.5 text-base',
};

export function buttonClass(variant: Variant = 'secondary', size: Size = 'md'): string {
  return cn(BASE, VARIANTS[variant], SIZES[size]);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /**
   * Shows progress and marks the button busy. By itself this leaves the button
   * focusable, so that keyboard focus is not thrown back to the top of the
   * page, and the handler must ignore presses meanwhile. Where the page is
   * about to change anyway, set `disabled` as well.
   */
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      className={cn(buttonClass(variant, size), className)}
      {...props}
    >
      {loading ? <LoaderCircle className="size-5 shrink-0 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** A page of another site, such as the payment page: a plain link, not a client-side navigation. */
  external?: boolean;
}

/** A link that looks like a button, for actions that are really navigation. */
export function ButtonLink({
  href,
  variant = 'secondary',
  size = 'md',
  icon,
  external = false,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  const classes = cn(buttonClass(variant, size), className);
  if (external) {
    return (
      <a href={href} rel="noreferrer" className={classes} {...props}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} {...props}>
      <LinkPending icon={icon} />
      {children}
    </Link>
  );
}
