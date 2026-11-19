'use client';

import {
  ArrowRightLeft,
  Banknote,
  Building2,
  FileText,
  Lock,
  LockOpen,
  MoreHorizontal,
  Percent,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Card, Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';
import { FolioLines } from './folio-lines';
import { invoiceableLines } from './invoice-dialog';
import { BALANCE_TEXT_TONES, KIND_LABELS, balanceText } from './labels';
import type { Folio, FolioLine, Invoice, TaxedKind } from './types';

export type FolioAction =
  | {
      kind: 'charge' | 'discount' | 'payment' | 'move' | 'company' | 'invoice' | 'close' | 'reopen';
      folio: Folio;
    }
  | { kind: 'void' | 'refund'; folio: Folio; line: FolioLine };

function takes(folio: Folio): string {
  return folio.routes
    .map((kind) => (KIND_LABELS[kind as TaxedKind] ?? kind).toLowerCase())
    .join(', ');
}

/** One folio: who pays it, its entries, its totals and what can be done with it. */
export function FolioCard({
  folio,
  guestName,
  invoices,
  several,
  canWrite,
  canRefund,
  busy,
  onAction,
}: {
  folio: Folio;
  /** The reservation's guest, who a folio is billed to unless it says otherwise. */
  guestName: string;
  invoices: Invoice[];
  /** Whether the reservation has other folios: charges can then be moved here, and each folio shows its own balance. */
  several: boolean;
  canWrite: boolean;
  canRefund: boolean;
  /** True while this folio is being closed or reopened. */
  busy: boolean;
  onAction: (action: FolioAction) => void;
}) {
  const currency = folio.currency;
  const open = folio.status === 'open';
  const { totals } = folio;
  const balance = balanceText(totals.balance, currency);
  const billedTo = folio.companyId || folio.billTo.name !== guestName ? folio.billTo.name : null;
  const canInvoice = invoiceableLines(folio).length > 0;
  // Nothing on a closed folio can be voided, so its lines get no menu for that.
  const onVoid =
    canWrite && open ? (line: FolioLine) => onAction({ kind: 'void', folio, line }) : undefined;
  const onRefund = canRefund
    ? (line: FolioLine) => onAction({ kind: 'refund', folio, line })
    : undefined;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 pt-3 pb-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-medium text-ink">{folio.label}</h4>
            <Badge tone={open ? 'success' : 'neutral'}>{open ? 'Open' : 'Closed'}</Badge>
          </div>
          {(billedTo || folio.routes.length > 0) && (
            <p className="mt-0.5 text-[13px] text-ink-soft">
              {[
                billedTo && `Billed to ${billedTo}`,
                folio.routes.length > 0 && `Takes: ${takes(folio)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        {several && (
          <p className={cn('text-sm font-medium', BALANCE_TEXT_TONES[balance.tone])}>
            {balance.text}
          </p>
        )}
      </div>

      {folio.lines.length === 0 ? (
        <p className="border-t border-line px-3 py-3 text-[13px] text-ink-faint">
          Nothing on this folio yet.
        </p>
      ) : (
        <div className="border-t border-line">
          <FolioLines folio={folio} invoices={invoices} onVoid={onVoid} onRefund={onRefund} />
          <dl
            className={cn(
              'grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 border-t border-line py-2.5 pl-3 text-[13px]',
              // Lines up with the Total column, which stops short of the per-line menus.
              onVoid || onRefund ? 'pr-10' : 'pr-3',
            )}
          >
            <dt className="text-ink-soft">Charges</dt>
            <dd className="tabular text-right text-ink">{formatMoney(totals.charges, currency)}</dd>
            <dt className="text-ink-soft">Taxes</dt>
            <dd className="tabular text-right text-ink">{formatMoney(totals.taxes, currency)}</dd>
            <dt className="text-ink-soft">Paid</dt>
            <dd className="tabular text-right text-ink">
              {formatMoney(totals.payments === 0 ? 0 : -totals.payments, currency)}
            </dd>
            {totals.transfers !== 0 && (
              <>
                <dt className="text-ink-soft">Moved</dt>
                <dd className="tabular text-right text-ink">
                  {formatMoney(totals.transfers, currency)}
                </dd>
              </>
            )}
            <dt className="font-medium text-ink">Balance</dt>
            <dd
              className={cn(
                'tabular text-right font-semibold',
                totals.balance > 0 ? 'text-danger-700' : 'text-ink',
              )}
            >
              {formatMoney(totals.balance, currency)}
            </dd>
          </dl>
        </div>
      )}

      {canWrite && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-sunken/50 px-3 py-2.5">
          {open ? (
            <>
              <Button
                size="sm"
                icon={<Plus className="size-3.5" />}
                onClick={() => onAction({ kind: 'charge', folio })}
              >
                Add charge
              </Button>
              <Button
                size="sm"
                icon={<Banknote className="size-3.5" />}
                onClick={() => onAction({ kind: 'payment', folio })}
              >
                Record payment
              </Button>
              {canInvoice && (
                <Button
                  size="sm"
                  icon={<FileText className="size-3.5" />}
                  onClick={() => onAction({ kind: 'invoice', folio })}
                >
                  Issue invoice
                </Button>
              )}
              <Menu
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`More actions for ${folio.label}`}
                    loading={busy}
                  >
                    {!busy && <MoreHorizontal className="size-4" />}
                  </Button>
                }
              >
                <MenuItem icon={<Percent />} onSelect={() => onAction({ kind: 'discount', folio })}>
                  Add discount
                </MenuItem>
                {several && (
                  <MenuItem
                    icon={<ArrowRightLeft />}
                    onSelect={() => onAction({ kind: 'move', folio })}
                  >
                    Move charges here
                  </MenuItem>
                )}
                {totals.balance > 0 && (
                  <MenuItem
                    icon={<Building2 />}
                    onSelect={() => onAction({ kind: 'company', folio })}
                  >
                    Bill to company
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem
                  icon={<Lock />}
                  disabled={totals.balance !== 0}
                  onSelect={() => onAction({ kind: 'close', folio })}
                >
                  Close folio
                </MenuItem>
                {totals.balance !== 0 && (
                  <MenuLabel>The balance must be zero to close it.</MenuLabel>
                )}
              </Menu>
            </>
          ) : (
            <>
              {canInvoice && (
                <Button
                  size="sm"
                  icon={<FileText className="size-3.5" />}
                  onClick={() => onAction({ kind: 'invoice', folio })}
                >
                  Issue invoice
                </Button>
              )}
              <Button
                size="sm"
                icon={<LockOpen className="size-3.5" />}
                loading={busy}
                onClick={() => onAction({ kind: 'reopen', folio })}
              >
                Reopen folio
              </Button>
              <p className="basis-full text-xs text-ink-faint">
                A closed folio takes no charges or payments until it is reopened.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
