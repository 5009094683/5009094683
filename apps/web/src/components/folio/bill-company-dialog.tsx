'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import { useCompanies } from './data';
import type { Company, Folio } from './types';

/** What a company owes on account against its credit limit, in words. */
export function CompanyCredit({
  company,
  adding,
  currency,
}: {
  company: Company;
  /** An amount about to be added to the account. */
  adding: number;
  currency: string;
}) {
  const after = company.outstanding + adding;
  const over = company.creditLimit !== null && after > company.creditLimit;
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-sunken px-3 py-2.5 text-[13px]">
        <dt className="text-ink-soft">Already owes</dt>
        <dd className="tabular text-right text-ink">
          {formatMoney(company.outstanding, currency)}
        </dd>
        <dt className="text-ink-soft">Credit limit</dt>
        <dd className="tabular text-right text-ink">
          {company.creditLimit === null ? 'No limit' : formatMoney(company.creditLimit, currency)}
        </dd>
        <dt className="text-ink-soft">Will owe after this</dt>
        <dd className="tabular text-right font-medium text-ink">{formatMoney(after, currency)}</dd>
      </dl>
      {over && (
        <Notice tone="warning">
          This would take {company.name} over its credit limit, and is refused when it does. Take
          payment for part of the bill first, or have the limit raised.
        </Notice>
      )}
    </div>
  );
}

/** Moves what is owed on a folio to a company's account, to be paid later. */
export function BillCompanyDialog({
  folio,
  reservation,
  onClose,
  onDone,
}: {
  folio: Folio;
  reservation: Reservation;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { companies, error, isLoading } = useCompanies();
  const preferred = folio.companyId ?? reservation.company?.id ?? '';
  const [picked, setPicked] = useState<string | null>(null);
  const companyId = picked ?? (companies.some((c) => c.id === preferred) ? preferred : '');
  const company = companies.find((c) => c.id === companyId);
  const owed = folio.totals.balance;
  const currency = folio.currency;

  const save = useAction(async (target: Company) => {
    const { amount } = await api<{ amount: number }>(`/folios/${folio.id}/bill-company`, {
      body: { companyId: target.id },
    });
    toast.success(`${formatMoney(amount, currency)} billed to ${target.name}`);
    onDone();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (company) void save.run(company);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Bill to company"
      description={`Moves the ${formatMoney(owed, currency)} owed on ${folio.label} to the company's account. The company pays it later.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="folio-bill-company-form"
            variant="primary"
            loading={save.busy}
            disabled={!company}
          >
            Bill {formatMoney(owed, currency)} to company
          </Button>
        </>
      }
    >
      <form id="folio-bill-company-form" onSubmit={submit} className="flex flex-col gap-3">
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        {error ? (
          <Notice tone="danger">{errorMessage(error)}</Notice>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-sm text-ink-faint">
            <Spinner /> Loading companies…
          </div>
        ) : companies.length === 0 ? (
          <Notice tone="info">No company has been set up yet, so there is none to bill.</Notice>
        ) : (
          <>
            <Field label="Company">
              {(props) => (
                <Select
                  {...props}
                  value={companyId}
                  onChange={(e) => setPicked(e.target.value)}
                  autoFocus
                  required
                >
                  <option value="">Choose a company</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.kind === 'travel_agent' ? ' (travel agent)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {company && <CompanyCredit company={company} adding={owed} currency={currency} />}
          </>
        )}
      </form>
    </Dialog>
  );
}
