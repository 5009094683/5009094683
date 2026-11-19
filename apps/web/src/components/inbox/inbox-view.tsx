'use client';

import { Inbox as InboxIcon, MessagesSquare, Search, SearchX, SquarePen } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { Button } from '@/components/ui/button';
import { Input, Segmented, Select } from '@/components/ui/field';
import { EmptyState, ErrorState, Notice, PageHeader, PageLoading } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useDebounced } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { ConversationList, conversationHref, rowId } from './conversation-list';
import { ConversationPane } from './conversation-pane';
import { ASSIGNED_OPTIONS, CHANNEL_KINDS, STATUS_OPTIONS } from './labels';
import { NewConversationDialog } from './new-conversation-dialog';
import { NoAccess } from './no-access';
import type { AssignedFilter, Channel, ConversationRecord, Filters, StatusFilter } from './types';
import { useConversations } from './use-conversations';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INBOX = '/inbox';

/** Marks the browser's history entry of a conversation that was opened from the list. */
const OPENED_HERE = 'inboxOpenedHere';

function openedHere(): boolean {
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null && OPENED_HERE in state;
}

/** The time, kept fresh enough for "today" and "yesterday" to stay true on a screen left open. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const isChannel = (value: string): value is Channel =>
  CHANNEL_KINDS.some((kind) => kind.value === value);
const isStatus = (value: string): value is StatusFilter =>
  STATUS_OPTIONS.some((option) => option.value === value);

function NewMessageButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="primary"
      icon={<SquarePen className="size-3.5" aria-hidden />}
      onClick={onClick}
    >
      New message
    </Button>
  );
}

/**
 * The address holds the open conversation (`/inbox?c=<id>`), so it can be sent to a colleague
 * and the browser's back button returns to the list. It is written straight to the browser's
 * history: opening a conversation then costs no request for the page itself.
 */
