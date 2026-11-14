'use client';

import { ArrowLeft, Banknote, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { useReturnFocus } from '@/components/housekeeping/focus';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Badge, Card, EmptyState, ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { useProperties } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { ageAccounts } from './ageing';
import { overLimit, termsText } from './companies-view';
import { CompanyDialog, KIND_LABELS } from './company-dialog';
import { useAccountsCurrency } from './currency';
import { money, percentText } from './money';
import { NoAccess } from './no-access';
import { PaymentDialog, type PayableAccount } from './payment-dialog';
import type { Company, Statement, StatementEntry } from './types';

const LIST = '/accounts/companies';

function balanceText(balance: number, currency: string): string {
  if (balance > 0) return `Owes ${money(balance, currency)}`;
  if (balance < 0) return `In credit by ${money(-balance, currency)}`;
  return 'Nothing owed';
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className="text-sm break-words text-ink">{children}</dd>
    </div>
  );
}

function CompanyDetails({
  company,
  currency,
  partial,
}: {
  company: Company;
  currency: string;
  /** The viewer sees the accounts of some properties only, so the amount owed is not the whole of it. */
  partial: boolean;
}) {
  const address = [company.addressLine1, company.city, company.state, company.postalCode]
    .filter(Boolean)
    .join(', ');
  const contact = [company.contactName, company.email, company.phone].filter(Boolean);
  const over = overLimit(company);
  const agent = company.kind === 'travel_agent';
  return (
    <Card className="p-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-[13px] text-ink-soft">
            {partial ? 'Owes at the properties you can see' : 'Owes in all'}
          </dt>
          <dd
            className={cn('tabular text-xl font-semibold', over ? 'text-danger-600' : 'text-ink')}
          >
            {money(company.outstanding, currency)}
          </dd>
        </div>
        <Detail label="Credit limit">
          {company.creditLimit === null ? 'No limit' : money(company.creditLimit, currency)}
        </Detail>
        <Detail label="Payment terms">{termsText(company.paymentTermsDays)}</Detail>
        {agent ? (
          <Detail label="Commission">{percentText(company.commissionBp)}%</Detail>
        ) : (
          <Detail label="GSTIN">{company.gstin ?? 'Not given'}</Detail>
        )}
      </dl>
      {(agent || company.legalName || contact.length > 0 || address) && (
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-3">
          {agent && <Detail label="GSTIN">{company.gstin ?? 'Not given'}</Detail>}
          {company.legalName && <Detail label="Name on invoices">{company.legalName}</Detail>}
          {contact.length > 0 && (
            <Detail label="Contact">
              {contact.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </Detail>
          )}
          {address && <Detail label="Address">{address}</Detail>}
        </dl>
      )}
      {company.notes && (
        <p className="mt-4 border-t border-line pt-3 text-sm whitespace-pre-line text-ink-soft">
          {company.notes}
        </p>
      )}
    </Card>
  );
}

function Ageing({
  entries,
  currency,
  termsDays,
}: {
  entries: StatementEntry[];
  currency: string;
  /** Days the company has to pay. A band that starts later than this holds only late amounts. */
  termsDays: number;
}) {
  const ageing = ageAccounts(entries);
  const late = ageing.bands.some((band) => band.amount > 0 && band.from > termsDays);
  return (
    <section aria-label="How old the unpaid amount is">
      <h2 className="mb-2 text-sm font-semibold text-ink">How old the unpaid amount is</h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {ageing.bands.map((band) => (
          <Card key={band.label} className="px-4 py-3">
            <dt className="text-[13px] text-ink-soft">{band.label}</dt>
            <dd
              className={cn(
                'tabular text-base font-semibold',
                band.amount === 0
                  ? 'text-ink-faint'
                  : band.from > termsDays
                    ? 'text-danger-600'
                    : 'text-ink',
              )}
            >
              {money(band.amount, currency)}
            </dd>
          </Card>
        ))}
      </dl>
      <p className="mt-2 text-[13px] text-ink-faint">
        Payments are set against the oldest bills first.
        {late && ' Amounts in red are past the payment terms.'}
        {ageing.inCredit > 0 &&
          ` ${money(ageing.inCredit, currency)} has been paid beyond what was billed.`}
      </p>
    </section>
  );
}

function Entries({
  entries,
  currency,
  showProperty,
}: {
  entries: StatementEntry[];
  currency: string;
  showProperty: boolean;
}) {
  let running = 0;
  const rows = entries.map((entry) => ({ entry, balance: (running += entry.amount) }));
  return (
    <Card className="overflow-hidden">
      <div className="scrollbar-thin relative overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
              <th scope="col" className="px-4 py-2.5 font-medium">
                Date
              </th>
              {showProperty && (
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Property
                </th>
              )}
              <th scope="col" className="px-4 py-2.5 font-medium">
                Description
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Billed
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Paid
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Balance
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ entry, balance }, index) => (
              <tr key={index} className="align-top">
                <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                  {formatDate(entry.date)}
                </td>
                {showProperty && <td className="px-4 py-3 text-ink-soft">{entry.propertyName}</td>}
                <td className="px-4 py-3 text-ink">{entry.description}</td>
                <td className="tabular px-4 py-3 text-right whitespace-nowrap text-ink">
                  {entry.amount > 0 ? money(entry.amount, currency) : ''}
                </td>
                <td className="tabular px-4 py-3 text-right whitespace-nowrap text-success-700">
                  {entry.amount < 0 ? money(-entry.amount, currency) : ''}
                </td>
                <td className="tabular px-4 py-3 text-right font-medium whitespace-nowrap text-ink">
                  {money(balance, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** A company's account: what it owes at each property, how old that is, and every bill and payment. */
export function CompanyStatement({ companyId }: { companyId: string }) {
  const auth = useAuth();
  const allowed = auth.can('folio.read');
  const canManage = auth.can('accounting.manage');
  const fallbackCurrency = useAccountsCurrency();
  const { properties } = useProperties();
  const [editing, setEditing] = useState(false);
  /** The account a payment is being taken into; an empty string leaves the choice to the dialog. */
  const [paying, setPaying] = useState<string | null>(null);
  const [shown, setShown] = useState('');
  const rememberOpener = useReturnFocus(editing || paying !== null);
  const pay = (folioId: string) => {
    rememberOpener();
    setPaying(folioId);
  };

  const { data, error, isLoading, mutate } = useSWR<Statement>(
    allowed ? `/companies/${companyId}/statement` : null,
    // Another company's statement must never stand in for this one, not even for a moment.
    { keepPreviousData: false },
  );
  useLive(/^folio\./, () => void mutate());

  if (!allowed) return <NoAccess />;
  if (error && !data) {
    return (
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <ErrorState error={error} onRetry={() => void mutate()} />
        <p className="mt-3 text-center text-sm">
          <Link href={LIST} className="font-medium text-brand-700 hover:underline">
            Back to companies
          </Link>
        </p>
      </div>
    );
  }
  if (isLoading || !data) return <PageLoading label="Loading the statement" />;

  const { company } = data;
  // The server counts only the accounts at properties whose folios this person may read.
  const partial = auth.scope('folio.read') !== 'all';
  // An account does not say which property it is at; its entries do.
  const propertyOf = new Map(data.entries.map((entry) => [entry.folioId, entry.propertyId]));
  const accounts = data.accounts
    .map((account) => {
      const propertyId = propertyOf.get(account.folioId);
      return {
        ...account,
        currency: properties.find((p) => p.id === propertyId)?.currency ?? fallbackCurrency,
        canPay: propertyId !== undefined && auth.can('folio.write', propertyId),
      };
    })
    .sort((a, b) => a.propertyName.localeCompare(b.propertyName));
  const payable: PayableAccount[] = accounts.filter((account) => account.canPay);
  // Amounts in different currencies cannot share a running balance: then one account is shown at a time.
  const oneCurrency = new Set(accounts.map((account) => account.currency)).size <= 1;
  const accountId = accounts.some((account) => account.folioId === shown)
    ? shown
    : oneCurrency
      ? ''
      : (accounts[0]?.folioId ?? '');
  const entries = accountId
    ? data.entries.filter((entry) => entry.folioId === accountId)
    : data.entries;
  const currency =
    accounts.find((account) => account.folioId === accountId)?.currency ??
    accounts[0]?.currency ??
    fallbackCurrency;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={LIST}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Companies
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-ink">{company.name}</h1>
            <Badge tone="neutral">{KIND_LABELS[company.kind]}</Badge>
            {!company.active && <Badge tone="warning">Inactive</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button
              icon={<Pencil className="size-4" aria-hidden />}
              onClick={() => {
                rememberOpener();
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
          {payable.length > 0 && (
            <Button
              variant="primary"
              icon={<Banknote className="size-4" aria-hidden />}
              onClick={() => pay('')}
            >
              Record payment
            </Button>
          )}
        </div>
      </div>

      {overLimit(company) && company.creditLimit !== null && (
        <Notice tone="danger" title="Over its credit limit">
          {company.name} owes {money(company.outstanding - company.creditLimit, fallbackCurrency)}{' '}
          more than its limit of {money(company.creditLimit, fallbackCurrency)}
          {partial && ', counting only the properties you can see'}. Nothing more can be billed to
          it until it pays or the limit is raised.
        </Notice>
      )}

      <CompanyDetails company={company} currency={fallbackCurrency} partial={partial} />
      {partial && (
        <p className="-mt-3 text-[13px] text-ink-faint">
          What {company.name} owes at other properties is not shown here. It counts towards the
          credit limit as well.
        </p>
      )}

      {accounts.length === 0 ? (
        <EmptyState
          icon={<Banknote className="size-5" />}
          title="Nothing has been billed to this company yet"
          description="When a stay is billed to it from the folio, the bill shows here."
        />
      ) : (
        <>
          <section aria-label="Accounts">
            <h2 className="mb-2 text-sm font-semibold text-ink">
              {accounts.length === 1 ? 'Account' : 'Accounts, one for each property'}
            </h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {accounts.map((account) => (
                <li key={account.folioId}>
                  <Card className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">
                        {account.propertyName}
                      </p>
                      <p
                        className={cn(
                          'tabular text-[13px]',
                          account.balance > 0 ? 'text-ink-soft' : 'text-success-700',
                        )}
                      >
                        {balanceText(account.balance, account.currency)}
                      </p>
                    </div>
                    {account.canPay && accounts.length > 1 && (
                      <Button
                        size="sm"
                        aria-label={`Record payment for ${account.propertyName}`}
                        onClick={() => pay(account.folioId)}
                      >
                        Record payment
                      </Button>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          </section>

          <Ageing entries={entries} currency={currency} termsDays={company.paymentTermsDays} />

          <section aria-label="Statement">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">Statement</h2>
              {accounts.length > 1 && (
                <Select
                  aria-label="Account shown"
                  className="w-auto"
                  value={accountId}
                  onChange={(event) => setShown(event.target.value)}
                >
                  {oneCurrency && <option value="">All properties</option>}
                  {accounts.map((account) => (
                    <option key={account.folioId} value={account.folioId}>
                      {account.propertyName}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <Entries
              entries={entries}
              currency={currency}
              showProperty={accounts.length > 1 && accountId === ''}
            />
          </section>
        </>
      )}

      {editing && (
        <CompanyDialog
          company={company}
          onClose={() => setEditing(false)}
          onSaved={() => void mutate()}
        />
      )}
      {paying !== null && (
        <PaymentDialog
          companyName={company.name}
          // Opened from one account's card, the payment is for that account and no other.
          accounts={paying ? payable.filter((account) => account.folioId === paying) : payable}
          onClose={() => setPaying(null)}
          onSaved={() => void mutate()}
        />
      )}
    </div>
  );
}
