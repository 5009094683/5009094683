import type { Metadata } from 'next';
import { CalendarView } from '@/components/owner-portal/calendar-view';

export const metadata: Metadata = { title: 'Calendar' };

export default function OwnerCalendarPage() {
  return <CalendarView />;
}
