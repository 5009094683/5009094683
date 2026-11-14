'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { NAV, homeFor } from '@/components/shell/nav';
import { PageLoading } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';

/** Sends each person to the first screen their role opens: the calendar for most, their villa for an owner. */
export default function HomePage() {
  const router = useRouter();
  const { can } = useAuth();
  const target = homeFor(can);
  useEffect(() => router.replace(target), [router, target]);
  return (
    <PageLoading
      label={`Opening ${NAV.find((item) => item.href === target)?.label ?? 'your page'}`}
    />
  );
}
