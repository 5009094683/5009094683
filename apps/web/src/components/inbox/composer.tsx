'use client';

import { FileText, SendHorizontal, Sparkles, Undo2, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { languageName } from './labels';
import { TemplateDialog, type SentTemplate } from './template-dialog';
import type { Conversation, ReplyDraft } from './types';

export interface Reply {
  body: string;
  subject: string | null;
  aiDrafted: boolean;
}

/** What is in the reply box, as far as sending it goes. */
interface Draft {
  text: string;
  /** The subject a template brought, for an email. Without one the server answers under the guest's own. */
  subject: string | null;
  /** The text began as a suggested reply. */
  suggested: boolean;
}

const EMPTY: Draft = { text: '', subject: null, suggested: false };

/** The most a message may hold. */
const LIMIT = 10_000;

/** Replies begun and not sent, by conversation: they are still there after looking at another one. */
const unsent = new Map<string, Draft>();

const TOUCH = '(pointer: coarse) and (hover: none)';

function watchTouch(onChange: () => void): () => void {
  const media = window.matchMedia(TOUCH);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** A phone's keyboard has no Shift and Enter: there Enter starts a new line and the button sends. */
function useTouchKeyboard(): boolean {
  return useSyncExternalStore(
    watchTouch,
    () => window.matchMedia(TOUCH).matches,
    () => false,
  );
}

/**
 * Where a reply is written. Nothing is ever sent without the person pressing Send or Enter:
 * a suggested reply and a template only fill the box.
 */
export function Composer({
  conversation,
  canWriteFreely,
  sendingUnavailable,
  canSuggest,
  autoFocus,
  onSend,
  onTemplateSent,
}: {
  conversation: Conversation;
  canWriteFreely: boolean;
  sendingUnavailable: string | null;
  canSuggest: boolean;
  autoFocus: boolean;
  /** Sends the reply. Answers with what the server said when it could not, else null. */
  onSend: (reply: Reply) => Promise<string | null>;
  onTemplateSent: (sent: SentTemplate) => void;
}) {
  const id = conversation.id;
  const email = conversation.channel === 'email';
  // The kit's text box takes no ref, so it is reached through the element around it.
  const wrap = useRef<HTMLDivElement>(null);
  const box = () => wrap.current?.querySelector('textarea') ?? null;
  const hintId = useId();
  const touch = useTouchKeyboard();

  const [draft, setDraft] = useState<Draft>(() => unsent.get(id) ?? EMPTY);
  /** What was in the box before a suggestion or a template took its place. */
  const [replaced, setReplaced] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<ReplyDraft | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestProblem, setSuggestProblem] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    if (draft.text) unsent.set(id, draft);
    else unsent.delete(id);
  }, [id, draft]);

  useLayoutEffect(() => {
    const area = wrap.current?.querySelector('textarea');
    if (!area) return;
    area.style.height = 'auto';
    // The border is part of the height and not of what scrolls.
    area.style.height = `${Math.min(area.scrollHeight + 2, 220)}px`;
  }, [draft.text]);

  useEffect(() => {
    if (autoFocus) wrap.current?.querySelector('textarea')?.focus();
  }, [autoFocus]);

  const focusEnd = (showStart = false) => {
    // After the dialog or the button that had the keyboard has let go of it.
    window.setTimeout(() => {
      const area = box();
      if (!area) return;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      // A text put in for the person to read is read from its first line.
      if (showStart) area.scrollTop = 0;
    }, 60);
  };

  const type = (text: string) => {
    setDraft(text.trim() ? { ...draft, text } : EMPTY);
    setProblem(null);
  };

  const replace = (next: Draft) => {
    setReplaced(draft.text.trim() ? draft : null);
    setDraft(next);
    setProblem(null);
    focusEnd(true);
  };

  const putBack = () => {
    if (!replaced) return;
    setDraft(replaced);
    setReplaced(null);
    focusEnd();
  };

  const body = draft.text.trim();
  const blocked = sendingUnavailable !== null || !canWriteFreely;

  const send = async () => {
    if (!body || blocked) return;
    const sent = draft;
    setDraft(EMPTY);
    setReplaced(null);
    setProblem(null);
    setSuggestion(null);
    setSuggestProblem(null);
    // The Send button is about to go grey and would take the keyboard's place with it.
    box()?.focus();
    const refusal = await onSend({
      body,
      subject: email ? sent.subject?.trim() || null : null,
      aiDrafted: sent.suggested,
    });
    if (refusal === null) return;
    // Nothing written is lost: what did not go comes back, ahead of anything typed since.
    setDraft((current) =>
      current.text.trim() ? { ...sent, text: `${sent.text}\n\n${current.text}` } : sent,
    );
    setProblem(refusal);
    focusEnd();
  };

  const suggest = async () => {
    setSuggesting(true);
    setSuggestProblem(null);
    setSuggestion(null);
    try {
      const answer = await api<ReplyDraft>(`/inbox/conversations/${id}/draft`, { method: 'POST' });
      setSuggestion(answer);
      if (answer.draft) replace({ text: answer.draft, subject: null, suggested: true });
    } catch (err) {
      setSuggestProblem(errorMessage(err));
    } finally {
      setSuggesting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    if (touch && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    void send();
  };

  const templates = choosing && (
    <TemplateDialog
      conversation={conversation}
      approvedOnly={!canWriteFreely}
      onClose={() => setChoosing(false)}
      onUse={(message) =>
        replace({ text: message.body, subject: message.subject, suggested: false })
      }
      onSent={onTemplateSent}
    />
  );

  if (sendingUnavailable !== null) {
    return (
      <div className="border-t border-line bg-surface px-3 py-3 sm:px-4">
        <Notice tone="warning" title="A reply cannot be sent from here at the moment">
          {sendingUnavailable}
        </Notice>
      </div>
    );
  }

  if (!canWriteFreely) {
    return (
      <div className="border-t border-line bg-surface px-3 py-3 sm:px-4">
        <Notice tone="info" title="Only an approved template can be sent now">
          <p>
            The guest last wrote more than 24 hours ago. WhatsApp then lets a property send only a
            template it has approved, until the guest writes again.
          </p>
          <Button
            size="sm"
            className="mt-2"
            icon={<FileText className="size-3.5" aria-hidden />}
            onClick={() => setChoosing(true)}
          >
            Choose a template
          </Button>
        </Notice>
        {templates}
      </div>
    );
  }

  const decision = suggestion?.needsStaff ? (suggestion.reason ?? 'Someone has to decide.') : null;
  const nothing =
    suggestion && !suggestion.draft && !suggestion.needsStaff
      ? (suggestion.reason ?? 'There is nothing to suggest for this conversation.')
      : null;

  return (
    <div className="@container flex flex-col gap-2 border-t border-line bg-surface px-3 py-3 sm:px-4">
      {problem && (
        <Notice tone="danger" title="The message was not sent">
          {problem} Your text is still in the box.
        </Notice>
      )}
      {suggestProblem && (
        <Notice tone="danger">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 [overflow-wrap:anywhere]">{suggestProblem}</p>
            <DismissButton onClick={() => setSuggestProblem(null)} />
          </div>
        </Notice>
      )}
      {decision && (
        <Notice tone="warning">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-medium">This needs a decision:</span> {decision}
            </p>
            <DismissButton onClick={() => setSuggestion(null)} />
          </div>
        </Notice>
      )}
      {nothing && (
        <Notice tone="info">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 [overflow-wrap:anywhere]">{nothing}</p>
            <DismissButton onClick={() => setSuggestion(null)} />
          </div>
        </Notice>
      )}

      {email && draft.subject !== null && (
        <label className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">
          Subject
          <Input
            value={draft.subject}
            maxLength={300}
            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
            className="h-8"
          />
        </label>
      )}

      <div ref={wrap} className="flex">
        <Textarea
          rows={2}
          value={draft.text}
          maxLength={LIMIT}
          onChange={(event) => type(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={`Reply to ${conversation.contactName}`}
          aria-describedby={touch ? undefined : hintId}
          placeholder="Write a reply"
          className="min-h-[3.75rem] resize-none"
        />
      </div>

      {suggestion?.draft && draft.suggested && (
        <div className="text-[13px] text-ink-soft">
          {suggestion.translation && (
            <div className="rounded-md border border-line bg-canvas px-3 py-2">
              <p className="mb-0.5 text-xs font-medium text-ink-faint">
                The suggestion is in{' '}
                {suggestion.language ? languageName(suggestion.language) : 'the guest’s language'}.
                In English:
              </p>
              <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
                {suggestion.translation}
              </p>
            </div>
          )}
          <p className="mt-1 text-xs text-ink-faint">
            {suggestion.source === 'rules'
              ? 'Suggested from the property’s details, without an AI service. '
              : 'A suggested reply. '}
            Read it and change what you like: nothing is sent until you send it.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          aria-label="Use a template"
          icon={<FileText className="size-3.5" aria-hidden />}
          onClick={() => setChoosing(true)}
        >
          <span className="@md:hidden">Template</span>
          <span className="hidden @md:inline">Use a template</span>
        </Button>
        {canSuggest && (
          <Button
            size="sm"
            aria-label="Suggest a reply"
            loading={suggesting}
            icon={<Sparkles className="size-3.5" aria-hidden />}
            onClick={() => void suggest()}
          >
            <span className="@md:hidden">Suggest</span>
            <span className="hidden @md:inline">Suggest a reply</span>
          </Button>
        )}
        {replaced && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Undo2 className="size-3.5" aria-hidden />}
            onClick={putBack}
          >
            Put back what I wrote
          </Button>
        )}
        <span className="ml-auto flex items-center gap-3">
          {!touch && (
            <span id={hintId} className="hidden text-xs text-ink-faint @2xl:inline">
              Enter to send, Shift+Enter for a new line
            </span>
          )}
          <Button
            variant="primary"
            disabled={!body}
            icon={<SendHorizontal className="size-4" aria-hidden />}
            onClick={() => void send()}
          >
            Send
          </Button>
        </span>
      </div>
      {templates}
    </div>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Dismiss"
      onClick={onClick}
      className="-my-0.5 -mr-1 shrink-0 rounded p-1 opacity-70 hover:opacity-100"
    >
      <X className="size-3.5" aria-hidden />
    </button>
  );
}
