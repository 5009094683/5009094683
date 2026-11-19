import type { Metadata } from 'next';
import { TaxRegisterView } from '@/components/accounts/tax-register-view';

export const metadata: Metadata = { title: 'Tax register' };

export default function TaxRegisterPage() {
  return <TaxRegisterView />;
}
