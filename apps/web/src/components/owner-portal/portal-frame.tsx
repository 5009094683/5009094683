'use client';

import { House, Lock } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';

const TABS = [
  { href: '/owner', label: 'Overview' },
  { href: '/owner/calendar', label: 'Calendar' },
  { href: '/owner/statements', label: 'Statements' },
];

/** The owner portal's own frame: its name, its three pages, and who may see them. */
export function PortalFrame({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = usePathname();

  if (!auth.can('owner.portal')) {
    return (
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <EmptyState
          icon={<Lock className="size-5" />}
          title="This page is for villa owners"
          description={
            'It shows an owner their own villa: its bookings, their own stays and their statements. Your sign-in is not an owner\u2019s, so there is nothing for you here.'
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <div className="print:hidden">
        <h1 className="text-xl font-semibold tracking-tight text-ink">My villa</h1>
        <nav aria-label="My villa" className="mt-3 mb-5 flex gap-1 border-b border-line">
          {TABS.map((tab) => {
            const active =
              tab.href === '/owner'
                ? pathname === tab.href
                : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-ink-soft hover:text-ink',
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
      {children}
    </div>
  );
}

/**
 * What to show when a page of the portal could not be loaded. A sign-in that
 * is not linked to an owner is refused by the server in words meant for the
 * owner, so those are shown as they are and not as a fault.
 */
export function PortalProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <EmptyState
        icon={<House className="size-5" />}
        title="Your villa is not shown here yet"
        description={error.message}
      />
    );
  }
  return <ErrorState error={error} onRetry={onRetry} />;
}
