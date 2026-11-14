'use client';

import { ChevronDown, RefreshCw, Star } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { addDays } from '@pms/domain/shared';
import { isRateLimited } from '@/components/assistant/errors';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Segmented, Select } from '@/components/ui/field';
import {
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  PageLoading,
  Popover,
  Spinner,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { plural } from '@/lib/format';
import { useCurrentProperty, useProperties } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { Property } from '@/lib/types';
import { MOODS, MOOD_LABELS } from './labels';
import { NoAccess } from './no-access';
import { ReviewCard } from './review-card';
import { ReviewFigures } from './review-figures';
import type { Mood, Review, ReviewInsights } from './types';

const LIST_LIMIT = 200;

/** A review being read, or a reply on its way to the booking site, settles within moments. */
const SETTLING_POLL_MS = 3000;

/** Reviews asked for from the booking sites arrive through the worker a little later. */
const ARRIVAL_CHECKS_MS = [2500, 6000, 12000];

const MOOD_OPTIONS: { value: Mood | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  ...MOODS.map((mood) => ({ value: mood, label: MOOD_LABELS[mood] })),
];

const DATE_LABEL =
  'flex flex-col gap-1 text-[13px] font-medium text-ink-soft sm:flex-row sm:items-center sm:gap-1.5';

const isReviewsKey = (key: unknown): boolean =>
  typeof key === 'string' && key.startsWith('/reviews');

/**
 * Reviews are fetched one property at a time. With every property on screen the person says
 * which one; a plain select copes with three properties as well as with eighty.
 */
function FetchChooser({
  properties,
  busy,
  onFetch,
}: {
  properties: Property[];
  busy: boolean;
  onFetch: (property: Property) => void;
}) {
  const { property: current } = useCurrentProperty();
  const [open, setOpen] = useState(false);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen =
    properties.find((p) => p.id === chosenId) ??
    properties.find((p) => p.id === current?.id) ??
    properties[0];

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-72"
      trigger={
        <Button icon={<RefreshCw className="size-4" />} loading={busy}>
          Fetch new reviews
          <ChevronDown className="size-3.5 text-ink-faint" aria-hidden />
        </Button>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setOpen(false);
          if (chosen) onFetch(chosen);
        }}
      >
        <Field label="From the booking sites of">
          {(props) => (
            <Select
              {...props}
              value={chosen?.id ?? ''}
              onChange={(event) => setChosenId(event.target.value)}
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="primary" className="self-end">
          Fetch
        </Button>
      </form>
    </Popover>
  );
}

function Reviews({ properties }: { properties: Property[] }) {
  const auth = useAuth();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [propertyId, setPropertyId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [mood, setMood] = useState<Mood | 'all'>('all');
  const [waiting, setWaiting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [looking, setLooking] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const property = properties.find((p) => p.id === propertyId);
  // A range typed backwards is read the way it was meant.
  const [first, last] = from && to && from > to ? [to, from] : [from, to];
  const range = {
    propertyIds: property ? [property.id] : undefined,
    from: first || undefined,
    // The server's `to` is the first day left out.
    to: last ? addDays(last, 1) : undefined,
  };

  const list = useSWR<{ reviews: Review[] }>(
    `/reviews${query({
      ...range,
      sentiment: mood === 'all' ? undefined : mood,
      unanswered: waiting ? 'true' : undefined,
      limit: LIST_LIMIT,
    })}`,
    {
      // Should an announcement be missed, what is still settling is asked for again.
      refreshInterval: (data) =>
        data?.reviews.some((r) => r.replyStatus === 'queued' || r.analysedAt === null)
          ? SETTLING_POLL_MS
          : 0,
    },
  );
  const settling = list.data?.reviews.some(
    (r) => r.replyStatus === 'queued' || r.analysedAt === null,
  );
  const insights = useSWR<ReviewInsights>(`/reviews/insights${query(range)}`, {
    refreshInterval: settling ? SETTLING_POLL_MS : 0,
  });

  const refresh = () => void mutate(isReviewsKey);
  // New reviews, their reading and the fate of a reply are announced by the server.
  useLive(/^review\./, refresh);

  const fetchNew = async (target: Property) => {
    if (fetching) return;
    setFetching(true);
    try {
      const { queued } = await api<{ queued: number }>(`/properties/${target.id}/reviews/refresh`, {
        method: 'POST',
      });
      if (queued === 0) {
        toast.info(
          `${target.name} is not connected to the booking sites`,
          'Reviews arrive through the channel manager connection, which is set up under Channels.',
        );
        return;
      }
      toast.info(
        `Asked the booking sites of ${target.name}`,
        'New reviews show here within moments.',
      );
      setLooking(true);
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
      ARRIVAL_CHECKS_MS.forEach((delay, index) => {
        const timer = window.setTimeout(() => {
          timers.current.delete(timer);
          refresh();
          if (index === ARRIVAL_CHECKS_MS.length - 1) setLooking(false);
        }, delay);
        timers.current.add(timer);
      });
    } catch (err) {
      if (isRateLimited(err)) {
        toast.info(
          'New reviews can be fetched a few times a minute',
          'Wait a minute, then try again.',
        );
      } else {
        toast.error(err);
      }
    } finally {
      setFetching(false);
    }
  };

  const showWaiting = () => {
    setMood('all');
    setWaiting(true);
    listHeading.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    listHeading.current?.focus({ preventScroll: true });
  };

  const fetchTargets = property ? [property] : properties;
  const reviews = list.data?.reviews ?? [];
  const nothing = insights.data?.count === 0 && reviews.length === 0;
  const narrowed = mood !== 'all' || waiting;

  return (
    <div className="mx-auto flex max-w-6xl flex-col p-4 sm:p-6">
      <PageHeader
        title="Reviews"
        description="What guests wrote on the booking sites, and what the property answered."
        actions={
          fetchTargets.length === 1 ? (
            <Button
              icon={<RefreshCw className="size-4" />}
              loading={fetching}
              onClick={() => void fetchNew(fetchTargets[0]!)}
            >
              Fetch new reviews
            </Button>
          ) : (
            fetchTargets.length > 1 && (
              <FetchChooser
                properties={fetchTargets}
                busy={fetching}
                onFetch={(target) => void fetchNew(target)}
              />
            )
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        {properties.length > 1 && (
          <Select
            aria-label="Property"
            value={property?.id ?? ''}
            onChange={(event) => setPropertyId(event.target.value)}
            className="w-full sm:w-auto"
          >
            <option value="">All properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <div className="grid w-full grid-cols-2 gap-x-3 sm:flex sm:w-auto sm:items-center">
          <label className={DATE_LABEL}>
            From
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
              className="sm:w-auto"
            />
          </label>
          <label className={DATE_LABEL}>
            To
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
              className="sm:w-auto"
            />
          </label>
        </div>
        {(from || to) && (
          <Button
            variant="ghost"
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            All dates
          </Button>
        )}
        {looking && (
          <span className="flex items-center gap-1.5 text-[13px] text-ink-soft">
            <Spinner label="Looking for new reviews" /> Looking for new reviews…
          </span>
        )}
      </div>

      {insights.error ? (
        <Card>
          <ErrorState error={insights.error} onRetry={refresh} />
        </Card>
      ) : !insights.data ? (
        <PageLoading />
      ) : nothing ? (
        <Card>
          <EmptyState
            icon={<Star className="size-5" />}
            title={
              from || to
                ? 'No reviews in these dates'
                : property
                  ? `No reviews for ${property.name} yet`
                  : 'No reviews yet'
            }
            description={
              from || to
                ? 'Guests may have written earlier or later than this.'
                : 'Reviews come in through the channel manager connection: once a property is connected to the booking sites, what its guests write there arrives here by itself. "Fetch new reviews" asks for them straight away.'
            }
            action={
              from || to ? (
                <Button
                  onClick={() => {
                    setFrom('');
                    setTo('');
                  }}
                >
                  Show all dates
                </Button>
              ) : (
                auth.can('channels.read') && (
                  <Link
                    href="/channels"
                    className="text-sm font-medium text-brand-700 hover:underline"
                  >
                    See the booking site connections
                  </Link>
                )
              )
            }
          />
        </Card>
      ) : (
        <>
          <ReviewFigures insights={insights.data} onShowWaiting={showWaiting} />

          <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2
              ref={listHeading}
              tabIndex={-1}
              className="scroll-mt-4 text-base font-semibold text-ink outline-none"
            >
              What guests wrote
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Segmented label="Mood" value={mood} onChange={setMood} options={MOOD_OPTIONS} />
              <Checkbox
                label="Waiting for a reply"
                checked={waiting}
                onChange={(event) => setWaiting(event.target.checked)}
              />
            </div>
          </div>

          {list.error ? (
            <Card>
              <ErrorState error={list.error} onRetry={() => void list.mutate()} />
            </Card>
          ) : !list.data ? (
            <PageLoading />
          ) : reviews.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Star className="size-5" />}
                title={
                  waiting && mood === 'all'
                    ? 'No review is waiting for a reply'
                    : 'No reviews match'
                }
                action={
                  narrowed && (
                    <Button
                      onClick={() => {
                        setMood('all');
                        setWaiting(false);
                      }}
                    >
                      Show all reviews
                    </Button>
                  )
                }
              />
            </Card>
          ) : (
            <>
              <ul className="flex flex-col gap-3">
                {reviews.map((review) => (
                  <li key={review.id}>
                    <ReviewCard
                      review={review}
                      showProperty={properties.length > 1 && !property}
                      onChanged={refresh}
                    />
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[13px] text-ink-faint">
                {reviews.length === LIST_LIMIT
                  ? `These are the latest ${LIST_LIMIT}. Narrow the dates to see earlier ones.`
                  : plural(reviews.length, 'review')}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function ReviewsView() {
  const auth = useAuth();
  const { properties, error, isLoading, mutate } = useProperties();
  if (!auth.can('reports.read')) return <NoAccess />;
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading) return <PageLoading />;
  return <Reviews properties={properties.filter((p) => auth.can('reports.read', p.id))} />;
}
