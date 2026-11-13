'use client';

import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Spinner } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { Detail, Details } from './details';
import {
  CHANNEL_ICONS,
  STATUS_LABELS,
  STATUS_TONES,
  channelName,
  fullTime,
  listTime,
} from './labels';
import type { Conversation } from './types';
import { useScrollAnchor } from './use-scroll';

/** The address of the inbox with a conversation open: what a row links to and what is shared. */
export const conversationHref = (id: string): string => `/inbox?c=${id}`;

/** The id of a conversation's row, for putting the keyboard back on it. */
export const rowId = (id: string): string => `conversation-row-${id}`;

/** A guest wrote this recently enough for it to be news rather than history. */
const NEWS_MS = 90_000;

/** How long after a conversation is opened its row is still brought into view when it turns up. */
const REVEAL_MS = 3_000;

/** What to tell a screen reader about the rows that changed, or nothing. */
function news(before: Conversation[], after: Conversation[], openId: string | null): string {
  if (before.length === 0) return '';
  const counts = new Map(before.map((c) => [c.id, c.unreadCount]));
  const fresh = after.filter(
    (c) =>
      c.id !== openId &&
      c.unreadCount > (counts.get(c.id) ?? 0) &&
      c.lastInboundAt !== null &&
      Date.now() - new Date(c.lastInboundAt).getTime() < NEWS_MS,
  );
  if (fresh.length === 0) return '';
  if (fresh.length === 1) return `New message from ${fresh[0]?.contactName ?? 'a guest'}`;
  return `New messages in ${fresh.length} conversations`;
}

const Row = memo(function Row({
  conversation,
  open,
  now,
  onOpen,
}: {
  conversation: Conversation;
  open: boolean;
  now: Date;
  onOpen: (id: string) => void;
}) {
  const Icon = CHANNEL_ICONS[conversation.channel];
  // The reader has the open conversation in front of them: it is read as it arrives.
  const unread = open ? 0 : conversation.unreadCount;
  const when = conversation.lastMessageAt ?? conversation.createdAt;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // A modified click keeps its meaning: open in a new tab or window.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onOpen(conversation.id);
  };

  return (
    <li>
      <a
        id={rowId(conversation.id)}
        href={conversationHref(conversation.id)}
        data-conversation={conversation.id}
        aria-current={open ? 'true' : undefined}
        onClick={onClick}
        className={cn(
          'flex gap-3 border-l-2 py-3 pr-3 pl-2.5 -outline-offset-2 transition-colors',
          open ? 'border-brand-600 bg-brand-50' : 'border-transparent hover:bg-sunken/60',
        )}
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-ink-soft">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                'line-clamp-2 min-w-0 [overflow-wrap:anywhere] text-ink',
                unread > 0 ? 'font-semibold' : 'font-medium',
              )}
            >
              {conversation.contactName}
            </span>
            <time
              dateTime={when}
              title={fullTime(when)}
              className="tabular shrink-0 text-xs text-ink-faint"
            >
              {listTime(when, now)}
            </time>
          </span>
          <Details className="text-xs text-ink-soft">
            <Detail>{channelName(conversation)}</Detail>
            {conversation.propertyName && <Detail>{conversation.propertyName}</Detail>}
          </Details>
          <span className="flex items-start justify-between gap-2">
            <span
              className={cn(
                'line-clamp-2 min-w-0 text-[13px] [overflow-wrap:anywhere]',
                unread > 0 ? 'text-ink' : 'text-ink-soft',
              )}
            >
              {conversation.lastMessagePreview ?? 'No messages yet'}
            </span>
            {/* The place of the count is kept when there is none, so the words beside it do
                not move when a message arrives or is read. */}
            <span className="mt-0.5 flex w-8 shrink-0 justify-end">
              {unread > 0 && (
                <span className="flex min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] leading-5 font-semibold text-white">
                  <span aria-hidden>{unread > 99 ? '99+' : unread}</span>
                  <span className="sr-only">{unread} unread</span>
                </span>
              )}
            </span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <Badge tone={STATUS_TONES[conversation.status]}>
              {STATUS_LABELS[conversation.status]}
            </Badge>
            <span className="[overflow-wrap:anywhere]">
              {conversation.assignedToName ?? 'Unassigned'}
            </span>
          </span>
        </span>
      </a>
    </li>
  );
});

/**
 * The conversations, newest activity first. The rows are links: Tab or the arrow keys move
 * between them and Enter opens one. Older ones load when the end comes into view.
 */
export function ConversationList({
  conversations,
  openId,
  now,
  updating,
  hasMore,
  loadingMore,
  onMore,
  onOpen,
}: {
  conversations: Conversation[];
  openId: string | null;
  now: Date;
  updating: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onOpen: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const onScroll = useScrollAnchor(scroller);

  const [shown, setShown] = useState(conversations);
  const [announcement, setAnnouncement] = useState('');
  if (shown !== conversations) {
    setShown(conversations);
    const text = news(shown, conversations, openId);
    if (text) setAnnouncement(text);
  }

  // The row of the conversation just opened is brought into view once: a conversation started
  // a moment ago, or one opened from a link, can lie further down than the list shows.
  const present = openId !== null && conversations.some((c) => c.id === openId);
  const openedAt = useRef(0);
  useEffect(() => {
    openedAt.current = Date.now();
  }, [openId]);
  useEffect(() => {
    if (!openId || !present || Date.now() - openedAt.current > REVEAL_MS) return;
    document.getElementById(rowId(openId))?.scrollIntoView({ block: 'nearest' });
  }, [openId, present]);

  const more = useRef(onMore);
  useEffect(() => {
    more.current = onMore;
  });
  // Watched afresh after each page: a short page can leave the end still in view, and an
  // observer only reports a change.
  useEffect(() => {
    const root = scroller.current;
    const target = end.current;
    if (!root || !target || !hasMore || loadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more.current();
      },
      { root, rootMargin: '0px 0px 240px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, conversations.length]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('a[data-conversation]')];
    const at = rows.findIndex((row) => row === document.activeElement);
    if (at === -1) return;
    const next =
      event.key === 'ArrowDown'
        ? at + 1
        : event.key === 'ArrowUp'
          ? at - 1
          : event.key === 'Home'
            ? 0
            : rows.length - 1;
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  };

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      aria-busy={updating || undefined}
      className={cn(
        'scrollbar-thin min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]',
        updating && 'opacity-60',
      )}
    >
      <ul
        role="list"
        aria-label="Conversations"
        onKeyDown={onKeyDown}
        className="divide-y divide-line border-b border-line"
      >
        {conversations.map((conversation) => (
          <Row
            key={conversation.id}
            conversation={conversation}
            open={conversation.id === openId}
            now={now}
            onOpen={onOpen}
          />
        ))}
      </ul>
      {hasMore && (
        <div ref={end} className="flex min-h-12 items-center justify-center p-2">
          {loadingMore ? (
            <Spinner label="Loading older conversations" />
          ) : (
            <Button size="sm" variant="ghost" onClick={onMore}>
              Show older conversations
            </Button>
          )}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
