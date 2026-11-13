'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { use } from 'react';
import useSWR from 'swr';
import { ReservationPanel } from '@/components/reservations/reservation-panel';
import { Card } from '@/components/ui/misc';
import type { Reservation } from '@/lib/types';

export default function ReservationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Shares its request with the panel below; used here only for the heading.
  const { data } = useSWR<Reservation>(`/reservations/${id}`);
  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <Link
        href="/reservations"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Reservations
      </Link>
      <h1 className="mb-3 text-xl font-semibold tracking-tight text-ink">
        Reservation {data ? <span className="font-mono">{data.code}</span> : ''}
      </h1>
      <Card className="p-5">
        <ReservationPanel reservationId={id} />
      </Card>
    </div>
  );
}
