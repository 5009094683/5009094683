import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PortalFrame } from '@/components/owner-portal/portal-frame';

export const metadata: Metadata = {
  title: { default: 'My villa', template: '%s · My villa · PMS' },
};

export default function OwnerPortalLayout({ children }: { children: ReactNode }) {
  return <PortalFrame>{children}</PortalFrame>;
}
