import type { Metadata } from 'next';
import { FrontDeskView } from '@/components/frontdesk/front-desk-view';

export const metadata: Metadata = { title: 'Front desk' };

export default function FrontDeskPage() {
  return <FrontDeskView />;
}
