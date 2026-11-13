'use client';

import {
  ArrowDown,
  Check,
  CheckCheck,
  CircleAlert,
  Clock,
  Languages,
  Paperclip,
  RotateCcw,
  Sparkles,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  attachmentLink,
  clockTime,
  dayKey,
  dayLabel,
  deliveryLabel,
  fileSize,
  fullTime,
  isStaffNote,
  isSystemMessage,
  languageName,
} from './labels';
import type { Attachment, LocalMessage, Message, ThreadMessage, Translation } from './types';
import { useStickToEnd } from './use-scroll';

/** The most the translation service takes at once. */
const TRANSLATE_LIMIT = 6000;

const BUBBLE = 'max-w-[min(38rem,88%)] rounded-2xl border px-3.5 py-2.5 text-sm text-ink';
const UNDER_BUBBLE = 'max-w-[min(38rem,88%)] px-1';

const DELIVERY_ICONS: Record<Message['status'], LucideIcon> = {
  queued: Clock,
  sent: Check,
  delivered: CheckCheck,
  read: CheckCheck,
  failed: CircleAlert,
  received: Check,
};

const WEB_ADDRESS = /(https?:\/\/[^\s<>"']+)/g;

/** The text of a message as written, with web addresses turned into links. */
function Body({ text }: { text: string }) {
  return (
    <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
      {text.split(WEB_ADDRESS).map((part, index) => {
        if (index % 2 === 0) return part;
        // Punctuation after an address belongs to the sentence, not to the address.
        const after = /[.,;:!?)\]]+$/.exec(part)?.[0] ?? '';
        const address = after ? part.slice(0, -after.length) : part;
        return (
          <Fragment key={index}>
            <a
              href={address}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-ink-faint underline-offset-2 hover:decoration-ink"
            >
              {address}
            </a>
            {after}
          </Fragment>
        );
      })}
    </p>
  );
}

