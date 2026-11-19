'use client';

import { sourceName } from '@pms/domain/shared';
import { Card } from '@/components/ui/misc';
import { plural } from '@/lib/format';
import { DataTable, type Column } from './data-table';
import { Figure, Figures } from './figures';
import type { ReportFilters } from './filters';
import type { Formats } from './format';
import { ReportFrame } from './report-frame';
import { ShareBar, SourceDot, sourceFills } from './share-bar';
import type { ChannelMix, ChannelMixLine, ChannelMixTotal } from './types';

function SourcesBody({ report, formats }: { report: ChannelMix; formats: Formats }) {
  const { rows, total } = report;
  const fills = sourceFills(rows);
  const shares = rows.map((row) => ({
    key: row.key,
    name: sourceName(row.key),
    basisPoints: row.revenueShareBp ?? 0,
    text: formats.percent(row.revenueShareBp),
    fill: fills.get(row.key)!,
  }));

  const columns: Column<ChannelMixLine, ChannelMixTotal>[] = [
    {
      key: 'source',
      header: 'Source',
      cell: (row) => (
        <span className="flex items-center gap-2">
          <SourceDot fill={fills.get(row.key)!} />
          {sourceName(row.key)}
        </span>
      ),
      className: 'whitespace-nowrap',
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
      header: 'Commission',
      cell: (row) => formats.money(row.commission),
      total: (sum) => formats.money(sum.commission),
    },
    {
      key: 'net',
      header: 'Revenue after commission',
      cell: (row) => formats.money(row.netRevenue),
      total: (sum) => formats.money(sum.netRevenue),
      className: 'min-w-28',
    },
    {
      key: 'adr',
      header: 'Average rate (ADR)',
      cell: (row) => formats.money(row.adr),
      total: (sum) => formats.money(sum.adr),
      className: 'min-w-28',
    },
    {
      key: 'share',
      header: 'Share of revenue',
      cell: (row) => formats.percent(row.revenueShareBp),
      total: (sum) => formats.percent(sum.revenueShareBp),
      className: 'min-w-24',
    },
    {
      key: 'lead',
      header: 'Days booked ahead',
      cell: (row) => formats.average(row.avgLeadDays),
      total: (sum) => formats.average(sum.avgLeadDays),
      className: 'min-w-24',
    },
    {
      key: 'stay',
      header: 'Nights per stay',
      cell: (row) => formats.average(row.avgNights),
      total: (sum) => formats.average(sum.avgNights),
      className: 'min-w-20',
    },
    {
      key: 'cancelled',
      header: 'Cancelled',
      cell: (row) => formats.percent(row.cancellationBp),
      total: (sum) => formats.percent(sum.cancellationBp),
    },
  ];

  return (
    <>
      <Figures columns={4}>
        <Figure
          label="Room revenue"
          value={formats.money(total.roomRevenue)}
          note="What the rooms earned, before tax."
        />
        <Figure
          label="Commission"
          value={formats.money(total.commission)}
          note="What booking sites and travel agents keep."
        />
        <Figure
          label="Revenue after commission"
          value={formats.money(total.netRevenue)}
          note="What is left of the room revenue."
        />
        <Figure
          label="Bookings"
          value={formats.count(total.reservations)}
          note={`${plural(total.roomNights, 'room night')} in the period`}
        />
      </Figures>

      {shares.some((share) => share.basisPoints > 0) && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">Share of room revenue</h3>
          <ShareBar label="Share of room revenue by source" shares={shares} />
        </Card>
      )}

      <DataTable
        label="Bookings by where they came from"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        total={total}
      />
      <p className="text-xs text-ink-faint">
        A booking counts when it has a night in the period and was not cancelled. Days booked ahead
        and nights per stay are averages. Cancelled is the share of the bookings due to arrive in
        the period that were cancelled.
      </p>
    </>
  );
}

/** Which booking sites and other sources the stays of a period came from, and what they cost. */
export function SourcesReport({ filters }: { filters: ReportFilters }) {
  return (
    <ReportFrame<ChannelMix>
      view="sources"
      filters={filters}
      isEmpty={(report) => report.rows.length === 0}
      empty={{
        title: 'No bookings have a night in this period',
        description: 'Try a longer period, or other properties.',
      }}
    >
      {(report, formats) => <SourcesBody report={report} formats={formats} />}
    </ReportFrame>
  );
}
