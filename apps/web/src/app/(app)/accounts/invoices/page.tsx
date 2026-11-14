import type { Metadata } from 'next';
import { InvoicesView } from '@/components/accounts/invoices-view';

export const metadata: Metadata = { title: 'Invoices' };

export default function InvoicesPage() {
  return <InvoicesView />;
}