function Attachments({
  attachments,
  messageId,
}: {
  attachments: Attachment[];
  messageId: string | null;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1" aria-label="Attachments">
      {attachments.map((attachment, index) => {
        const link = attachmentLink(attachment, messageId);
        return (
          <li key={index} className="flex items-start gap-1.5 text-[13px]">
            <Paperclip className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand-700 underline underline-offset-2"
                >
                  {attachment.name}
                </a>
              ) : (
                <span className="font-medium">{attachment.name}</span>
              )}
              {typeof attachment.size === 'number' && (
                <span className="text-ink-faint"> · {fileSize(attachment.size)}</span>
              )}
              {!link && (
                <span className="text-ink-faint">
                  {attachment.expired
                    ? ' · the file is no longer kept'
                    : ' · the file is not kept here'}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={fullTime(at)} className="tabular">
      {clockTime(at)}
    </time>
  );
}

function Line({ side, children }: { side: 'start' | 'end'; children: ReactNode }) {
  return (
    <p
      className={cn(
        'mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-xs text-ink-faint',
        side === 'end' && 'justify-end',
      )}
    >
      {children}
    </p>
  );
}

const Dot = () => <span aria-hidden>·</span>;

/** What the guest wrote, on the guest's side, with the translation under it once asked for. */
function FromGuest({
  message,
  guestName,
  subject,
  canTranslate,
}: {
  message: ThreadMessage;
  guestName: string;
  subject: string | null;
  canTranslate: boolean;
}) {
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const translate = async () => {
    if (translation) {
      setShown(!shown);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      setTranslation(
        await api<Translation>('/ai/translate', {
          body: { text: message.body.slice(0, TRANSLATE_LIMIT), target: 'en' },
        }),
      );
      setShown(true);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col items-start">
      <span className="sr-only">{guestName} wrote:</span>
      <div className={cn(BUBBLE, 'rounded-bl-md border-line bg-surface shadow-card')}>
        {subject && <p className="mb-1 font-medium [overflow-wrap:anywhere]">{subject}</p>}
        <Body text={message.body} />
        <Attachments attachments={message.attachments} messageId={message.id} />
        {translation && shown && (
          <div className="mt-2 border-t border-line pt-2 text-ink-soft">
            {translation.sourceLanguage === 'en' ? (
              <p className="text-[13px]">This message is already in English.</p>
            ) : (
              <>
                <p className="mb-0.5 text-xs font-medium text-ink-faint">
                  {translation.sourceLanguage
                    ? `Translated from ${languageName(translation.sourceLanguage)}`
                    : 'Translated'}
                  {message.body.length > TRANSLATE_LIMIT && ' (the first part only)'}
                </p>
                <Body text={translation.translation} />
              </>
            )}
          </div>
        )}
      </div>
      <Line side="start">
        <When at={message.createdAt} />
        {canTranslate && (
          <>
            <Dot />
            <button
              type="button"
              onClick={() => void translate()}
              disabled={busy}
              aria-expanded={translation ? shown : undefined}
              className="inline-flex items-center gap-1 rounded font-medium text-ink-soft hover:text-ink disabled:opacity-60"
            >
              <Languages className="size-3.5" aria-hidden />
              {busy ? 'Translating…' : translation && shown ? 'Hide translation' : 'Translate'}
            </button>
          </>
        )}
      </Line>
      {problem && (
        <p role="alert" className={cn(UNDER_BUBBLE, 'mt-0.5 text-xs text-danger-600')}>
          {problem}
        </p>
      )}
    </li>
  );
}

/** What the property sent, on the property's side, with who sent it and how far it got. */
function FromProperty({
  message,
  subject,
  sender,
  canRetry,
  onRetry,
}: {
  message: ThreadMessage;
  subject: string | null;
  sender: string;
  canRetry: boolean;
  onRetry: (messageId: string) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const failed = message.status === 'failed';
  const StateIcon = DELIVERY_ICONS[message.status];
  const id = message.id;

  const retry = async (messageId: string) => {
    setRetrying(true);
    try {
      await onRetry(messageId);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <li className="flex flex-col items-end">
      <span className="sr-only">{sender} replied:</span>
      <div
        className={cn(
          BUBBLE,
          'rounded-br-md',
          failed ? 'border-danger-100 bg-danger-50' : 'border-brand-100 bg-brand-50',
        )}
      >
        {subject && <p className="mb-1 font-medium [overflow-wrap:anywhere]">{subject}</p>}
        <Body text={message.body} />
        <Attachments attachments={message.attachments} messageId={message.id} />
      </div>
      <Line side="end">
        <When at={message.createdAt} />
        <Dot />
        <span className="[overflow-wrap:anywhere]">{sender}</span>
        {message.aiDrafted && (
          <span title="Started from a suggested reply" className="inline-flex">
            <Sparkles className="size-3" aria-hidden />
            <span className="sr-only">Started from a suggested reply</span>
          </span>
        )}
        <Dot />
        <span
          className={cn(
            'inline-flex items-center gap-1',
            failed && 'font-medium text-danger-600',
            message.status === 'read' && 'text-brand-700',
          )}
        >
          <StateIcon className="size-3.5" aria-hidden />
          {deliveryLabel(message.status)}
        </span>
      </Line>
      {message.status === 'queued' && message.attempts > 0 && message.error && (
        <p
          className={cn(
            UNDER_BUBBLE,
            'mt-0.5 text-right text-xs [overflow-wrap:anywhere] text-warning-700',
          )}
        >
          The last try did not go through: {message.error} Trying again.
        </p>
      )}
      {failed && (
        <div className={cn(UNDER_BUBBLE, 'mt-1 flex flex-col items-end gap-1.5')}>
          <p className="text-right text-[13px] [overflow-wrap:anywhere] text-danger-700">
            {message.error ?? 'The message could not be sent.'}
          </p>
          {canRetry && id && (
            <Button
              size="sm"
              loading={retrying}
              icon={<RotateCcw className="size-3.5" aria-hidden />}
              onClick={() => void retry(id)}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function StaffNote({ message, sender }: { message: ThreadMessage; sender: string }) {
  return (
    <li className="flex flex-col items-end">
      <div className={cn(BUBBLE, 'rounded-br-md border-warning-100 bg-warning-50')}>
        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-warning-700">
          <StickyNote className="size-3.5" aria-hidden />
          Note for staff, not sent to the guest
        </p>
        <Body text={message.body} />
      </div>
      <Line side="end">
        <When at={message.createdAt} />
        <Dot />
        <span className="[overflow-wrap:anywhere]">{sender}</span>
      </Line>
    </li>
  );
}

function SystemMessage({ message, from }: { message: ThreadMessage; from: string }) {
  return (
    <li className="flex justify-center">
      <div className="max-w-[min(34rem,92%)] rounded-lg bg-sunken px-3 py-1.5 text-center text-[13px] text-ink-soft">
        <p className="text-xs font-medium text-ink-faint">
          {from} · <When at={message.createdAt} />
        </p>
        <Body text={message.body} />
      </div>
    </li>
  );
}

const Item = memo(function Item({
  message,
  subject,
  sender,
  guestName,
  site,
  canRetry,
  canTranslate,
  onRetry,
}: {
  message: ThreadMessage;
  /** The subject, when it is worth showing: an email whose subject differs from the one before. */
  subject: string | null;
  /** Who a message from the property is from. */
  sender: string;
  guestName: string;
  /** What the channel of the conversation is called: who a message from the channel itself is from. */
  site: string;
  canRetry: boolean;
  canTranslate: boolean;
  onRetry: (messageId: string) => Promise<void>;
}) {
  if (isSystemMessage(message)) return <SystemMessage message={message} from={site} />;
  if (isStaffNote(message)) return <StaffNote message={message} sender={sender} />;
  if (message.direction === 'in') {
    return (
      <FromGuest
        message={message}
        guestName={guestName}
        subject={subject}
        canTranslate={canTranslate}
      />
    );
  }
  return (
    <FromProperty
      message={message}
      subject={subject}
      sender={sender}
      canRetry={canRetry}
      onRetry={onRetry}
    />
  );
});

interface Day {
  key: string;
  at: string;
  entries: { key: string; message: ThreadMessage; subject: string | null }[];
}

const withoutReply = (subject: string): string => subject.replace(/^(\s*re:\s*)+/i, '').trim();

function byDay(messages: Message[], local: LocalMessage[], meId: string): Day[] {
  const days: Day[] = [];
  const dayFor = (at: string): Day => {
    const key = dayKey(at);
    const last = days.at(-1);
    if (last?.key === key) return last;
    const day: Day = { key, at, entries: [] };
    days.push(day);
    return day;
  };
  // A message written here keeps the key it was first shown under, so that it stays in place
  // (and is not read out again) when the server's copy of it takes over.
  const firstShownAs = new Map<string, string>();
  for (const entry of local) if (entry.sent) firstShownAs.set(entry.sent.id, entry.localId);
  const known = new Set<string>();
  let subject = '';
  const add = (key: string, message: ThreadMessage) => {
    const own = message.subject ? withoutReply(message.subject) : '';
    dayFor(message.createdAt).entries.push({
      key,
      message,
      subject: own && own !== subject ? message.subject : null,
    });
    if (own) subject = own;
  };
  for (const message of messages) {
    known.add(message.id);
    add(firstShownAs.get(message.id) ?? message.id, message);
  }
  for (const entry of local) {
    if (entry.sent && known.has(entry.sent.id)) continue;
    // On its way, a message already looks as the server's copy of it will: nothing about it
    // moves when that takes over.
    add(
      entry.localId,
      entry.sent ?? {
        id: null,
        direction: 'out',
        kind: 'text',
        body: entry.body,
        subject: entry.subject,
        attachments: [],
        status: 'queued',
        error: null,
        attempts: 0,
        sentBy: meId,
        senderName: null,
        aiDrafted: entry.aiDrafted,
        meta: {},
        createdAt: entry.createdAt,
      },
    );
  }
  return days;
}

/**
 * The messages of a conversation, oldest first and grouped by day: the guest on one side,
 * the property on the other. It is a log for screen readers, so what arrives is read out.
 */
export function Thread({
  guestName,
  site,
  messages,
  local,
  now,
  meId,
  people,
  canWrite,
  canTranslate,
  toEndSignal,
  onRetry,
}: {
  guestName: string;
  /** What the channel of the conversation is called. */
  site: string;
  messages: Message[];
  /** What was written here and the conversation, as last read, may not hold yet. */
  local: LocalMessage[];
  now: Date;
  /** The person signed in: who the messages on their way are from. */
  meId: string;
  /** The names of the people who may have written, by id. The server knows them by email only. */
  people: ReadonlyMap<string, string>;
  canWrite: boolean;
  canTranslate: boolean;
  /** Changes when the reader sends something: their own message is always scrolled to. */
  toEndSignal: number;
  onRetry: (messageId: string) => Promise<void>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { atEnd, onScroll, toEnd } = useStickToEnd(scroller, content);

  useLayoutEffect(() => {
    if (toEndSignal > 0) toEnd();
  }, [toEndSignal, toEnd]);

  const days = useMemo(() => byDay(messages, local, meId), [messages, local, meId]);
  const lastKey = days.at(-1)?.entries.at(-1)?.key ?? null;
  const [seenKey, setSeenKey] = useState(lastKey);
  if (atEnd && seenKey !== lastKey) setSeenKey(lastKey);
  const unseen = !atEnd && seenKey !== lastKey;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={`Messages with ${guestName}`}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto -outline-offset-2"
      >
        <div ref={content} className="mx-auto flex max-w-4xl flex-col gap-4 px-3 py-4 sm:px-5">
          {days.length === 0 && (
            <p className="py-10 text-center text-sm text-ink-faint">
              {canWrite ? 'No messages yet. Write the first one below.' : 'No messages yet.'}
            </p>
          )}
          {days.map((day) => {
            const label = dayLabel(day.at, now);
            return (
              <section key={day.key} aria-label={label} className="flex flex-col gap-2.5">
                <h3 className="mx-auto rounded-full bg-sunken px-2.5 py-0.5 text-xs font-medium text-ink-soft">
                  {label}
                </h3>
                <ol className="flex flex-col gap-2.5">
                  {day.entries.map((entry) => (
                    <Item
                      key={entry.key}
                      message={entry.message}
                      subject={entry.subject}
                      sender={
                        (entry.message.sentBy && people.get(entry.message.sentBy)) ||
                        entry.message.senderName ||
                        'The property'
                      }
                      guestName={guestName}
                      site={site}
                      canRetry={canWrite}
                      canTranslate={canTranslate}
                      onRetry={onRetry}
                    />
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      </div>
      {unseen && (
        <Button
          size="sm"
          icon={<ArrowDown className="size-3.5" aria-hidden />}
          onClick={toEnd}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-pop"
        >
          New messages
        </Button>
      )}
    </div>
  );
}
