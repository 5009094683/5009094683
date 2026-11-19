'use client';

import { LogIn, LogOut } from 'lucide-react';
import { useState } from 'react';
import { scrollToBill } from '@/components/folio/folio-section';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { usePropertyDetail } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import { CheckInDialog } from './check-in-dialog';
import { CheckOutDialog } from './check-out-dialog';
import { hotelDayOf } from './labels';

/**
 * Check in and Check out for the reservation panel, shown to front desk staff when a room is due
 * to arrive or is in house.
 */
export function StayActions({
  reservation,
  onChanged,
}: {
  reservation: Reservation;
  onChanged: (updated: Reservation) => void;
}) {
  const auth = useAuth();
  const { data: detail } = usePropertyDetail(reservation.propertyId);
  const [dialog, setDialog] = useState<'check-in' | 'check-out' | null>(null);

  if (!detail || !auth.can('frontdesk.operate', reservation.propertyId)) return null;
  const hotelDay = hotelDayOf(detail.property);
  const due = reservation.rooms.some(
    (room) => room.status === 'confirmed' && room.checkIn <= hotelDay,
  );
  const inHouse = reservation.rooms.filter((room) => room.status === 'in_house');
  const dueOut = inHouse.some((room) => room.checkOut <= hotelDay);
  // The check-out dialog stays up to show the result after the last room has left.
  if (!due && inHouse.length === 0 && dialog === null) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {due && (
        <Button
          variant="primary"
          icon={<LogIn className="size-4" />}
          onClick={() => setDialog('check-in')}
        >
          Check in
        </Button>
      )}
      {inHouse.length > 0 && (
        <Button
          variant={dueOut && !due ? 'primary' : 'secondary'}
          icon={<LogOut className="size-4" />}
          onClick={() => setDialog('check-out')}
        >
          {dueOut ? 'Check out' : 'Check out early'}
        </Button>
      )}
      {dialog === 'check-in' && (
        <CheckInDialog
          reservationId={reservation.id}
          hotelDay={hotelDay}
          onClose={() => setDialog(null)}
          onDone={(updated) => {
            setDialog(null);
            onChanged(updated);
          }}
        />
      )}
      {dialog === 'check-out' && (
        <CheckOutDialog
          reservationId={reservation.id}
          hotelDay={hotelDay}
          onClose={() => setDialog(null)}
          onCheckedOut={onChanged}
          onOpenBill={scrollToBill}
        />
      )}
    </div>
  );
}
