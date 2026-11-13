'use client';

import { Download, ReceiptText } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';
import useSWR from 'swr';
import { isValidDate } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Segmented, Select } from '@/components/ui/field';
import {
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { useProperties } from '@/lib/hooks';
import { downloadCsv, invoicesCsv } from './invoice-csv';
import { InvoiceTable } from './invoice-table';
import { NoAccess } from './no-access';
import type { Invoice } from './types';

type TypeFilter = 'all' | 'invoice' | 'credit_note';

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'Both' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'credit_note', label: 'Credit notes' },
];

/** The most the server lists at once. */
const LIMIT = 1000;

const dateParam = (value: string | null): string => (value && isValidDate(value) ? value : '');

function countText(invoices: Invoice[]): string {
  const notes = invoices.filter((invoice) => invoice.type === 'credit_note').length;
  const parts = [
    invoices.length > notes ? plural(invoices.length - notes, 'invoice') : null,
    notes > 0 ? plural(notes, 'credit note') : null,
  ];
  return parts.filter(Boolean).join(' and ');
}

/**
 * The filters live in the address, so the list comes back as it was left
 * after opening an invoice, and a filtered list can be sent to someone.
 */
function InvoiceList() {
  const auth = useAuth();
  const pathname = usePathname();
  const params = useSearchParams();
  const { properties } = useProperties();

  const readable = properties.filter((p) => auth.can('folio.read', p.id));
  const names = useMemo(() => new Map(properties.map((p) => [p.id, p.name])), [properties]);
  const wanted = params.get('property');
  const propertyId = readable.some((p) => p.id === wanted) ? (wanted ?? '') : '';
  const from = dateParam(params.get('from'));
  const to = dateParam(params.get('to'));
  const type = TYPE_OPTIONS.find((option) => option.value === params.get('type'))?.value ?? 'all';
  const filtered = propertyId !== '' || from !== '' || to !== '' || type !== 'all';
  const backwards = from !== '' && to !== '' && from > to;

  // The address is read and written directly, not through the router: two changes made one
  // straight after the other then both hold, and no request goes to the server for the page.
  const change = (changes: Record<string, string>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const text = next.toString();
    window.history.replaceState(null, '', text ? `${pathname}?${text}` : pathname);
  };
  const clear = () => window.history.replaceState(null, '', pathname);

  const { data, error, isLoading, mutate } = useSWR<{ invoices: Invoice[] }>(
    backwards
      ? null
      : `/invoices${query({
          propertyIds: propertyId,
          from,
          to,
          type: type === 'all' ? '' : type,
          limit: LIMIT,
        })}`,
  );
  const invoices = data?.invoices ?? [];

  const download = () => {
    const name = ['invoices', from && `from-${from}`, to && `to-${to}`].filter(Boolean).join('-');
    downloadCsv(`${name}.csv`, invoicesCsv(invoices, names));
  };

  const active = readable.filter((p) => p.active);
  const closed = readable.filter((p) => !p.active);
  /** With one property there is nothing to choose between and no need to name it on each row. */
  const several = readable.length > 1;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Invoices"
        description="Tax invoices and credit notes, newest first."
        actions={
          <Button
            icon={<Download className="size-4" aria-hidden />}
            onClick={download}
            disabled={invoices.length === 0}
          >
            Download CSV
          </Button>
        }
      />

      <Card className="mb-4 p-4">
        <div
          className={cn(
            'grid grid-cols-2 items-end gap-3',
            several
              ? 'lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]'
              : 'lg:grid-cols-[minmax(0,14rem)_minmax(0,14rem)_auto] lg:justify-start',
          )}
        >
          {several && (
            <Field label="Property" className="col-span-2 lg:col-span-1">
              {(props) => (
                <Select
                  {...props}
                  value={propertyId}
                  onChange={(event) => change({ property: event.target.value })}
                >
                  <option value="">All properties</option>
                  {active.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {closed.length > 0 && (
                    <optgroup label="No longer active">
                      {closed.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              )}
            </Field>
          )}
          <Field label="From">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => change({ from: event.target.value })}
              />
            )}
          </Field>
          <Field label="To">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => change({ to: event.target.value })}
              />
            )}
          </Field>
          <div className="col-span-2 flex items-center justify-between gap-3 lg:col-span-1">
            <Segmented
              label="Type"
              value={type}
              onChange={(value) => change({ type: value === 'all' ? '' : value })}
              options={TYPE_OPTIONS}
            />
            {filtered && (
              <Button variant="ghost" onClick={clear}>
                Clear
              </Button>
            )}
          </div>
        </div>
      </Card>

      {backwards ? (
        <Notice tone="warning">The first date is after the last. Change one of them.</Notice>
      ) : error && !data ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <PageLoading label="Loading invoices" />
      ) : invoices.length === 0 ? (
        <EmptyState
          icon={<ReceiptText className="size-5" />}
          title={filtered ? 'Nothing matches these filters' : 'No invoices yet'}
          description={
            filtered
              ? several
                ? 'Try other dates, another property or both types.'
                : 'Try other dates or both types.'
              : 'An invoice is issued from a folio, usually at check-out. It then shows here.'
          }
          action={filtered && <Button onClick={clear}>Clear filters</Button>}
        />
      ) : (
        <>
          <p className="mb-2 text-[13px] text-ink-soft" aria-live="polite">
            {countText(invoices)}
            {invoices.length >= LIMIT &&
              `. Only the newest ${LIMIT.toLocaleString('en')} are listed: narrow the dates to see the rest.`}
          </p>
          <InvoiceTable invoices={invoices} propertyNames={names} showProperty={several} />
        </>
      )}
    </div>
  );
}

export function InvoicesView() {
  const auth = useAuth();
  if (!auth.can('folio.read')) return <NoAccess />;
  return (
    <Suspense fallback={<PageLoading />}>
      <InvoiceList />
    </Suspense>
  );
}
