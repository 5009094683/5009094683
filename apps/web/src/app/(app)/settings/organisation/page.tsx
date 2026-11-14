import type { Metadata } from 'next';
import { OrganisationView } from '@/components/settings/organisation-view';

export const metadata: Metadata = { title: 'Organisation' };

export default function OrganisationPage() {
  return <OrganisationView />;
}
