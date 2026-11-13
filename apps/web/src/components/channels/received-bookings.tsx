'use client';

import { Inbox, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
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
  RECEIVED_VIA,
  REVISION_KINDS,
  REVISION_STATUS,
  channelLabel,
  isNotRecorded,
  nameRooms,
  revisionSubject,
  sentence,
} from './labels';
import { useMonitor } from './monitor';
import { RelativeTime, StaleNotice } from './parts';
import { roomNamesOf, useChannelManagerStructure } from './structure';
import type { Connection, Reapplied, Revision } from './types';

const SHOWN = 50;
const COLUMNS = ['Received', 'Channel', 'What', 'Guest', 'Stay', 'Result', 'How it arrived'];

const RECORDED: Record<Revision['kind'], string> = {
  new: 'The booking is recorded',
  modified: 'The change is recorded',
  cancelled: 'The cancellation is recorded',
};

/**
 * Why a booking was not recorded. Where the server could name the room only by its id in the
 * channel manager, the channel manager is asked what the room is called.
 */
function Reason({
  revision,
  connection,
}: {
  revision: Revision;
  connection: Connection | undefined;
}) {
  const auth = useAuth();
  const structure = useChannelManagerStructure(
    revision.status === 'unmapped' ? connection : undefined,
    auth.can('channels.manage', revision.propertyId),
  );
  const reason = nameRooms(revision.error ?? 'No reason was recorded', roomNamesOf(structure.data));
  return (
    <p className="min-w-0 flex-1 basis-64 break-words">
      {sentence(reason)}
      {revision.status === 'unmapped' &&
        ' Map the room in the set-up of the connection, then apply this again.'}
      {revision.status === 'failed' &&
        revision.attempts > 1 &&
        ` Tried ${plural(revision.attempts, 'time')}.`}
    </p>
  );
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
  emptyHint,
}: {
  /** Only what this connection received. Left out, everything the user may see. */
  connectionId?: string;
  /** The connections the rows can belong to, once known. */
  connections: readonly Connection[] | undefined;
  /** Given when the table spans properties, to say which one each row belongs to. */
  propertyNames?: ReadonlyMap<string, string>;
  now: Date;
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

  const applyAgain = async (revision: Revision) => {
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
        toast.error(
          'The room is still not mapped. Map it in the set-up of the connection, then apply the booking again.',
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
  const notRecorded = revisions.filter(isNotRecorded).length;

  return (
    <>
      {error && data && <StaleNotice error={error} onRetry={() => void mutate()} />}
      {notRecorded > 0 && (
        <Notice
          tone="danger"
          className="mb-3"
          title={
            notRecorded === 1
              ? '1 booking from the channels could not be recorded here'
              : `${notRecorded} bookings from the channels could not be recorded here`
          }
        >
          {notRecorded === 1
            ? 'Until it is, the calendar does not match what the booking sites have sold. Fix what is described below, then apply it again.'
            : 'Until they are, the calendar does not match what the booking sites have sold. Fix what is described below, then apply each one again.'}
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
            title="No bookings have arrived from the channels yet"
            description={emptyHint}
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
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
                  const status = REVISION_STATUS[revision.status];
                  const via = RECEIVED_VIA[revision.receivedVia];
                  const problem = isNotRecorded(revision);
                  const propertyName = propertyNames?.get(revision.propertyId);
                  const subject = revisionSubject(revision);
                  return (
                    <Fragment key={revision.id}>
                      <tr className={cn(index > 0 && 'border-t border-line')}>
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
                          {REVISION_KINDS[revision.kind]}
                        </td>
                        <td className="px-4 py-3 text-ink">
                          {revision.guestName || <span className="text-ink-faint">Not given</span>}
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
                                connection={connections?.find(
                                  (connection) => connection.id === revision.connectionId,
                                )}
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
                                {auth.can('channels.manage', revision.propertyId) && (
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
