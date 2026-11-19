'use client';

import { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { query } from '@/lib/api';
import type { Conversation, ConversationPage, Filters } from './types';

const PAGE_SIZE = 30;

function listPath(filters: Filters, cursor?: string): string {
  return `/inbox/conversations${query({
    status: filters.status === 'all' ? undefined : filters.status,
    channel: filters.channel,
    assignedTo: filters.assigned === 'all' ? undefined : filters.assigned,
    search: filters.search,
    cursor,
    limit: PAGE_SIZE,
  })}`;
}

/**
 * The conversations that match the filters, newest activity first, a page at a time. A
 * refresh asks for every page shown again, in order, so that a conversation that moved to
 * the top is not also left further down.
 */
export function useConversations(filters: Filters) {
  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite<ConversationPage>(
    (index: number, previous: ConversationPage | null) => {
      if (index === 0) return listPath(filters);
      return previous?.nextCursor ? listPath(filters, previous.nextCursor) : null;
    },
    // Asking for older conversations reads that page only. The live stream brings the rest up
    // to date, and that reads every page again.
    { revalidateFirstPage: false },
  );

  const conversations = useMemo(() => {
    const seen = new Set<string>();
    const all: Conversation[] = [];
    for (const page of data ?? []) {
      for (const conversation of page.conversations) {
        if (seen.has(conversation.id)) continue;
        seen.add(conversation.id);
        all.push(conversation);
      }
    }
    return all;
  }, [data]);

  const hasMore = Boolean(data?.at(-1)?.nextCursor);
  const loadingMore = data !== undefined && size > data.length;
  const loadMore = useCallback(() => void setSize((pages) => pages + 1), [setSize]);

  // An empty list may only mean the filters match nothing: ask whether there is anything at all.
  const empty = data !== undefined && !isLoading && conversations.length === 0;
  const anything = useSWR<ConversationPage>(empty ? '/inbox/conversations?limit=1' : null);
  const checking = empty && !anything.data && !anything.error;
  const recheck = anything.mutate;

  const refresh = useCallback(() => {
    void mutate();
    void recheck();
  }, [mutate, recheck]);

  return {
    conversations,
    /** Nothing has been loaded yet. */
    loading: (data === undefined && !error) || checking,
    /** The filters changed and the list still shows what matched the old ones. */
    updating: data !== undefined && isLoading,
    error,
    loaded: data !== undefined,
    hasMore,
    loadingMore,
    loadMore,
    refresh,
    /** No conversation exists at all, whatever the filters. */
    nothingYet: empty && anything.data?.conversations.length === 0,
  };
}
