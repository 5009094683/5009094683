'use client';

import { BedDouble, Lightbulb } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import useSWR from 'swr';
import { calmErrorMessage } from '@/components/assistant/errors';
import { useReturnFocus } from '@/components/assistant/return-focus';
import { roomLabel, stayDates } from '@/components/frontdesk/labels';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { Badge, EmptyState, ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { useLive } from '@/lib/live';
import type { AssignmentOutcome, AssignmentPlan, RoomlessStay, SuggestedRoom } from './types';

/** How far ahead stays without a room are looked for. */
const DAYS = 30;
/** The most the API takes in one request. */
const MOST_AT_ONCE = 500;

/** How a suggested room sits against whatever used the room last: the fewer empty nights, the better. */
function gapText(gap: number | null): string {
  if (gap === null) return 'The room is not in use before this stay';
  if (gap === 0) return 'No empty night before this stay';
  return `${plural(gap, 'empty night')} before this stay`;
}

function StayLine({ stay }: { stay: RoomlessStay }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-medium text-ink">
        {stay.guestName}{' '}
        <span className="font-mono text-xs font-normal text-ink-soft">{stay.code}</span>
      </span>
      <span className="block text-ink-soft">{stayDates(stay.checkIn, stay.checkOut)}</span>
    </span>
  );
}

function Suggestion({ room }: { room: SuggestedRoom }) {
  return (
    <span className="grid min-w-0 flex-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
      <StayLine stay={room} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-medium text-ink">
          <BedDouble className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
          <span className="sr-only">Suggested: </span>
          {roomLabel(room.unitName)}
        </span>
        <span className={cn('block', room.gapBefore === 0 ? 'text-success-700' : 'text-ink-soft')}>
          {gapText(room.gapBefore)}
        </span>
      </span>
    </span>
  );
}

