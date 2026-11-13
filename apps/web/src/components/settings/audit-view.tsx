'use client';

import { ScrollText } from 'lucide-react';
import { useId, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import {
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { errorMessage, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { plural } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { AuditTable, type AuditPage } from './audit-table';
import { NoAccess } from './no-access';

const PAGE_SIZE = 50;

/** Suggestions only: the filter accepts any entity type the trail contains. */
const ENTITY_TYPES = [
  'block',
  'guest',
  'oidc_provider',
  'organization',
  'property',
  'rate_plan',
  'reservation',
  'room_type',
  'unit',
  'user',
];

/**
 * The instant a calendar day starts or ends in the viewer's time zone, in the
 * form the API takes. Undefined for a date that is still being typed.
 */
function dayBoundary(day: string, boundary: 'start' | 'end'): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < '1900-01-01') return undefined;
  const date = new Date(`${day}T${boundary === 'start' ? '00:00:00' : '23:59:59.999'}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function AuditTrail() {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const actionsId = useId();
  const entityTypesId = useId();

  const filtered = action.trim() !== '' || entityType.trim() !== '' || from !== '' || to !== '';
  const clear = () => {
    setAction('');
    setEntityType('');
    setFrom('');
    setTo('');
  };

  const search = useDebounced(
    query({
      actionPrefix: action.trim(),
      entityType: entityType.trim(),
      from: dayBoundary(from, 'start'),
      to: dayBoundary(to, 'end'),
      limit: PAGE_SIZE,
    }),
    300,
  );

  const { data, error, isValidating, size, setSize, mutate } = useSWRInfinite<AuditPage>(
    (_index: number, previous: AuditPage | null) => {
      if (previous && previous.nextBeforeId === null) return null;
      return `/audit${search}${previous ? `&beforeId=${previous.nextBeforeId}` : ''}`;
    },
    { keepPreviousData: false },
  );

  // While other filters load, the last results stay on screen, dimmed. They are dropped when
  // that load fails, because they answer a different question than the filters now ask.
  const [lastPages, setLastPages] = useState<AuditPage[]>();
  if (data && data !== lastPages) setLastPages(data);
  const pages = data ?? (error ? undefined : lastPages);
  const stale = !data && pages !== undefined;

  const entries = pages?.flatMap((page) => page.entries) ?? [];
  const lastPage = pages?.at(-1);
  const hasMore = lastPage !== undefined && lastPage.nextBeforeId !== null;
  // The next page has been asked for and has not arrived: it is on its way, or it failed.
  const awaitingMore = hasMore && data !== undefined && data.length < size;
  // After a failure the same page is asked for again, not the one after it.
  const loadMore = () => void setSize(awaitingMore ? size : size + 1);
  const noun = filtered
    ? plural(entries.length, 'matching entry', 'matching entries')
    : plural(entries.length, 'entry', 'entries');

  const actions = [...new Set(entries.map((entry) => entry.action))].sort();
  const entityTypes = [
    ...new Set([...ENTITY_TYPES, ...entries.map((entry) => entry.entityType)]),
  ].sort();

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader title="Audit trail" description="Who changed what, newest first." />

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Action starts with">
            {(props) => (
              <Input
                {...props}
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="reservation."
                maxLength={60}
                list={actionsId}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Entity type">
            {(props) => (
              <Input
                {...props}
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                placeholder="reservation"
                maxLength={60}
                list={entityTypesId}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="From">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="To"
            error={from !== '' && to !== '' && to < from ? 'This is before the from date.' : null}
          >
            {(props) => (
              <Input
                {...props}
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            )}
          </Field>
        </div>
        <datalist id={actionsId}>
          {actions.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <datalist id={entityTypesId}>
          {entityTypes.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-ink-faint">
            The entity type must match exactly. Dates are in your own time zone.
          </p>
          {filtered && (
            <Button size="sm" onClick={clear}>
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      {!pages ? (
        error ? (
          <ErrorState error={error} onRetry={() => void mutate()} />
        ) : (
          <PageLoading />
        )
      ) : entries.length === 0 ? (
        <Card aria-busy={stale}>
          {filtered ? (
            <EmptyState
              icon={<ScrollText className="size-5" />}
              title="No entries match these filters"
              action={<Button onClick={clear}>Clear filters</Button>}
            />
          ) : (
            <EmptyState
              icon={<ScrollText className="size-5" />}
              title="Nothing has been recorded yet"
              description="Changes made by users and by the system are listed here."
            />
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <AuditTable entries={entries} stale={stale} />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line px-4 py-3">
            {error && (
              <Notice tone="danger" className="w-full">
                {awaitingMore
                  ? 'Older entries could not be loaded'
                  : 'The list could not be refreshed'}
                : {errorMessage(error)}
              </Notice>
            )}
            <p className="text-[13px] text-ink-soft" aria-live="polite">
              {hasMore ? `Showing the most recent ${noun}.` : `${noun}, all shown.`}
            </p>
            {hasMore && (
              <Button loading={awaitingMore && isValidating} onClick={loadMore}>
                {awaitingMore && error ? 'Try again' : 'Load more'}
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

export function AuditView() {
  const auth = useAuth();
  return auth.can('audit.read') ? <AuditTrail /> : <NoAccess />;
}
