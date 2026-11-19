'use client';

import { UsersRound } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';

/** The group a reservation is part of, with a way out of it. Shows nothing for other stays. */
export function GroupRow({
  reservation,
  canEdit,
  onChanged,
}: {
  reservation: Reservation;
  canEdit: boolean;
  onChanged: (updated: Reservation) => void;
}) {
  const toast = useToast();
  const group = reservation.group;
  const leave = useAction(async () => {
    try {
      const updated = await api<Reservation>(`/reservations/${reservation.id}/group`, {
        method: 'PUT',
        body: { groupId: null },
      });
      toast.success(
        `Taken out of ${group?.name ?? 'the group'}`,
        'It no longer uses a room held for the group.',
      );
      onChanged(updated);
    } catch (err) {
      toast.error(err);
    }
  });
  if (!group) return null;
  const live = ['tentative', 'confirmed', 'in_house'].includes(reservation.status);

  return (
    <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2 text-sm">
      <UsersRound className="size-4 shrink-0 text-ink-faint" aria-hidden />
      <span className="text-ink-soft">Group</span>
      <Link href={`/groups/${group.id}`} className="font-medium text-brand-700 hover:underline">
        {group.name}
      </Link>
      {canEdit && live && (
        <Button
          size="sm"
          variant="ghost"
          loading={leave.busy}
          onClick={() => void leave.run()}
          className="ml-auto"
        >
          Take out of group
        </Button>
      )}
    </div>
  );
}
