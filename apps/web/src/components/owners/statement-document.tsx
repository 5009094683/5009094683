'use client';

import type { ReactNode } from 'react';
import { diffDays, sourceName } from '@pms/domain/shared';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDate, formatStay, plural } from '@/lib/format';
import { money, percentText, signedMoney } from './money';
import type { Statement, StatementStay } from './types';
import {
  CATEGORY_LABELS,
  MODEL_LABELS,
  basisWords,
  formatDayOf,
  statementMonth,
  statementPeriod,
} from './words';

/**
 * Printing gives the statement alone on A4. The app shell around it cannot be
 * changed from here, so in print every element that holds the sheet becomes
 * a plain block and everything beside those elements is hidden.
 */
const PRINT_CSS = `
@page { size: A4; margin: 14mm; }
@media print {
  html:has([data-statement-sheet]) {
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }
  :is(body, body *):has([data-statement-sheet]) {
    display: block !important;
    position: static !important;
    width: auto !important;
    max-width: none !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    overflow: visible !important;
    background: none !important;
    box-shadow: none !important;
    transform: none !important;
  }
  :is(body, body *):has([data-statement-sheet]) > :not(:has([data-statement-sheet])):not([data-statement-sheet]) {
    display: none !important;
  }
  [data-statement-sheet] {
    width: 100% !important;
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    font-size: 9.5pt;
    line-height: 1.45 !important;
  }
  /* Closer together than on screen, so that an ordinary month fits one page. */
  [data-statement-sheet] > header {
    padding-bottom: 4mm !important;
  }
  [data-statement-sheet] > section {
    padding-top: 3mm !important;
    padding-bottom: 3mm !important;
  }
  [data-statement-sheet] :is(th, td) {
    padding-top: 1.2mm !important;
    padding-bottom: 1.2mm !important;
  }
  /* The closing line never goes to a page of its own. */
  [data-statement-sheet] > footer {
    margin-top: 3mm !important;
    padding-top: 2mm !important;
    break-before: avoid;
  }
  [data-statement-sheet] tr,
  [data-statement-sheet] [data-keep-together] {
    break-inside: avoid;
  }
}
`;

const TH = 'px-2 py-2 text-left align-bottom font-medium';
const TD = 'px-2 py-2 align-top';
const NUM = 'tabular text-right whitespace-nowrap';
/** A table where there is room for one and on paper; a list of the same lines on a phone. */
const WIDE = 'hidden sm:block print:block';
const NARROW = 'sm:hidden print:hidden';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
      {children}
    </h3>
  );
}

/** Nights counted on this statement, and of how many when the stay runs into another month. */
function nightsText(stay: StatementStay): string {
  const whole = diffDays(stay.checkIn, stay.checkOut);
  return stay.nights === whole ? String(stay.nights) : `${stay.nights} of ${whole}`;
}

