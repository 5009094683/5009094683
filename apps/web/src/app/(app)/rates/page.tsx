import type { Metadata } from 'next';
import { RatesView } from '@/components/rates/rates-view';

export const metadata: Metadata = { title: 'Rates' };

export default function RatesPage() {
  return <RatesView />;
}
