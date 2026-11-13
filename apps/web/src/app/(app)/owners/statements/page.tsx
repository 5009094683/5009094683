import type { Metadata } from 'next';
import { StatementsView } from '@/components/owners/statements-view';

export const metadata: Metadata = { title: 'Owner statements' };

export default function OwnerStatementsPage() {
  return <StatementsView />;
}
