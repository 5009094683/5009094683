import type { Metadata } from 'next';
import { ReservationsView } from '@/components/reservations/reservations-view';

export const metadata: Metadata = { title: 'Reservations' };

export default function ReservationsPage() {
  return <ReservationsView />;
}
