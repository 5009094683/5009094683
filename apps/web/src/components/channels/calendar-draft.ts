import type { PropertyDetail } from '@/lib/types';
import type { CalendarFeed, CalendarFeedInput } from './types';

export type TreatAs = NonNullable<CalendarFeedInput['treatAs']>;

/** One calendar while it is being edited. Text is kept as typed and tidied when it is saved. */
export interface DraftCalendar {
  /** Stays the same while the calendar is edited: its id once saved, a made-up one before. */
  key: string;
  /** Left out for a calendar that has not been saved yet. */
  id?: string;
  unitId: string;
  label: string;
  code: string;
  url: string;
  treatAs: TreatAs;
}

export type CalendarField = 'label' | 'code' | 'url';
export type CalendarErrors = Partial<Record<CalendarField, string>>;

/** Sites offered while the name of a site is typed. Any other name can be typed as well. */
export const SITE_SUGGESTIONS = [
  'Airbnb',
  'Booking.com',
  'Vrbo',
  'Agoda',
  'Expedia',
  'MakeMyTrip',
  'Tripadvisor',
  'Trip.com',
];

/**
 * What an entry in the calendar of a site is taken to be: the choice, what it means, and the
 * same as a statement about a calendar.
 */
export const TREAT_AS: Record<TreatAs, { label: string; explanation: string; summary: string }> = {
  auto: {
    label: 'Let the system decide',
    explanation:
      'An entry that says the dates are closed or not available becomes blocked dates; every other entry becomes a booking.',
    summary: 'The system decides whether an entry is a booking or blocked dates.',
  },
  reservations: {
    label: 'Always as bookings',
    explanation: 'Every entry becomes a booking for staff to complete.',
    summary: 'Every entry is taken as a booking.',
  },
  blocks: {
    label: 'Always as blocked dates',
    explanation: 'Every entry only closes the dates. No booking is recorded.',
    summary: 'Every entry is taken as blocked dates.',
  },
};

export function draftOf(feeds: CalendarFeed[]): DraftCalendar[] {
  return feeds.map((feed) => ({
    key: feed.id,
    id: feed.id,
    unitId: feed.unitId,
    label: feed.label,
    code: feed.channelCode ?? '',
    url: feed.importUrl ?? '',
    treatAs: feed.treatAs,
  }));
}

function tidy(calendar: DraftCalendar): DraftCalendar {
  return {
    ...calendar,
    label: calendar.label.trim(),
    code: calendar.code.trim().toUpperCase(),
    url: calendar.url.trim(),
  };
}

function sameCalendar(a: DraftCalendar, b: DraftCalendar): boolean {
  const [x, y] = [tidy(a), tidy(b)];
  return (
    x.key === y.key &&
    x.unitId === y.unitId &&
    x.label === y.label &&
    x.code === y.code &&
    x.url === y.url &&
    x.treatAs === y.treatAs
  );
}

/** Whether saving the one would leave what the other holds. */
export function sameCalendars(a: DraftCalendar[], b: DraftCalendar[]): boolean {
  return a.length === b.length && a.every((calendar, index) => sameCalendar(calendar, b[index]!));
}

function addressError(address: string): string | undefined {
  if (address.length > 1000) return 'This address is too long: use at most 1000 characters.';
  if (/^webcals?:\/\//i.test(address)) return 'Replace webcal:// at the start with https://.';
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'This is not a web address. It starts with https:// and usually ends in .ics.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The address must start with https://.';
  }
  if (url.username || url.password) {
    return 'An address with a user name or password in it is not accepted.';
  }
  return undefined;
}

/**
 * What is wrong with each calendar, by its key, in the words of the screen. The server checks
 * the same things, but names the first mistake only, and some of them by their place in the list.
 */
export function calendarErrors(draft: DraftCalendar[]): Map<string, CalendarErrors> {
  const errors = new Map<string, CalendarErrors>();
  const addresses = new Set<string>();
  for (const calendar of draft) {
    const { label, code, url } = tidy(calendar);
    const found: CalendarErrors = {};
    if (!label) found.label = 'Enter the name of the site, such as Airbnb.';
    else if (label.length > 60) found.label = 'Use at most 60 characters.';
    if (code && !/^[A-Z0-9]{2,6}$/.test(code)) {
      found.code = 'Use 2 to 6 letters or digits, such as ABB, or leave it empty.';
    }
    if (url) {
      const problem =
        addressError(url) ??
        (addresses.has(url) ? 'This address is entered for another calendar already.' : undefined);
      if (problem) found.url = problem;
      addresses.add(url);
    }
    if (Object.keys(found).length > 0) errors.set(calendar.key, found);
  }
  return errors;
}

/** The whole set as the server takes it: saving replaces every calendar of the connection. */
export function toInput(draft: DraftCalendar[]): CalendarFeedInput[] {
  return draft.map((calendar) => {
    const { id, unitId, label, code, url, treatAs } = tidy(calendar);
    return {
      ...(id ? { id } : {}),
      unitId,
      label,
      channelCode: code || null,
      importUrl: url || null,
      treatAs,
    };
  });
}

/**
 * What saving would undo that cannot be put back by saving again: calendars taken away, whose
 * address for the site stops working, calendars of a site that are no longer read, and
 * calendars of a site now read from another address.
 */
export function lostBySaving(
  saved: CalendarFeed[],
  draft: DraftCalendar[],
): { removed: CalendarFeed[]; noLongerRead: CalendarFeed[]; readElsewhere: CalendarFeed[] } {
  const kept = new Map(draft.filter((calendar) => calendar.id).map((c) => [c.id, tidy(c)]));
  const readBefore = saved.filter((feed) => feed.importUrl && kept.has(feed.id));
  return {
    removed: saved.filter((feed) => !kept.has(feed.id)),
    noLongerRead: readBefore.filter((feed) => !kept.get(feed.id)?.url),
    readElsewhere: readBefore.filter((feed) => {
      const url = kept.get(feed.id)?.url;
      return Boolean(url) && url !== feed.importUrl;
    }),
  };
}

type RoomType = PropertyDetail['roomTypes'][number];
type Unit = RoomType['units'][number];

export interface UnitGroup {
  type: RoomType;
  /** The units to show: those in use, and any other that has a calendar. */
  units: Unit[];
  /** How many rooms of this room type are in use. */
  rooms: number;
}

/** The units of a property by room type, as far as calendars are concerned. */
export function unitGroups(roomTypes: RoomType[], calendars: { unitId: string }[]): UnitGroup[] {
  const withCalendar = new Set(calendars.map((calendar) => calendar.unitId));
  return roomTypes
    .map((type) => ({
      type,
      rooms: type.active ? type.units.filter((unit) => unit.active).length : 0,
      units: type.units.filter((unit) => (type.active && unit.active) || withCalendar.has(unit.id)),
    }))
    .filter((group) => group.units.length > 0);
}

/**
 * A calendar says that dates are taken or free and nothing else. It cannot count rooms, so it
 * fits a room type with one room and no other.
 */
export function fitsCalendars(group: UnitGroup): boolean {
  return group.rooms === 1;
}

/**
 * Our calendar for a unit lists the bookings that have that unit as their room. Where bookings
 * are taken without a room, the sites would go on seeing their dates as free.
 */
export function takesBookingsWithoutRoom(type: RoomType): boolean {
  return type.assignment === 'at_check_in' && !type.autoAssign;
}
