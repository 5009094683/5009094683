'use client';

import { timeIn } from '@pms/domain/shared';
import { Moon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { PropertyPicker, usePropertyFor } from '@/components/housekeeping/property-picker';
import type { StaffMember } from '@/components/housekeeping/types';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatWeekday, plural } from '@/lib/format';
import { useLive } from '@/lib/live';
import type { Property } from '@/lib/types';
import { RunAuditDialog } from './night-audit-dialog';
import { dayText, hourText, ranBy } from './night-audit-figures';
import { AuditHistory } from './night-audit-history';
import { NoAccess } from './no-access';
import type { AuditStatus, NightAudit } from './types';

interface AuditState {
  status: AuditStatus;
  audits: NightAudit[];
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className="mt-0.5 text-base font-semibold text-ink">{children}</dd>
    </div>
  );
}

/** What the state of the hotel day means, in a sentence, when it is not simply up to date. */
function StatusNote({ property, status }: { property: Property; status: AuditStatus }) {
  if (status.businessDate > status.today) {
    return (
      <Notice tone="info">
        {formatWeekday(status.today)} was closed early, so the hotel day is ahead of the calendar.
        There is nothing to close until {formatWeekday(status.businessDate)} begins.
      </Notice>
    );
  }
  if (status.daysBehind === 0) return null;
  const waiting =
    status.daysBehind === 1 &&
    status.automaticAt !== null &&
    timeIn(property.timezone).hour < status.automaticAt;
  if (waiting && status.automaticAt !== null) {
    return (
      <Notice tone="info">
        {formatWeekday(status.businessDate)} is still open. It closes by itself at{' '}
        {hourText(status.automaticAt)}, and the room charges for that night are posted then.
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title={`${formatWeekday(status.businessDate)} has not been closed`}>
      {status.daysBehind === 1
        ? 'Room charges for that night are not on the folios yet.'
        : `Room charges for the last ${status.daysBehind} nights are not on the folios yet. The days are closed one at a time, oldest first.`}{' '}
      {status.automaticAt === null
        ? 'The automatic run is off, so it has to be run here.'
        : 'The automatic run should have closed it. Run it here, and tell whoever looks after the system.'}
    </Notice>
  );
}

function AuditScreen({ property }: { property: Property }) {
  const auth = useAuth();
  const canRun = auth.can('nightaudit.run', property.id);
  const [confirming, setConfirming] = useState<AuditStatus | null>(null);

  const { data, error, isLoading, mutate } = useSWR<AuditState>(
    `/properties/${property.id}/night-audit`,
  );
  // The night audit announces itself with these two events and no payload.
  useLive(/^(folio|task)\.updated$/, (events) => {
    if (events.some((event) => event.kind === 'resync' || event.propertyId === property.id)) {
      void mutate();
    }
  });
  const staff = useSWR<{ staff: StaffMember[] }>(
    auth.can('housekeeping.read', property.id) ? `/properties/${property.id}/staff` : null,
  );

  if (error && !data) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data) return <PageLoading label="Loading the night audit" />;

  const { status, audits } = data;
  const names = new Map((staff.data?.staff ?? []).map((person) => [person.id, person.name]));
  if (auth.me) names.set(auth.me.user.id, auth.me.user.name);
  const ahead = status.businessDate > status.today;

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-col gap-4 p-4 sm:p-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
          <Fact label="Hotel day in progress">{dayText(status.businessDate)}</Fact>
          <Fact label="Today at the property">{dayText(status.today)}</Fact>
          <Fact label="Night audit">
            {status.daysBehind === 0 ? (
              <Badge tone="success" className="text-[13px]">
                Up to date
              </Badge>
            ) : (
              <Badge tone="warning" className="text-[13px]">
                {plural(status.daysBehind, 'day')} behind
              </Badge>
            )}
          </Fact>
          <Fact label="Automatic run">
            {status.automaticAt === null ? (
              'Automatic run is off'
            ) : (
              <>Runs by itself at {hourText(status.automaticAt)}</>
            )}
          </Fact>
        </dl>

        <StatusNote property={property} status={status} />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-[13px] text-ink-soft">
            {status.last
              ? `Last run: ${formatWeekday(status.last.businessDate)} was closed ${formatDateTime(
                  status.last.completedAt,
                )}, ${
                  ranBy(status.last, names) === 'Automatic'
                    ? 'by itself'
                    : `by ${ranBy(status.last, names)}`
                }.`
              : 'The night audit has not run here yet.'}
          </p>
          {canRun && (
            <Button
              variant="primary"
              icon={<Moon className="size-4" aria-hidden />}
              disabled={ahead}
              onClick={() => setConfirming(status)}
            >
              Run night audit now
            </Button>
          )}
        </div>
      </Card>

      <section aria-label="History">
        <h2 className="mb-2 text-sm font-semibold text-ink">
          History
          {audits.length >= 30 && (
            <span className="font-normal text-ink-faint"> · the last 30 runs</span>
          )}
        </h2>
        {audits.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Moon className="size-5" />}
              title="No night audit yet"
              description="Each closed hotel day shows here, with what was charged and who needs a look."
            />
          </Card>
        ) : (
          <AuditHistory audits={audits} currency={property.currency} names={names} />
        )}
      </section>

      {confirming && (
        <RunAuditDialog
          property={property}
          status={confirming}
          onClose={() => setConfirming(null)}
          onChanged={() => void mutate()}
        />
      )}
    </div>
  );
}

/** The night audit of one property: where the hotel day stands, running it by hand, and past runs. */
export function NightAuditView() {
  const auth = useAuth();
  const { property, properties, select, isLoading } = usePropertyFor('folio.read');

  if (!auth.can('folio.read')) return <NoAccess />;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Night audit"
        description="Closes the hotel day: charges the night's rooms and starts the next day."
        actions={
          property && (
            <PropertyPicker property={property} properties={properties} onSelect={select} />
          )
        }
      />
      {isLoading ? (
        <PageLoading />
      ) : property ? (
        <AuditScreen key={property.id} property={property} />
      ) : (
        <EmptyState
          icon={<Moon className="size-5" />}
          title="No property to show"
          description="There is no open property whose accounts you can see."
        />
      )}
    </div>
  );
}
