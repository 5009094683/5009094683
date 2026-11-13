import type { Metadata } from 'next';
import { StatementView } from '@/components/owner-portal/statement-view';

export const metadata: Metadata = { title: 'Statement' };

export default async function OwnerStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StatementView key={id} statementId={id} />;
}