function Bookings({ statement }: { statement: Statement }) {
  const { stays } = statement.lines;
  const { currency } = statement;
  const home = statement.unitName ?? statement.propertyName;
  const showUnit = stays.some((stay) => stay.unitName !== null && stay.unitName !== home);
  const showCommission = stays.some((stay) => stay.commission !== 0);
  const partial = stays.some((stay) => stay.nights !== diffDays(stay.checkIn, stay.checkOut));
  // The commission on the bookings adds up to this only when it is taken off the owner's share.
  const commissionTotal = statement.channelCommission !== 0 ? statement.channelCommission : null;

  if (stays.length === 0) {
    return (
      <section className="py-4">
        <SectionHeading>Bookings</SectionHeading>
        <p className="text-ink-soft">
          {statement.status === 'draft'
            ? 'No guest stays have been counted for this month so far.'
            : 'No guests stayed in this month.'}
        </p>
      </section>
    );
  }

  return (
    <section className="py-4">
      <SectionHeading>Bookings</SectionHeading>
      <div className={WIDE}>
        <table className="w-full border-collapse text-[12px]">
          <caption className="sr-only">
            Guest stays counted on this statement, with the room revenue of each
          </caption>
          <thead>
            <tr className="border-y border-line-strong text-ink-soft">
              <th scope="col" className={TH}>
                Booking
              </th>
              <th scope="col" className={TH}>
                Source
              </th>
              {showUnit && (
                <th scope="col" className={TH}>
                  Unit
                </th>
              )}
              <th scope="col" className={TH}>
                Arrival
              </th>
              <th scope="col" className={TH}>
                Departure
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Nights
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Room revenue
              </th>
              {showCommission && (
                <th scope="col" className={cn(TH, 'text-right')}>
                  Commission
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {stays.map((stay, index) => (
              <tr key={index} className="border-b border-line">
                <td className={cn(TD, 'font-mono text-[11px] whitespace-nowrap')}>
                  {stay.reservationCode}
                </td>
                <td className={TD}>{sourceName(stay.source)}</td>
                {showUnit && <td className={TD}>{stay.unitName ?? home}</td>}
                <td className={cn(TD, 'whitespace-nowrap')}>{formatDate(stay.checkIn)}</td>
                <td className={cn(TD, 'whitespace-nowrap')}>{formatDate(stay.checkOut)}</td>
                <td className={cn(TD, NUM)}>{nightsText(stay)}</td>
                <td className={cn(TD, NUM)}>{money(stay.revenue, currency)}</td>
                {showCommission && (
                  <td className={cn(TD, NUM)}>
                    {stay.commission !== 0 ? money(stay.commission, currency) : ''}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-b border-line-strong font-medium">
              <th scope="row" colSpan={showUnit ? 5 : 4} className={cn(TD, 'text-left')}>
                Total
              </th>
              <td className={cn(TD, NUM)}>{statement.roomNights}</td>
              <td className={cn(TD, NUM)}>{money(statement.grossRevenue, currency)}</td>
              {showCommission && (
                <td className={cn(TD, NUM)}>
                  {commissionTotal !== null ? money(commissionTotal, currency) : ''}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>

      <ul className={cn(NARROW, 'divide-y divide-line border-y border-line-strong')}>
        {stays.map((stay, index) => (
          <li key={index} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-ink">{formatStay(stay.checkIn, stay.checkOut)}</p>
              <p className="text-ink-soft">
                {nightsText(stay)} {stay.nights === 1 ? 'night' : 'nights'} ·{' '}
                {sourceName(stay.source)}
                {showUnit && ` · ${stay.unitName ?? home}`}
              </p>
              <p className="font-mono text-[11px] text-ink-faint">{stay.reservationCode}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="tabular text-ink">{money(stay.revenue, currency)}</p>
              {stay.commission !== 0 && (
                <p className="tabular text-ink-soft">
                  Commission {money(stay.commission, currency)}
                </p>
              )}
            </div>
          </li>
        ))}
        <li className="flex items-start justify-between gap-3 py-2 font-medium">
          <span>Total, {plural(statement.roomNights, 'night')}</span>
          <span className="tabular">{money(statement.grossRevenue, currency)}</span>
        </li>
      </ul>

      {partial && (
        <p className="mt-2 text-ink-soft">
          Where a stay runs into another month, only its nights in {statementMonth(statement)} are
          counted here. The others are on that month&rsquo;s statement.
        </p>
      )}
    </section>
  );
}

function Costs({ statement }: { statement: Statement }) {
  const { expenses } = statement.lines;
  const { currency } = statement;
  if (expenses.length === 0) return null;
  return (
    <section className="py-4" data-keep-together>
      <SectionHeading>Costs charged to the owner</SectionHeading>
      <div className={WIDE}>
        <table className="w-full border-collapse text-[12px]">
          <caption className="sr-only">Costs taken off this statement</caption>
          <thead>
            <tr className="border-y border-line-strong text-ink-soft">
              <th scope="col" className={TH}>
                Date
              </th>
              <th scope="col" className={TH}>
                Kind
              </th>
              <th scope="col" className={TH}>
                What for
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => (
              <tr key={expense.id} className="border-b border-line">
                <td className={cn(TD, 'whitespace-nowrap')}>{formatDate(expense.date)}</td>
                <td className={TD}>{CATEGORY_LABELS[expense.category] ?? expense.category}</td>
                <td className={TD}>{expense.description}</td>
                <td className={cn(TD, NUM)}>{money(expense.amount, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={cn(NARROW, 'divide-y divide-line border-y border-line-strong')}>
        {expenses.map((expense) => (
          <li key={expense.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="break-words text-ink">{expense.description}</p>
              <p className="text-ink-soft">
                {formatDate(expense.date)} · {CATEGORY_LABELS[expense.category] ?? expense.category}
              </p>
            </div>
            <p className="tabular shrink-0 text-ink">{money(expense.amount, currency)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Adjustments({ statement }: { statement: Statement }) {
  const { adjustments } = statement.lines;
  if (adjustments.length === 0) return null;
  return (
    <section className="py-4" data-keep-together>
      <SectionHeading>Adjustments</SectionHeading>
      <ul className="divide-y divide-line border-y border-line-strong">
        {adjustments.map((adjustment, index) => (
          <li
            key={index}
            className="flex items-start justify-between gap-3 py-2 sm:px-2 print:px-2"
          >
            <p className="min-w-0 break-words text-ink">{adjustment.description}</p>
            <p className="tabular shrink-0 text-ink">
              {signedMoney(adjustment.amount, statement.currency)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SumRow({
  label,
  detail,
  amount,
  strong,
}: {
  label: string;
  detail?: string;
  amount: string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-6',
        strong && 'mt-1 border-t border-line-strong pt-2 text-sm font-semibold',
      )}
    >
      <dt className={cn(!strong && 'text-ink-soft')}>
        {label}
        {detail && <span className="block text-[12px] font-normal text-ink-faint">{detail}</span>}
      </dt>
      <dd className="tabular shrink-0 text-right">{amount}</dd>
    </div>
  );
}

/** How the amount payable comes about. Every figure is the server's own. */
function Summary({ statement }: { statement: Statement }) {
  const { currency } = statement;
  const less = (amount: number) => money(-amount, currency);
  const share = statement.model === 'revenue_share';
  // Commission shown against bookings but not taken off here is borne by the management company.
  // The rent for the month is what is payable before costs and adjustments: the server keeps
  // the three it is made of, and this puts them back together.
  const rent = statement.payout + statement.expenses - statement.adjustments;
  const commissionNotCharged =
    share &&
    statement.channelCommission === 0 &&
    statement.lines.stays.some((stay) => stay.commission !== 0);

  return (
    <section className="py-4" data-keep-together>
      <SectionHeading>Summary</SectionHeading>
      <div className="flex justify-end">
        <dl className="flex w-full max-w-sm flex-col gap-1.5">
          {share && (
            <>
              <SumRow
                label="Room revenue"
                detail={`${plural(statement.roomNights, 'night')} guests stayed`}
                amount={money(statement.grossRevenue, currency)}
              />
              {statement.channelCommission !== 0 && (
                <SumRow
                  label="Commission"
                  detail="Kept by booking sites and travel agents"
                  amount={less(statement.channelCommission)}
                />
              )}
              <SumRow
                label="Management fee"
                detail={`${percentText(statement.managementFeeBp)}% ${basisWords(statement.feeBasis)}`}
                amount={less(statement.managementFee)}
              />
              {(statement.feeTax !== 0 || statement.feeTaxBp !== 0) && (
                <SumRow
                  label="Tax on the management fee"
                  detail={`${percentText(statement.feeTaxBp)}%`}
                  amount={less(statement.feeTax)}
                />
              )}
            </>
          )}
          {!share && statement.fixedRent !== null && (
            <SumRow
              label="Rent"
              detail={`${money(statement.fixedRent, currency)} a month${
                rent === statement.fixedRent ? '' : ', for the days the contract covers'
              }`}
              amount={money(rent, currency)}
            />
          )}
          {(statement.expenses !== 0 || statement.lines.expenses.length > 0) && (
            <SumRow label="Costs" amount={less(statement.expenses)} />
          )}
          {(statement.adjustments !== 0 || statement.lines.adjustments.length > 0) && (
            <SumRow label="Adjustments" amount={signedMoney(statement.adjustments, currency)} />
          )}
          <SumRow label="Payable to the owner" amount={money(statement.payout, currency)} strong />
        </dl>
      </div>
      {!share && (
        <p className="mt-3 text-ink-soft">
          This contract pays a fixed rent. The amount payable is the rent for the days of{' '}
          {statementMonth(statement)} the contract covers, less the costs, plus any adjustments.
          What guests paid does not change it.
        </p>
      )}
      {commissionNotCharged && (
        <p className="mt-3 text-ink-soft">
          The commission on these bookings is not taken off the owner&rsquo;s share.
        </p>
      )}
      {statement.payout < 0 && (
        <p className="mt-3 text-ink-soft">
          The amounts taken off in this month came to more than the villa earned, so nothing is
          payable for it.
        </p>
      )}
    </section>
  );
}

/**
 * An owner's statement for a month as it is printed and as the owner reads
 * it: the stays, the costs, and how the amount payable comes about. It shows
 * the figures the server worked out and adds none of its own.
 */
export function StatementDocument({ statement }: { statement: Statement }) {
  const { me } = useAuth();
  const share = statement.model === 'revenue_share';
  const terms = share
    ? `${MODEL_LABELS.revenue_share}. Management fee: ${percentText(statement.managementFeeBp)}% ${basisWords(statement.feeBasis)}${
        statement.feeTaxBp !== 0 ? `, plus ${percentText(statement.feeTaxBp)}% tax on the fee` : ''
      }.`
    : statement.fixedRent === null
      ? `${MODEL_LABELS.fixed_rent}.`
      : `${MODEL_LABELS.fixed_rent} of ${money(statement.fixedRent, statement.currency)} a month.`;

  return (
    <>
      <style>{PRINT_CSS}</style>
      <article
        data-statement-sheet
        aria-label={`Owner statement for ${statementMonth(statement)}`}
        className="mx-auto w-full max-w-[210mm] rounded-xl border border-line bg-surface p-5 text-[13px] leading-relaxed text-ink shadow-card sm:p-10"
      >
        {statement.status === 'draft' && (
          <p className="mb-5 rounded-md border border-dashed border-line-strong px-3 py-2 text-ink-soft">
            <span className="font-semibold text-ink">Draft.</span> Not issued to the owner yet: the
            figures can still change.
          </p>
        )}

        <header className="flex flex-col gap-6 border-b border-line-strong pb-6 sm:flex-row sm:justify-between">
          <div className="min-w-0 text-ink-soft">
            <p className="text-lg leading-snug font-semibold text-ink">
              {me.organization?.name ?? 'Property management'}
            </p>
            <p>Statement of what the villa earned and what is payable to its owner.</p>
          </div>
          <div className="shrink-0 sm:text-right">
            <h2 className="text-xl font-semibold tracking-wide text-ink uppercase">
              Owner statement
            </h2>
            <dl className="mt-2 grid grid-cols-[auto_auto] justify-start gap-x-4 gap-y-0.5 sm:justify-end">
              <Fact label="Number">
                <span className="font-medium">{statement.number ?? 'Not issued yet'}</span>
              </Fact>
              <Fact label="Month">{statementMonth(statement)}</Fact>
              {statement.issuedAt && <Fact label="Issued">{formatDayOf(statement.issuedAt)}</Fact>}
              {statement.status === 'issued' && <Fact label="Payment">To follow</Fact>}
              {statement.status === 'paid' && statement.paidAt && (
                <Fact label="Paid">{formatDayOf(statement.paidAt)}</Fact>
              )}
              {statement.status === 'paid' && statement.paymentReference && (
                <Fact label="Reference">{statement.paymentReference}</Fact>
              )}
            </dl>
          </div>
        </header>

        <section className="grid grid-cols-1 gap-6 border-b border-line py-6 sm:grid-cols-2">
          <div className="min-w-0">
            <SectionHeading>Owner</SectionHeading>
            <p className="text-sm font-semibold break-words text-ink">{statement.ownerName}</p>
          </div>
          <div className="min-w-0 text-ink-soft">
            <SectionHeading>Villa</SectionHeading>
            <p className="text-sm font-semibold break-words text-ink">{statement.propertyName}</p>
            {statement.unitName && statement.unitName !== statement.propertyName && (
              <p>{statement.unitName}</p>
            )}
            <p>{statementPeriod(statement)}</p>
            <p>{terms}</p>
          </div>
        </section>

        <Bookings statement={statement} />
        <Costs statement={statement} />
        <Adjustments statement={statement} />
        <Summary statement={statement} />

        {statement.notes && (
          <section className="py-4" data-keep-together>
            <SectionHeading>Note</SectionHeading>
            <p className="break-words whitespace-pre-line text-ink">{statement.notes}</p>
          </section>
        )}

        <footer className="mt-6 border-t border-line pt-4 text-xs text-ink-faint">
          {(share || statement.lines.stays.length > 0) &&
            'Room revenue is the charge for the nights guests stayed, before tax. '}
          Amounts are in {statement.currency}.
        </footer>
      </article>
    </>
  );
}
