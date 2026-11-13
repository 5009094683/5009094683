'use client';

import { Download, Landmark } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import type { TaxRegister } from '@pms/domain';
import { addDays, isValidDate, monthOf, todayIn } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { downloadFromApi } from '@/lib/download';
import { formatDate, plural } from '@/lib/format';
import { useAction, useProperties } from '@/lib/hooks';
import type { Serialized } from '@/lib/types';
import { money } from './money';
import { NoAccess } from './no-access';

type Register = Serialized<TaxRegister>;

/** The most lines shown on screen. The file always has them all. */
const SHOWN = 200;

const dateParam = (value: string | null): string => (value && isValidDate(value) ? value : '');

const percent = (rateBp: number): string => `${rateBp / 100}%`;

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="p-4">
      <p className="text-[13px] text-ink-soft">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold text-ink">{value}</p>
      {note && <p className="mt-0.5 text-[13px] text-ink-faint">{note}</p>}
    </Card>
  );
}

const TH = 'px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-ink-soft';
const TD = 'px-3 py-2 align-top text-sm text-ink';
const NUM = 'tabular text-right whitespace-nowrap';

function ByRate({ register, currency }: { register: Register; currency: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="border-b border-line px-4 py-3 text-left text-sm font-semibold text-ink">
            By tax rate
            <span className="block text-[13px] font-normal text-ink-soft">
              Sales to customers with a GSTIN apart from the rest, as the return asks for them.
            </span>
          </caption>
          <thead>
            <tr className="border-b border-line bg-sunken/60">
              <th scope="col" className={TH}>
                Rate
              </th>
              <th scope="col" className={TH}>
                Sold to
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Taxable value
              </th>
              {register.components.map((code) => (
                <th key={code} scope="col" className={`${TH} text-right`}>
                  {code}
                </th>
              ))}
              <th scope="col" className={`${TH} text-right`}>
                Tax
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {register.summary.map((line) => (
              <tr
                key={`${line.rateBp}-${line.registered}`}
                className="border-b border-line last:border-0"
              >
                <th scope="row" className={`${TD} text-left font-medium`}>
                  {percent(line.rateBp)}
                </th>
                <td className={TD}>
                  {line.registered ? 'Registered businesses' : 'Everyone else'}
                </td>
                <td className={`${TD} ${NUM}`}>{money(line.taxable, currency)}</td>
                {register.components.map((code) => (
                  <td key={code} className={`${TD} ${NUM}`}>
                    {money(line.taxes[code] ?? 0, currency)}
                  </td>
                ))}
                <td className={`${TD} ${NUM}`}>{money(line.taxTotal, currency)}</td>
                <td className={`${TD} ${NUM}`}>{money(line.total, currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-sunken/60 font-semibold">
              <th scope="row" colSpan={2} className={`${TD} text-left`}>
                Total
              </th>
              <td className={`${TD} ${NUM}`}>{money(register.total.taxable, currency)}</td>
              {register.components.map((code) => (
                <td key={code} className={`${TD} ${NUM}`}>
                  {money(register.total.taxes[code] ?? 0, currency)}
                </td>
              ))}
              <td className={`${TD} ${NUM}`}>{money(register.total.taxTotal, currency)}</td>
              <td className={`${TD} ${NUM}`}>{money(register.total.total, currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

function Lines({
  register,
  currency,
  showProperty,
}: {
  register: Register;
  currency: string;
  showProperty: boolean;
}) {
  const rows = register.rows.slice(0, SHOWN);
  return (
    <Card className="overflow-hidden">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="border-b border-line px-4 py-3 text-left text-sm font-semibold text-ink">
            Document by document
            <span className="block text-[13px] font-normal text-ink-soft">
              One line for each service code and rate on a document. Credit notes are negative.
            </span>
          </caption>
          <thead>
            <tr className="border-b border-line bg-sunken/60">
              <th scope="col" className={TH}>
                Number
              </th>
              <th scope="col" className={TH}>
                Date
              </th>
              {showProperty && (
                <th scope="col" className={TH}>
                  Property
                </th>
              )}
              <th scope="col" className={TH}>
                Customer
              </th>
              <th scope="col" className={TH}>
                Service code
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Rate
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Taxable value
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Tax
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={`${row.number}-${row.serviceCode}-${row.rateBp}-${index}`}
                className="border-b border-line last:border-0"
              >
                <th scope="row" className={`${TD} text-left font-medium whitespace-nowrap`}>
                  {row.number}
                  {row.type === 'credit_note' && (
                    <span className="block text-xs font-normal text-ink-faint">
                      Credit note{row.againstNumber ? ` against ${row.againstNumber}` : ''}
                    </span>
                  )}
                </th>
                <td className={`${TD} whitespace-nowrap`}>{formatDate(row.issuedOn)}</td>
                {showProperty && <td className={TD}>{row.propertyName}</td>}
                <td className={TD}>
                  {row.buyerName}
                  {row.buyerGstin && (
                    <span className="block font-mono text-xs text-ink-faint">{row.buyerGstin}</span>
                  )}
                </td>
                <td className={`${TD} font-mono text-[13px]`}>{row.serviceCode ?? ''}</td>
                <td className={`${TD} ${NUM}`}>{percent(row.rateBp)}</td>
                <td className={`${TD} ${NUM}`}>{money(row.taxable, currency)}</td>
                <td className={`${TD} ${NUM}`}>{money(row.taxTotal, currency)}</td>
                <td className={`${TD} ${NUM}`}>{money(row.total, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {register.rows.length > SHOWN && (
        <p className="border-t border-line px-4 py-3 text-[13px] text-ink-soft">
          The first {SHOWN} of {register.rows.length.toLocaleString('en')} lines are shown. The file
          has them all.
        </p>
      )}
    </Card>
  );
}

/**
 * The filters live in the address, so a month's register can be bookmarked or sent to the
 * accountant as a link.
 */
function Register() {
  const auth = useAuth();
  const toast = useToast();
  const pathname = usePathname();
  const params = useSearchParams();
  const { properties } = useProperties();
  const readable = properties.filter((p) => auth.can('folio.read', p.id));

  // A return is made for a month just ended: that is the period to start from.
  const [lastMonth] = useState(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return monthOf(addDays(monthOf(todayIn(zone)).start, -1));
  });
  const wanted = params.get('property');
  const propertyId = readable.some((p) => p.id === wanted) ? (wanted ?? '') : '';
  const from = dateParam(params.get('from')) || lastMonth.start;
  const to = dateParam(params.get('to')) || addDays(lastMonth.end, -1);
  const backwards = from > to;

  const change = (changes: Record<string, string>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const text = next.toString();
    window.history.replaceState(null, '', text ? `${pathname}?${text}` : pathname);
  };

  // The server's period ends on the first day not covered.
  const asked = `/reports/tax-register${query({ propertyIds: propertyId, from, to: addDays(to, 1) })}`;
  const { data, error, isLoading, mutate } = useSWR<Register>(backwards ? null : asked, {
    keepPreviousData: false,
  });
  const download = useAction(async () => {
    try {
      await downloadFromApi(`${asked}&format=csv`);
    } catch (err) {
      toast.error(err);
    }
  });

  const several = readable.length > 1;
  const currency = data?.currency ?? 'INR';
  const empty = data !== undefined && data.rows.length === 0;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Tax register"
        description="Every invoice and credit note issued in a period, by service code and tax rate: the figures for the tax return. It is a file to hand to your accountant or to load into their tool; nothing is filed from here."
        actions={
          <Button
            icon={<Download className="size-4" aria-hidden />}
            loading={download.busy}
            disabled={!data || empty}
            onClick={() => void download.run()}
          >
            Download CSV
          </Button>
        }
      />

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-2 items-end gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
          {several && (
            <Field label="Property" className="col-span-2 lg:col-span-1">
              {(props) => (
                <Select
                  {...props}
                  value={propertyId}
                  onChange={(event) => change({ property: event.target.value })}
                >
                  <option value="">All properties</option>
                  {readable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Issued from">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={from}
                max={to}
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
                min={from}
                onChange={(event) => change({ to: event.target.value })}
              />
            )}
          </Field>
        </div>
      </Card>

      {backwards ? (
        <Notice tone="warning">The first date is after the last. Change one of them.</Notice>
      ) : error && !data ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <PageLoading label="Loading the register" />
      ) : empty ? (
        <EmptyState
          icon={<Landmark className="size-5" />}
          title="Nothing was invoiced in this period"
          description="Invoices and credit notes show here by the date they were issued. Try other dates."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure
              label="Documents"
              value={plural(data.total.invoices, 'invoice')}
              note={
                data.total.creditNotes > 0
                  ? `and ${plural(data.total.creditNotes, 'credit note')}`
                  : 'No credit notes'
              }
            />
            <Figure label="Taxable value" value={money(data.total.taxable, currency)} />
            <Figure label="Tax" value={money(data.total.taxTotal, currency)} />
            <Figure label="Total invoiced" value={money(data.total.total, currency)} />
          </div>
          {data.currency === null && (
            <Notice tone="warning">
              These properties invoice in different currencies, so the totals add unlike amounts.
              Choose one property for figures you can use.
            </Notice>
          )}
          <ByRate register={data} currency={currency} />
          <Lines register={data} currency={currency} showProperty={several && !propertyId} />
          <p className="flex items-center gap-2 text-[13px] text-ink-faint">
            <Badge>Note</Badge>
            The rates and service codes are the ones each charge was posted with. Have your
            accountant confirm them before filing.
          </p>
        </div>
      )}
    </div>
  );
}

export function TaxRegisterView() {
  const auth = useAuth();
  if (!auth.can('folio.read')) return <NoAccess />;
  return (
    <Suspense fallback={<PageLoading />}>
      <Register />
    </Suspense>
  );
}
