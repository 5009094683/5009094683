'use client';

import { LoaderCircle } from 'lucide-react';
import { useLinkStatus } from 'next/link';
import type { ReactNode } from 'react';

/**
 * Goes inside a link to another page of this site, in the place of its icon. While that
 * page is being fetched it shows progress instead, and carries `data-pending` for the
 * link's own styles to answer to.
 *
 * This is what the pages have in place of a loading screen. With one, Next.js sends a
 * page in pieces that a script puts in place: the page can then no longer be read without
 * scripts, and can no longer answer "not found" or send the guest elsewhere properly.
 * Without one, nothing on the screen changes until the next page arrives, so the link
 * that was tapped has to show that the tap was taken.
 */
export function LinkPending({ icon }: { icon?: ReactNode }) {
  const { pending } = useLinkStatus();
  if (!pending) return icon ?? null;
  return icon ? (
    <LoaderCircle data-pending className="size-4 shrink-0 animate-spin" aria-hidden />
  ) : (
    <span data-pending hidden />
  );
}
