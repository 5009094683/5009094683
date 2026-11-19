'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatDate, plural } from '@/lib/format';
import { money } from './money';
import type { Invoice } from './types';

/** Sums of the listed rows, when they are all in one currency and so can be added up. */
function totalsOf(invoices: Invoice[]) {
  const currency = invoices[0]?.currency;
  if (!currency || invoices.some((invoice) => invoice.currency !== currency)) return null;
  return {
    currency,
    taxable: invoices.reduce((sum, invoice) => sum + invoice.totals.taxable, 0),
    tax: invoices.reduce((sum, invoice) => sum + invoice.totals.taxTotal, 0),
    total: invoices.reduce((sum, invoice) => sum + invoice.totals.total, 0),
  };
}

const CELL = 'px-3 py-3 first:pl-4 last:pr-4';
const HEAD = 'px-3 py-2.5 font-medium first:pl-4 last:pr-4';
const AMOUNT = 'tabular text-right whitespace-nowrap';

/** Invoices and credit notes, one per row. A credit note's amounts are negative. */
export function InvoiceTable({
  invoices,
  propertyNames,
  showProperty,
}: {
  invoices: Invoice[];
  propertyNames: Map<string, string>;
  /** Whether to say which property each row belongs to: pointless when there is only one. */
  showProperty: boolean;
}) {
  const router = useRouter();
  const totals = totalsOf(invoices);

  return (
    <Card className="overflow-hidden">
      <div className="scrollbar-thin relative overflow-x-auto">
        <table className="w-full min-w-[880px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
              <th scope="col" className={HEAD}>
                Number
              </th>
              <th scope="col" className={HEAD}>
                Date
              </th>
              <th scope="col" className={HEAD}>
                Made out to
              </th>
              {showProperty && (
                <th scope="col" className={HEAD}>
                  Property
                </th>
              )}
              <th scope="col" className={HEAD}>
                Type
              </th>
              <th scope="col" className={cn(HEAD, 'text-right')}>
                Taxable
              </th>
              <th scope="col" className={cn(HEAD, 'text-right')}>
                Tax
              </th>
              <th scope="col" className={cn(HEAD, 'text-right')}>
                Total
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {invoices.map((invoice) => {
              const href = `/accounts/invoices/${invoice.id}`;
              return (
                <tr
                  key={invoice.id}
                  className="cursor-pointer align-top transition-colors hover:bg-brand-50/60"
                  onClick={() => router.push(href)}
                >
                  <td className={cn(CELL, 'whitespace-nowrap')}>
                    <Link
                      href={href}
                      className="font-medium text-ink hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {invoice.number}
                    </Link>
                  </td>
                  <td className={cn(CELL, 'whitespace-nowrap text-ink-soft')}>
                    {formatDate(invoice.issuedOn)}
                  </td>
                  <td className={CELL}>
                    <p className="text-ink">{invoice.buyer.name}</p>
                    {invoice.buyer.gstin && (
                      <p className="text-[13px] whitespace-nowrap text-ink-faint">
                        GSTIN {invoice.buyer.gstin}
                      </p>
                    )}
                  </td>
                  {showProperty && (
                    <td className={cn(CELL, 'text-ink-soft')}>
                      {propertyNames.get(invoice.propertyId) ?? invoice.seller.name}
                    </td>
                  )}
                  <td className={CELL}>
                    {invoice.type === 'credit_note' ? (
                      <Badge tone="warning">Credit note</Badge>
                    ) : (
                      <Badge tone="neutral">Invoice</Badge>
                    )}
                  </td>
                  <td className={cn(CELL, AMOUNT, 'text-ink-soft')}>
                    {money(invoice.totals.taxable, invoice.currency)}
                  </td>
                  <td className={cn(CELL, AMOUNT, 'text-ink-soft')}>
                    {money(invoice.totals.taxTotal, invoice.currency)}
                  </td>
                  <td className={cn(CELL, AMOUNT, 'font-medium text-ink')}>
                    {money(invoice.totals.total, invoice.currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {totals && invoices.length > 1 && (
            <tfoot>
              <tr className="border-t border-line-strong bg-sunken/60 text-sm font-medium text-ink">
                <th
                  scope="row"
                  colSpan={showProperty ? 5 : 4}
                  className={cn(CELL, 'text-left font-medium')}
                >
                  Total of the {plural(invoices.length, 'row')} listed
                </th>
                <td className={cn(CELL, AMOUNT)}>{money(totals.taxable, totals.currency)}</td>
                <td className={cn(CELL, AMOUNT)}>{money(totals.tax, totals.currency)}</td>
                <td className={cn(CELL, AMOUNT)}>{money(totals.total, totals.currency)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}
