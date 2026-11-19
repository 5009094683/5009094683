import type { Metadata } from 'next';
import { PromosView } from '@/components/promos/promos-view';

export const metadata: Metadata = { title: 'Promotional codes' };

export default function PromosPage() {
  return <PromosView />;
}
