'use client';

import { cn } from '@/lib/cn';
import { formatMonth, formatWeekday } from '@/lib/format';
import { weeksOf, type NightKind } from './days';

const WEEKDAYS = [
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
] as const;

/** What each kind of night is called: in full for a screen reader, in a word inside the day. */
const KIND_WORDS: Record<NightKind, { full: string; short: string }> = {
  free: { full: 'free', short: '' },
  guests: { full: 'guests staying', short: 'Guests' },
  own: { full: 'your own stay', short: 'You' },
  closed: { full: 'not available', short: 'Closed' },
  outside: { full: 'outside your contract', short: '' },
  unknown: { full: 'loading', short: '' },
};

export const KIND_STYLES: Record<NightKind, string> = {
  free: 'border border-line bg-surface text-ink',
  guests: 'bg-brand-100 text-brand-900',
  own: 'bg-info-100 text-info-700',
  closed: 'stripes bg-line-strong text-ink-soft',
  outside: 'bg-canvas text-ink-faint',
  unknown: 'border border-line bg-surface text-ink-faint',
};

/**
 * One month of one villa, a square a day. A day stands for the night that
 * starts on it. Days the owner could arrive or leave on are buttons.
 */
export function MonthGrid({
  monthStart,
  monthEnd,
  kinds,
  today,
  arrival,
  departure,
  leaveBy,
  pickable,
  onPick,
}: {
  monthStart: string;
  monthEnd: string;
  kinds: Map<string, NightKind>;
  today: string;
  /** The stay being chosen: its first night, and the day it ends. Empty when not chosen. */
  arrival: string;
  departure: string;
  /** While the day to leave is being chosen: the latest it can be. Empty otherwise. */
  leaveBy: string;
  /** Whether a day can be chosen, as an arrival or as a departure. */
  pickable: (date: string) => boolean;
  onPick: (date: string) => void;
}) {
  const weeks = weeksOf(monthStart, monthEnd);
  return (
    <table className="w-full table-fixed border-separate border-spacing-1">
      <caption className="sr-only">
        {formatMonth(monthStart)}. Each day shows the night that starts on it.
      </caption>
      <thead>
        <tr>
          {WEEKDAYS.map(([short, full]) => (
            <th key={short} scope="col" className="pb-1 text-xs font-medium text-ink-faint">
              <span aria-hidden>{short}</span>
              <span className="sr-only">{full}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, index) => (
          <tr key={index}>
            {week.map((date, column) => {
              if (!date) return <td key={column} />;
              const kind = kinds.get(date) ?? 'unknown';
              const past = date < today;
              const chosen =
                arrival !== '' && date >= arrival && departure !== '' && date < departure;
              const first = date === arrival;
              const leaving = departure !== '' && date === departure;
              const couldLeave = leaveBy !== '' && date > arrival && date <= leaveBy;
              const words = chosen || first ? 'chosen for your stay' : KIND_WORDS[kind].full;
              const label = `${formatWeekday(date)}, ${words}${leaving ? ', the day you leave' : ''}${
                couldLeave ? ', you could leave on this day' : ''
              }${date === today ? ', today' : ''}`;
              const body = (
                <>
                  <span
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full text-[13px] leading-none',
                      date === today && 'font-semibold ring-1 ring-current',
                    )}
                  >
                    {Number(date.slice(8))}
                  </span>
                  <span className="h-3 text-[10px] leading-3">
                    {first
                      ? 'Arrive'
                      : chosen
                        ? 'Stay'
                        : leaving
                          ? 'Leave'
                          : KIND_WORDS[kind].short}
                  </span>
                </>
              );
              const style = cn(
                'flex h-12 w-full flex-col items-center justify-center gap-0.5 rounded-md sm:h-14',
                chosen || first ? 'bg-info-500 text-white' : KIND_STYLES[kind],
                couldLeave && kind === 'free' && 'bg-info-50',
                kind === 'unknown' && 'animate-pulse',
                past && !(chosen || first) && 'opacity-55',
                leaving && 'ring-2 ring-info-500 ring-inset',
              );
              return (
                <td key={column} className="p-0">
                  {pickable(date) ? (
                    <button
                      type="button"
                      aria-label={label}
                      aria-pressed={chosen || first || leaving}
                      onClick={() => onPick(date)}
                      className={cn(
                        style,
                        'transition-colors',
                        !(chosen || first) && kind === 'free' && 'hover:bg-info-50',
                      )}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={style}>
                      <span className="sr-only">{label}</span>
                      <span aria-hidden className="contents">
                        {body}
                      </span>
                    </div>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
