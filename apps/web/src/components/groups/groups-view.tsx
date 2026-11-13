'use client';

import { CalendarRange, Plus, Search, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { PropertyPicker, usePropertyFor } from '@/components/housekeeping/property-picker';
import { NoAccess } from '@/components/settings/no-access';
import { Button } from '@/components/ui/button';
import { Input, Segmented } from '@/components/ui/field';
import { Badge, Card, EmptyState, ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { GroupDialog } from './group-dialog';
import type { GroupItem, StatusFilter } from './types';
import { STATUS_LABELS, STATUS_TONES, cutoffText, datesText, progressText } from './words';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'open', label: 'Holding rooms' },
  { value: 'closed', label: 'Released' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All' },
];

const EMPTY: Record<StatusFilter, { title: string; description: string }> = {
  open: {
    title: 'No group is holding rooms',
    description:
      'Start a group for a wedding, a tour or a conference: its rooms are kept off sale until the guests book them.',
  },
  closed: {
    title: 'No released groups',
    description: 'Groups whose unbooked rooms have gone back on sale show here.',
  },
  cancelled: {
    title: 'No cancelled groups',
    description: 'Groups that were called off show here.',
  },
  all: { title: 'No groups yet', description: 'Groups you start show here.' },
};

function GroupCard({ group }: { group: GroupItem }) {
  const cutoff = cutoffText(group);
  return (
    <li>
      <Link
        href={`/groups/${group.id}`}
        className="block rounded-xl focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:outline-none"
      >
        <Card className="flex flex-col gap-2 p-4 transition-colors hover:border-line-strong">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{group.name}</p>
              <p className="font-mono text-xs text-ink-faint">{group.code}</p>
            </div>
            <Badge tone={STATUS_TONES[group.status]}>{STATUS_LABELS[group.status]}</Badge>
          </div>
          <p className="flex items-center gap-2 text-sm text-ink">
            <CalendarRange className="size-4 shrink-0 text-ink-faint" aria-hidden />
            {datesText(group)}
          </p>
          <p className="text-[13px] text-ink-soft">{progressText(group)}</p>
          {group.heldNights > 0 && (
            <div
              role="img"
              aria-label={`${group.heldNights - group.leftNights} of ${group.heldNights} held room nights booked`}
              className="h-1.5 overflow-hidden rounded-full bg-sunken"
            >
              <div
                className="h-full rounded-full bg-brand-500"
                style={{
                  width: `${Math.round(((group.heldNights - group.leftNights) / group.heldNights) * 100)}%`,
                }}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px] text-ink-soft">
            <span>{group.contactName ?? 'No contact given'}</span>
            {group.value > 0 && (
              <span className="tabular font-medium text-ink">
                {formatMoney(group.value, group.currency)}
              </span>
            )}
          </div>
          {cutoff && <p className="text-[13px] text-ink-faint">{cutoff}</p>}
        </Card>
      </Link>
    </li>
  );
}

/** The groups of a property: rooms held for each and how many its guests have booked. */
export function GroupsView() {
  const auth = useAuth();
  const router = useRouter();
  const allowed = auth.can('reservations.read');
  const {
    property,
    properties,
    select,
    isLoading: propertiesLoading,
    error: propertiesError,
    retry,
  } = usePropertyFor('reservations.read');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [term, setTerm] = useState('');
  const search = useDebounced(term.trim(), 250);
  const [creating, setCreating] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<{ groups: GroupItem[] }>(
    allowed && property ? `/properties/${property.id}/groups${query({ status, search })}` : null,
    { keepPreviousData: false },
  );
  useLive(/^(group|reservation)\./, () => void mutate());

  if (!allowed) return <NoAccess />;

  const canCreate = property
    ? auth.can('reservations.write', property.id) && auth.can('blocks.write', property.id)
    : false;
  const groups = data?.groups ?? [];
  const failure = error && !data ? error : !property ? propertiesError : undefined;

  return (
    <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
      <PageHeader
        title="Groups"
        description="Rooms held for a wedding, a tour or a conference, and the bookings made from them."
        actions={
          canCreate && (
            <Button
              variant="primary"
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() => setCreating(true)}
            >
              New group
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {property && (
          <PropertyPicker property={property} properties={properties} onSelect={select} />
        )}
        <Segmented label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        <div className="relative w-full sm:ml-auto sm:w-64">
          <Search
            className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-faint"
            aria-hidden
          />
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Name, code or contact"
            aria-label="Find a group"
            className="pl-8"
          />
        </div>
      </div>

      {failure ? (
        <ErrorState
          error={failure}
          onRetry={() => {
            retry();
            void mutate();
          }}
        />
      ) : propertiesLoading || (isLoading && !data) ? (
        <PageLoading label="Loading groups" />
      ) : !property ? (
        <EmptyState
          icon={<UsersRound className="size-5" />}
          title="No property to show"
          description="Groups belong to a property. None is open to you yet."
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<UsersRound className="size-5" />}
          title={search ? 'No group matches' : EMPTY[status].title}
          description={
            search ? 'Try another name, or look under another status.' : EMPTY[status].description
          }
          action={
            !search && status === 'open' && canCreate ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New group
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <GroupCard key={group.id} group={group} />
          ))}
        </ul>
      )}

      {creating && property && (
        <GroupDialog
          property={property}
          onClose={() => setCreating(false)}
          onSaved={(group) => router.push(`/groups/${group.id}`)}
        />
      )}
    </div>
  );
}
