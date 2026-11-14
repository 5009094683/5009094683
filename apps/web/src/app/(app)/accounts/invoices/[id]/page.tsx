import type { Metadata } from 'next';
import { InvoiceView } from '@/components/accounts/invoice-view';

export const metadata: Metadata = { title: 'Invoice' };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed so that going from an invoice to its credit note starts afresh, with no dialog left open.
  return <InvoiceView key={id} invoiceId={id} />;
}
