'use client';

import { DataTable, type Column } from './data-table';
import { Figure, Figures } from './figures';
import type { ReportFilters } from './filters';
import { rateText, type Formats } from './format';
import { ReportFrame } from './report-frame';
import type { AgentCommission, AgentLine } from './types';

type AgentTotal = AgentCommission['total'];

function AgentsBody({ report, formats }: { report: AgentCommission; formats: Formats }) {
  const { rows, total } = report;
  const columns: Column<AgentLine, AgentTotal>[] = [
    {
      key: 'agent',
      header: 'Travel agent',
      cell: (row) => row.name,
      className: 'max-w-48 min-w-32 sm:max-w-none',
    },
    {
      key: 'rate',
      header: 'Commission rate',
      cell: (row) => rateText(row.commissionBp),
    },
    {
      key: 'bookings',
      header: 'Bookings',
      cell: (row) => formats.count(row.reservations),
      total: (sum) => formats.count(sum.reservations),
    },
    {
      key: 'nights',
      header: 'Room nights',
      cell: (row) => formats.count(row.roomNights),
      total: (sum) => formats.count(sum.roomNights),
    },
    {
      key: 'revenue',
      header: 'Room revenue',
      cell: (row) => formats.money(row.roomRevenue),
      total: (sum) => formats.money(sum.roomRevenue),
    },
    {
      key: 'commission',
      header: 'Commission due',
      cell: (row) => formats.money(row.commission),
      total: (sum) => formats.money(sum.commission),
      className: 'font-medium',
    },
  ];

  return (
    <>
      <Figures columns={3}>
        <Figure
          label="Commission due"
          value={formats.money(total.commission)}
          note="Each agent's rate on the room revenue of their guests."
        />
        <Figure
          label="Room revenue"
          value={formats.money(total.roomRevenue)}
          note="From stays booked by travel agents, before tax."
        />
        <Figure
          label="Room nights"
          value={formats.count(total.roomNights)}
          note={`in ${formats.count(total.reservations)} ${total.reservations === 1 ? 'booking' : 'bookings'}`}
        />
      </Figures>

      <DataTable
        label="Commission by travel agent"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.companyId}
        total={total}
      />
      <p className="text-xs text-ink-faint">
        Commission is earned on nights the guest has stayed: a night counts once the guest has
        checked in, and bookings still to come do not.
      </p>
    </>
  );
}

/** What each travel agent has earned on the stays of a period. */
export function AgentsReport({ filters }: { filters: ReportFilters }) {
  return (
    <ReportFrame<AgentCommission>
      view="agents"
      filters={filters}
      isEmpty={(report) => report.rows.length === 0}
      empty={{
        title: 'No guest of a travel agent stayed in this period',
        description:
          'Commission counts once a guest booked by a travel agent has checked in. Try a longer period, or other properties.',
      }}
    >
      {(report, formats) => <AgentsBody report={report} formats={formats} />}
    </ReportFrame>
  );
}
