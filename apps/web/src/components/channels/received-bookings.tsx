'use client';

import { Inbox, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useEffect, useRef, useState } from 'react';
import { ReservationPanel } from '@/components/reservations/reservation-panel';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { Badge, Card, EmptyState, ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatStay, plural } from '@/lib/format';
import { useReturnFocus } from './focus';
import {
  channelLabel,
  isBlockedDates,
  isNotRecorded,
  nameRooms,
  receivedVia,
  revisionKind,
  revisionStatus,
  revisionSubject,
  sentence,
  unknownRoomInEmail,
} from './labels';
import { useMonitor } from './monitor';
import { RelativeTime, StaleNotice } from './parts';
import { roomNamesOf, useChannelManagerStructure } from './structure';
import type { Connection, Kind, Reapplied, Revision } from './types';

const SHOWN = 50;
const COLUMNS = ['Received', 'Channel', 'What', 'Guest', 'Stay', 'Result', 'How it arrived'];

const RECORDED: Record<Revision['kind'], string> = {
  new: 'The booking is recorded',
  modified: 'The change is recorded',
  cancelled: 'The cancellation is recorded',
};

/**
 * What to do about a booking for a room the connection cannot place. A mailbox knows rooms by
 * the names the sites write in their emails, the channel manager by the rooms mapped in its
 * set-up. `onItsPage` says whether this is read on the page of the connection itself.
 */
function howToPlace(
  kind: Kind | undefined,
  what: 'this' | 'the booking',
  onItsPage: boolean,
): string {
  return kind === 'email'
    ? `Enter the name for the right room type under Room names, ${onItsPage ? 'above' : 'on the page of the connection'}, then apply ${what} again.`
    : `Map ${what === 'this' ? 'the room' : 'it'} in the set-up of the connection, then apply ${what} again.`;
}

/** Why a mailbox could not place a booking and what to do about it; null where the server says something else. */
function unknownRoom(revision: Revision, onItsPage: boolean): string | null {
  const unknown = unknownRoomInEmail(revision.error);
  if (!unknown) return null;
  // With no name to go by, no name entered under Room names can place it.
  return `${sentence(unknown.text)} ${
    unknown.named
      ? howToPlace('email', 'this', onItsPage)
      : 'Open the email and enter the booking by hand.'
  }`;
}

/**
 * Why a booking was not recorded. Where the server could name the room only by its id in the
 * channel manager, the channel manager is asked what the room is called.
 */
function Reason({
  revision,
  connection,
  onItsPage,
}: {
  revision: Revision;
  connection: Connection | undefined;
  onItsPage: boolean;
}) {
  const auth = useAuth();
  const structure = useChannelManagerStructure(
    revision.status === 'unmapped' ? connection : undefined,
    auth.can('channels.manage', revision.propertyId),
  );
  const fromEmail =
    connection?.adapter === 'email' && revision.status === 'unmapped'
      ? unknownRoom(revision, onItsPage)
      : null;
  const reason = nameRooms(revision.error ?? 'No reason was recorded', roomNamesOf(structure.data));
  // Too old to act on: what the message said is no longer kept, so there is nothing to apply.
  if (revision.contentsDropped) {
    return (
      <p className="min-w-0 flex-1 basis-64 break-words">
        {sentence(reason)} The message was never used and its contents are no longer kept, so it
        cannot be applied any more.
      </p>
    );
  }
  return (
    <p className="min-w-0 flex-1 basis-64 break-words">
      {fromEmail ?? (
        <>
          {sentence(reason)}
          {revision.status === 'unmapped' &&
            ` ${howToPlace(connection?.adapter, 'this', onItsPage)}`}
        </>
      )}
      {revision.status === 'failed' &&
        revision.attempts > 1 &&
        ` Tried ${plural(revision.attempts, 'time')}.`}
    </p>
  );
}

/**
 * What to say above the table about what is not recorded. What a mailbox could not use is not
 * always put right by applying it again: some emails are for staff to deal with by hand.
 */
