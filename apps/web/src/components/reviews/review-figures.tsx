'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { MOODS, MOOD_LABELS, formatReviewMonth, formatScore, siteName, topicLabel } from './labels';
import type { Mood, ReviewInsights } from './types';

const MOOD_BARS: Record<Mood, string> = {
  positive: 'bg-success-500',
  neutral: 'bg-line-strong',
  negative: 'bg-danger-500',
};

const MONTHS_SHOWN = 12;

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <dt className="text-[13px] font-medium text-ink-soft">{label}</dt>
      <dd className="flex flex-1 flex-col gap-1">{children}</dd>
    </Card>
  );
}

function Big({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('tabular text-2xl font-semibold tracking-tight text-ink', className)}>
      {children}
    </span>
  );
}

/**
 * A bar split by mood, `width` of its track long. Decoration only: the numbers beside it
 * say the same in words.
 */
function MoodBar({ counts, width = '100%' }: { counts: Record<Mood, number>; width?: string }) {
  return (
    <span aria-hidden className="block h-2 rounded-full bg-sunken">
      <span className="flex h-full overflow-hidden rounded-full" style={{ width }}>
        {MOODS.map(
          (mood) =>
            counts[mood] > 0 && (
              <span key={mood} className={MOOD_BARS[mood]} style={{ flexGrow: counts[mood] }} />
            ),
        )}
      </span>
    </span>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-ink-soft">{description}</p>}
      <div className="mt-3">{children}</div>
    </Card>
  );
}

const share = (part: number, whole: number): string => `${whole > 0 ? (part / whole) * 100 : 0}%`;

/** The figures over the reviews the property and date filters select. */
export function ReviewFigures({
  insights,
  onShowWaiting,
}: {
  insights: ReviewInsights;
  onShowWaiting: () => void;
}) {
  const { count, averageScore, sentiment, unanswered } = insights;
  const read = MOODS.reduce((sum, mood) => sum + sentiment[mood], 0);
  // The server lists criticism first; "mentioned most" is the order the heading promises.
  const topics = insights.topics
    .map((topic) => ({ ...topic, total: topic.positive + topic.neutral + topic.negative }))
    .sort((a, b) => b.total - a.total || b.negative - a.negative);
  const mostMentions = Math.max(1, ...topics.map((topic) => topic.total));
  const months = insights.trend.slice(-MONTHS_SHOWN);
  const busiestMonth = Math.max(1, ...months.map((entry) => entry.count));

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure label="Reviews">
          <Big>{count}</Big>
        </Figure>
        <Figure label="Average score">
          {averageScore === null ? (
            <>
              <Big className="text-ink-faint">–</Big>
              <span className="text-[13px] text-ink-soft">No review carried a score</span>
            </>
          ) : (
            <span>
              <Big>{formatScore(averageScore)}</Big>
              <span className="text-[13px] text-ink-soft"> out of 10</span>
            </span>
          )}
        </Figure>
        <Figure label="Mood">
          <span className="mt-2">
            <MoodBar counts={sentiment} />
          </span>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-ink-soft">
            {MOODS.map((mood) => (
              <li key={mood} className="flex items-center gap-1.5">
                <span aria-hidden className={cn('size-2 rounded-full', MOOD_BARS[mood])} />
                <span className="tabular font-medium text-ink">{sentiment[mood]}</span>
                {MOOD_LABELS[mood].toLowerCase()}
              </li>
            ))}
          </ul>
          {read < count && (
            <span className="text-[13px] text-ink-faint">{count - read} still being read</span>
          )}
        </Figure>
        <Figure label="Waiting for a reply">
          <Big className={unanswered > 0 ? 'text-warning-700' : undefined}>{unanswered}</Big>
          {unanswered > 0 ? (
            <Button size="sm" className="self-start" onClick={onShowWaiting}>
              Show {unanswered === 1 ? 'it' : 'them'}
            </Button>
          ) : (
            <span className="text-[13px] text-ink-soft">Every review has a reply</span>
          )}
        </Figure>
      </dl>

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel
          title="What guests mention most"
          description="How often each subject was praised and how often criticised."
        >
          {topics.length === 0 ? (
            <p className="text-[13px] text-ink-soft">
              No subject has been picked out of these reviews yet.
            </p>
          ) : (
            <>
              <ul className="flex flex-col gap-2.5">
                {topics.map((topic) => (
                  <li key={topic.topic}>
                    <div className="flex items-baseline justify-between gap-2 text-[13px]">
                      <span className="font-medium text-ink">{topicLabel(topic.topic)}</span>
                      <span className="tabular text-ink-soft">
                        {[
                          topic.positive > 0 && `${topic.positive} praise`,
                          topic.negative > 0 && `${topic.negative} criticism`,
                          topic.neutral > 0 && `${topic.neutral} neither`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </div>
                    <div className="mt-1">
                      <MoodBar counts={topic} width={share(topic.total, mostMentions)} />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-faint">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2 rounded-full bg-success-500" /> Praise
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2 rounded-full bg-danger-500" /> Criticism
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2 rounded-full bg-line-strong" /> Neither
                </span>
              </p>
            </>
          )}
        </Panel>

        <Panel title="By booking site">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-xs text-ink-faint">
                <th scope="col" className="pb-1.5 font-medium">
                  Booking site
                </th>
                <th scope="col" className="pb-1.5 text-right font-medium">
                  Reviews
                </th>
                <th scope="col" className="pb-1.5 text-right font-medium">
                  Average score
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {insights.byChannel.map((site) => (
                <tr key={site.channelCode ?? ''}>
                  <th scope="row" className="py-1.5 font-medium text-ink">
                    {siteName(site.channelCode)}
                  </th>
                  <td className="tabular py-1.5 text-right text-ink-soft">{site.count}</td>
                  <td className="tabular py-1.5 text-right text-ink">
                    {site.averageScore === null ? '–' : formatScore(site.averageScore)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel
          title="By month"
          description={
            insights.trend.length > MONTHS_SHOWN
              ? `The latest ${MONTHS_SHOWN} of ${insights.trend.length} months.`
              : undefined
          }
        >
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-xs text-ink-faint">
                <th scope="col" className="pb-1.5 font-medium">
                  Month
                </th>
                <th scope="col" className="w-full pb-1.5 pl-3 font-medium">
                  Reviews
                </th>
                <th scope="col" className="pb-1.5 text-right font-medium whitespace-nowrap">
                  Average score
                </th>
              </tr>
            </thead>
            <tbody>
              {months.map((entry) => (
                <tr key={entry.month}>
                  <th scope="row" className="py-1 font-medium whitespace-nowrap text-ink">
                    {formatReviewMonth(entry.month)}
                  </th>
                  <td className="py-1 pl-3">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="h-2 min-w-1 rounded-full bg-brand-400"
                        style={{ width: share(entry.count, busiestMonth * 1.25) }}
                      />
                      <span className="tabular text-ink-soft">{entry.count}</span>
                    </span>
                  </td>
                  <td className="tabular py-1 text-right text-ink">
                    {entry.averageScore === null ? '–' : formatScore(entry.averageScore)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
