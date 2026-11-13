'use client';

import { Card } from '@/components/ui/misc';
import { formatDay, fromMinor, toMinor } from '@/lib/format';
import { BarChart, type ChartSlot } from './bar-chart';
import { roundAxis } from './chart-parts';
import { DataTable, type Column } from './data-table';
import { Figure, Figures } from './figures';
import type { ReportFilters } from './filters';
import { dayLabel, monthLabel, monthTick, spansYears, weekLabel, type Formats } from './format';
import { daysIn, reportSpan, spanText } from './periods';
import { RankChart } from './rank-chart';
import { ReportFrame } from './report-frame';
import type { Performance, PerformanceGroup, PerformanceLine } from './types';
import { PERFORMANCE_GROUPS, performanceGroup } from './views';

const FULL = 10_000;

const GROUP_WORDS: Record<PerformanceGroup, { heading: string; each: string }> = {
  day: { heading: 'Day', each: 'day' },
  week: { heading: 'Week', each: 'week' },
  month: { heading: 'Month', each: 'month' },
  property: { heading: 'Property', each: 'property' },
  room_type: { heading: 'Room type', each: 'room type' },
};

function rowName(report: Performance, row: PerformanceLine): string {
  const withYear = spansYears(reportSpan(report));
  switch (report.groupBy) {
    case 'day':
      return dayLabel(row.key, withYear);
    case 'week':
      return weekLabel(row.key, withYear);
    case 'month':
      return monthLabel(row.key);
    default:
      return row.label;
  }
}

/** The fullest and the emptiest row, for saying the chart in words. */
function extremes(rows: PerformanceLine[]): { high: PerformanceLine; low: PerformanceLine } | null {
  const known = rows.filter((row) => row.occupancyBp !== null);
  if (known.length < 2) return null;
  const sorted = [...known].sort((a, b) => a.occupancyBp! - b.occupancyBp!);
  return { high: sorted[sorted.length - 1]!, low: sorted[0]! };
}

function OccupancyChart({ report, formats }: { report: Performance; formats: Formats }) {
  const { rows, total, groupBy } = report;
  const span = reportSpan(report);
  const each = GROUP_WORDS[groupBy].each;
  const highest = Math.max(0, ...rows.map((row) => row.occupancyBp ?? 0));
  const ends = extremes(rows);
  const label =
    `Occupancy by ${each}, ${spanText(span)}. ` +
    (ends
      ? `Highest ${formats.percent(ends.high.occupancyBp)} for ${rowName(report, ends.high)}, ` +
        `lowest ${formats.percent(ends.low.occupancyBp)} for ${rowName(report, ends.low)}. `
      : '') +
    `${formats.percent(total.occupancyBp)} over the whole period, at an average rate of ${formats.money(total.adr)}.`;

  if (groupBy === 'property' || groupBy === 'room_type') {
    return (
      <RankChart
        label={label}
        measure="occupancy"
        max={Math.max(FULL, highest)}
        rows={rows.map((row) => ({
          key: row.key,
          name: row.label,
          value: row.occupancyBp ?? 0,
          valueLabel: formats.percent(row.occupancyBp),
        }))}
      />
    );
  }

  const withYear = spansYears(span);
  const slots: ChartSlot[] = rows.map((row) => ({
    key: row.key,
    tick: groupBy === 'month' ? monthTick(row.key, withYear) : formatDay(row.key),
    title: `${rowName(report, row)}: ${formats.percent(row.occupancyBp)} occupancy, average rate ${formats.money(row.adr)}`,
    bar: row.occupancyBp ?? 0,
    barLabel: formats.percent(row.occupancyBp),
    lines: [row.adr],
  }));
  // Occupancy is a share of the rooms there are, so its scale runs to 100% whatever the figures;
  // further only if more rooms were sold than there were.
  const occupancyAxis = roundAxis(Math.max(FULL, highest), (value) => `${value / 100}%`);
  const highestRate = Math.max(0, ...rows.map((row) => row.adr ?? 0));
  const major = roundAxis(fromMinor(highestRate, formats.currency), (value) =>
    formats.shortMoney(toMinor(value, formats.currency)),
  );
  const rateAxis = {
    max: toMinor(major.max, formats.currency),
    ticks: major.ticks.map((tick) => ({ ...tick, value: toMinor(tick.value, formats.currency) })),
  };

  return (
    <BarChart
      label={label}
      slots={slots}
      bars={{ name: 'Occupancy', axis: occupancyAxis }}
      lines={[{ name: 'Average rate (ADR)' }]}
      lineAxis={rateAxis}
    />
  );
}

