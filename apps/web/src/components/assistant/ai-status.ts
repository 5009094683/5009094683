'use client';

import useSWR from 'swr';
import type { AiStatus } from './types';

/** Which AI features this installation has. Pass false to skip the request. */
export function useAiStatus(enabled = true): AiStatus | undefined {
  // It changes only when the server is reconfigured, so there is no need to ask again on focus.
  const { data } = useSWR<AiStatus>(enabled ? '/ai/status' : null, { revalidateOnFocus: false });
  return data;
}
