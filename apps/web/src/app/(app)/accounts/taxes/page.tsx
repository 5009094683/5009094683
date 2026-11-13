import type { Metadata } from 'next';
import { TaxRulesView } from '@/components/accounts/tax-rules-view';

export const metadata: Metadata = { title: 'Tax rules' };

export default function TaxRulesPage() {
  return <TaxRulesView />;
}
