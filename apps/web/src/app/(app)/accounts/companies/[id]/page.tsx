import type { Metadata } from 'next';
import { CompanyStatement } from '@/components/accounts/company-statement';

export const metadata: Metadata = { title: 'Company statement' };

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CompanyStatement key={id} companyId={id} />;
}
