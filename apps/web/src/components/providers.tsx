'use client';

import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/misc';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError, fetcher } from '@/lib/api';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: true,
        keepPreviousData: true,
        dedupingInterval: 500,
        // Retry outages, not refusals: a 4xx will not get better by asking again.
        shouldRetryOnError: (err) =>
          !(err instanceof ApiError) || err.status === 0 || err.status >= 500,
        errorRetryCount: 3,
      }}
    >
      <TooltipProvider>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </SWRConfig>
  );
}
