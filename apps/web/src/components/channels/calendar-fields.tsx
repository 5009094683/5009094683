'use client';

import { Trash2 } from 'lucide-react';
import { useId } from 'react';
import { CopyField } from '@/components/settings/fields';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { TREAT_AS, type CalendarErrors, type DraftCalendar, type TreatAs } from './calendar-draft';
import { CalendarStatus } from './calendar-status';
import type { CalendarFeed } from './types';

/** Typed as it is, not as prose: no corrections, no capitals put in. */
const AS_TYPED = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false } as const;

function TreatAsChoice({
  calendar,
  saved,
  disabled,
  onChange,
}: {
  calendar: DraftCalendar;
  saved?: CalendarFeed;
  disabled: boolean;
  onChange: (treatAs: TreatAs) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">
        How the entries in the calendar of the site are treated
      </legend>
      {(Object.keys(TREAT_AS) as TreatAs[]).map((value) => (
        <label key={value} className="flex items-start gap-2 text-sm text-ink">
          <input
            type="radio"
            name={name}
            value={value}
            checked={calendar.treatAs === value}
            disabled={disabled}
            onChange={() => onChange(value)}
            className="mt-0.5 size-4 shrink-0 accent-brand-600"
          />
          <span className="min-w-0">
            {TREAT_AS[value].label}
            <span className="block text-[13px] text-ink-faint">{TREAT_AS[value].explanation}</span>
          </span>
        </label>
      ))}
      {saved && saved.treatAs !== calendar.treatAs && (
        <p className="text-[13px] text-ink-soft">
          This goes for entries that appear from now on. What was read before stays as it was
          recorded.
        </p>
      )}
    </fieldset>
  );
}

/**
 * One calendar of a unit: the site it is for, where the calendar of the site is read from, and
 * the address of our calendar to give to the site.
 */
export function CalendarFields({
  calendar,
  unitName,
  saved,
  errors,
  suggestionsId,
  disabled,
  live,
  now,
  onChange,
  onRemove,
}: {
  calendar: DraftCalendar;
  unitName: string;
  /** The calendar as it is saved, once it is. */
  saved?: CalendarFeed;
  /** What is wrong with what was typed, once saving has been tried. */
  errors?: CalendarErrors;
  /** The list of sites offered while the name of a site is typed. */
  suggestionsId: string;
  disabled: boolean;
  live: boolean;
  now: Date;
  onChange: (change: Partial<DraftCalendar>) => void;
  onRemove: () => void;
}) {
  const site = calendar.label.trim();
  const title = site ? `${site} calendar` : 'New calendar';
  const read = calendar.url.trim() !== '';

  return (
    <div
      role="group"
      aria-label={`${title} for ${unitName}`}
      data-calendar={calendar.key}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-ink">{title}</p>
        <Button
          size="sm"
          variant="danger-ghost"
          icon={<Trash2 className="size-3.5" />}
          disabled={disabled}
          aria-label={`Remove the ${site || 'new'} calendar of ${unitName}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Booking site" error={errors?.label}>
          {(props) => (
            <Input
              {...props}
              data-field="label"
              list={suggestionsId}
              maxLength={60}
              placeholder="Airbnb"
              autoComplete="off"
              value={calendar.label}
              disabled={disabled}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Site code"
          optional
          error={errors?.code}
          hint="A short code that bookings from this site are listed under, such as ABB. Left empty, it is filled in for the well-known sites."
        >
          {(props) => (
            <Input
              {...props}
              {...AS_TYPED}
              data-field="code"
              maxLength={6}
              className="uppercase placeholder:normal-case"
              value={calendar.code}
              disabled={disabled}
              onChange={(e) => onChange({ code: e.target.value })}
            />
          )}
        </Field>
      </div>

      <Field
        label="Address of the calendar of the site"
        optional
        error={errors?.url}
        hint="The site gives it out in its calendar or availability settings, under export calendar. Left empty, nothing is read from the site: it can only read ours."
      >
        {(props) => (
          <Input
            {...props}
            {...AS_TYPED}
            data-field="url"
            type="url"
            inputMode="url"
            placeholder="https://"
            className="font-mono text-[13px]"
            value={calendar.url}
            disabled={disabled}
            onChange={(e) => onChange({ url: e.target.value })}
          />
        )}
      </Field>

      {read && (
        <TreatAsChoice
          calendar={calendar}
          saved={saved}
          disabled={disabled}
          onChange={(treatAs) => onChange({ treatAs })}
        />
      )}

      {saved?.exportUrl ? (
        <CopyField
          // Named by its site: the page can hold many of these, and each has a button to copy it.
          label={`Address of our calendar for ${saved.label}`}
          value={saved.exportUrl}
          hint={`Paste it in the site's calendar or availability settings, under import or sync a calendar. It is for ${saved.label} only, and shows which nights are taken, nothing else.`}
        />
      ) : (
        <p className="text-[13px] text-ink-soft">
          The address of our calendar, to give to the site, appears here once the calendars are
          saved.
        </p>
      )}

      {saved && (
        <CalendarStatus feed={saved} read={Boolean(saved.importUrl)} live={live} now={now} />
      )}
    </div>
  );
}
