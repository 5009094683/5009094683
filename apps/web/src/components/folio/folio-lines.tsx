'use client';

import { Ban, ExternalLink, MoreHorizontal, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Menu, MenuItem, Tooltip } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatDay, formatMoney } from '@/lib/format';
import { invoiceHref } from './invoice-dialog';
import { isCharge, lineTotal } from './labels';
import type { Folio, FolioLine, Invoice } from './types';

const MONEY_TONES: Partial<Record<FolioLine['kind'], string>> = {
  payment: 'text-success-700',
  refund: 'text-warning-700',
  transfer: 'text-info-700',
};

function InvoiceBadge({ invoiceId, invoice }: { invoiceId: string; invoice?: Invoice }) {
  const what = invoice?.type === 'credit_note' ? 'credit note' : 'invoice';
  return (
    <Tooltip
      content={
        invoice?.type === 'credit_note'
          ? 'Open the credit note in a new tab.'
          : 'Open the invoice in a new tab. A mistake on an invoice is corrected with a credit note.'
      }
    >
      <a
        href={invoiceHref(invoiceId)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-flex rounded-full hover:underline"
        aria-label={`Open ${what} ${invoice?.number ?? ''} in a new tab`}
      >
        <Badge tone="info">
          {invoice?.number ?? `On an ${what}`}
          <ExternalLink className="size-3" aria-hidden />
        </Badge>
      </a>
    </Tooltip>
  );
}

/**
 * The entries on a folio, oldest first. Money received is a negative total, as it is in the
 * balance: charges add to what is owed and payments take away from it.
 */
export function FolioLines({
  folio,
  invoices,
  onVoid,
  onRefund,
}: {
  folio: Folio;
  invoices: Invoice[];
  /** Absent when the user may not void. */
  onVoid?: (line: FolioLine) => void;
  /** Absent when the user may not refund. */
  onRefund?: (line: FolioLine) => void;
}) {
  const currency = folio.currency;
  const hasMenus = Boolean(onVoid || onRefund);

  return (
    // Positioned, so that the visually hidden column heading scrolls with the table instead of
    // widening the page.
    <div className="scrollbar-thin relative overflow-x-auto">
      <table className="w-full min-w-[27rem] text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-faint">
            <th scope="col" className="py-1.5 pr-2 pl-3 font-medium">
              Day
            </th>
            <th scope="col" className="px-2 py-1.5 font-medium">
              Description
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Tax
            </th>
            <th
              scope="col"
              className={cn('py-1.5 pl-2 text-right font-medium', !hasMenus && 'pr-3')}
            >
              Total
            </th>
            {hasMenus && (
              <th scope="col" className="w-9 py-1.5 pr-1">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {folio.lines.map((line) => {
            const voided = Boolean(line.voidedAt);
            const charge = isCharge(line);
            const canVoid =
              onVoid && charge && !voided && !line.invoiceId && folio.status === 'open';
            const canRefund =
              onRefund && line.kind === 'payment' && !voided && line.paymentId && line.amount < 0;
            const struck = voided && 'text-ink-faint line-through';
            return (
              <tr key={line.id} className="align-top">
                <td className="tabular py-2 pr-2 pl-3 whitespace-nowrap text-ink-soft">
                  {formatDay(line.businessDate)}
                </td>
                <td className="px-2 py-2">
                  <span className={cn('text-ink', struck)}>
                    {line.description}
                    {line.quantity > 1 ? ` × ${line.quantity}` : ''}
                  </span>
                  {line.kind === 'discount' && <Badge className="ml-1.5">Discount</Badge>}
                  {voided && (
                    <span className="mt-0.5 block text-xs text-ink-soft">
                      Voided: {line.voidReason ?? 'no reason given'}
                    </span>
                  )}
                  {line.invoiceId && (
                    <span className="block">
                      <InvoiceBadge
                        invoiceId={line.invoiceId}
                        invoice={invoices.find((candidate) => candidate.id === line.invoiceId)}
                      />
                    </span>
                  )}
                </td>
                <td className={cn('tabular px-2 py-2 text-right whitespace-nowrap', struck)}>
                  {charge ? formatMoney(line.amount, currency) : ''}
                </td>
                <td className={cn('tabular px-2 py-2 text-right whitespace-nowrap', struck)}>
                  {charge ? formatMoney(line.taxAmount, currency) : ''}
                </td>
                <td
                  className={cn(
                    'tabular py-2 pl-2 text-right font-medium whitespace-nowrap',
                    !hasMenus && 'pr-3',
                    struck || MONEY_TONES[line.kind] || 'text-ink',
                  )}
                >
                  {formatMoney(lineTotal(line), currency)}
                </td>
                {hasMenus && (
                  <td className="py-1 pr-1 text-right">
                    {(canVoid || canRefund) && (
                      <Menu
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label={`Actions for ${line.description}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        }
                      >
                        {canVoid && (
                          <MenuItem icon={<Ban />} tone="danger" onSelect={() => onVoid(line)}>
                            Void
                          </MenuItem>
                        )}
                        {canRefund && (
                          <MenuItem icon={<Undo2 />} onSelect={() => onRefund(line)}>
                            Refund
                          </MenuItem>
                        )}
                      </Menu>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
