import type { Metadata } from 'next';
import { NightAuditView } from '@/components/accounts/night-audit-view';

export const metadata: Metadata = { title: 'Night audit' };

export default function NightAuditPage() {
  return <NightAuditView />;
}
