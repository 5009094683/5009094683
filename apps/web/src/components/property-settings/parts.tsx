'use client';

import { Pencil } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import type { SettingsForm } from './use-settings-form';
import { countText } from './values';

/** One section of a property's settings as it stands, with the way in to editing it for those who may. */
export function SettingsCard({
  title,
  status,
  onEdit,
  children,
}: {
  title: string;
  /** A badge beside the title. */
  status?: ReactNode;
  onEdit?: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Card className="p-4 sm:p-5">
      <section aria-labelledby={headingId}>
        <div className="flex items-start justify-between gap-3 pb-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 id={headingId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {status}
          </div>
          {onEdit && (
            <Button
              size="sm"
              icon={<Pencil className="size-3.5" aria-hidden />}
              // Four sections each have this button: its name says which one it edits.
              aria-label={`Edit ${title.charAt(0).toLowerCase()}${title.slice(1)}`}
              onClick={onEdit}
            >
              Edit
            </Button>
          )}
        </div>
        {children}
      </section>
    </Card>
  );
}

/** The settings of a section, laid out as the property's details are: up to four to a row. */
export function Items({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4', className)}>
      {children}
    </dl>
  );
}

/** A setting and its value, inside `Items`. */
export function Item({
  label,
  empty = 'Not set',
  note,
  className,
  children,
}: {
  label: string;
  /** What to say when there is no value. */
  empty?: string;
  /** A line under the value that says what it means. */
  note?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <dt className="text-[13px] text-ink-faint">{label}</dt>
      <dd className="text-sm break-words text-ink">
        {children || <span className="text-ink-faint">{empty}</span>}
        {note && <p className="text-[13px] text-ink-faint">{note}</p>}
      </dd>
    </div>
  );
}

function Clamped({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const measure = useCallback((node: HTMLParagraphElement | null) => {
    if (!node) return undefined;
    const check = () => {
      // Opened out, nothing is cut off: whether there is more to show was settled before.
      if (node.dataset.open === undefined) setCut(node.scrollHeight > node.clientHeight + 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <p
        ref={measure}
        data-open={open ? '' : undefined}
        className={cn('whitespace-pre-line', !open && 'line-clamp-4')}
      >
        {text}
      </p>
      {(cut || open) && (
        <button
          type="button"
          aria-expanded={open}
          className="mt-1 text-[13px] font-medium text-brand-700 hover:underline"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}

/** A text that may run to pages, shown by its first lines with a way to read the rest. */
export function LongText({ text }: { text: string }) {
  // A new text is measured afresh.
  return <Clamped key={text} text={text} />;
}

/** A group of fields under a heading, two to a row where there is room. */
export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <h3
        id={headingId}
        className="border-b border-line pb-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase sm:col-span-2"
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

/** What is wrong with a text that is longer than the server takes, or undefined when it fits. */
export function tooLong(text: string, limit: number): string | undefined {
  const over = text.trim().length - limit;
  return over > 0
    ? `This is ${plural(over, 'character')} too long. It can hold ${countText(limit)}: shorten it to save.`
    : undefined;
}

/**
 * A text of several lines with a limit. Nothing is cut off as it is typed or pasted: a text
 * that is too long says so, and by how much, so that nothing goes missing unnoticed.
 */
export function LongTextField({
  label,
  hint,
  value,
  onChange,
  limit,
  rows = 5,
  placeholder,
  className,
}: {
  label: string;
  hint: ReactNode;
  value: string;
  onChange: (value: string) => void;
  limit: number;
  rows?: number;
  placeholder?: string;
  className?: string;
}) {
  const length = value.trim().length;
  return (
    <Field
      label={label}
      optional
      className={className}
      error={tooLong(value, limit)}
      hint={
        <>
          {hint}
          {length >= limit * 0.9 && ` ${countText(length)} of ${countText(limit)} characters used.`}
        </>
      }
    >
      {(props) => (
        <Textarea
          {...props}
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="resize-y"
        />
      )}
    </Field>
  );
}

/**
 * A box for a whole number. It is a text box that brings up the number keys on a phone, not a
 * number box: a number box hands over nothing at all for something like `1e`, and what was
 * typed would then pass for an empty box.
 */
export function WholeNumberInput({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'inputMode'>) {
  return (
    <Input
      {...props}
      type="text"
      inputMode="numeric"
      maxLength={4}
      autoComplete="off"
      className={cn('sm:max-w-40', className)}
    />
  );
}

/**
 * Moves the keyboard once the next change is on the page. For a list whose rows carry their own
 * buttons: the button just used may have gone, or moved, or been switched off, and the keyboard
 * would be left on nothing.
 */
export function useFocusAfterChange(): (find: () => HTMLElement | null | undefined) => void {
  const pending = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useEffect(() => {
    const find = pending.current;
    pending.current = null;
    find?.()?.focus();
  });
  return useCallback((find) => {
    pending.current = find;
  }, []);
}

/**
 * The dialog around one section's form. Cancel drops the changes, as it says. Escape, the
 * cross and a click outside are easily done by accident, so with changes in the form they ask
 * first.
 */
export function SettingsDialog<Values, Problem extends string>({
  title,
  description,
  size = 'lg',
  form,
  onClose,
  children,
}: {
  title: string;
  description: ReactNode;
  size?: 'md' | 'lg';
  form: SettingsForm<Values, Problem>;
  onClose: () => void;
  children: ReactNode;
}) {
  const formId = useId();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Dialog
        open
        onClose={() => (form.dirty && !form.busy ? setAsking(true) : onClose())}
        size={size}
        title={title}
        description={description}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" form={formId} variant="primary" loading={form.busy}>
              Save
            </Button>
          </>
        }
      >
        <form
          ref={form.ref}
          id={formId}
          onSubmit={form.submit}
          noValidate
          className="flex flex-col gap-5"
        >
          <FormError message={form.error && `Could not save. ${form.error}`} />
          {children}
        </form>
      </Dialog>
      {asking && (
        <Dialog
          open
          onClose={() => setAsking(false)}
          size="sm"
          title="Discard the changes?"
          footer={
            <>
              <Button onClick={() => setAsking(false)}>Keep editing</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setAsking(false);
                  onClose();
                }}
              >
                Discard changes
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-soft">
            What you changed here is not saved yet. If you close now, it is lost.
          </p>
        </Dialog>
      )}
    </>
  );
}
