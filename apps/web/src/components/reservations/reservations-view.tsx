'use client';

import { AlertTriangle, ClipboardList, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { addDays, todayIn } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  PageLoading,
  STATUS_TONES,
} from '@/components/ui/misc';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { STATUS_LABELS, formatMoney, formatStay, plural, sourceLabel } from '@/lib/format';
import { useDebounced, useProperties } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { Reservation } from '@/lib/types';
import { ReservationDialog } from './reservation-dialog';
import { ReservationPanel } from './reservation-panel';

type View = 'upcoming' | 'arrivals' | 'departures' | 'in_house' | 'attention' | 'cancelled' | 'all';

const VIEWS: { value: View; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'arrivals', label: 'Arriving today' },
  { value: 'departures', label: 'Leaving today' },
  { value: 'in_house', label: 'In house' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All' },
];

const PAGE_SIZE = 50;

export function ReservationsView() {
  const auth = useAuth();
  const { properties } = useProperties();
  const [view, setView] = useState<View>('upcoming');
  const [propertyId, setPropertyId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(search.trim(), 250);

  const today = useMemo(() => todayIn(properties[0]?.timezone ?? 'Asia/Kolkata'), [properties]);
  const filters = useMemo(() => {
    // A search looks everywhere: someone asking about a booking rarely knows which list it is in.
    if (term) return { search: term, sort: 'created' };
    switch (view) {
      case 'upcoming':
        return { statuses: ['tentative', 'confirmed'], from: today, to: addDays(today, 730) };
      case 'arrivals':
        return { arrivingOn: today, statuses: ['tentative', 'confirmed', 'in_house'] };
      case 'departures':
        return { departingOn: today, statuses: ['in_house', 'checked_out', 'confirmed'] };
      case 'in_house':
        return { statuses: ['in_house'] };
      case 'attention':
        return { needsAttention: 'true' };
      case 'cancelled':
        return { statuses: ['cancelled', 'no_show'], sort: 'created' };
      default:
        return { sort: 'created' };
    }
  }, [view, term, today]);

  const key = `/reservations${query({
    ...filters,
    propertyIds: propertyId ? [propertyId] : undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  })}`;
  const { data, error, mutate, isLoading } = useSWR<{ reservations: Reservation[]; total: number }>(
    key,
  );
  useLive(/^reservation\./, () => void mutate());

  const propertyName = (id: string) => properties.find((p) => p.id === id)?.name ?? '';
  const canCreate = properties.some((p) => auth.can('reservations.write', p.id));
  const open = data?.reservations.find((r) => r.id === openId);
  const pages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
      <PageHeader
        title="Reservations"
        actions={
          canCreate && (
            <Button
              variant="primary"
              icon={<Plus className="size-4" />}
              onClick={() => setCreating(true)}
            >
              New reservation
            </Button>
          )
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-faint"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Guest, confirmation code, email, phone"
            aria-label="Search reservations"
            className="pl-8"
          />
        </div>
        {properties.length > 1 && (
          <Select
            aria-label="Property"
            value={propertyId}
            onChange={(e) => {
              setPropertyId(e.target.value);
              setPage(0);
            }}
            className="w-auto"
          >
            <option value="">All properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Reservation lists"
        className="mb-3 flex gap-1 overflow-x-auto border-b border-line"
      >
        {VIEWS.map((v) => (
          <button
            key={v.value}
            role="tab"
            type="button"
            aria-selected={!term && view === v.value}
            onClick={() => {
              setView(v.value);
              setSearch('');
              setPage(0);
            }}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              !term && view === v.value
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        {error ? (
          <ErrorState error={error} onRetry={() => void mutate()} />
        ) : isLoading || !data ? (
          <PageLoading />
        ) : data.reservations.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="size-5" />}
            title={term ? `Nothing matches "${term}"` : 'No reservations in this list'}
            description={
              term
                ? 'Try the guest name, the confirmation code or the channel reference.'
                : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Guest
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Stay
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Room
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Source
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.reservations.map((r) => {
                  const rooms = r.rooms.filter(
                    (room) => room.status !== 'cancelled' || r.status === 'cancelled',
                  );
                  const first = rooms[0];
                  return (
                    <tr
                      key={r.id}
                      className="cursor-pointer transition-colors hover:bg-brand-50/60"
                      onClick={() => setOpenId(r.id)}
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="text-left font-medium text-ink hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenId(r.id);
                          }}
                        >
                          {r.guestName}
                        </button>
                        <p className="font-mono text-xs text-ink-faint">{r.code}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-ink">{formatStay(r.checkIn, r.checkOut)}</p>
                        <p className="text-xs text-ink-faint">
                          {plural(r.nights, 'night')} · {plural(r.adults + r.children, 'guest')}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-ink">
                          {first?.roomTypeName ?? ''}
                          {rooms.length > 1 && (
                            <span className="text-ink-faint"> +{rooms.length - 1}</span>
                          )}
                        </p>
                        <p className="text-xs text-ink-faint">
                          {properties.length > 1 ? `${propertyName(r.propertyId)} · ` : ''}
                          {first?.unitName ?? 'No room assigned'}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-ink-soft">
                        {sourceLabel(r.source, r.channelCode)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap items-center gap-1">
                          <Badge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Badge>
                          {r.overbooked && (
                            <Badge tone="danger">
                              <AlertTriangle className="size-3" aria-hidden /> Overbooked
                            </Badge>
                          )}
                          {r.needsReview && <Badge tone="warning">Review</Badge>}
                        </span>
                      </td>
                      <td className="tabular px-4 py-3 text-right font-medium text-ink">
                        {formatMoney(r.totalAmount, r.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[13px] text-ink-soft">
            <span>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} of {data.total}
            </span>
            <span className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </span>
          </div>
        )}
      </div>

      <Drawer
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={open ? `Reservation ${open.code}` : 'Reservation'}
        description={open?.guestName}
      >
        {openId && <ReservationPanel reservationId={openId} onChanged={() => void mutate()} />}
      </Drawer>
      <ReservationDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => void mutate()}
      />
    </div>
  );
}
