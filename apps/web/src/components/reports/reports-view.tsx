'use client';

import { Suspense } from 'react';
import { ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { useProperties } from '@/lib/hooks';
import { AgentsReport } from './agents-report';
import { useReportFilters, type ReportFilters } from './filters';
import { NoAccess } from './no-access';
import { PaceReport } from './pace-report';
import { PerformanceReport } from './performance-report';
import { ReportTabs } from './report-tabs';
import { SchedulesView } from './schedules-view';
import { SourcesReport } from './sources-report';
import { TakingsReport } from './takings-report';

function OpenView({ filters }: { filters: ReportFilters }) {
  switch (filters.view) {
    case 'performance':
      return <PerformanceReport filters={filters} />;
    case 'sources':
      return <SourcesReport filters={filters} />;
    case 'pace':
      return <PaceReport filters={filters} />;
    case 'takings':
      return <TakingsReport filters={filters} />;
    case 'agents':
      return <AgentsReport filters={filters} />;
    case 'schedules':
      return <SchedulesView offered={filters.offered} />;
  }
}

function Reports() {
  const auth = useAuth();
  const { properties, error, isLoading, mutate } = useProperties();
  // A role for particular properties is offered those and no others, as the server would allow.
  const offered = properties.filter((p) => auth.can('reports.read', p.id));
  const filters = useReportFilters(offered);

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader
        title="Reports"
        description="How the rooms are selling, where bookings come from and what has been taken."
      />
      <ReportTabs filters={filters} />
      {error && properties.length === 0 ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading ? (
        <PageLoading />
      ) : (
        <OpenView filters={filters} />
      )}
    </div>
  );
}

/** The reports and the emails that send them. The view and its filters are kept in the address. */
export function ReportsView() {
  const auth = useAuth();
  if (!auth.can('reports.read')) return <NoAccess />;
  return (
    <Suspense fallback={<PageLoading />}>
      <Reports />
    </Suspense>
  );
}
