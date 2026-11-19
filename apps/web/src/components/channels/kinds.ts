import { CalendarSync, Mail, Network, type LucideIcon } from 'lucide-react';
import type { Connection, Kind } from './types';

interface SectionWords {
  description: string;
  emptyTitle: string;
  emptyHint: string;
}

export interface KindWords {
  icon: LucideIcon;
  /** What a connection of this kind is called where connections are listed. */
  label: string;
  /** The connection inside a sentence: `the calendar connection for Coral Cottage`. */
  named(propertyName: string): string;
  /** The job that looks for bookings, when asked for by hand. */
  read: { label: string; started: string };
  /** What the overview says while the connection is paused, and while it is switched off. */
  whenPaused: string;
  whenOff: string;
  /** What staff are told once it has been switched on, and once it has been paused. */
  switchedOn(propertyName: string): { title: string; detail?: string };
  paused(propertyName: string): { title: string; detail: string };
  /** What pausing costs, and what happens to bookings made meanwhile: asked before pausing. */
  pauseWarning: string;
  afterPause: string;
  bookings: SectionWords;
  activity: SectionWords;
}

export const KINDS: Record<Kind, KindWords> = {
  channex: {
    icon: Network,
    label: 'Channel manager',
    named: (propertyName) => `the channel manager connection for ${propertyName}`,
    read: { label: 'Fetch bookings now', started: 'Fetching bookings' },
    whenPaused: 'Paused. Nothing is sent or fetched until it is resumed.',
    whenOff: 'Switched off. Nothing is sent or fetched.',
    switchedOn: (propertyName) => ({
      title: `${propertyName} is live`,
      detail: 'Availability and rates for the whole planning horizon are being sent.',
    }),
    paused: (propertyName) => ({
      title: `${propertyName} is paused`,
      detail: 'Nothing is sent or fetched until it is resumed.',
    }),
    pauseWarning:
      'While it is paused, nothing is sent to the booking sites and bookings made there are not fetched. The sites keep selling from the availability they last received, so a room can be sold twice.',
    afterPause: 'Bookings made in the meantime arrive after you resume.',
    bookings: {
      description:
        'New bookings, changes and cancellations that arrived for this property, newest first.',
      emptyTitle: 'No bookings have arrived from the channels yet',
      emptyHint: 'They appear here within seconds of being made on a booking site.',
    },
    activity: {
      description:
        'The latest 50 things sent and received. Waited is how long a change took to reach the other side.',
      emptyTitle: 'Nothing has been sent or received yet',
      emptyHint: 'Activity appears here once the connection is switched on.',
    },
  },
  ical: {
    icon: CalendarSync,
    label: 'Calendars',
    named: (propertyName) => `the calendar connection for ${propertyName}`,
    read: { label: 'Read the calendars now', started: 'Reading the calendars' },
    whenPaused: 'Paused. The calendars of the sites are not read until it is resumed.',
    whenOff: 'Switched off. No calendar is read, and the sites cannot read ours.',
    switchedOn: (propertyName) => ({
      title: `The calendar connection for ${propertyName} is on`,
      detail: 'The calendars of the sites are read every 5 minutes.',
    }),
    paused: (propertyName) => ({
      title: `The calendar connection for ${propertyName} is paused`,
      detail: 'The calendars of the sites are not read until it is resumed.',
    }),
    pauseWarning:
      'While it is paused, the calendars of the sites are not read, so bookings made there do not arrive and the dates stay open here. The sites can still read our calendar.',
    afterPause: 'Bookings made in the meantime arrive after you resume.',
    bookings: {
      description:
        'What was found in the calendars of the sites, newest first: bookings, changes of dates, cancellations and blocked dates.',
      emptyTitle: 'Nothing has been found in the calendars yet',
      emptyHint: 'A booking shows here within 5 minutes of appearing in the calendar of a site.',
    },
    activity: {
      description:
        'The latest 50 things found in the calendars of the sites, and reads that failed. A read that finds nothing new is not listed.',
      emptyTitle: 'Nothing has been found yet',
      emptyHint:
        'What is found in the calendars of the sites is listed here, and any read that fails.',
    },
  },
  email: {
    icon: Mail,
    label: 'Reservations mailbox',
    named: (propertyName) => `the reservations mailbox for ${propertyName}`,
    read: { label: 'Read the mailbox now', started: 'Reading the mailbox' },
    whenPaused: 'Paused. Booking emails are not read until it is resumed.',
    whenOff: 'Switched off. Booking emails are not read.',
    switchedOn: (propertyName) => ({
      title: `The reservations mailbox for ${propertyName} is on`,
      detail: 'Booking emails are read about once a minute.',
    }),
    paused: (propertyName) => ({
      title: `The reservations mailbox for ${propertyName} is paused`,
      detail: 'Booking emails are not read until it is resumed.',
    }),
    pauseWarning:
      'While it is paused, booking emails are not read, so the bookings in them do not arrive and the dates stay open here.',
    afterPause:
      'Emails that reach the mailbox in the meantime are read after you resume. Emails that a mail service forwards in the meantime are not kept.',
    bookings: {
      description:
        'What was read from booking emails, newest first: new bookings, changes and cancellations.',
      emptyTitle: 'No booking email has been read yet',
      emptyHint: 'A booking shows here about a minute after its email arrives.',
    },
    activity: {
      description:
        'The latest 50 things read from booking emails, and reads of the mailbox that failed. Waited is the time from the email being sent to the booking being recorded.',
      emptyTitle: 'Nothing has been read yet',
      emptyHint:
        'What is read from booking emails is listed here, and any read of the mailbox that fails.',
    },
  },
};

/** The order in which the connections of one property are listed: the main route first. */
export const KIND_ORDER: Kind[] = ['channex', 'ical', 'email'];

export function kindOf(connection: Connection): KindWords {
  return KINDS[connection.adapter];
}

/**
 * What the server calls a connection that was given no name. Kept in step by hand: the server's
 * own list cannot be loaded into the browser.
 */
const UNNAMED: Record<Kind, string> = {
  channex: 'channel manager',
  ical: 'calendar feeds',
  email: 'reservations mailbox',
};

/** A name someone gave the connection, as opposed to the name of its kind. */
export function ownName(connection: Connection): string | null {
  const name = connection.name.trim();
  const plain = name.toLowerCase();
  const kindName =
    plain === UNNAMED[connection.adapter] || plain === kindOf(connection).label.toLowerCase();
  return name && !kindName ? name : null;
}

/**
 * How often the worker reads a calendar connection and a mailbox. Kept in step with the
 * adapters by hand: the server does not say how often it reads.
 */
export const READ_EVERY_MS: Partial<Record<Kind, number>> = { ical: 5 * 60_000, email: 60_000 };

/** How a calendar connection's calendars look from its summary: how many, and whether any is read. */
export function calendarsOf(connection: Connection): { count: number; read: boolean } {
  return { count: connection.calendars?.count ?? 0, read: (connection.calendars?.read ?? 0) > 0 };
}

/** Whether there is a mailbox to read for a mailbox connection. */
export function hasMailbox(connection: Connection): boolean {
  return connection.mailbox?.entered ?? false;
}