function Inbox() {
  const auth = useAuth();
  const openId = useSearchParams().get('c');
  const canStart = auth.can('inbox.write');

  const [status, setStatus] = useState<StatusFilter>('active');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [assigned, setAssigned] = useState<AssignedFilter>('all');
  const [term, setTerm] = useState('');
  const search = useDebounced(term.trim(), 250);
  const filters = useMemo<Filters>(
    () => ({ status, channel, assigned, search }),
    [status, channel, assigned, search],
  );
  const filtered = status !== 'active' || channel !== '' || assigned !== 'all' || search !== '';

  const list = useConversations(filters);
  const { refresh: refreshList } = list;
  const { mutate } = useSWRConfig();
  const now = useNow();
  const [starting, setStarting] = useState(false);
  const [startedId, setStartedId] = useState<string | null>(null);

  useLive(/^message\./, refreshList);
  const refresh = useCallback(() => {
    refreshList();
    void mutate('/inbox/unread');
  }, [refreshList, mutate]);

  const open = useCallback((id: string) => {
    if (new URLSearchParams(window.location.search).get('c') === id) return;
    window.history.pushState({ [OPENED_HERE]: true }, '', conversationHref(id));
  }, []);

  const back = useCallback(() => {
    if (openedHere()) window.history.back();
    else window.history.replaceState(null, '', INBOX);
  }, []);

  // Back at the list, the keyboard returns to the conversation that was open.
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    if (openId) {
      lastOpen.current = openId;
    } else if (lastOpen.current) {
      document.getElementById(rowId(lastOpen.current))?.focus();
      lastOpen.current = null;
    }
  }, [openId]);

  const started = (conversation: ConversationRecord) => {
    setStarting(false);
    setStartedId(conversation.id);
    refresh();
    open(conversation.id);
  };

  const showAll = () => {
    setStatus('all');
    setChannel('');
    setAssigned('all');
    setTerm('');
  };

  const dialog = starting && (
    <NewConversationDialog onClose={() => setStarting(false)} onStarted={started} />
  );

  if (list.nothingYet && !openId) {
    return (
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <PageHeader
          title="Inbox"
          description="Every conversation with guests, in one place."
          actions={canStart && <NewMessageButton onClick={() => setStarting(true)} />}
        />
        <EmptyState
          icon={<InboxIcon className="size-5" />}
          title="Nothing in the inbox yet"
          description={
            canStart
              ? 'Messages that guests send through booking sites, WhatsApp and email arrive here. You can also write to a guest first.'
              : 'Messages that guests send through booking sites, WhatsApp and email arrive here.'
          }
        />
        {dialog}
      </div>
    );
  }

  return (
    <div className="relative flex h-full">
      <section
        aria-label="Inbox"
        className={cn(
          'absolute inset-0 flex min-w-0 flex-col bg-surface',
          'lg:static lg:w-[23rem] lg:shrink-0 lg:border-r lg:border-line',
          openId && 'invisible lg:visible',
        )}
      >
        <div className="flex flex-col gap-2 border-b border-line px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-ink">Inbox</h1>
            {canStart && <NewMessageButton onClick={() => setStarting(true)} />}
          </div>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-faint"
              aria-hidden
            />
            <Input
              type="search"
              aria-label="Search conversations"
              placeholder="Search by guest name or booking code"
              autoComplete="off"
              maxLength={120}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              className="pl-8"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select
              aria-label="Status"
              value={status}
              onChange={(event) => isStatus(event.target.value) && setStatus(event.target.value)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Came through"
              value={channel}
              onChange={(event) =>
                setChannel(isChannel(event.target.value) ? event.target.value : '')
              }
            >
              <option value="">All messages</option>
              {CHANNEL_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Segmented
              label="Assigned to"
              size="sm"
              value={assigned}
              onChange={setAssigned}
              options={ASSIGNED_OPTIONS}
            />
          </div>
        </div>

        {list.error && !list.loaded ? (
          <ErrorState error={list.error} onRetry={refreshList} />
        ) : list.loading ? (
          <PageLoading label="Loading conversations" />
        ) : (
          <>
            {list.error && (
              <Notice tone="danger" className="m-3 mb-0">
                <div className="flex items-center justify-between gap-2">
                  <span>The list could not be brought up to date. {errorMessage(list.error)}</span>
                  <Button size="sm" onClick={refreshList}>
                    Try again
                  </Button>
                </div>
              </Notice>
            )}
            {list.conversations.length === 0 ? (
              <EmptyState
                icon={<SearchX className="size-5" />}
                title={
                  search
                    ? 'No conversation matches'
                    : filtered
                      ? 'No conversations here'
                      : 'No active conversations'
                }
                description={
                  search
                    ? 'Try another name or booking code, or show every conversation.'
                    : filtered
                      ? 'Nothing fits what is chosen above.'
                      : 'Closed conversations are kept. Show every conversation to see them.'
                }
                action={<Button onClick={showAll}>Show all conversations</Button>}
              />
            ) : (
              <ConversationList
                conversations={list.conversations}
                openId={openId}
                now={now}
                updating={list.updating}
                hasMore={list.hasMore}
                loadingMore={list.loadingMore}
                onMore={list.loadMore}
                onOpen={open}
              />
            )}
          </>
        )}
      </section>

      <section
        aria-label="Conversation"
        className={cn(
          'absolute inset-0 flex min-w-0 flex-col bg-canvas lg:static lg:flex-1',
          !openId && 'invisible lg:visible',
        )}
      >
        {!openId ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={<MessagesSquare className="size-5" />}
              title="No conversation selected"
              description="Choose one from the list to read it and reply."
            />
          </div>
        ) : !UUID.test(openId) ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={<SearchX className="size-5" />}
              title="This link does not lead to a conversation"
              description="It may have been cut short when it was copied."
              action={<Button onClick={back}>Back to the inbox</Button>}
            />
          </div>
        ) : (
          <ConversationPane
            key={openId}
            id={openId}
            preview={list.conversations.find((conversation) => conversation.id === openId)}
            now={now}
            justStarted={openId === startedId}
            onBack={back}
            onOpen={open}
            onChanged={refresh}
          />
        )}
      </section>
      {dialog}
    </div>
  );
}

/** Every conversation with guests, whichever way they wrote: the list and the open conversation. */
export function InboxView() {
  const auth = useAuth();
  if (!auth.can('inbox.read')) return <NoAccess />;
  return (
    <Suspense fallback={<PageLoading />}>
      <Inbox />
    </Suspense>
  );
}
