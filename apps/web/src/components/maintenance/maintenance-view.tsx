'use client';

import { Plus, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { useReturnFocus } from '@/components/housekeeping/focus';
import { Button } from '@/components/ui/button';
import { Segmented, Select } from '@/components/ui/field';
import { EmptyState, ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useProperties } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { IssueDrawer } from './issue-drawer';
import { IssueList } from './issue-list';
import { NoAccess } from './no-access';
import { ReportDialog } from './report-dialog';
import type { Issue, StatusFilter } from './types';

const ALL = 'all';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
];

const EMPTY: Record<StatusFilter, { title: string; description: string }> = {
  open: { title: 'Nothing needs fixing', description: 'Issues that are reported show here.' },
  done: { title: 'No finished issues', description: 'Resolved and closed issues show here.' },
  all: { title: 'No issues yet', description: 'Issues that are reported show here.' },
};

/** What needs fixing across the properties, and the rooms that are off sale because of it. */
export function MaintenanceView() {
  const auth = useAuth();
  const allowed = auth.can('housekeeping.read');
  const {
    properties,
    isLoading: propertiesLoading,
    error: propertiesError,
    mutate: reloadProperties,
  } = useProperties();
  const [propertyId, setPropertyId] = useState(ALL);
  const [status, setStatus] = useState<StatusFilter>('open');
  const [reporting, setReporting] = useState(false);
  const [opened, setOpened] = useState<Issue | null>(null);
  const rememberOpener = useReturnFocus(reporting || opened !== null);
  const report = () => {
    rememberOpener();
    setReporting(true);
  };

  const byId = useMemo(() => new Map(properties.map((p) => [p.id, p])), [properties]);
  const visible = properties.filter((p) => p.active && auth.can('housekeeping.read', p.id));
  const writable = visible.filter((p) => auth.can('maintenance.write', p.id));
  // A property that has since closed, or that the user lost, falls back to all.
  const filter = visible.some((p) => p.id === propertyId) ? propertyId : ALL;

  const { data, error, isLoading, mutate } = useSWR<{ issues: Issue[] }>(
    allowed
      ? `/maintenance${query({ propertyIds: filter === ALL ? undefined : filter, status })}`
      : null,
    // Issues kept from another filter would stay on screen, unexplained, if this request failed.
    { keepPreviousData: false },
  );
  useLive(/^task\./, () => void mutate());

  if (!allowed) return <NoAccess />;

  const issues = data?.issues ?? [];
  // The drawer keeps showing its issue even when a change takes it off the list behind it.
  const current = opened ? (issues.find((i) => i.id === opened.id) ?? opened) : null;
  // Without the properties an issue cannot say where it is, so that failure counts as well.
  const failure = error && !data ? error : properties.length === 0 ? propertiesError : undefined;

  return (
    <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
      <PageHeader
        title="Maintenance"
        description="What needs fixing, and the rooms that are off sale because of it."
        actions={
          writable.length > 0 && (
            <Button
              variant="primary"
              icon={<Plus className="size-4" aria-hidden />}
              onClick={report}
            >
              Report an issue
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {visible.length > 1 && (
          <Select
            aria-label="Property"
            value={filter}
            onChange={(event) => setPropertyId(event.target.value)}
            className="w-auto max-w-full"
          >
            <option value={ALL}>All properties</option>
            {visible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <Segmented label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
      </div>

      {failure ? (
        <ErrorState
          error={failure}
          onRetry={() => {
            void reloadProperties();
            void mutate();
          }}
        />
      ) : isLoading || propertiesLoading || !data ? (
        <PageLoading label="Loading issues" />
      ) : issues.length === 0 ? (
        <EmptyState
          icon={<Wrench className="size-5" />}
          title={EMPTY[status].title}
          description={EMPTY[status].description}
          action={
            writable.length > 0 &&
            status !== 'done' && <Button onClick={report}>Report an issue</Button>
          }
        />
      ) : (
        <IssueList
          issues={issues}
          properties={byId}
          onOpen={(issue) => {
            rememberOpener();
            setOpened(issue);
          }}
        />
      )}

      {reporting && (
        <ReportDialog
          properties={writable}
          propertyId={filter === ALL ? undefined : filter}
          onClose={() => setReporting(false)}
          onSaved={() => void mutate()}
        />
      )}
      {current && (
        <IssueDrawer
          key={current.id}
          issue={current}
          property={byId.get(current.propertyId)}
          canWrite={auth.can('maintenance.write', current.propertyId)}
          onClose={() => setOpened(null)}
          onSaved={() => void mutate()}
        />
      )}
    </div>
  );
}
