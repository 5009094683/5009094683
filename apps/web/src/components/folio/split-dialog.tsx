'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import {
  BillToFields,
  billToDraft,
  billToErrors,
  billToFromDraft,
  type BillToDraft,
  type BillToErrors,
} from './bill-to-fields';
import { useCompanies } from './data';
import { KIND_LABELS, TAXED_KINDS } from './labels';
import type { Folio, TaxedKind } from './types';

/** Adds a folio to the reservation so that the bill can be split, for example between a company and the guest. */
export function SplitDialog({
  reservation,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { companies } = useCompanies();
  const [label, setLabel] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [routes, setRoutes] = useState<TaxedKind[]>([]);
  const [ownBillTo, setOwnBillTo] = useState(false);
  const [billTo, setBillTo] = useState<BillToDraft>(billToDraft());
  const [billToProblems, setBillToProblems] = useState<BillToErrors | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);

  // The reservation's own company is offered even if it has since been made inactive.
  const linked = reservation.company;
  const options =
    linked && !companies.some((c) => c.id === linked.id)
      ? [{ id: linked.id, name: linked.name }, ...companies]
      : companies;
  const company = options.find((c) => c.id === companyId);

  const chooseCompany = (id: string) => {
    setCompanyId(id);
    const chosen = options.find((c) => c.id === id);
    if (chosen && (!label.trim() || label === company?.name)) {
      setLabel(chosen.name);
      setLabelError(null);
    }
  };

  const save = useAction(async () => {
    const folio = await api<Folio>(`/reservations/${reservation.id}/folios`, {
      body: {
        label: label.trim(),
        ...(companyId ? { companyId } : {}),
        ...(routes.length > 0 ? { routes } : {}),
        ...(ownBillTo ? { billTo: billToFromDraft(billTo) } : {}),
      },
    });
    toast.success(`Folio "${folio.label}" added`);
    onDone();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems = ownBillTo ? billToErrors(billTo) : null;
    setBillToProblems(problems);
    setLabelError(label.trim() ? null : 'Give the folio a name.');
    if (problems || !label.trim()) return;
    void save.run();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Split bill"
      description="Adds a second folio to this reservation, so that part of the bill can be paid by someone else."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="folio-split-form" variant="primary" loading={save.busy}>
            Add folio
          </Button>
        </>
      }
    >
      <form id="folio-split-form" onSubmit={submit} className="flex flex-col gap-4">
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name of the new folio" hint="Such as Company or Extras." error={labelError}>
            {(props) => (
              <Input
                {...props}
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setLabelError(null);
                }}
                maxLength={80}
                autoFocus
                required
              />
            )}
          </Field>
          <Field label="Company that pays it" optional>
            {(props) => (
              <Select {...props} value={companyId} onChange={(e) => chooseCompany(e.target.value)}>
                <option value="">No company</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-[13px] font-medium text-ink-soft">
            Charges it takes from now on{' '}
            <span className="font-normal text-ink-faint">(optional)</span>
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
            {TAXED_KINDS.map((kind) => (
              <Checkbox
                key={kind}
                label={KIND_LABELS[kind]}
                checked={routes.includes(kind)}
                onChange={(e) =>
                  setRoutes(e.target.checked ? [...routes, kind] : routes.filter((k) => k !== kind))
                }
              />
            ))}
          </div>
          <p className="text-[13px] text-ink-faint">
            New charges of the ticked kinds go to this folio. Charges already made stay where they
            are: move them afterwards with Move charges here.
          </p>
        </fieldset>

        <div className="flex flex-col gap-3">
          <Checkbox
            label="Make the bill out to someone else"
            checked={ownBillTo}
            onChange={(e) => setOwnBillTo(e.target.checked)}
          />
          {ownBillTo ? (
            <BillToFields
              draft={billTo}
              onChange={(next) => {
                setBillTo(next);
                setBillToProblems(null);
              }}
              errors={billToProblems}
            />
          ) : (
            <p className="text-[13px] text-ink-faint">
              {company
                ? `It is made out to ${company.name}.`
                : `It is made out to the guest, ${reservation.guestName}.`}
            </p>
          )}
        </div>
      </form>
    </Dialog>
  );
}
