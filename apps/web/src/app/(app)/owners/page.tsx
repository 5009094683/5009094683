import type { Metadata } from 'next';
import { OwnersView } from '@/components/owners/owners-view';

export const metadata: Metadata = { title: 'Villa owners' };

export default function OwnersPage() {
  return <OwnersView />;
}
