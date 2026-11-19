import type { Metadata } from 'next';
import { SsoView } from '@/components/settings/sso-view';

export const metadata: Metadata = { title: 'Single sign-on' };

export default function SsoPage() {
  return <SsoView />;
}
