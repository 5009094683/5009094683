'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { usePropertyDetail } from '@/lib/hooks';
import { fitsCalendars, unitGroups } from './calendar-draft';
import { KINDS, KIND_ORDER } from './kinds';
import type { Connection, Kind } from './types';

interface Offer {
  title: string;
  /** What it is for, and when to use it instead of the channel manager or beside it. */
  about: string;
  action: string;
}

const OFFERS: Record<Kind, Offer> = {
  channex: {
    title: 'Channel manager',
    about:
      'The main way to connect. Availability and prices reach the booking sites within seconds, and bookings, changes and cancellations come back by themselves. Use it for every site it can connect.',
    action: 'Connect the channel manager',
  },
  ical: {
    title: 'Calendar connection',
    about:
      "For a villa or a single room listed on a site that the channel manager does not connect. The site and this system read each other's calendar, so only dates pass between them, and the site looks only every few hours. Never for a room type with more than one room.",
    action: 'Add a calendar connection',
  },
  email: {
    title: 'Reservations mailbox',
    about:
      'Reads the booking emails that sites send to the property and records each booking for staff to check. Use it beside the channel manager or a calendar, for a site whose bookings arrive in no other way. It sends nothing to the sites: closing rooms there is left to the other two.',
    action: 'Add a reservations mailbox',
  },
};

/**
 * Whether a calendar could be used for any unit of a property: only a room type with a single
 * room can have one. Undefined until the units of the property are known.
 */
function useFitsCalendars(propertyId: string): boolean | undefined {
  const { data } = usePropertyDetail(propertyId);
  return data && unitGroups(data.roomTypes, []).some(fitsCalendars);
}

/**
 * Offers the kinds of connection a property does not have yet, each with what it is for. A
 * property can have one of each kind; the server refuses a second, and its reason is shown.
 */
export function AddConnectionDialog({
  property,
  existing,
  onAdded,
  onRefused,
  onClose,
}: {
  property: { id: string; name: string };
  /** The kinds of connection the property has already. */
  existing: readonly Kind[];
  onAdded: (connection: Connection) => void;
  /** The server said no, so what the list shows may be out of date. */
  onRefused: () => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fitsCalendar = useFitsCalendars(property.id);
  const offered = KIND_ORDER.filter((kind) => !existing.includes(kind));

  const add = async (kind: Kind) => {
    setAdding(kind);
    setError(null);
    try {
      const created = await api<Connection>('/channels/connections', {
        body: { propertyId: property.id, adapter: kind },
      });
      // Stays busy: the page of the new connection opens next.
      onAdded(created);
    } catch (err) {
      setError(errorMessage(err));
      setAdding(null);
      onRefused();
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add a connection for ${property.name}`}
      description="A property can have one connection of each kind, side by side."
    >
      <div className="flex flex-col gap-3">
        {error && <Notice tone="danger">{error}</Notice>}
        {offered.length === 0 ? (
          <p className="text-sm text-ink-soft">
            {property.name} has a connection of every kind already.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {offered.map((kind) => {
              const offer = OFFERS[kind];
              const Icon = KINDS[kind].icon;
              // Without a room type of one room there is nothing a calendar could be added for,
              // and a connection cannot be taken away again once it is made.
              const unfit = kind === 'ical' && fitsCalendar === false;
              return (
                <li key={kind} className="flex items-start gap-3 rounded-lg border border-line p-3">
                  <span className="rounded-md bg-sunken p-1.5 text-ink-soft">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                    <h3 className="text-sm font-semibold text-ink">{offer.title}</h3>
                    <p className="text-[13px] text-ink-soft">{offer.about}</p>
                    {unfit ? (
                      <p className="mt-1 text-[13px] font-medium text-warning-700">
                        Not for {property.name} as it is: none of its room types has exactly one
                        room.
                      </p>
                    ) : (
                      <Button
                        size="sm"
                        className="mt-2"
                        icon={<Plus className="size-3.5" />}
                        loading={adding === kind}
                        disabled={adding !== null && adding !== kind}
                        onClick={() => void add(kind)}
                      >
                        {offer.action}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
