import type { Metadata } from 'next';
import { StatementsView } from '@/components/owner-portal/statements-view';

export const metadata: Metadata = { title: 'Statements' };

export default function OwnerStatementsPage() {
  return <StatementsView />;
}
