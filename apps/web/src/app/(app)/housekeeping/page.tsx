import type { Metadata } from 'next';
import { HousekeepingView } from '@/components/housekeeping/housekeeping-view';

export const metadata: Metadata = { title: 'Housekeeping' };

export default function HousekeepingPage() {
  return <HousekeepingView />;
}