function PlanSection({
  plan,
  canAssign,
  left,
  onToggle,
  disabled,
}: {
  plan: AssignmentPlan;
  canAssign: boolean;
  /** Rooms of stays the person has left out. */
  left: Set<string>;
  onToggle: (roomId: string, on: boolean) => void;
  disabled: boolean;
}) {
  const headingId = useId();
  const noGap = plan.assignments.filter((room) => room.gapBefore === 0).length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 id={headingId} className="text-sm font-semibold text-ink">
          {plan.roomTypeName}
        </h3>
        <p className="text-xs text-ink-faint">
          {plural(plan.assignments.length + plan.unplaced.length, 'stay')} without a room
          {noGap > 0 &&
            ` · ${noGap} of the suggested rooms ${noGap === 1 ? 'leaves' : 'leave'} no empty night`}
        </p>
      </div>
      {plan.assignments.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {plan.assignments.map((room) => (
            <li key={room.roomId}>
              {canAssign ? (
                <Checkbox
                  className="flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-sunken/60 [&>input]:mt-0.5"
                  checked={!left.has(room.roomId)}
                  disabled={disabled}
                  onChange={(event) => onToggle(room.roomId, event.target.checked)}
                  label={<Suggestion room={room} />}
                />
              ) : (
                <div className="flex px-3 py-2.5">
                  <Suggestion room={room} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {plan.unplaced.length > 0 && (
        <Notice
          tone="warning"
          title={
            plan.unplaced.length === 1
              ? 'No room could be suggested for 1 stay'
              : `No room could be suggested for ${plan.unplaced.length} stays`
          }
        >
          <p>
            Every {plan.roomTypeName} room is taken for part of{' '}
            {plan.unplaced.length === 1 ? 'this stay' : 'each of these stays'}. Move another booking
            on the calendar, or change the room type in the reservation.
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {plan.unplaced.map((stay) => (
              <li key={stay.roomId} className="flex flex-wrap items-baseline gap-x-2">
                <span>
                  {stay.guestName} <span className="font-mono text-xs">{stay.code}</span> ·{' '}
                  {stayDates(stay.checkIn, stay.checkOut)}
                </span>
                <Link
                  href={`/reservations/${stay.reservationId}`}
                  className="font-medium underline underline-offset-2"
                >
                  Open the reservation
                </Link>
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </section>
  );
}

/** What came of assigning, with the stay each refusal is about. */
interface Outcome {
  applied: number;
  failed: { room: SuggestedRoom | undefined; reason: string }[];
}

function OutcomeNotice({ outcome }: { outcome: Outcome }) {
  if (outcome.failed.length === 0) {
    return (
      <Notice tone="success" title={`${plural(outcome.applied, 'room')} assigned`}>
        The front desk board and the calendar show {outcome.applied === 1 ? 'it' : 'them'} now.
      </Notice>
    );
  }
  return (
    <Notice
      tone={outcome.applied > 0 ? 'warning' : 'danger'}
      title={
        outcome.applied > 0
          ? `${plural(outcome.applied, 'room')} assigned, ${outcome.failed.length} could not be`
          : outcome.failed.length === 1
            ? 'The room could not be assigned'
            : 'None of the rooms could be assigned'
      }
    >
      <ul className="flex flex-col gap-1">
        {outcome.failed.map((failure, index) => (
          <li key={failure.room?.roomId ?? index}>
            {failure.room && (
              <span className="font-medium">
                {failure.room.guestName} ({failure.room.code}), {roomLabel(failure.room.unitName)}
                :{' '}
              </span>
            )}
            {failure.reason}
          </li>
        ))}
      </ul>
      <p className="mt-1.5">Where another room is free, it is suggested below.</p>
    </Notice>
  );
}

function SuggestRoomsDialog({
  propertyId,
  propertyName,
  plans,
  error,
  onRetry,
  onAssigned,
  onClose,
}: {
  propertyId: string;
  propertyName: string;
  plans: AssignmentPlan[] | undefined;
  error: unknown;
  onRetry: () => void;
  /** Called after rooms were assigned, once the suggestions have been worked out afresh. */
  onAssigned: () => Promise<unknown>;
  onClose: () => void;
}) {
  const auth = useAuth();
  const canAssign = auth.can('reservations.write', propertyId);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<{ message: string; again: boolean } | null>(null);

  const suggested = (plans ?? []).flatMap((plan) => plan.assignments);
  const chosen = suggested.filter((room) => !left.has(room.roomId));

  const toggle = (roomId: string, on: boolean) => {
    const next = new Set(left);
    if (on) next.delete(roomId);
    else next.add(roomId);
    setLeft(next);
  };

  const assign = async () => {
    setBusy(true);
    setOutcome(null);
    setFailure(null);
    const sent = chosen;
    const result: Outcome = { applied: 0, failed: [] };
    try {
      for (let start = 0; start < sent.length; start += MOST_AT_ONCE) {
        const answer = await api<AssignmentOutcome>(
          `/properties/${propertyId}/insights/assignments/apply`,
          {
            body: {
              assignments: sent
                .slice(start, start + MOST_AT_ONCE)
                .map(({ reservationId, roomId, unitId }) => ({ reservationId, roomId, unitId })),
            },
          },
        );
        result.applied += answer.applied;
        for (const refusal of answer.failed) {
          result.failed.push({
            room: sent.find((room) => room.roomId === refusal.roomId),
            reason: refusal.reason,
          });
        }
      }
    } catch (err) {
      // A fault on the server's side says nothing about what to do next; the others do.
      setFailure({
        message: calmErrorMessage(err),
        again: err instanceof ApiError && err.status >= 500,
      });
    }
    // Rooms given before a request failed stay given, so the outcome so far is shown either way.
    if (result.applied > 0 || result.failed.length > 0) setOutcome(result);
    try {
      await onAssigned();
    } finally {
      setBusy(false);
    }
  };

  const nothingLeft = plans !== undefined && plans.length === 0;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Suggested rooms"
      description={`Stays arriving at ${propertyName} in the next ${DAYS} days that have no room yet.`}
      footer={
        <>
          {canAssign && suggested.length > 0 && chosen.length < suggested.length && (
            <p className="mr-auto text-[13px] text-ink-soft" aria-live="polite">
              {chosen.length === 0
                ? 'None ticked'
                : `${chosen.length} of ${suggested.length} ticked`}
            </p>
          )}
          <Button onClick={onClose}>{nothingLeft && outcome ? 'Done' : 'Close'}</Button>
          {canAssign && suggested.length > 0 && (
            <Button
              variant="primary"
              loading={busy}
              disabled={chosen.length === 0}
              onClick={() => void assign()}
            >
              {chosen.length === 0 || chosen.length === suggested.length
                ? 'Assign these rooms'
                : `Assign the ${chosen.length} ticked`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {outcome && <OutcomeNotice outcome={outcome} />}
        {failure && (
          <Notice tone="danger" title="Could not assign the rooms">
            <p>{failure.message}</p>
            {failure.again && <p>Try again in a moment.</p>}
          </Notice>
        )}
        {error && !plans ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : !plans ? (
          <PageLoading />
        ) : nothingLeft ? (
          <EmptyState
            icon={<BedDouble className="size-5" />}
            title="Every stay has a room"
            description={`No stay arriving in the next ${DAYS} days is waiting for a room.`}
          />
        ) : (
          <>
            {suggested.length > 0 && (
              <p className="text-[13px] text-ink-soft">
                Each stay is offered the free room that leaves the fewest empty nights before it, so
                that odd nights nobody can book are avoided and longer free runs stay whole.{' '}
                {canAssign
                  ? 'Nothing changes until you assign the rooms, and a room can still be changed in the reservation afterwards.'
                  : 'Rooms are assigned by people who may change reservations.'}
              </p>
            )}
            {plans.map((plan) => (
              <PlanSection
                key={plan.roomTypeId}
                plan={plan}
                canAssign={canAssign}
                left={left}
                onToggle={toggle}
                disabled={busy}
              />
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * "Suggest rooms" on the front desk: for stays that have no room yet, the rooms that leave the
 * fewest gaps, to look through and assign. The button shows only while such stays exist.
 */
export function SuggestRooms({
  propertyId,
  propertyName,
  onAssigned,
}: {
  propertyId: string;
  propertyName: string;
  onAssigned: () => void;
}) {
  const auth = useAuth();
  const allowed = auth.can('reservations.read', propertyId);
  const [open, setOpen] = useState(false);
  const rememberOpener = useReturnFocus(open);
  // Once used, the button stays for the rest of the visit: the keyboard returns to it when the
  // dialog closes, even after the last stay was given a room.
  const [used, setUsed] = useState(false);
  const { data, error, mutate } = useSWR<{ plans: AssignmentPlan[] }>(
    allowed ? `/properties/${propertyId}/insights/assignments?days=${DAYS}` : null,
    { keepPreviousData: false },
  );
  useLive(/^(reservation|block|unit)\./, (events) => {
    if (events.some((e) => e.kind === 'resync' || !e.propertyId || e.propertyId === propertyId))
      void mutate();
  });
  if (!allowed) return null;
  const waiting = (data?.plans ?? []).reduce(
    (sum, plan) => sum + plan.assignments.length + plan.unplaced.length,
    0,
  );
  if (waiting === 0 && !used) return null;

  return (
    <>
      <Button
        className="ml-auto"
        icon={<Lightbulb className="size-4" aria-hidden />}
        onClick={() => {
          rememberOpener();
          setUsed(true);
          setOpen(true);
        }}
      >
        Suggest rooms
        {waiting > 0 && (
          <Badge tone="warning" className="px-1.5 py-0">
            <span className="sr-only">: </span>
            {waiting}
            <span className="sr-only"> {waiting === 1 ? 'stay' : 'stays'} without a room</span>
          </Badge>
        )}
      </Button>
      {open && (
        <SuggestRoomsDialog
          propertyId={propertyId}
          propertyName={propertyName}
          plans={data?.plans}
          error={error}
          onRetry={() => void mutate()}
          onAssigned={async () => {
            await mutate();
            onAssigned();
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
