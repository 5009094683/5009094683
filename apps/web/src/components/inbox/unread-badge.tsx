'use client';

import useSWR from 'swr';
import { useLive } from '@/lib/live';

/** How many conversations wait for an answer, shown beside the Inbox link. */
export function InboxUnread() {
  const { data, mutate } = useSWR<{ unread: number }>('/inbox/unread');
  useLive(/^message\./, () => void mutate());
  const unread = data?.unread ?? 0;
  if (unread === 0) return null;
  return (
    <span
      aria-label={`${unread} unread`}
      className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] leading-5 font-semibold text-white"
    >
      {unread > 99 ? '99+' : unread}
    </span>
  );
}
