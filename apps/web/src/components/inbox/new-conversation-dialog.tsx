'use client';

import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Badge, Notice, STATUS_TONES, Spinner } from '@/components/ui/misc';
import { api, errorMessage, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { STATUS_LABELS, formatStay } from '@/lib/format';
import { useDebounced, useProperties } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import { Detail, Details } from './details';
import { CHANNEL_ICONS, bookingSiteName } from './labels';
import type { Channel, ConversationRecord } from './types';
import { useReturnFocus } from './use-return-focus';

interface Way {
  channel: Channel;
  name: string;
  /** Where the message goes: the number, the address. */
  detail: string | null;
  /** Why the guest cannot be reached this way; null when they can. */
  problem: string | null;
}

/** The ways the guest of a booking can be written to, with the reason for each that cannot be used. */
function waysToReach(reservation: Reservation): Way[] {
  const site = bookingSiteName(reservation.channelCode);
  const guest = reservation.guest;
  return [
    {
      channel: 'ota',
      name: site ?? 'Booking site',
      detail: 'The message box of the booking',
      problem:
        reservation.connectionId && reservation.externalId
          ? null
          : 'This booking did not come from a booking site.',
    },
    {
      channel: 'whatsapp',
      name: 'WhatsApp',
      detail: guest?.phone ?? null,
      problem: guest?.phone ? null : 'There is no phone number for this guest.',
    },
    {
      channel: 'email',
      name: 'Email',
      detail: guest?.email ?? null,
      problem: guest?.email ? null : 'There is no email address for this guest.',
    },
  ];
}

function BookingSummary({
  reservation,
  propertyName,
}: {
  reservation: Reservation;
  propertyName: string | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium [overflow-wrap:anywhere] text-ink">
          {reservation.guestName}
        </span>
        <Badge tone={STATUS_TONES[reservation.status]}>{STATUS_LABELS[reservation.status]}</Badge>
      </span>
      <Details className="text-[13px] text-ink-soft">
        <Detail>{reservation.code}</Detail>
        {propertyName && <Detail>{propertyName}</Detail>}
        <Detail>{formatStay(reservation.checkIn, reservation.checkOut)}</Detail>
      </Details>
    </span>
  );
}

/**
 * Starts writing to a guest: find the booking, choose how to reach its guest, and the
 * conversation opens (the one there already is, if the guest has been written to before).
 */
export function NewConversationDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (conversation: ConversationRecord) => void;
}) {
  useReturnFocus();
  const auth = useAuth();
  const { properties } = useProperties();
  const names = useMemo(() => new Map(properties.map((p) => [p.id, p.name])), [properties]);

  const [term, setTerm] = useState('');
  const search = useDebounced(term.trim(), 250);
  const { data, error, isLoading } = useSWR<{ reservations: Reservation[] }>(
    search.length >= 2 ? `/reservations${query({ search, limit: 8, sort: 'created' })}` : null,
    { keepPreviousData: false },
  );
  const found = (data?.reservations ?? []).filter((r) => auth.can('inbox.write', r.propertyId));

  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const ways = reservation ? waysToReach(reservation) : [];

  const choose = (next: Reservation | null) => {
    setReservation(next);
    setChannel(next ? (waysToReach(next).find((way) => !way.problem)?.channel ?? null) : null);
    setRefusal(null);
  };

  const start = async () => {
    if (!reservation || !channel) return;
    setBusy(true);
    setRefusal(null);
    try {
      onStarted(
        await api<ConversationRecord>('/inbox/conversations', {
          body: { channel, reservationId: reservation.id },
        }),
      );
    } catch (err) {
      setRefusal(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New message"
      description="Find the booking, then choose how to reach the guest."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!reservation || !channel}
            loading={busy}
            onClick={() => void start()}
          >
            Start conversation
          </Button>
        </>
      }
    >
      <div className="flex min-h-56 flex-col gap-4">
        {refusal && <Notice tone="danger">{refusal}</Notice>}
        {reservation ? (
          <>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
              <BookingSummary
                reservation={reservation}
                propertyName={names.get(reservation.propertyId)}
              />
              <Button size="sm" onClick={() => choose(null)}>
                Change
              </Button>
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">
                Write to the guest through
              </legend>
              {ways.map((way) => {
                const Icon = CHANNEL_ICONS[way.channel];
                const selected = way.channel === channel;
                return (
                  <label
                    key={way.channel}
                    className={cn(
                      'flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors',
                      'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500',
                      way.problem
                        ? 'cursor-not-allowed border-line bg-sunken/50'
                        : selected
                          ? 'cursor-pointer border-brand-500 bg-brand-50'
                          : 'cursor-pointer border-line hover:bg-sunken/60',
                    )}
                  >
                    <input
                      type="radio"
                      name="new-conversation-channel"
                      checked={selected}
                      disabled={way.problem !== null}
                      autoFocus={selected}
                      onChange={() => {
                        setChannel(way.channel);
                        setRefusal(null);
                      }}
                      className="mt-0.5 size-4 shrink-0 accent-brand-600 outline-none"
                    />
                    <Icon className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'block font-medium',
                          way.problem ? 'text-ink-faint' : 'text-ink',
                        )}
                      >
                        {way.name}
                      </span>
                      <span className="block text-[13px] [overflow-wrap:anywhere] text-ink-soft">
                        {way.problem ?? way.detail}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {channel === null && (
              <Notice tone="warning">
                This guest cannot be written to from here. Add a phone number or an email address to
                the guest’s profile first.
              </Notice>
            )}
          </>
        ) : (
          <>
            <Field label="Booking" hint="Search by guest name, booking code, email or phone.">
              {(props) => (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-faint"
                    aria-hidden
                  />
                  <Input
                    {...props}
                    type="search"
                    autoFocus
                    autoComplete="off"
                    maxLength={120}
                    value={term}
                    onChange={(event) => setTerm(event.target.value)}
                    className="pl-8"
                  />
                </div>
              )}
            </Field>
            <div aria-live="polite">
              {search.length < 2 ? null : error ? (
                <Notice tone="danger">{errorMessage(error)}</Notice>
              ) : isLoading || !data ? (
                <p className="flex items-center gap-2 text-sm text-ink-faint">
                  <Spinner label="Searching" /> Searching…
                </p>
              ) : found.length === 0 ? (
                <p className="text-sm text-ink-soft">No booking matches “{search}”.</p>
              ) : (
                <ul
                  aria-label="Bookings found"
                  className="divide-y divide-line overflow-hidden rounded-lg border border-line"
                >
                  {found.map((result) => (
                    <li key={result.id}>
                      <button
                        type="button"
                        onClick={() => choose(result)}
                        className="flex w-full px-3 py-2 text-left -outline-offset-2 transition-colors hover:bg-sunken/60"
                      >
                        <BookingSummary
                          reservation={result}
                          propertyName={names.get(result.propertyId)}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
