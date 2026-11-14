import { Check, ChevronDown, CircleAlert } from 'lucide-react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

/**
 * Text is 16 px so that phones do not zoom in when a field takes focus, and
 * every control is at least 48 px tall.
 */
export const controlClass =
  'block min-h-12 w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-base text-ink ' +
  'placeholder:text-ink-faint transition-colors hover:border-ink-faint ' +
  'aria-invalid:border-danger-600 aria-invalid:bg-danger-50/40 disabled:bg-sunken disabled:text-ink-faint';

interface Labelled {
  /** Ties the label, the hint and the error to the control. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Marks the label "(optional)". Required fields carry no mark: most fields are required. */
  optional?: boolean;
  className?: string;
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-sm font-medium text-danger-700">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function describedBy(id: string, hint: ReactNode, error?: string | null): string | undefined {
  const ids = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function Shell({
  id,
  label,
  hint,
  error,
  optional,
  className,
  children,
}: Labelled & { children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        {optional ? <span className="font-normal text-ink-faint"> (optional)</span> : null}
      </label>
      {children}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type TextFieldProps = Labelled &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'> & { inputClassName?: string };

export function TextField({
  id,
  label,
  hint,
  error,
  optional,
  className,
  inputClassName,
  ...input
}: TextFieldProps) {
  return (
    <Shell
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={className}
    >
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(controlClass, inputClassName)}
        {...input}
      />
    </Shell>
  );
}

export type SelectFieldProps = Labelled &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'className'>;

export function SelectField({
  id,
  label,
  hint,
  error,
  optional,
  className,
  children,
  ...select
}: SelectFieldProps) {
  return (
    <Shell
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={className}
    >
      <div className="relative">
        <select
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          className={cn(controlClass, 'appearance-none pr-10')}
          {...select}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
      </div>
    </Shell>
  );
}

export type TextAreaFieldProps = Labelled &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className'>;

export function TextAreaField({
  id,
  label,
  hint,
  error,
  optional,
  className,
  ...textarea
}: TextAreaFieldProps) {
  return (
    <Shell
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={className}
    >
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(controlClass, 'min-h-24 resize-y')}
        {...textarea}
      />
    </Shell>
  );
}

export interface CheckboxFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'className'
> {
  id: string;
  label: ReactNode;
  error?: string | null;
  className?: string;
}

/** A checkbox whose whole row, label included, is the tap target. */
export function CheckboxField({ id, label, error, className, ...input }: CheckboxFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="flex min-h-11 items-start gap-3 py-1.5 text-[15px] text-ink">
        <span className="relative mt-0.5 flex size-6 shrink-0 items-center justify-center">
          <input
            id={id}
            type="checkbox"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="peer size-6 appearance-none rounded-md border border-line-strong bg-surface transition-colors checked:border-ink checked:bg-ink hover:border-ink-faint aria-invalid:border-danger-600"
            {...input}
          />
          <Check
            className="pointer-events-none absolute size-4 text-white opacity-0 peer-checked:opacity-100"
            strokeWidth={3}
            aria-hidden
          />
        </span>
        <span className="pt-0.5">{label}</span>
      </label>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </div>
  );
}
