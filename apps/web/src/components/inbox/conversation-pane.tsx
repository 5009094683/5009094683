'use client';

import { ArrowLeft, Check, ChevronDown, RotateCcw, SearchX, UserRound, UserX } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import {
  Badge,
  EmptyState,
  ErrorState,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  PageLoading,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLive } from '@/lib/live';
import { Composer, type Reply } from './composer';
import { Detail, Details } from './details';
import { CHANNEL_ICONS, STATUS_LABELS, STATUS_TONES, channelName } from './labels';
import type { SentTemplate } from './template-dialog';
import { Thread } from './thread';
import type {
  AiStatus,
  Conversation,
  ConversationRecord,
  ConversationWithMessages,
  LocalMessage,
  Message,
  StaffMember,
} from './types';

/** One pane at a time below this width, as in the layout. */
const twoPanes = (): boolean => window.matchMedia('(min-width: 1024px)').matches;

type Patch = { status: Conversation['status'] } | { assignedTo: string | null };

/** The people who may answer guests at a property: the ones a conversation can be handed to. */
function useStaff(propertyId: string | null): StaffMember[] | undefined {
  const { data } = useSWR<{ staff: StaffMember[] }>(
    `/inbox/assignees${query({ propertyId: propertyId ?? undefined })}`,
  );
  return data?.staff;
}

