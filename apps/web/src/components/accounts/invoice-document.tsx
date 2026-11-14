import type { ReactNode } from 'react';
import { formatDate } from '@/lib/format';
import { amountInWords } from './amount-in-words';
import { taxCodes } from './invoice-csv';
import { money, percentText } from './money';
import type { Invoice, InvoiceLine, InvoiceParty } from './types';

/**
 * Printing gives the invoice alone on A4. The app shell around it cannot be
 * changed from here, so in print every element that holds the sheet becomes
 * a plain block and everything beside those elements is hidden.
 */
const PRINT_CSS = `
@page { size: A4; margin: 14mm; }
@media print {
  html:has([data-invoice-sheet]) {
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }
  :is(body, body *):has([data-invoice-sheet]) {
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
  :is(body, body *):has([data-invoice-sheet]) > :not(:has([data-invoice-sheet])):not([data-invoice-sheet]) {
    display: none !important;
  }
  [data-invoice-sheet] {
    width: 100% !important;
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    font-size: 10pt;
  }
  [data-invoice-sheet] tr {
    break-inside: avoid;
  }
}
`;

function stateText(party: InvoiceParty): string | null {
  if (party.state && party.stateCode) return `${party.state} (${party.stateCode})`;
  if (party.state) return party.state;
  return party.stateCode ? `State code ${party.stateCode}` : null;
}

function PartyDetails({ party }: { party: InvoiceParty }) {
  const state = stateText(party);
  return (
    <>
      {party.address && <p>{party.address}</p>}
      {state && <p>State: {state}</p>}
      {party.gstin && <p>GSTIN: {party.gstin}</p>}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </>
  );
}

/** The whole rate on a line: its components (CGST and SGST, or IGST) added up. */
function lineRate(line: InvoiceLine): string {
  if (line.taxes.length === 0) return 'None';
  return `${percentText(line.taxes.reduce((sum, tax) => sum + tax.rateBp, 0))}%`;
}

const TH = 'px-2 py-2 text-left align-bottom font-medium';
const TD = 'px-2 py-2 align-top';

/**
 * A tax invoice or credit note as it is printed. It shows the copy frozen
 * when it was issued, never the guest, company or property as they are now.
 * A credit note stores its amounts as negatives; the document states what
 * is credited as plain amounts.
 */
export function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  const credit = invoice.type === 'credit_note';
  const sign = credit ? -1 : 1;
  const { seller, buyer, reference, currency } = invoice;
  const show = (amount: number) => money(sign * amount, currency);
  const contact = [seller.phone, seller.email].filter(Boolean).join(' · ');

  return (
    <>
      <style>{PRINT_CSS}</style>
      <article
        data-invoice-sheet
        className="mx-auto w-full max-w-[210mm] rounded-xl border border-line bg-surface p-5 text-[13px] leading-relaxed text-ink shadow-card sm:p-10"
      >
        <header className="flex flex-col gap-6 border-b border-line-strong pb-6 sm:flex-row sm:justify-between">
          <div className="min-w-0 text-ink-soft">
            <p className="text-lg leading-snug font-semibold text-ink">{seller.name}</p>
            <PartyDetails party={seller} />
            {contact && <p>{contact}</p>}
          </div>
          <div className="shrink-0 sm:text-right">
            <h2 className="text-xl font-semibold tracking-wide text-ink uppercase">
              {credit ? 'Credit note' : 'Tax invoice'}
            </h2>
            <dl className="mt-2 grid grid-cols-[auto_auto] justify-start gap-x-4 gap-y-0.5 sm:justify-end">
              <Fact label={credit ? 'Credit note number' : 'Invoice number'}>
                <span className="font-medium">{invoice.number}</span>
              </Fact>
              <Fact label="Date">{formatDate(invoice.issuedOn)}</Fact>
              {credit && reference.invoice && (
                <Fact label="Against invoice">{reference.invoice}</Fact>
              )}
            </dl>
          </div>
        </header>

        <section className="grid grid-cols-1 gap-6 py-6 sm:grid-cols-2">
          <div className="min-w-0 text-ink-soft">
            <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
              {credit ? 'Credit to' : 'Billed to'}
            </h3>
            <p className="mt-1 text-sm font-semibold text-ink">{buyer.name}</p>
            <PartyDetails party={buyer} />
          </div>
          {(reference.reservation || reference.guest || reference.arrival) && (
            <div className="min-w-0">
              <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Stay</h3>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
                {reference.guest && <Fact label="Guest">{reference.guest}</Fact>}
                {reference.reservation && <Fact label="Booking">{reference.reservation}</Fact>}
                {reference.arrival && reference.departure && (
                  <Fact label="Dates">
                    {formatDate(reference.arrival)} to {formatDate(reference.departure)}
                  </Fact>
                )}
                {reference.channelReference && (
                  <Fact label="Channel reference">{reference.channelReference}</Fact>
                )}
              </dl>
            </div>
          )}
        </section>

        {credit && invoice.reason && (
          <p className="mb-6 rounded-md border border-line px-3 py-2">
            <span className="text-ink-soft">Reason for this credit note: </span>
            {invoice.reason}
          </p>
        )}

        <div className="scrollbar-thin overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[640px] border-collapse text-[12px] print:min-w-0">
            <thead>
              <tr className="border-y border-line-strong text-ink-soft">
                <th scope="col" className={TH}>
                  Description
                </th>
                <th scope="col" className={TH}>
                  SAC
                </th>
                <th scope="col" className={TH}>
                  Date
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Quantity
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Rate
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Taxable amount
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Tax rate
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Tax
                </th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                <tr key={index} className="border-b border-line">
                  <td className={TD}>{line.description}</td>
                  <td className={TD}>{line.serviceCode ?? ''}</td>
                  <td className={`${TD} whitespace-nowrap`}>{formatDate(line.date)}</td>
                  <td className={`${TD} tabular text-right`}>{line.quantity}</td>
                  <td className={`${TD} tabular text-right whitespace-nowrap`}>
                    {show(Math.round(line.amount / Math.max(1, line.quantity)))}
                  </td>
                  <td className={`${TD} tabular text-right whitespace-nowrap`}>
                    {show(line.amount)}
                  </td>
                  <td className={`${TD} tabular text-right whitespace-nowrap`}>{lineRate(line)}</td>
                  <td className={`${TD} tabular text-right whitespace-nowrap`}>
                    {show(line.taxAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex justify-end">
          <dl className="grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1">
            <dt className="text-ink-soft">Taxable amount</dt>
            <dd className="tabular text-right">{show(invoice.totals.taxable)}</dd>
            {taxCodes([invoice]).map((code) => (
              <div key={code} className="contents">
                <dt className="text-ink-soft">{code}</dt>
                <dd className="tabular text-right">{show(invoice.totals.taxes[code] ?? 0)}</dd>
              </div>
            ))}
            <dt className="mt-1 border-t border-line-strong pt-2 text-sm font-semibold">
              {credit ? 'Total credit' : 'Total'}
            </dt>
            <dd className="tabular mt-1 border-t border-line-strong pt-2 text-right text-sm font-semibold">
              {show(invoice.totals.total)}
            </dd>
          </dl>
        </div>

        <p className="mt-6">
          <span className="text-ink-soft">Amount in words: </span>
          {amountInWords(invoice.totals.total, currency)}
        </p>

        <footer className="mt-10 border-t border-line pt-4 text-xs text-ink-faint">
          This is a computer-generated {credit ? 'credit note' : 'invoice'}.
        </footer>
      </article>
    </>
  );
}
