'use client';

import { Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { useFocusAfterChange } from './parts';
import { LIMITS, sameText } from './values';

/**
 * Amenities many properties list, offered until the list has something that covers them: a
 * property with a "Private pool" is not offered "Swimming pool". The website draws an icon for
 * each of these (`apps/booking/src/components/amenities.tsx`).
 */
const SUGGESTIONS: { name: string; covers: RegExp }[] = [
  { name: 'Swimming pool', covers: /pool/i },
  { name: 'Free Wi-Fi', covers: /wi-?fi|internet/i },
  { name: 'Free parking', covers: /parking/i },
  { name: 'Air conditioning', covers: /air.?con|a\/c\b|\bac\b/i },
  { name: 'Restaurant', covers: /restaurant/i },
  { name: 'Kitchen', covers: /kitchen/i },
  { name: 'Breakfast', covers: /breakfast/i },
  { name: 'Bar', covers: /\bbar\b/i },
  { name: 'Room service', covers: /room service/i },
  { name: 'Airport transfers', covers: /airport|transfers?\b|shuttle/i },
  { name: 'Garden', covers: /garden/i },
  { name: 'Daily housekeeping', covers: /housekeeping|cleaning|cleaned/i },
  { name: 'Laundry', covers: /laundry/i },
  { name: 'Gym', covers: /gym|fitness/i },
  { name: 'Spa', covers: /\bspa\b/i },
  { name: 'Pets welcome', covers: /\bpets?\b|\bdogs?\b/i },
];

/**
 * The list of amenities: each can be taken off, and more added from the suggestions or by
 * typing. What is typed joins the list on Enter, on Add, and when the typing box is left, so
 * that saving never drops an amenity that was typed and not added.
 */
export function AmenitiesEditor({
  value,
  onChange,
  typed,
  onTyped,
  error,
}: {
  value: string[];
  onChange: (amenities: string[]) => void;
  /** What is in the typing box and not in the list yet. */
  typed: string;
  onTyped: (typed: string) => void;
  /** What the form found wrong with what is left in the typing box. */
  error?: string;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const focusAfterChange = useFocusAfterChange();
  const full = value.length >= LIMITS.amenities;
  const suggestions = full
    ? []
    : SUGGESTIONS.filter((suggestion) => !value.some((name) => suggestion.covers.test(name)));

  const typingBox = () => root.current?.querySelector<HTMLInputElement>('input:enabled');
  const buttonIn = (list: 'chosen' | 'suggested', index: number) => {
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>(
      `[data-list="${list}"] button`,
    );
    return buttons?.[Math.min(index, buttons.length - 1)];
  };

  /** Adds what was typed: one amenity, or several with commas between them. */
  const add = () => {
    const names = typed
      .split(/[,;\n]+/)
      .map((name) => name.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const next = [...value];
    let wrong: string | null = null;
    const left: string[] = [];
    for (const name of names) {
      if (wrong) left.push(name);
      else if (next.some((other) => sameText(other, name))) continue;
      else if (name.length > LIMITS.amenityLength) {
        wrong = `An amenity can have ${LIMITS.amenityLength} characters at most. Shorten this one and add it again.`;
        left.push(name);
      } else if (next.length >= LIMITS.amenities) {
        wrong = `A property can list ${LIMITS.amenities} amenities at most. Take one off to add another.`;
        left.push(name);
      } else next.push(name);
    }
    setProblem(wrong);
    // What could not be added stays in the box to be put right.
    onTyped(left.join(', '));
    if (next.length > value.length) onChange(next);
  };

  return (
    <div ref={root} className="flex flex-col gap-2.5 sm:col-span-2">
      {value.length > 0 && (
        <ul data-list="chosen" aria-label="Amenities listed" className="flex flex-wrap gap-1.5">
          {value.map((name, index) => (
            <li
              // Not the name alone: a list saved by another system can hold one twice.
              key={`${name}-${index}`}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface py-0.5 pr-1 pl-2.5 text-[13px] text-ink"
            >
              <span className="min-w-0 break-words">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-sunken hover:text-ink"
                onClick={() => {
                  onChange(value.filter((_, other) => other !== index));
                  // The amenity that takes its place, else the one before, else the typing box.
                  focusAfterChange(() => buttonIn('chosen', index) ?? typingBox());
                }}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Field
        label="Add an amenity"
        hint={
          full
            ? `The list is full at ${LIMITS.amenities} amenities. Take one off to add another.`
            : 'Type one and press Enter. To add several at once, put commas between them.'
        }
        error={problem ?? error}
      >
        {(props) => (
          <div className="flex gap-2">
            <Input
              {...props}
              value={typed}
              disabled={full && typed === ''}
              maxLength={2000}
              autoComplete="off"
              enterKeyHint="enter"
              className="min-w-0 flex-1"
              onChange={(e) => {
                onTyped(e.target.value);
                setProblem(null);
              }}
              onBlur={() => {
                if (typed.trim() !== '') add();
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                // Enter adds to the list. It must not save the whole form.
                e.preventDefault();
                add();
              }}
            />
            <Button
              disabled={full && typed === ''}
              onClick={() => {
                add();
                typingBox()?.focus();
              }}
            >
              Add
            </Button>
          </div>
        )}
      </Field>

      {suggestions.length > 0 && (
        <div
          data-list="suggested"
          role="group"
          aria-label="Amenities often listed"
          className="flex flex-wrap items-center gap-1.5"
        >
          <span className="text-[13px] text-ink-faint">Often listed:</span>
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.name}
              type="button"
              aria-label={`Add ${suggestion.name}`}
              className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-2.5 py-0.5 text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
              onClick={() => {
                onChange([...value, suggestion.name]);
                focusAfterChange(
                  () => buttonIn('suggested', index) ?? typingBox() ?? buttonIn('chosen', 0),
                );
              }}
            >
              <Plus className="size-3" aria-hidden />
              {suggestion.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
