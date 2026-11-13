'use client';

import { Copy, Link2Off } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import type { AuditPage } from '@/components/settings/audit-table';
import { LinkDialog } from '@/components/settings/link-dialog';
import { Button } from '@/components/ui/button';
import { Badge, Notice, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLive } from '@/lib/live';
import type { Reservation } from '@/lib/types';
import { AskDialog } from './ask-dialog';
import { CheckinDrawer } from './checkin-drawer';
import { CHECKIN_LABELS, CHECKIN_TONES, checkinTimes } from './checkin-words';
import { copyText } from './clipboard';
import { paymentOrdersKey, useGuestLinks } from './data';
import type { Checkin } from './types';

const forbidden = (error: unknown): boolean => error instanceof ApiError && error.status === 403;

type Open =
  { kind: 'revoke' } | { kind: 'checkin' } | { kind: 'link'; label: string; link: string };

/**
 * The guest's own page for a reservation (the link to it, and making old links stop working)
 * and what the guest sent in through online check-in. Renders nothing for a user who may not
 * see the reservation.
 */
export function GuestAccessSection({
  reservation,
  frame,
}: {
  reservation: Reservation;
  /** Puts the content inside the host's own section, heading included. */
  frame: (content: ReactNode) => ReactNode;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { mutate: mutateAny } = useSWRConfig();
  const propertyId = reservation.propertyId;
  const canRead = auth.can('reservations.read', propertyId);
  const canRevoke = auth.can('reservations.write', propertyId);
  const links = useGuestLinks(reservation.id, canRead);
  const checkin = useSWR<Checkin>(
    canRead ? `/reservations/${reservation.id}/online-checkin` : null,
  );
  // The answer does not say who checked the details; the audit trail does, for those who may read it.
  const audit = useSWR<AuditPage>(
    checkin.data?.status === 'verified' && auth.canOrgWide('audit.read')
      ? `/audit${query({
          entityType: 'reservation',
          entityId: reservation.id,
          actionPrefix: 'reservation.online_checkin_verified',
          limit: 1,
        })}`
      : null,
  );
  const [open, setOpen] = useState<Open | null>(null);

  // The guest sending in the details is announced as a change to the reservation.
  useLive(/^reservation\./, (events) => {
    const concerned = events.some(
      (event) => event.kind === 'resync' || event.payload?.reservationId === reservation.id,
    );
    if (concerned) void checkin.mutate();
  });

  if (!canRead || forbidden(links.error)) return null;

  const copy = async (label: string, link: string) => {
    if (await copyText(link)) toast.success(`${label} copied`);
    else setOpen({ kind: 'link', label, link });
  };

  const revoke = async () => {
    await api(`/reservations/${reservation.id}/guest-link/revoke`, { method: 'POST' });
    await links.mutate();
    // Links to pay carry the guest's link in them, so the ones still waiting changed too.
    void mutateAny(paymentOrdersKey(reservation.id));
    setOpen(null);
    toast.success('The old links no longer work', 'Copy the new link to send it to the guest.');
  };

  const status = checkin.data?.status;
  const times = checkin.data
    ? checkinTimes(checkin.data, audit.data?.entries[0]?.actorLabel)
    : null;
  const hasDetails =
    checkin.data !== undefined &&
    status !== 'not_started' &&
    (checkin.data.guests.length > 0 || checkin.data.documents.length > 0);

  return frame(
    <div className="flex flex-col gap-3">
      {links.error && !links.data ? (
        <Notice tone="danger" title="The guest link could not be loaded">
          <p>{errorMessage(links.error)}</p>
          <Button size="sm" className="mt-2" onClick={() => void links.mutate()}>
            Try again
          </Button>
        </Notice>
      ) : !links.data ? (
        <div className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner /> Loading the guest link…
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-ink-soft">
            The guest&apos;s own page for this booking: the details, paying online and checking in
            before arrival. Anyone who has the link can open it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<Copy className="size-3.5" />}
              onClick={() => void copy('Booking link', links.data!.url)}
            >
              Copy booking link
            </Button>
            {reservation.status === 'confirmed' && (
              <Button
                size="sm"
                icon={<Copy className="size-3.5" />}
                onClick={() => void copy('Check-in link', links.data!.checkInUrl)}
              >
                Copy check-in link
              </Button>
            )}
            {canRevoke && (
              <Button
                size="sm"
                variant="danger-ghost"
                icon={<Link2Off className="size-3.5" />}
                onClick={() => setOpen({ kind: 'revoke' })}
              >
                Stop old links working
              </Button>
            )}
          </div>
        </div>
      )}

      {checkin.data && status && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-line p-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
              Online check-in
              <Badge tone={CHECKIN_TONES[status]}>{CHECKIN_LABELS[status]}</Badge>
            </p>
            {times && <p className="mt-0.5 text-[13px] text-ink-soft">{times}</p>}
          </div>
          {hasDetails && (
            <Button size="sm" onClick={() => setOpen({ kind: 'checkin' })}>
              {status === 'submitted' ? 'View and check' : 'View details'}
            </Button>
          )}
        </div>
      )}
      {checkin.error && !checkin.data && !forbidden(checkin.error) && (
        <Notice tone="danger" title="Online check-in could not be loaded">
          <p>{errorMessage(checkin.error)}</p>
          <Button size="sm" className="mt-2" onClick={() => void checkin.mutate()}>
            Try again
          </Button>
        </Notice>
      )}

      {open?.kind === 'revoke' && (
        <AskDialog
          title="Stop old links working?"
          confirmLabel="Stop old links"
          onClose={() => setOpen(null)}
          onConfirm={revoke}
        >
          <p>
            Every link already sent to {reservation.guestName} for this booking stops working
            straight away: the booking page, online check-in, and links to pay that are in messages
            already sent.
          </p>
          <p>
            A new link is made at once. The guest only gets it when you send it, or with the next
            message that carries it. Do this when a link has reached the wrong person.
          </p>
        </AskDialog>
      )}
      {open?.kind === 'checkin' && checkin.data && (
        <CheckinDrawer
          reservation={reservation}
          checkin={checkin.data}
          checkedBy={audit.data?.entries[0]?.actorLabel}
          onClose={() => setOpen(null)}
          onVerified={() => void checkin.mutate()}
        />
      )}
      {open?.kind === 'link' && (
        <LinkDialog
          title={open.label}
          label={open.label}
          link={open.link}
          onClose={() => setOpen(null)}
        >
          <p className="text-sm text-ink-soft">
            The browser did not allow copying. Select the link and copy it yourself.
          </p>
        </LinkDialog>
      )}
    </div>,
  );
}
