'use client';

import { Badge, Card } from '@/components/ui/misc';
import { formatDateTime, formatDay } from '@/lib/format';
import { BarChart, type ChartSlot } from './bar-chart';
import { roundAxis } from './chart-parts';
import { DataTable, Pair, type Column } from './data-table';
import { Figure, Figures } from './figures';
import type { ReportFilters } from './filters';
import { DASH, dayLabel, monthLabel, monthTick, spansYears, type Formats } from './format';
import { daysIn, reportSpan, spanText } from './periods';
import { ReportFrame } from './report-frame';
import type { Pace, PaceLine, PaceTotal } from './types';
import { PACE_GROUPS, paceGroup } from './views';

/** Room nights on the books now against the same point last year, in words. */
function standing(figures: PaceTotal, formats: Formats): string {
  const ahead = figures.sold - figures.lastYear.soldThen;
  if (ahead === 0) return 'Level';
  return `${formats.count(Math.abs(ahead))} ${ahead > 0 ? 'ahead' : 'behind'}`;
}

function Standing({ figures, formats }: { figures: PaceTotal; formats: Formats }) {
  const ahead = figures.sold - figures.lastYear.soldThen;
  return (
    <Badge tone={ahead > 0 ? 'success' : ahead < 0 ? 'danger' : 'neutral'}>
      {standing(figures, formats)}
    </Badge>
  );
}

function RevenueAdded({ text }: { text: string }) {
  return (
    <>
      room nights, and <span className="whitespace-nowrap">{text}</span> of room revenue
    </>
  );
}