function notRecordedNotice(count: number, emails: number): { title: string; text: string } {
  if (emails === count) {
    return count === 1
      ? {
          title: '1 booking email could not be recorded here',
          text: 'Until it is dealt with, the calendar may not match what the booking sites have sold. It says below what to do.',
        }
      : {
          title: `${count} booking emails could not be recorded here`,
          text: 'Until each is dealt with, the calendar may not match what the booking sites have sold. Each one says below what to do.',
        };
  }
  if (count === 1) {
    return {
      title: '1 booking from the channels could not be recorded here',
      text: 'Until it is, the calendar does not match what the booking sites have sold. Fix what is described below, then apply it again.',
    };
  }
  return {
    title: `${count} bookings from the channels could not be recorded here`,
    text:
      emails > 0
        ? 'Until they are, the calendar does not match what the booking sites have sold. Each one says below what to do.'
        : 'Until they are, the calendar does not match what the booking sites have sold. Fix what is described below, then apply each one again.',
  };
}

/**
 * What the booking sites have sent: new bookings, changes and cancellations,
 * newest first, each with what became of it. One that could not be recorded
 * says why and can be applied again once the cause is fixed.
 */
export function ReceivedBookings({
  connectionId,
  connections,
  propertyNames,
  now,
  emptyTitle = 'No bookings have arrived from the channels yet',
  emptyHint,
}: {
  /** Only what this connection received. Left out, everything the user may see. */
  connectionId?: string;
  /** The connections the rows can belong to, once known. */
  connections: readonly Connection[] | undefined;
  /** Given when the table spans properties, to say which one each row belongs to. */
  propertyNames?: ReadonlyMap<string, string>;
  now: Date;
  emptyTitle?: string;
  emptyHint: string;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { data, error, mutate } = useMonitor<{ revisions: Revision[] }>(
    `/channels/revisions${query({ connectionId, limit: SHOWN })}`,
  );
  const [applying, setApplying] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<Revision | null>(null);
  const rememberOpener = useReturnFocus(open !== null);
  // The table of one connection sits on the page of that connection.
  const onItsPage = connectionId !== undefined;

  // A booking that gets recorded loses the notice that held the button just pressed, and the
  // keyboard with it. Its row takes the keyboard instead of the page: the reservation, if shown.
  const table = useRef<HTMLTableElement>(null);
  const lastApplied = useRef<string | null>(null);
  useEffect(() => {
    const id = lastApplied.current;
    if (id === null || applying.has(id)) return;
    lastApplied.current = null;
    const focused = document.activeElement;
    const lost =
      focused === null ||
      focused === document.body ||
      (focused instanceof HTMLButtonElement && focused.disabled);
    if (!lost) return;
    const row = table.current?.querySelector<HTMLElement>(`[data-revision="${id}"]`);
    (row?.querySelector<HTMLElement>('button') ?? row)?.focus();
  }, [applying]);

  const connectionOf = (revision: Revision): Connection | undefined =>
    connections?.find((connection) => connection.id === revision.connectionId);

  const applyAgain = async (revision: Revision) => {
    lastApplied.current = revision.id;
    setApplying((current) => new Set(current).add(revision.id));
    try {
      const result = await api<Reapplied>(`/channels/revisions/${revision.id}/reprocess`, {
        method: 'POST',
      });
      await mutate();
      if (result.status === 'applied') {
        toast.success(RECORDED[revision.kind]);
      } else if (result.status === 'superseded') {
        toast.info('Nothing to do', 'A newer version of this booking has already been recorded.');
      } else if (result.status === 'unmapped') {
        const kind = connectionOf(revision)?.adapter;
        toast.error(
          `${kind === 'email' ? 'The room in the email is still not known.' : 'The room is still not mapped.'} ${howToPlace(kind, 'the booking', onItsPage)}`,
        );
      } else {
        toast.error(result.error ?? 'The booking could not be recorded');
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setApplying((current) => {
        const next = new Set(current);
        next.delete(revision.id);
        return next;
      });
    }
  };

  const revisions = data?.revisions ?? [];
  const notRecorded = revisions.filter(isNotRecorded);
  const notice = notRecordedNotice(
    notRecorded.length,
    notRecorded.filter((revision) => connectionOf(revision)?.adapter === 'email').length,
  );

  return (
    <>
      {error && data && <StaleNotice error={error} onRetry={() => void mutate()} />}
      {notRecorded.length > 0 && (
        <Notice tone="danger" className="mb-3" title={notice.title}>
          {notice.text}
        </Notice>
      )}
      <Card className="@container overflow-hidden">
        {!data ? (
          error ? (
            <ErrorState error={error} onRetry={() => void mutate()} />
          ) : (
            <PageLoading />
          )
        ) : revisions.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-5" />}
            title={emptyTitle}
            description={emptyHint}
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table ref={table} className="w-full min-w-[880px] text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
                  {COLUMNS.map((column) => (
                    <th key={column} scope="col" className="px-4 py-2.5 font-medium">
                      {column}
                    </th>
                  ))}
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Reservation
                  </th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((revision, index) => {
                  const connection = connectionOf(revision);
                  const kind = connection?.adapter;
                  const status = revisionStatus(revision, kind);
                  const via = receivedVia(revision, kind);
                  const problem = isNotRecorded(revision);
                  const propertyName = propertyNames?.get(revision.propertyId);
                  const subject = revisionSubject(revision, kind);
                  return (
                    <Fragment key={revision.id}>
                      <tr
                        data-revision={revision.id}
                        tabIndex={-1}
                        className={cn(index > 0 && 'border-t border-line')}
                      >
                        <td className="tabular w-28 px-4 py-3 whitespace-nowrap text-ink-soft">
                          <RelativeTime value={revision.receivedAt} now={now} />
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-ink">
                            {channelLabel(revision.channelCode)}
                          </p>
                          {propertyName && <p className="text-xs text-ink-faint">{propertyName}</p>}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-ink">
                          {revisionKind(revision, kind)}
                        </td>
                        <td className="px-4 py-3 text-ink">
                          {revision.guestName ||
                            (!isBlockedDates(revision, kind) && (
                              <span className="text-ink-faint">Not given</span>
                            ))}
                        </td>
                        <td className="tabular px-4 py-3 whitespace-nowrap text-ink">
                          {revision.checkIn && revision.checkOut
                            ? formatStay(revision.checkIn, revision.checkOut)
                            : ''}
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={status.tone}>{status.label}</Badge>
                          {revision.status === 'applied' && revision.error && (
                            <p className="mt-1 max-w-64 text-xs text-ink-soft">{revision.error}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                          <span title={via.hint}>{via.label}</span>
                        </td>
                        <td className="px-4 py-3">
                          {revision.reservationId &&
                            revision.reservationCode &&
                            (auth.can('reservations.read', revision.propertyId) ? (
                              <button
                                type="button"
                                className="rounded font-mono text-[13px] font-medium text-brand-700 hover:underline"
                                aria-label={`Open reservation ${revision.reservationCode}`}
                                onClick={(event) => {
                                  rememberOpener(event);
                                  setOpen(revision);
                                }}
                              >
                                {revision.reservationCode}
                              </button>
                            ) : (
                              <span className="font-mono text-[13px] text-ink-soft">
                                {revision.reservationCode}
                              </span>
                            ))}
                        </td>
                      </tr>
                      {problem && (
                        <tr>
                          <td colSpan={COLUMNS.length + 1} className="px-4 pb-3">
                            {/* Stays in view while the table scrolls sideways on a narrow screen. */}
                            <div className="sticky left-4 flex w-[calc(100cqw-2rem)] flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-danger-100 bg-danger-50 px-3 py-2 text-[13px] text-danger-700">
                              <Reason
                                revision={revision}
                                connection={connection}
                                onItsPage={onItsPage}
                              />
                              <div className="flex items-center gap-3">
                                {!connectionId && (
                                  <Link
                                    href={`/channels/${revision.connectionId}`}
                                    className="font-medium underline underline-offset-2"
                                    aria-label={`Open the connection: ${subject}`}
                                  >
                                    Open the connection
                                  </Link>
                                )}
                                {auth.can('channels.manage', revision.propertyId) &&
                                  !revision.contentsDropped && (
                                    <Button
                                      size="sm"
                                      icon={<RotateCw className="size-3.5" />}
                                      loading={applying.has(revision.id)}
                                      aria-label={`Apply again: ${subject}`}
                                      onClick={() => void applyAgain(revision)}
                                    >
                                      Apply again
                                    </Button>
                                  )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {revisions.length >= SHOWN && (
          <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">
            Showing the latest {SHOWN}.
          </p>
        )}
      </Card>

      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open?.reservationCode ? `Reservation ${open.reservationCode}` : 'Reservation'}
        description={open?.guestName || undefined}
      >
        {open?.reservationId && (
          <ReservationPanel reservationId={open.reservationId} onChanged={() => void mutate()} />
        )}
      </Drawer>
    </>
  );
}
