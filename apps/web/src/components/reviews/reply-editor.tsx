'use client';

import { Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { calmErrorMessage } from '@/components/assistant/errors';
import { useReturnFocus } from '@/components/assistant/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { siteName } from './labels';
import type { DraftReply, Review, ReviewRow } from './types';

const MAX_REPLY = 4000;

interface Suggestion {
  source: DraftReply['source'];
  draft: string;
  /** What the person had written themselves when the suggestion took its place. */
  replaced: string | null;
}

/** Where a property writes its one public reply to a review. */
export function ReplyEditor({
  review,
  canSuggest,
  onPosted,
  onCancel,
  onStale,
}: {
  review: Review;
  canSuggest: boolean;
  onPosted: () => void;
  onCancel: () => void;
  /** The review turned out to be answered already: what is on screen is out of date. */
  onStale: () => void;
}) {
  const toast = useToast();
  const site = review.channelCode ? siteName(review.channelCode) : 'the booking site';
  const [text, setText] = useState(review.replyStatus === 'failed' ? (review.reply ?? '') : '');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const rememberOpener = useReturnFocus(confirming);
  const [stale, setStale] = useState(false);
  const reply = text.trim();

  const suggest = async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const answer = await api<DraftReply>(`/reviews/${review.id}/draft-reply`, { method: 'POST' });
      const draft = answer.draft.slice(0, MAX_REPLY);
      const own = reply !== '' && text !== suggestion?.draft && reply !== draft.trim();
      setSuggestion({ source: answer.source, draft, replaced: own ? text : null });
      setText(draft);
    } catch (err) {
      setSuggestError(calmErrorMessage(err));
    } finally {
      setSuggesting(false);
    }
  };

  const post = useAction(async () => {
    try {
      await api<ReviewRow>(`/reviews/${review.id}/reply`, {
        method: 'POST',
        body: { text: reply },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setStale(true);
      throw err;
    }
    toast.success(`Reply sent to ${site}`, 'It shows as posted here once the site has taken it.');
    onPosted();
  });

  const closeConfirmation = () => {
    if (post.busy) return;
    setConfirming(false);
    post.clearError();
    if (stale) onStale();
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reply) return;
        rememberOpener();
        setConfirming(true);
      }}
    >
      <Field
        label={`Reply to ${review.guestName ?? 'the guest'}`}
        hint={`Shown under the review on ${site} for anyone to read. One reply per review.`}
      >
        {(props) => (
          <Textarea
            {...props}
            autoFocus
            rows={6}
            maxLength={MAX_REPLY}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="field-sizing-content max-h-96"
          />
        )}
      </Field>
      {text.length > MAX_REPLY - 400 && (
        <p className="tabular text-xs text-ink-faint">
          {text.length.toLocaleString('en-GB')} of {MAX_REPLY.toLocaleString('en-GB')} characters
        </p>
      )}
      {suggestion && text === suggestion.draft && (
        <p className="text-[13px] text-ink-soft">
          {suggestion.source === 'rules'
            ? 'Suggested from a standard wording, as no AI service is configured. Read it through and make it yours before posting.'
            : 'Suggested by the AI service from what the guest wrote. It can be wrong: read it through and correct it before posting.'}
        </p>
      )}
      {suggestion?.replaced && (
        <p className="text-[13px] text-ink-soft">
          The suggestion took the place of what you had written.{' '}
          <button
            type="button"
            className="font-medium text-brand-700 hover:underline"
            onClick={() => {
              setText(suggestion.replaced ?? '');
              setSuggestion(null);
            }}
          >
            Put my text back
          </button>
        </p>
      )}
      {suggestError && <Notice tone="warning">{suggestError}</Notice>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {canSuggest ? (
          <Button
            size="sm"
            icon={<Lightbulb className="size-3.5" />}
            loading={suggesting}
            onClick={() => void suggest()}
          >
            {suggestion ? 'Suggest again' : 'Suggest a reply'}
          </Button>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!reply}>
            Post reply
          </Button>
        </span>
      </div>

      <Dialog
        open={confirming}
        onClose={closeConfirmation}
        size="sm"
        title="Post this reply?"
        footer={
          stale ? (
            <Button onClick={closeConfirmation}>Close</Button>
          ) : (
            <>
              <Button onClick={closeConfirmation} disabled={post.busy}>
                Cancel
              </Button>
              <Button variant="primary" loading={post.busy} onClick={() => void post.run()}>
                Post reply
              </Button>
            </>
          )
        }
      >
        <div className="flex flex-col gap-3 text-sm text-ink-soft">
          <p>
            {review.channelCode ? siteName(review.channelCode) : 'A booking site'} takes one reply
            per review, and the reply is public: it stays under the review for anyone to read. Once
            posted it cannot be changed or taken back from here.
          </p>
          <blockquote className="scrollbar-thin max-h-48 overflow-y-auto rounded-md border border-line bg-sunken/60 px-3 py-2 whitespace-pre-line text-ink">
            {reply}
          </blockquote>
          {post.error && <Notice tone="danger">{post.error}</Notice>}
        </div>
      </Dialog>
    </form>
  );
}