function PaceBody({ report, formats }: { report: Pace; formats: Formats }) {
  const { rows, total, groupBy } = report;
  const span = reportSpan(report);
  const withYear = spansYears(span);
  const each = groupBy === 'day' ? 'day' : 'month';
  const name = (row: PaceLine) =>
    groupBy === 'day' ? dayLabel(row.period, withYear) : monthLabel(row.period);
  /** With nothing on record for the same dates a year ago, a comparison would only mislead. */
  const compared = total.lastYear.soldThen !== 0 || total.lastYear.soldFinal !== 0;

  const slots: ChartSlot[] = rows.map((row) => ({
    key: row.period,
    tick: groupBy === 'day' ? formatDay(row.period) : monthTick(row.period, withYear),
    title:
      `${name(row)}: ${formats.count(row.sold)} of ${formats.count(row.available)} sold` +
      (compared
        ? `. Last year at this point ${formats.count(row.lastYear.soldThen)}, in the end ${formats.count(row.lastYear.soldFinal)}`
        : ''),
    bar: row.sold,
    barLabel: formats.count(row.sold),
    lines: compared ? [row.lastYear.soldThen, row.lastYear.soldFinal] : undefined,
  }));
  const highest = Math.max(
    0,
    ...rows.flatMap((row) =>
      compared ? [row.sold, row.lastYear.soldThen, row.lastYear.soldFinal] : [row.sold],
    ),
  );
  const lead = total.sold - total.lastYear.soldThen;
  const against =
    lead === 0
      ? 'level with'
      : `${formats.count(Math.abs(lead))} ${lead > 0 ? 'ahead of' : 'behind'}`;
  const chartLabel =
    `Room nights on the books by ${each}, ${spanText(span)}. ` +
    `${formats.count(total.sold)} of ${formats.count(total.available)} available are sold` +
    (compared
      ? `: ${against} the ${formats.count(total.lastYear.soldThen)} on the books at this point ` +
        `last year. Last year ended on ${formats.count(total.lastYear.soldFinal)}.`
      : '.');

  const added = (pickup: PaceTotal['pickup7']) => (
    <Pair
      main={formats.countChange(pickup.roomNights)}
      sub={formats.moneyChange(pickup.roomRevenue)}
    />
  );
  // How the nights stand against last year comes straight after the nights themselves: it is
  // what the report is read for, and on a narrow screen it is then in view without scrolling.
  const standingColumn: Column<PaceLine, PaceTotal> = {
    key: 'standing',
    header: 'Against last year',
    cell: (row) => <Standing figures={row} formats={formats} />,
    total: (sum) => <Standing figures={sum} formats={formats} />,
  };
  const lastYearColumns: Column<PaceLine, PaceTotal>[] = [
    {
      key: 'then',
      header: 'On the books at this point',
      group: 'The same dates last year',
      cell: (row) => (
        <Pair
          main={formats.count(row.lastYear.soldThen)}
          sub={formats.money(row.lastYear.roomRevenueThen)}
        />
      ),
      total: (sum) => (
        <Pair
          main={formats.count(sum.lastYear.soldThen)}
          sub={formats.money(sum.lastYear.roomRevenueThen)}
        />
      ),
      className: 'min-w-28',
    },
    {
      key: 'final',
      header: 'Sold in the end',
      group: 'The same dates last year',
      cell: (row) => (
        <Pair
          main={formats.count(row.lastYear.soldFinal)}
          sub={formats.money(row.lastYear.roomRevenueFinal)}
        />
      ),
      total: (sum) => (
        <Pair
          main={formats.count(sum.lastYear.soldFinal)}
          sub={formats.money(sum.lastYear.roomRevenueFinal)}
        />
      ),
      className: 'min-w-24',
    },
  ];
  const columns: Column<PaceLine, PaceTotal>[] = [
    {
      key: 'period',
      header: groupBy === 'day' ? 'Date' : 'Month',
      cell: name,
      className: 'whitespace-nowrap',
    },
    {
      key: 'sold',
      header: 'Room nights sold',
      cell: (row) => (
        <Pair main={formats.count(row.sold)} sub={`of ${formats.count(row.available)}`} />
      ),
      total: (sum) => (
        <Pair main={formats.count(sum.sold)} sub={`of ${formats.count(sum.available)}`} />
      ),
      className: 'min-w-24',
    },
    ...(compared ? [standingColumn] : []),
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
      key: 'pickup7',
      header: 'In the last 7 days',
      group: 'Added, less cancelled',
      cell: (row) => added(row.pickup7),
      total: (sum) => added(sum.pickup7),
      className: 'min-w-24',
    },
    {
      key: 'pickup30',
      header: 'In the last 30 days',
      group: 'Added, less cancelled',
      cell: (row) => added(row.pickup30),
      total: (sum) => added(sum.pickup30),
      className: 'min-w-24',
    },
    ...(compared ? lastYearColumns : []),
  ];

  return (
    <>
      <Figures columns={5}>
        <Figure
          label="Room nights on the books"
          value={formats.count(total.sold)}
          note={`of ${formats.count(total.available)} available: ${formats.percent(total.occupancyBp)} occupancy`}
        />
        <Figure
          label="Room revenue"
          value={formats.money(total.roomRevenue)}
          note={`Average rate (ADR) ${formats.money(total.adr)}`}
        />
        <Figure
          label="Added in the last 7 days"
          value={formats.countChange(total.pickup7.roomNights)}
          note={<RevenueAdded text={formats.moneyChange(total.pickup7.roomRevenue)} />}
        />
        <Figure
          label="Added in the last 30 days"
          value={formats.countChange(total.pickup30.roomNights)}
          note={<RevenueAdded text={formats.moneyChange(total.pickup30.roomRevenue)} />}
        />
        <Figure
          label="Against last year"
          value={
            compared ? (
              <span
                className={
                  total.sold > total.lastYear.soldThen
                    ? 'text-success-700'
                    : total.sold < total.lastYear.soldThen
                      ? 'text-danger-700'
                      : undefined
                }
              >
                {standing(total, formats)}
              </span>
            ) : (
              DASH
            )
          }
          note={
            compared
              ? `${formats.count(total.lastYear.soldThen)} room nights were on the books at this point last year. It ended on ${formats.count(total.lastYear.soldFinal)}.`
              : 'Nothing is on record for the same dates last year.'
          }
        />
      </Figures>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">Room nights on the books by {each}</h3>
        <BarChart
          label={chartLabel}
          slots={slots}
          bars={{
            name: 'On the books now',
            axis: roundAxis(highest, (value) => formats.count(value), { whole: true }),
          }}
          lines={
            compared
              ? [
                  { name: 'Last year at this point' },
                  { name: 'Last year in the end', dashed: true },
                ]
              : []
          }
        />
      </Card>

      <DataTable
        label={`Pace by ${each}`}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.period}
        total={total}
      />
      <p className="text-xs text-ink-faint">
        As things stood at {formatDateTime(report.asOf)}. Added, less cancelled, is the change in
        room nights and room revenue on the books over the last 7 and the last 30 days.
        {compared
          ? ' Last year means the same weekdays 52 weeks earlier: what was on the books for them on this day last year, and what they had sold by the time they came.'
          : ' There is nothing to compare with yet: the comparison with last year shows once bookings are on record for the same dates a year ago.'}
      </p>
    </>
  );
}

/** How the nights ahead are filling, against a week ago, a month ago and a year ago. */
export function PaceReport({ filters }: { filters: ReportFilters }) {
  const groupBy = paceGroup(filters.group, filters.span ? daysIn(filters.span) : 0);
  return (
    <ReportFrame<Pace>
      view="pace"
      filters={filters}
      group={{ value: groupBy, options: PACE_GROUPS }}
      isEmpty={({ rows, total }) =>
        rows.length === 0 ||
        (total.sold === 0 &&
          total.pickup7.roomNights === 0 &&
          total.pickup30.roomNights === 0 &&
          total.lastYear.soldThen === 0 &&
          total.lastYear.soldFinal === 0)
      }
      empty={{
        title: 'Nothing is on the books for this period',
        description: 'Try a longer period, or other properties.',
      }}
    >
      {(report, formats) => <PaceBody report={report} formats={formats} />}
    </ReportFrame>
  );
}
