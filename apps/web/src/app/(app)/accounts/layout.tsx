import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AccountsNav } from '@/components/accounts/accounts-nav';

export const metadata: Metadata = {
  title: { default: 'Accounts', template: '%s · Accounts · PMS' },
};

export default function AccountsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[84rem] flex-col lg:flex-row">
      <AccountsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
