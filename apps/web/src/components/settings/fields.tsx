'use client';

import { Copy } from 'lucide-react';
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

/** A switch with its label and explanation beside it. Clicking the text toggles it too. */
export function SwitchField({
  label,
  hint,
  checked,
  onChange,
  disabled,
  className,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'flex items-start justify-between gap-4',
        !disabled && 'cursor-pointer',
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[13px] text-ink-faint">{hint}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </label>
  );
}

/** A value to hand over (a link, an address) shown read-only with a button that copies it. */
export function CopyField({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  className?: string;
}) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      // The clipboard is unavailable on plain-HTTP origins and when the browser denies access.
      toast.error('Could not copy. Select the text and copy it yourself.');
    }
  };
  return (
    <Field label={label} hint={hint} className={className}>
      {(props) => (
        <div className="flex gap-2">
          <Input
            {...props}
            readOnly
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 font-mono text-[13px]"
          />
          <Button
            icon={<Copy className="size-4" />}
            aria-label={`Copy ${label}`}
            onClick={() => void copy()}
          >
            Copy
          </Button>
        </div>
      )}
    </Field>
  );
}

function supportedValues(kind: 'timeZone' | 'currency'): string[] {
  try {
    return Intl.supportedValuesOf(kind);
  } catch {
    return [];
  }
}

// Some browsers list India under its older name only; the name this product defaults to must be offered too.
const TIME_ZONES = [...new Set(['Asia/Kolkata', 'UTC', ...supportedValues('timeZone')])].sort();
const CURRENCIES = supportedValues('currency');

function zonesByRegion(zones: string[]): [string, string[]][] {
  const regions = new Map<string, string[]>();
  for (const zone of zones) {
    const region = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other';
    regions.set(region, [...(regions.get(region) ?? []), zone]);
  }
  return [...regions.entries()];
}

/** A time zone picker listing the names the browser knows, grouped by region. */
export function TimeZoneSelect({
  value,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'children'> & { value: string }) {
  // A stored zone the browser does not list (an alias, say) must stay selectable, or opening the
  // form would silently change it.
  const zones = TIME_ZONES.includes(value) || value === '' ? TIME_ZONES : [value, ...TIME_ZONES];
  return (
    <Select {...props} value={value}>
      {zonesByRegion(zones).map(([region, names]) => (
        <optgroup key={region} label={region}>
          {names.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'list'>;

/**
 * A three-letter currency code. Shown in capitals however it is typed; callers
 * send `value.toUpperCase()`.
 */
export function CurrencyInput({ className, ...props }: TextInputProps) {
  const listId = useId();
  return (
    <>
      <Input
        {...props}
        list={listId}
        pattern="[A-Za-z]{3}"
        minLength={3}
        maxLength={3}
        title="Three letters, such as INR"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className={cn('uppercase', className)}
      />
      <datalist id={listId}>
        {CURRENCIES.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>
    </>
  );
}

/**
 * A short code for a property, room type or rate plan. The server stores it in
 * capitals, so it is shown that way however it is typed.
 */
export function CodeInput({ className, ...props }: TextInputProps) {
  return (
    <Input
      {...props}
      pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,19}"
      maxLength={20}
      title="Up to 20 letters, digits, dashes or underscores"
      autoComplete="off"
      autoCapitalize="characters"
      spellCheck={false}
      className={cn('font-mono uppercase placeholder:font-sans placeholder:normal-case', className)}
    />
  );
}
