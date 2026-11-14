'use client';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { hexColour, sixDigitColour, websiteUsesColour } from './values';

/**
 * The property's own colour on the website. The website takes a plain hex colour and nothing
 * else, so the colour is picked, or its code typed, and never a name or an `rgb()` value.
 */
export function ColourField({
  value,
  onChange,
  saved,
  error,
  className,
}: {
  /** The code as typed. Empty: no colour of its own. */
  value: string;
  onChange: (value: string) => void;
  /** The colour as it is saved now. */
  saved: string;
  error?: string;
  className?: string;
}) {
  const colour = hexColour(value);
  const unusable = value === saved && saved !== '' && !websiteUsesColour(saved);
  return (
    <Field
      label="Colour of buttons and links"
      optional
      className={className}
      error={error}
      hint={
        unusable
          ? `The website cannot use “${saved}” and shows its own colour. Pick a colour, or remove this one.`
          : colour
            ? 'Used for the buttons and links on this property’s pages of the website.'
            : 'Pick a colour or type its code, such as #1f6f8b. Without one, the website uses its own colour.'
      }
    >
      {(props) => (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="color"
            aria-label="Pick a colour"
            // The picker cannot be empty: without a colour it rests on white.
            value={colour ? sixDigitColour(colour) : '#ffffff'}
            onChange={(e) => onChange(e.target.value)}
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface p-1 shadow-sm"
          />
          <Input
            {...props}
            value={value}
            placeholder="No colour"
            maxLength={20}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="w-32 font-mono placeholder:font-sans"
            onChange={(e) => onChange(e.target.value)}
          />
          {value.trim() !== '' && (
            <Button
              variant="ghost"
              onClick={() => {
                onChange('');
                // This button goes with the colour: the keyboard moves to the code.
                document.getElementById(props.id)?.focus();
              }}
            >
              Remove the colour
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}
