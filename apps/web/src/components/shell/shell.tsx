'use client';

import { BedDouble, Bell, LogOut, Menu as MenuIcon, ShieldCheck, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Assistant } from '@/components/assistant/assistant';
import { InboxUnread } from '@/components/inbox/unread-badge';
import {
  Badge,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Popover,
  Tooltip,
} from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useLive, useLiveStatus } from '@/lib/live';
import type { Alert } from '@/lib/types';
import { GlobalSearch } from './global-search';
import { NAV } from './nav';

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const auth = useAuth();
  const items = NAV.filter((item) => item.permissions.some((p) => auth.can(p)));
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-brand-50 text-brand-700'
                : 'text-ink-soft hover:bg-sunken hover:text-ink',
            )}
          >
            <Icon
              className={cn('size-4 shrink-0', active ? 'text-brand-600' : 'text-ink-faint')}
              aria-hidden
            />
            {item.label}
            {item.badge === 'inbox' && <InboxUnread />}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  const { me } = useAuth();
  return (
    <div className="flex items-center gap-2.5 px-4 py-4">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
        <BedDouble className="size-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink">{me.organization?.name ?? 'PMS'}</p>
        <p className="text-xs text-ink-faint">Property management</p>
      </div>
    </div>
  );
}

const SEVERITY_TONE = { critical: 'danger', warning: 'warning', info: 'info' } as const;

function AlertsBell() {
  const { data, mutate } = useSWR<{ alerts: Alert[] }>('/alerts?limit=30');
  useLive(/^alert\./, () => void mutate());
  const alerts = data?.alerts ?? [];
  const open = alerts.filter((a) => a.status === 'open');
  const critical = open.some((a) => a.severity === 'critical');

  const act = async (id: string, action: 'acknowledge' | 'resolve') => {
    await api(`/alerts/${id}/${action}`, { method: 'POST' });
    await mutate();
  };

  return (
    <Popover
      align="end"
      className="w-[min(26rem,calc(100vw-1.5rem))] p-0"
      trigger={
        <button
          type="button"
          aria-label={open.length > 0 ? `Alerts: ${open.length} open` : 'Alerts'}
          className="relative rounded-md p-2 text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
        >
          <Bell className="size-[18px]" />
          {open.length > 0 && (
            <span
              className={cn(
                'absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold text-white',
                critical ? 'bg-danger-500' : 'bg-warning-500',
              )}
            >
              {open.length}
            </span>
          )}
        </button>
      }
    >
      <div className="border-b border-line px-4 py-3">
        <p className="text-sm font-semibold text-ink">Alerts</p>
      </div>
      <div className="scrollbar-thin max-h-[60vh] overflow-y-auto">
        {alerts.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-faint">Nothing needs attention.</p>
        ) : (
          <ul className="divide-y divide-line">
            {alerts.map((alert) => (
              <li key={alert.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-ink">{alert.title}</p>
                  <Badge tone={SEVERITY_TONE[alert.severity]}>{alert.severity}</Badge>
                </div>
                {alert.body && <p className="mt-1 text-[13px] text-ink-soft">{alert.body}</p>}
                <div className="mt-2 flex items-center gap-3 text-xs text-ink-faint">
                  <span>{formatRelative(alert.lastSeenAt)}</span>
                  {alert.occurrences > 1 && <span>seen {alert.occurrences} times</span>}
                  {alert.entityType === 'reservation' && alert.entityId && (
                    <Link
                      href={`/reservations/${alert.entityId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      Open reservation
                    </Link>
                  )}
                  <span className="ml-auto flex gap-3">
                    {alert.status === 'open' && (
                      <button
                        type="button"
                        className="font-medium text-ink-soft hover:underline"
                        onClick={() => void act(alert.id, 'acknowledge')}
                      >
                        Acknowledge
                      </button>
                    )}
                    <button
                      type="button"
                      className="font-medium text-ink-soft hover:underline"
                      onClick={() => void act(alert.id, 'resolve')}
                    >
                      Resolve
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  );
}

function LiveDot() {
  const connected = useLiveStatus();
  return (
    <Tooltip
      content={
        connected
          ? 'Live: changes made elsewhere appear here straight away'
          : 'Reconnecting. Changes made elsewhere will appear once the connection is back.'
      }
    >
      <span
        role="status"
        aria-label={connected ? 'Live updates connected' : 'Live updates reconnecting'}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-ink-faint"
      >
        <span
          className={cn(
            'size-2 rounded-full',
            connected ? 'bg-success-500' : 'animate-pulse bg-warning-500',
          )}
        />
        <span className="hidden sm:inline">{connected ? 'Live' : 'Reconnecting'}</span>
      </span>
    </Tooltip>
  );
}

function UserMenu() {
  const { me } = useAuth();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const initials = me.user.name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    // Drop everything cached for this user before the next person signs in.
    await mutate(() => true, undefined, { revalidate: false });
    router.replace('/login');
  };

  return (
    <Menu
      trigger={
        <button
          type="button"
          aria-label="Account menu"
          className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800 transition-colors hover:bg-brand-200"
        >
          {initials || <UserRound className="size-4" />}
        </button>
      }
    >
      <MenuLabel>
        <span className="block text-sm font-medium text-ink">{me.user.name}</span>
        <span className="block font-normal">{me.user.email}</span>
      </MenuLabel>
      <MenuSeparator />
      <MenuItem icon={<ShieldCheck />} onSelect={() => router.push('/settings/security')}>
        Password and security
      </MenuItem>
      <MenuItem icon={<LogOut />} onSelect={() => void signOut()}>
        Sign out
      </MenuItem>
    </Menu>
  );
}

/** The frame around every signed-in page: navigation, alerts, account. */
export function Shell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <Brand />
        <div className="scrollbar-thin flex-1 overflow-y-auto pb-4">
          <NavLinks />
        </div>
      </aside>

      {menuOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 animate-fade-in bg-ink/40"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-surface shadow-pop">
            <div className="flex items-center justify-between pr-2">
              <Brand />
              <button
                type="button"
                aria-label="Close navigation"
                className="rounded-md p-2 text-ink-soft hover:bg-sunken"
                onClick={() => setMenuOpen(false)}
              >
                <X className="size-4" />
              </button>
            </div>
            <NavLinks onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <button
            type="button"
            aria-label="Open navigation"
            className="rounded-md p-2 text-ink-soft hover:bg-sunken md:hidden"
            onClick={() => setMenuOpen(true)}
          >
            <MenuIcon className="size-[18px]" />
          </button>
          <div className="flex min-w-0 flex-1 items-center">
            {auth.can('reservations.read') && <GlobalSearch />}
          </div>
          {auth.can('ai.use') && <Assistant />}
          <LiveDot />
          {auth.can('property.read') && <AlertsBell />}
          <UserMenu />
        </header>
        <main className="scrollbar-thin min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
