'use client';

import { ArrowDown, ArrowUp, Image as ImageIcon, ImageOff, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { useFocusAfterChange } from './parts';
import { LIMITS, isWebAddress, websiteShowsPhoto } from './values';

/**
 * A small view of a photo. Photos live on hosts we do not know, so, like the website, this is
 * a plain image that sends no referrer. An address that is not on the web is not tried.
 */
export function PhotoThumbnail({
  address,
  className,
  onFailed,
}: {
  address: string;
  className?: string;
  onFailed?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const shape = cn('shrink-0 rounded-md bg-sunken', className);
  if (!isWebAddress(address) || failed) {
    const Icon = failed ? ImageOff : ImageIcon;
    return (
      <span
        role="img"
        aria-label={failed ? 'The photo did not load' : 'No preview'}
        className={cn(shape, 'inline-flex items-center justify-center text-ink-faint')}
      >
        <Icon className="size-4" aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={address}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailed(true);
        onFailed?.();
      }}
      className={cn(shape, 'object-cover')}
    />
  );
}

/** What staff should know about a photo in the list, if anything. */
function concern(address: string, failed: boolean): string | null {
  if (!websiteShowsPhoto(address)) {
    return 'This is not the address of a photo on the web, so the website leaves it out. Remove it.';
  }
  if (!isWebAddress(address))
    return 'A file of the website itself. There is no preview of it here.';
  if (failed) return 'This photo does not load. Check the address, or remove it.';
  if (/^http:/i.test(address)) {
    return 'This address starts with http://, which many browsers refuse to show on a secure page. Use the https:// address if there is one.';
  }
  return null;
}

function Row({
  address,
  index,
  last,
  onMove,
  onRemove,
}: {
  address: string;
  index: number;
  last: boolean;
  /** Moves the photo to another place in the list, and says which of its buttons to go to after. */
  onMove: (to: number, then: 'up' | 'down') => void;
  onRemove: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const note = concern(address, failed);
  const number = index + 1;
  return (
    <li data-row={index} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5">
      <PhotoThumbnail address={address} className="h-12 w-16" onFailed={() => setFailed(true)} />
      <div className="flex min-w-0 flex-1 basis-40 flex-col items-start gap-0.5">
        <p className="max-w-full truncate text-[13px] text-ink" title={address}>
          <span className="sr-only">Photo {number}: </span>
          {address}
        </p>
        {index === 0 ? (
          <Badge tone="brand">Main photo</Badge>
        ) : (
          <button
            type="button"
            data-action="main"
            aria-label={`Make photo ${number} the main photo`}
            className="text-[13px] font-medium text-brand-700 hover:underline"
            onClick={() => onMove(0, 'down')}
          >
            Make main photo
          </button>
        )}
        {note && <p className="text-[13px] text-warning-700">{note}</p>}
      </div>
      <div className="ml-auto flex shrink-0 items-center">
        <Button
          size="icon"
          variant="ghost"
          data-action="up"
          aria-label={`Move photo ${number} up`}
          disabled={index === 0}
          onClick={() => onMove(index - 1, 'up')}
        >
          <ArrowUp className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          data-action="down"
          aria-label={`Move photo ${number} down`}
          disabled={last}
          onClick={() => onMove(index + 1, 'down')}
        >
          <ArrowDown className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="danger-ghost"
          data-action="remove"
          aria-label={`Remove photo ${number}`}
          onClick={onRemove}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </div>
    </li>
  );
}

/**
 * The property's photos, in the order the website shows them. There is nowhere to upload a
 * photo to, so each is the address of a photo that is already on the web. What is in the
 * address box joins the list on Enter, on Add, and when the box is left.
 */
export function PhotosEditor({
  value,
  onChange,
  typed,
  onTyped,
  error,
}: {
  value: string[];
  onChange: (photos: string[]) => void;
  /** What is in the address box and not in the list yet. */
  typed: string;
  onTyped: (typed: string) => void;
  /** What the form found wrong with what is left in the address box. */
  error?: string;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const focusAfterChange = useFocusAfterChange();
  const full = value.length >= LIMITS.photos;

  const addressBox = () => root.current?.querySelector<HTMLInputElement>('input:enabled');
  const button = (row: number, action: string) =>
    root.current?.querySelector<HTMLButtonElement>(
      `[data-row="${row}"] [data-action="${action}"]:enabled`,
    );

  /** Adds the addresses in a text: one, or several with spaces or line breaks between them. */
  const add = (text: string) => {
    const next = [...value];
    let wrong: string | null = null;
    const left: string[] = [];
    for (const address of text.split(/\s+/).filter(Boolean)) {
      if (wrong) left.push(address);
      else if (next.includes(address)) continue;
      else {
        wrong = !isWebAddress(address)
          ? 'A photo’s address starts with https:// and has no spaces. A photo on your computer has to be put on the web first.'
          : address.length > LIMITS.photoLength
            ? `This address is longer than ${LIMITS.photoLength} characters, which is the most that can be saved. Use a shorter address for the photo.`
            : next.length >= LIMITS.photos
              ? `A property can have ${LIMITS.photos} photos at most. Remove one to add another.`
              : null;
        if (wrong) left.push(address);
        else next.push(address);
      }
    }
    setProblem(wrong);
    // What could not be added stays in the box to be put right.
    onTyped(left.join(' '));
    if (next.length > value.length) onChange(next);
  };

  const move = (from: number, to: number, then: 'up' | 'down') => {
    const next = [...value];
    const [photo] = next.splice(from, 1);
    if (photo === undefined) return;
    next.splice(to, 0, photo);
    onChange(next);
    // Stay with the photo that moved. At either end of the list one of its arrows is off.
    focusAfterChange(() => button(to, then) ?? button(to, then === 'up' ? 'down' : 'up'));
  };

  // A list saved by another system can hold an address twice: tell the two apart by their turn.
  const turns = new Map<string, number>();
  const keys = value.map((address) => {
    const turn = turns.get(address) ?? 0;
    turns.set(address, turn + 1);
    return `${turn}:${address}`;
  });

  return (
    <div ref={root} className="flex flex-col gap-2.5 sm:col-span-2">
      {value.length > 0 && (
        <ol aria-label="Photos" className="divide-y divide-line rounded-lg border border-line">
          {value.map((address, index) => (
            <Row
              key={keys[index]}
              address={address}
              index={index}
              last={index === value.length - 1}
              onMove={(to, then) => move(index, to, then)}
              onRemove={() => {
                onChange(value.filter((_, other) => other !== index));
                // The photo that takes its place, else the one before, else the address box.
                focusAfterChange(
                  () =>
                    button(index, 'remove') ??
                    button(index - 1, 'remove') ??
                    addressBox() ??
                    undefined,
                );
              }}
            />
          ))}
        </ol>
      )}

      <Field
        label="Add a photo"
        hint={
          full
            ? `The list is full at ${LIMITS.photos} photos. Remove one to add another.`
            : 'Paste the address of the photo, which starts with https://, and press Enter.'
        }
        error={problem ?? error}
      >
        {(props) => (
          <div className="flex gap-2">
            <Input
              {...props}
              type="url"
              inputMode="url"
              value={typed}
              disabled={full && typed === ''}
              placeholder="https://"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="enter"
              className="min-w-0 flex-1"
              onChange={(e) => {
                onTyped(e.target.value);
                setProblem(null);
              }}
              onPaste={(e) => {
                // A box of one line runs several pasted lines together: take them one by one.
                const pasted = e.clipboardData.getData('text');
                if (!/\S\s+\S/.test(pasted)) return;
                e.preventDefault();
                add(`${typed} ${pasted}`);
              }}
              onBlur={() => {
                if (typed.trim() !== '') add(typed);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                // Enter adds to the list. It must not save the whole form.
                e.preventDefault();
                add(typed);
              }}
            />
            <Button
              disabled={full && typed === ''}
              onClick={() => {
                add(typed);
                addressBox()?.focus();
              }}
            >
              Add
            </Button>
          </div>
        )}
      </Field>
    </div>
  );
}
