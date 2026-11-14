import type { Metadata } from 'next';
import { OwnerDetail } from '@/components/owners/owner-detail';

export const metadata: Metadata = { title: 'Villa owner' };

export default async function OwnerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed so that going from one owner to another starts afresh, with no dialog left open.
  return <OwnerDetail key={id} ownerId={id} />;
}