function PerformanceBody({ report, formats }: { report: Performance; formats: Formats }) {
  const { total, groupBy } = report;
  const words = GROUP_WORDS[groupBy];

  const columns: Column<PerformanceLine, PerformanceLine>[] = [
    {
      key: 'name',
      header: words.heading,
      cell: (row) => rowName(report, row),
      className:
        groupBy === 'property' || groupBy === 'room_type'
          ? 'max-w-44 min-w-32 sm:max-w-none'
          : 'whitespace-nowrap',
    },
    {
      key: 'available',
      header: 'Available',
      group: 'Room nights',
      cell: (row) => formats.count(row.available),
      total: (sum) => formats.count(sum.available),
    },
    {
      key: 'sold',
      header: 'Sold',
      group: 'Room nights',
      cell: (row) => formats.count(row.sold),
      total: (sum) => formats.count(sum.sold),
    },
    {
      key: 'occupancy',
      header: 'Occupancy',
      cell: (row) => formats.percent(row.occupancyBp),
      total: (sum) => formats.percent(sum.occupancyBp),
    },
    {
      key: 'revenue',
      header: 'Room revenue',
      cell: (row) => formats.money(row.roomRevenue),
      total: (sum) => formats.money(sum.roomRevenue),
    },
    {
      key: 'adr',
      header: 'Average rate (ADR)',
      cell: (row) => formats.money(row.adr),
      total: (sum) => formats.money(sum.adr),
      className: 'min-w-28',
    },
    {
      key: 'revpar',
      header: 'Revenue per available room (RevPAR)',
      cell: (row) => formats.money(row.revpar),
      total: (sum) => formats.money(sum.revpar),
      className: 'min-w-44',
    },
  ];

  return (
    <>
      <Figures columns={5}>
        <Figure
          label="Occupancy"
          value={formats.percent(total.occupancyBp)}
          note="The share of the room nights available that were sold."
        />
        <Figure
          label="Average rate (ADR)"
          value={formats.money(total.adr)}
          note="Room revenue for each room night sold."
        />
        <Figure
          label="Revenue per available room (RevPAR)"
          value={formats.money(total.revpar)}
          note="Room revenue for each room night available, sold or not."
        />
        <Figure
          label="Room revenue"
          value={formats.money(total.roomRevenue)}
          note="What the rooms earned, before tax."
        />
        <Figure
          label="Room nights sold"
          value={formats.count(total.sold)}
          note={`of ${formats.count(total.available)} available`}
        />
      </Figures>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">Occupancy by {words.each}</h3>
        <OccupancyChart report={report} formats={formats} />
      </Card>

      <DataTable
        label={`Performance by ${words.each}`}
        columns={columns}
        rows={report.rows}
        rowKey={(row) => row.key}
        total={total}
      />
      {groupBy === 'week' && (
        <p className="text-xs text-ink-faint">
          Weeks run from Monday to Sunday. The first and the last may be part of a week: only the
          days in the period are counted.
        </p>
      )}
    </>
  );
}

/** How full the rooms were, at what rate, and what each room available earned. */
export function PerformanceReport({ filters }: { filters: ReportFilters }) {
  const groupBy = performanceGroup(filters.group, filters.span ? daysIn(filters.span) : 0);
  return (
    <ReportFrame<Performance>
      view="performance"
      filters={filters}
      group={{ value: groupBy, options: PERFORMANCE_GROUPS }}
      isEmpty={(report) =>
        report.rows.length === 0 || (report.total.sold === 0 && report.total.roomRevenue === 0)
      }
      empty={{
        title: 'No rooms were sold in this period',
        description: 'Try a longer period, or other properties.',
      }}
    >
      {(report, formats) => <PerformanceBody report={report} formats={formats} />}
    </ReportFrame>
  );
}
