import type { Metadata } from 'next';
import { ConnectionDetailView } from '@/components/channels/connection-detail';

export const metadata: Metadata = { title: 'Channel connection' };

export default async function ConnectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed so that going from one connection to another starts afresh, without the first one's
  // unsaved mapping or an open dialog carried over.
  return <ConnectionDetailView key={id} connectionId={id} />;
}
