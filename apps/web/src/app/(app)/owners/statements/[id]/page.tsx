import type { Metadata } from 'next';
import { StatementView } from '@/components/owners/statement-view';

export const metadata: Metadata = { title: 'Owner statement' };

export default async function OwnerStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed so that going from one statement to another starts afresh, with no dialog left open.
  return <StatementView key={id} statementId={id} />;
}
