'use client';

import { DataTable, type Column } from './data-table';
import { Figure, Figures } from './figures';
import type { ReportFilters } from './filters';
import { dayLabel, spansYears, type Formats } from './format';
import { reportSpan } from './periods';
import { ReportFrame } from './report-frame';
import type { PaymentMethod, Takings, TakingsDay, TakingsTotal } from './types';

/** Every way of paying, in the order the spreadsheet has them. */
const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  online: 'Online',
  channel: 'Booking site',
  other: 'Other',
};
const METHODS = Object.keys(METHOD_LABELS) as PaymentMethod[];

function TakingsBody({ report, formats }: { report: Takings; formats: Formats }) {
  const { days, total } = report;
  const withYear = spansYears(reportSpan(report));
  // A way of paying nobody used is a column of noughts: it is left out and said so beneath.
  const used = METHODS.filter((method) => total.payments[method] !== undefined);
  const unused = METHODS.filter((method) => !used.includes(method));

  const charge = (
    key: 'room' | 'food' | 'service' | 'other' | 'discounts' | 'tax' | 'total',
    header: string,
  ): Column<TakingsDay, TakingsTotal> => ({
    key,
    header,
    group: 'Charged',
    cell: (day) => formats.money(day[key]),
    total: (sum) => formats.money(sum[key]),
    className: key === 'total' ? 'font-medium' : undefined,
  });
  const columns: Column<TakingsDay, TakingsTotal>[] = [
    {
      key: 'day',
      header: 'Day',
      cell: (day) => dayLabel(day.date, withYear),
      className: 'whitespace-nowrap',
    },
    charge('room', 'Rooms'),
    charge('food', 'Food and drink'),
    charge('service', 'Services'),
    charge('other', 'Extras and fees'),
    charge('discounts', 'Discounts'),
    charge('tax', 'Tax'),
    charge('total', 'Total charged'),
    ...used.map((method): Column<TakingsDay, TakingsTotal> => ({
      key: method,
      header: METHOD_LABELS[method],
      group: 'Money taken',
      cell: (day) => formats.money(day.payments[method] ?? 0),
      total: (sum) => formats.money(sum.payments[method] ?? 0),
    })),
    {
      key: 'taken',
      header: 'Total taken',
      group: 'Money taken',
      cell: (day) => formats.money(day.paymentsTotal),
      total: (sum) => formats.money(sum.paymentsTotal),
      className: 'font-medium',
    },
  ];

  return (
    <>
      <Figures columns={4}>
        <Figure
          label="Total charged"
          value={formats.money(total.total)}
          note="Charges less discounts, with tax."
        />
        <Figure label="Tax" value={formats.money(total.tax)} note="Part of the total charged." />
        <Figure
          label="Discounts"
          value={formats.money(total.discounts)}
          note="Taken off what was charged."
        />
        <Figure
          label="Money taken"
          value={formats.money(total.paymentsTotal)}
          note="Payments less refunds."
        />
      </Figures>

      <DataTable
        label="Charges and money taken by day"
        columns={columns}
        rows={days}
        rowKey={(day) => day.date}
        total={total}
        dense
      />
      <p className="text-xs text-ink-faint">
        Days are hotel days, which the night audit closes. Days with no charge and no payment are
        left out.
        {unused.length > 0 &&
          ` Not shown, because no money was taken that way in this period: ${unused.map((method) => METHOD_LABELS[method]).join(', ')}. The spreadsheet has every column.`}
      </p>
    </>
  );
}

/** What was charged, by kind, and what money came in, by how it was paid, for each hotel day. */
export function TakingsReport({ filters }: { filters: ReportFilters }) {
  return (
    <ReportFrame<Takings>
      view="takings"
      filters={filters}
      isEmpty={(report) => report.days.length === 0}
      empty={{
        title: 'Nothing was charged or paid in this period',
        description: 'Try a longer period, or other properties.',
      }}
    >
      {(report, formats) => <TakingsBody report={report} formats={formats} />}
    </ReportFrame>
  );
}
