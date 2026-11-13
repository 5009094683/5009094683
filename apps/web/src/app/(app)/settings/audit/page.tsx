import type { Metadata } from 'next';
import { AuditView } from '@/components/settings/audit-view';

export const metadata: Metadata = { title: 'Audit trail' };

export default function AuditPage() {
  return <AuditView />;
}
