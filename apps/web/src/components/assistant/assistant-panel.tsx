'use client';

import { SendHorizontal, SquarePen, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { MAX_TURN_LENGTH, type ChatItem, type ConversationApi } from './conversation';
import { ExampleChips, useExamples } from './examples';
import { ProposalCard } from './proposal-card';
import { ReplyText } from './reply-text';

export const ASSISTANT_PANEL_ID = 'assistant-panel';

const RULES_NOTE =
  'No AI service is configured, so the assistant understands a fixed set of requests.';

const isTouch = (): boolean => window.matchMedia('(pointer: coarse)').matches;

/**
 * The assistant's panel. It sits beside the page rather than over it: the page behind stays
 * in use, and the conversation is still here after moving to another page.
 */
export function AssistantPanel({
  chat,
  now,
  rules,
  draft,
  onDraft,
  onClose,
}: {
  chat: ConversationApi;
  now: number;
  /** True when it is known that no AI service is configured. */
  rules: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onClose: () => void;
}) {
  const { items, proposals } = chat.conversation;
  const examples = useExamples();
  const [examplesOpen, setExamplesOpen] = useState(false);
  const inputId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Proposals brought back from earlier are not yet a conversation: the introduction stays.
  const empty = items.every((item) => item.kind === 'earlier');
  const lastItem = items[items.length - 1];

  const focusInput = () => formRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();

  useEffect(() => {
    // On a phone the keyboard would cover half the panel before anything has been read.
    if (isTouch()) panelRef.current?.focus();
    else formRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, []);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    // An answer is read from its question down, so a long one starts at the top of the panel.
    const question =
      lastItem?.kind === 'assistant'
        ? [...log.querySelectorAll<HTMLElement>('[data-turn="user"]')].pop()
        : undefined;
    log.scrollTop = question ? question.offsetTop - 12 : log.scrollHeight;
  }, [items.length, lastItem?.kind, chat.asking, chat.earlierError]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || chat.asking) return;
    chat.ask(draft, rules && empty);
    onDraft('');
    setExamplesOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // On a phone Enter is the only way to start a new line, and Send is under the thumb.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || isTouch()) {
      return;
    }
    event.preventDefault();
    submit();
  };

  const pick = (example: string) => {
    onDraft(example);
    setExamplesOpen(false);
    focusInput();
  };

  const cards = (item: Exclude<ChatItem, { kind: 'user' }>) =>
    item.actionIds.map((id) => {
      const proposal = proposals[id];
      if (!proposal) return null;
      return (
        <ProposalCard
          key={id}
          proposal={proposal}
          now={now}
          busy={chat.deciding[id]}
          error={chat.cardErrors[id]}
          onConfirm={() => chat.confirm(id)}
          onDismiss={() => chat.dismiss(id)}
        />
      );
    });

  return (
    <aside
      ref={panelRef}
      id={ASSISTANT_PANEL_ID}
      aria-label="Assistant"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      className="fixed top-12 right-0 bottom-0 z-[35] flex w-full animate-slide-in flex-col border-l border-line bg-surface shadow-pop outline-none sm:w-[26rem]"
    >
      <div className="flex items-center gap-1 border-b border-line py-2 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-ink">Assistant</h2>
        <Button
          variant="ghost"
          size="sm"
          icon={<SquarePen className="size-3.5" aria-hidden />}
          disabled={empty}
          onClick={() => {
            chat.reset();
            onDraft('');
            setExamplesOpen(false);
            focusInput();
          }}
        >
          New conversation
        </Button>
        <button
          type="button"
          aria-label="Close assistant"
          onClick={onClose}
          className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-sunken hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>

      <div
        ref={logRef}
        role="log"
        aria-label="Conversation"
        className="scrollbar-thin relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
      >
        {empty && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Ask a question or ask for a change</p>
              <p className="mt-1 text-[13px] text-ink-soft">
                The assistant looks things up across your properties and prepares changes such as
                blocking a room or setting a rate. A change is made only when you confirm it.
              </p>
            </div>
            {examples.length > 0 && (
              <p className="text-[13px] text-ink-faint">
                {rules
                  ? `${RULES_NOTE} Start from one of these and change the names and dates.`
                  : 'For example:'}
              </p>
            )}
            <ExampleChips examples={examples} onPick={pick} />
          </div>
        )}

        {items.map((item) => {
          if (item.kind === 'user') {
            return (
              <div key={item.id} data-turn="user" className="flex flex-col items-end gap-1.5">
                <p className="max-w-[88%] rounded-lg bg-sunken px-3 py-2 text-sm whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
                  <span className="sr-only">You asked: </span>
                  {item.text}
                </p>
                {item.error && (
                  <div className="flex w-full flex-col items-start gap-2">
                    <Notice tone="warning" title="This was not answered" className="w-full">
                      {item.error}
                    </Notice>
                    {item === lastItem && !chat.asking && (
                      <Button size="sm" onClick={() => chat.retry(item.id)}>
                        Try again
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === 'earlier') {
            return (
              <div key={item.id} className="flex flex-col gap-2">
                <p className="text-xs font-medium text-ink-faint">Prepared earlier</p>
                {cards(item)}
              </div>
            );
          }
          return (
            <div key={item.id} className="flex flex-col gap-2.5">
              <div>
                <span className="sr-only">The assistant answered: </span>
                <ReplyText text={item.text} />
              </div>
              {cards(item)}
              {item.rulesNote && (
                <p className="text-xs text-ink-faint">
                  {RULES_NOTE}
                  {examples.length > 0 && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="font-medium text-ink-soft underline"
                        onClick={() => setExamplesOpen(true)}
                      >
                        Show examples
                      </button>
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}

        {chat.asking && (
          <p className="flex items-center gap-2 text-[13px] text-ink-faint">
            <Spinner label="Working on it" />
            Working on it…
          </p>
        )}
        {chat.earlierError && (
          <div className="flex flex-col items-start gap-2">
            <Notice
              tone="warning"
              title="Could not check for changes still waiting"
              className="w-full"
            >
              {chat.earlierError}
            </Notice>
            <Button size="sm" onClick={chat.loadEarlier}>
              Try again
            </Button>
          </div>
        )}
      </div>

      <form ref={formRef} onSubmit={submit} className="border-t border-line px-3 pt-3 pb-2">
        {examplesOpen && !empty && (
          <div className="scrollbar-thin mb-2 max-h-36 overflow-y-auto">
            <ExampleChips examples={examples} onPick={pick} />
          </div>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor={inputId} className="sr-only">
            Ask the assistant
          </label>
          <Textarea
            id={inputId}
            rows={2}
            maxLength={MAX_TURN_LENGTH}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask a question or ask for a change"
            className="field-sizing-content max-h-40 min-h-14 resize-none"
          />
          <Button
            type="submit"
            variant="primary"
            size="icon"
            aria-label="Send"
            loading={chat.asking}
            disabled={!draft.trim()}
            className="h-9 w-9"
          >
            {!chat.asking && <SendHorizontal className="size-4" aria-hidden />}
          </Button>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <p className="text-xs text-ink-faint">
            Answers can be wrong. Check anything that matters.
          </p>
          {!empty && examples.length > 0 && (
            <button
              type="button"
              aria-expanded={examplesOpen}
              onClick={() => setExamplesOpen((shown) => !shown)}
              className="shrink-0 text-xs font-medium text-ink-soft hover:underline"
            >
              {examplesOpen ? 'Hide examples' : 'Examples'}
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
