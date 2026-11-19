import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/settings/settings-nav';

export const metadata: Metadata = {
  title: { default: 'Settings', template: '%s · Settings · PMS' },
};

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[77rem] flex-col lg:flex-row">
      <SettingsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
