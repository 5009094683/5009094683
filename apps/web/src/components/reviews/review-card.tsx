'use client';

import { MessageSquareReply } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Notice } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import {
  MENTION_LABELS,
  MOOD_LABELS,
  MOOD_TONES,
  categoryLabel,
  formatReviewDay,
  formatScore,
  scoreOutOfTen,
  siteName,
  topicLabel,
} from './labels';
import { ReplyEditor } from './reply-editor';
import type { Mood, Review } from './types';

/** Praise first, then what needs attention, then what was only mentioned. */
const MENTION_ORDER: Mood[] = ['positive', 'negative', 'neutral'];

const LONG_REVIEW = 420;

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The one-line summary, when it says something the text beside it does not. Without an AI
 * service the summary is the opening of the review itself, and showing it twice helps nobody.
 */
function summaryOf(review: Review): string | null {
  const summary = review.summary ? flat(review.summary) : '';
  if (!summary) return null;
  return flat(review.content ?? '').startsWith(summary) ? null : summary;
}

function Reply({ review }: { review: Review }) {
  const site = review.channelCode ? siteName(review.channelCode) : 'the booking site';
  return (
    <div className="rounded-md border border-line bg-sunken/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13px] font-medium text-ink">Reply from the property</span>
        {review.replyStatus === 'sent' && (
          <>
            <Badge tone="success">Posted</Badge>
            <span className="text-xs text-ink-faint">
              {review.repliedAt ? formatReviewDay(review.repliedAt) : `Written on ${site} itself`}
            </span>
          </>
        )}
        {review.replyStatus === 'queued' && (
          <>
            <Badge tone="info">Being posted</Badge>
            <span className="text-xs text-ink-faint">On its way to {site}</span>
          </>
        )}
        {review.replyStatus === 'failed' && <Badge tone="danger">Not posted</Badge>}
      </div>
      <p className="mt-1.5 text-sm whitespace-pre-line text-ink-soft">{review.reply}</p>
    </div>
  );
}

/** One review as the guest left it, what was made of it, and the property's reply. */
export function ReviewCard({
  review,
  showProperty,
  onChanged,
}: {
  review: Review;
  showProperty: boolean;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const replyArea = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<'button' | 'area' | null>(null);

  const canReply = auth.can('inbox.write', review.propertyId);
  const answered = review.replyStatus === 'sent' || review.replyStatus === 'queued';
  const summary = summaryOf(review);
  const content = review.content?.trim() ?? '';
  const long = content.length > LONG_REVIEW;

  // The editor leaves the page when it closes; the keyboard carries on from where it stood.
  useEffect(() => {
    const target = returnFocus.current;
    if (editing || !target) return;
    returnFocus.current = null;
    const area = replyArea.current;
    ((target === 'button' && area?.querySelector<HTMLElement>('button')) || area)?.focus();
  }, [editing]);

  /**
   * After a reply is posted the Reply button is about to go, so focus rests on the reply
   * itself rather than on a button that disappears under it.
   */
  const close = (focus: 'button' | 'area') => {
    returnFocus.current = focus;
    setEditing(false);
  };
  const settled = () => {
    close('area');
    onChanged();
  };

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-xl border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold text-ink">
            {review.guestName ?? 'Guest not named'}
          </h3>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            {siteName(review.channelCode)} · {formatReviewDay(review.receivedAt)}
            {showProperty && ` · ${review.propertyName}`}
          </p>
        </div>
        {review.overallScore === null ? (
          <p className="shrink-0 text-[13px] text-ink-faint">No score</p>
        ) : (
          <p className="shrink-0 whitespace-nowrap">
            <span className="sr-only">Score </span>
            <span className="tabular text-xl font-semibold tracking-tight text-ink">
              {scoreOutOfTen(review.overallScore)}
            </span>
            <span aria-hidden className="text-[13px] text-ink-faint">
              {' '}
              / 10
            </span>
            <span className="sr-only"> out of 10</span>
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {review.sentiment ? (
          <Badge tone={MOOD_TONES[review.sentiment]}>
            <span className="sr-only">Mood: </span>
            {MOOD_LABELS[review.sentiment]}
          </Badge>
        ) : (
          <Badge>Being read</Badge>
        )}
        {review.hidden && <Badge tone="warning">Not public yet</Badge>}
        {MENTION_ORDER.map((mood) => {
          const topics = review.topics.filter((topic) => topic.sentiment === mood);
          if (topics.length === 0) return null;
          return (
            <span key={mood} className="flex flex-wrap items-center gap-1 text-xs text-ink-faint">
              {MENTION_LABELS[mood]}
              {topics.map((topic) => (
                <Badge key={topic.topic} tone={MOOD_TONES[mood]}>
                  {topicLabel(topic.topic)}
                </Badge>
              ))}
            </span>
          );
        })}
      </div>
      {review.hidden && (
        <p className="mt-1.5 text-xs text-ink-faint">
          {siteName(review.channelCode)} shows this review to the public only once the host has
          reviewed the guest.
        </p>
      )}

      {summary && <p className="mt-3 text-sm font-medium text-ink">{summary}</p>}
      {content ? (
        <p
          className={cn(
            'text-sm whitespace-pre-line text-ink-soft',
            summary ? 'mt-1' : 'mt-3',
            long && !expanded && 'line-clamp-4',
          )}
        >
          {content}
        </p>
      ) : (
        <p className="mt-3 text-sm text-ink-faint">The guest gave a score and wrote nothing.</p>
      )}
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1 text-[13px] font-medium text-brand-700 hover:underline"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show the whole review'}
        </button>
      )}

      {(review.scores.length > 0 || review.reservationId || review.otaReservationCode) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-ink-faint">
          <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
            {review.scores.map((entry) => (
              <li key={entry.category}>
                {categoryLabel(entry.category)}{' '}
                <span className="tabular font-medium text-ink-soft">
                  {formatScore(entry.score)}
                </span>
              </li>
            ))}
          </ul>
          {review.reservationId && auth.can('reservations.read', review.propertyId) ? (
            <Link
              href={`/reservations/${review.reservationId}`}
              className="text-[13px] font-medium text-brand-700 hover:underline"
            >
              Open the reservation
            </Link>
          ) : (
            review.otaReservationCode && <span>Booking reference {review.otaReservationCode}</span>
          )}
        </div>
      )}

      <div ref={replyArea} tabIndex={-1} className="mt-3 flex flex-col gap-2 outline-none">
        {editing && !answered ? (
          <ReplyEditor
            review={review}
            canSuggest={auth.can('ai.use', review.propertyId)}
            onCancel={() => close('button')}
            onPosted={settled}
            onStale={settled}
          />
        ) : (
          <>
            {review.reply && <Reply review={review} />}
            {review.replyStatus === 'failed' && (
              <Notice tone="danger" title="The reply could not be posted">
                {review.replyError ?? 'The booking site did not take it.'}{' '}
                {canReply
                  ? 'Change it and try again, or answer on the booking site itself.'
                  : 'It can be answered on the booking site itself.'}
              </Notice>
            )}
            {!answered &&
              (review.connectionId === null ? (
                <p className="text-[13px] text-ink-faint">
                  The connection this review came through no longer exists, so it can only be
                  answered on the booking site itself.
                </p>
              ) : (
                canReply && (
                  <Button
                    size="sm"
                    className="self-start"
                    icon={<MessageSquareReply className="size-3.5" />}
                    onClick={() => setEditing(true)}
                  >
                    {review.replyStatus === 'failed' ? 'Change and try again' : 'Reply'}
                  </Button>
                )
              ))}
          </>
        )}
      </div>
    </article>
  );
}