/** Who looks after the conversation, and the menu to hand it to me, a colleague or nobody. */
function Assignee({
  conversation,
  onAssign,
}: {
  conversation: Conversation;
  onAssign: (userId: string | null) => void;
}) {
  const me = useAuth().me.user;
  const colleagues = (useStaff(conversation.propertyId) ?? []).filter(
    (person) => person.id !== me.id,
  );
  const current = conversation.assignedTo;

  return (
    <Menu
      trigger={
        <Button size="sm" icon={<UserRound className="size-3.5 text-ink-faint" aria-hidden />}>
          <span className="max-w-44 truncate">
            {current
              ? `Assigned to ${current === me.id ? 'me' : (conversation.assignedToName ?? 'someone')}`
              : 'Unassigned'}
          </span>
          <ChevronDown className="size-3.5 text-ink-faint" aria-hidden />
        </Button>
      }
    >
      <MenuLabel>Assign to</MenuLabel>
      <MenuItem
        icon={current === me.id ? <Check /> : <UserRound />}
        disabled={current === me.id}
        onSelect={() => onAssign(me.id)}
      >
        Me
      </MenuItem>
      {colleagues.map((person) => (
        <MenuItem
          key={person.id}
          icon={current === person.id ? <Check /> : <UserRound />}
          disabled={current === person.id}
          onSelect={() => onAssign(person.id)}
        >
          {person.name}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<UserX />} disabled={current === null} onSelect={() => onAssign(null)}>
        Nobody
      </MenuItem>
    </Menu>
  );
}

function Header({
  conversation,
  site,
  canWrite,
  onBack,
  onPatch,
}: {
  conversation: Conversation | undefined;
  site: string;
  canWrite: boolean;
  onBack: () => void;
  onPatch: (patch: Patch) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // On a phone the list has just left the screen and taken the keyboard's place with it.
  useEffect(() => {
    if (!twoPanes()) heading.current?.focus();
  }, []);

  const Icon = conversation ? CHANNEL_ICONS[conversation.channel] : null;
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-2 py-2.5 sm:px-4">
      <Button
        size="icon"
        variant="ghost"
        aria-label="Back to conversations"
        className="self-start lg:hidden"
        onClick={onBack}
      >
        <ArrowLeft className="size-4" aria-hidden />
      </Button>
      <div className="min-w-0 flex-1 basis-52">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <h2
            ref={heading}
            tabIndex={-1}
            className="min-w-0 text-base font-semibold [overflow-wrap:anywhere] text-ink outline-none"
          >
            {conversation?.contactName ?? 'Conversation'}
          </h2>
          {conversation && (
            <Badge tone={STATUS_TONES[conversation.status]}>
              {STATUS_LABELS[conversation.status]}
            </Badge>
          )}
        </div>
        {conversation && Icon && (
          <Details className="text-[13px] text-ink-soft">
            <Detail className="inline-flex items-center gap-1.5">
              <Icon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
              {site}
            </Detail>
            {conversation.propertyName && <Detail>{conversation.propertyName}</Detail>}
            {conversation.contactAddress && <Detail>{conversation.contactAddress}</Detail>}
            <Detail>
              {conversation.reservationId ? (
                <Link
                  href={`/reservations/${conversation.reservationId}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  Booking {conversation.reservationCode ?? ''}
                </Link>
              ) : (
                <span className="text-ink-faint">Not linked to a booking</span>
              )}
            </Detail>
          </Details>
        )}
      </div>
      {conversation && (
        <div className="flex flex-wrap items-center gap-2">
          {canWrite ? (
            <>
              <Assignee
                conversation={conversation}
                onAssign={(assignedTo) => onPatch({ assignedTo })}
              />
              {conversation.status === 'closed' ? (
                <Button
                  size="sm"
                  icon={<RotateCcw className="size-3.5" aria-hidden />}
                  onClick={() => onPatch({ status: 'open' })}
                >
                  Reopen
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon={<Check className="size-3.5" aria-hidden />}
                  onClick={() => onPatch({ status: 'closed' })}
                >
                  Close conversation
                </Button>
              )}
            </>
          ) : (
            <span className="text-[13px] text-ink-soft">
              {conversation.assignedToName
                ? `Assigned to ${conversation.assignedToName}`
                : 'Unassigned'}
            </span>
          )}
        </div>
      )}
    </header>
  );
}

/**
 * The open conversation: who it is with, the messages, and the reply box for those who may
 * answer. Opening it marks it read; what arrives while it is open shows by itself.
 */
export function ConversationPane({
  id,
  preview,
  now,
  justStarted,
  onBack,
  onOpen,
  onChanged,
}: {
  id: string;
  /** What the list already knows of the conversation, to show while the messages load. */
  preview: Conversation | undefined;
  now: Date;
  /** The conversation was started a moment ago from here: the reply box takes the keyboard. */
  justStarted: boolean;
  onBack: () => void;
  onOpen: (id: string) => void;
  /** The list and the unread count are out of date. */
  onChanged: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { data, error, mutate } = useSWR<ConversationWithMessages>(`/inbox/conversations/${id}`, {
    keepPreviousData: false,
  });
  const conversation = data?.conversation ?? preview;
  const propertyId = conversation?.propertyId ?? null;
  const canWrite = auth.can('inbox.write', propertyId);
  const canUseAi = auth.can('ai.use');

  const [local, setLocal] = useState<LocalMessage[]>([]);
  const [toEndSignal, setToEndSignal] = useState(0);
  // The buttons stay as they are while a change is saved, so the keyboard keeps its place on
  // them; a second press in that moment is let go.
  const patching = useRef(false);
  const sends = useRef({ started: 0, inFlight: 0 });
  // Called from effects and requests that must not start over when the parent renders again.
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  });

  const { data: ai } = useSWR<AiStatus>(canUseAi ? '/ai/status' : null);
  const me = auth.me.user;
  const staff = useStaff(propertyId);
  const people = useMemo(() => {
    const names = new Map((staff ?? []).map((person) => [person.id, person.name]));
    names.set(me.id, me.name);
    return names;
  }, [staff, me.id, me.name]);
  const site = conversation ? channelName(conversation) : '';

  useLive(/^message\./, (events) => {
    // While a reply is on its way its answer brings the thread up to date; reading the
    // conversation in between would show the reply twice for a moment.
    if (sends.current.inFlight > 0) return;
    if (events.some((event) => event.kind === 'resync' || event.payload?.conversationId === id)) {
      void mutate();
    }
  });

  const unread = data?.conversation.unreadCount ?? 0;
  const newest = data?.messages.at(-1)?.id;
  useEffect(() => {
    // Read is shared by everyone, so it is for those who can answer to say.
    if (unread === 0 || !canWrite) return;
    let done = false;
    // Read means seen: a tab in the background waits until someone looks at it.
    const markRead = () => {
      if (done || document.visibilityState !== 'visible') return;
      done = true;
      api(`/inbox/conversations/${id}/read`, { method: 'POST' })
        .then(() => {
          void mutate();
          changed.current();
        })
        .catch(() => {
          // Left unread: the next message, or opening it again, tries once more.
        });
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', markRead);
    };
  }, [id, unread, newest, canWrite, mutate]);

  const send = useCallback(
    async (reply: Reply): Promise<string | null> => {
      const localId = `local-${++sends.current.started}`;
      sends.current.inFlight += 1;
      setLocal((list) => [
        ...list,
        {
          localId,
          body: reply.body,
          subject: reply.subject,
          aiDrafted: reply.aiDrafted,
          createdAt: new Date().toISOString(),
          sent: null,
        },
      ]);
      setToEndSignal((signal) => signal + 1);
      try {
        const sent = await api<Message>(`/inbox/conversations/${id}/messages`, {
          body: {
            body: reply.body,
            ...(reply.subject ? { subject: reply.subject } : {}),
            ...(reply.aiDrafted ? { aiDrafted: true } : {}),
          },
        });
        setLocal((list) =>
          list.map((entry) => (entry.localId === localId ? { ...entry, sent } : entry)),
        );
        return null;
      } catch (err) {
        setLocal((list) => list.filter((entry) => entry.localId !== localId));
        return errorMessage(err);
      } finally {
        sends.current.inFlight -= 1;
        if (sends.current.inFlight === 0) void mutate();
        changed.current();
      }
    },
    [id, mutate],
  );

  const retry = useCallback(
    async (messageId: string) => {
      try {
        const queued = await api<Message>(`/inbox/messages/${messageId}/retry`, {
          method: 'POST',
        });
        await mutate(
          (current) =>
            current && {
              ...current,
              messages: current.messages.map((message) =>
                message.id === queued.id ? queued : message,
              ),
            },
          { revalidate: false },
        );
      } catch (err) {
        toast.error(err);
        void mutate();
      }
    },
    [mutate, toast],
  );

  const patch = async (change: Patch) => {
    if (patching.current) return;
    patching.current = true;
    try {
      const saved = await api<ConversationRecord>(`/inbox/conversations/${id}`, {
        method: 'PATCH',
        body: change,
      });
      await mutate(
        (current) =>
          current && {
            ...current,
            conversation: {
              ...current.conversation,
              ...saved,
              // The name comes with the next read; until then the old one would be wrong.
              assignedToName:
                saved.assignedTo === current.conversation.assignedTo
                  ? current.conversation.assignedToName
                  : ((saved.assignedTo && people.get(saved.assignedTo)) ?? null),
            },
          },
        { revalidate: true },
      );
      onChanged();
    } catch (err) {
      toast.error(err, 'Could not save the change. Try again.');
    } finally {
      patching.current = false;
    }
  };

  const templateSent = (sent: SentTemplate) => {
    onChanged();
    if (sent.conversation.id !== id) {
      // The server writes to the number on the guest's profile, which has its own conversation.
      toast.info('Template sent', 'It went to the conversation with the guest’s own number.');
      onOpen(sent.conversation.id);
      return;
    }
    setToEndSignal((signal) => signal + 1);
    void mutate();
  };

  const pane = useRef<HTMLDivElement>(null);
  const back = useRef(onBack);
  useEffect(() => {
    back.current = onBack;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A dialog or a menu that was open has already taken the key for itself.
      if (event.key !== 'Escape' || event.defaultPrevented || twoPanes()) return;
      const target = event.target;
      const here = target instanceof Node && pane.current?.contains(target);
      if (here || target === document.body) back.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div ref={pane} className="flex h-full min-h-0 flex-col">
      <Header
        conversation={conversation}
        site={site}
        canWrite={canWrite}
        onBack={onBack}
        onPatch={(change) => void patch(change)}
      />
      {error && !data ? (
        // Trying again does not bring back a conversation that is not there.
        error instanceof ApiError && (error.status === 404 || error.status === 403) ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={<SearchX className="size-5" />}
              title={
                error.status === 404
                  ? 'This conversation was not found'
                  : 'You cannot open this conversation'
              }
              description={
                error.status === 404
                  ? 'The link may be wrong, or the conversation belongs to a property you do not have access to.'
                  : errorMessage(error)
              }
              action={<Button onClick={onBack}>Back to the inbox</Button>}
            />
          </div>
        ) : (
          <ErrorState error={error} onRetry={() => void mutate()} />
        )
      ) : !data ? (
        <PageLoading label="Loading messages" />
      ) : (
        <>
          <Thread
            guestName={data.conversation.contactName}
            site={site}
            messages={data.messages}
            local={local}
            now={now}
            meId={me.id}
            people={people}
            canWrite={canWrite}
            canTranslate={canUseAi && Boolean(ai?.provider)}
            toEndSignal={toEndSignal}
            onRetry={retry}
          />
          {canWrite ? (
            <Composer
              conversation={data.conversation}
              canWriteFreely={data.canWriteFreely}
              sendingUnavailable={data.sendingUnavailable}
              canSuggest={canUseAi}
              autoFocus={justStarted}
              onSend={send}
              onTemplateSent={templateSent}
            />
          ) : (
            <p className="border-t border-line bg-surface px-4 py-3 text-[13px] text-ink-soft">
              You can read this conversation. Replying is not part of your role.
            </p>
          )}
        </>
      )}
    </div>
  );
}
