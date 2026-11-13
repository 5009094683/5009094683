'use client';

import { Search } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, query } from '@/lib/api';
import { formatStay } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import type { Group } from './types';

/** Finds a booking that was made before the group existed, or outside it, and adds it. */
export function ExistingBookingDialog({
  group,
  onClose,
  onAdded,
}: {
  group: Group;
  onClose: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const [term, setTerm] = useState('');
  const search = useDebounced(term.trim(), 250);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useSWR<{ reservations: Reservation[] }>(
    search.length >= 2
      ? `/reservations${query({
          propertyIds: [group.propertyId],
          statuses: ['tentative', 'confirmed', 'in_house'],
          search,
          limit: 8,
        })}`
      : null,
  );
  const found = data?.reservations ?? [];

  const add = async (reservation: Reservation) => {
    setAdding(reservation.id);
    setError(null);
    try {
      await api(`/reservations/${reservation.id}/group`, {
        method: 'PUT',
        body: { groupId: group.id },
      });
      toast.success(
        `${reservation.guestName} added to ${group.name}`,
        'Where the group holds a room on those nights, the booking now uses it.',
      );
      onAdded();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdding(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add a booking to ${group.name}`}
      description="For a booking that already exists. It then counts against the rooms held for the group."
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-faint"
            aria-hidden
          />
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Guest name or confirmation code"
            aria-label="Find a booking"
            className="pl-8"
            autoFocus
          />
        </div>
        {search.length < 2 ? (
          <p className="text-[13px] text-ink-faint">Type at least two letters.</p>
        ) : isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : found.length === 0 ? (
          <p className="text-sm text-ink-soft">No booking that still stands matches.</p>
        ) : (
          <ul className="divide-y divide-line">
            {found.map((reservation) => {
              const here = reservation.group?.id === group.id;
              return (
                <li key={reservation.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {reservation.guestName}
                    </span>
                    <span className="block text-[13px] text-ink-soft">
                      <span className="font-mono">{reservation.code}</span> ·{' '}
                      {formatStay(reservation.checkIn, reservation.checkOut)}
                      {reservation.group && !here ? ` · in ${reservation.group.name}` : ''}
                    </span>
                  </span>
                  {here ? (
                    <span className="text-[13px] text-ink-faint">Already in this group</span>
                  ) : (
                    <Button
                      size="sm"
                      loading={adding === reservation.id}
                      disabled={adding !== null && adding !== reservation.id}
                      aria-label={`Add ${reservation.guestName}, ${reservation.code}`}
                      onClick={() => void add(reservation)}
                    >
                      Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
