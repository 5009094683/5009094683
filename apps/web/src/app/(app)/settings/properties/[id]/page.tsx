import type { Metadata } from 'next';
import { PropertyDetailView } from '@/components/settings/property-detail';

export const metadata: Metadata = { title: 'Property' };

export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed so that going from one property to another starts afresh, without the first one's
  // data or an open dialog carried over.
  return <PropertyDetailView key={id} propertyId={id} />;
}
