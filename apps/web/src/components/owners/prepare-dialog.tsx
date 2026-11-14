'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { api, errorMessage, query } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Contract, Statement } from './types';
import { STATUS_LABELS, localToday, monthKey, monthLabel, shiftMonth, villaName } from './words';

/** A contract to prepare a statement for, with the name of its owner. */
export interface PreparableContract {
  contract: Contract;
  ownerName: string;
}

/** The months a contract covers up to now, newest first. */
function monthsOf(contract: Contract, thisMonth: string): string[] {
  const first = monthKey(contract.startsOn);
  const end = contract.endsOn ? monthKey(contract.endsOn) : thisMonth;
  const last = end < thisMonth ? end : thisMonth;
  const out: string[] = [];
  // A contract that began long ago still offers a list that can be read.
  for (let month = last; month >= first && out.length < 120; month = shiftMonth(month, -1)) {
    out.push(month);
  }
  return out;
}

/**
 * Works out the statement of one contract for one month as a draft, or works
 * an existing draft out again. There is no way to prepare every contract at
 * once: the server drafts the month just ended by itself.
 */
export function PrepareDialog({
  contracts,
  onClose,
  onPrepared,
}: {
  /** The contracts to choose from. With one, there is nothing to choose. */
  contracts: PreparableContract[];
  onClose: () => void;
  onPrepared: (statement: Statement) => void;
}) {
  const thisMonth = monthKey(localToday());
  const lastMonth = shiftMonth(thisMonth, -1);
  const [contractId, setContractId] = useState(
    contracts.length === 1 ? contracts[0]!.contract.id : '',
  );
  const [chosenMonth, setChosenMonth] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const chosen = contracts.find((entry) => entry.contract.id === contractId);
  const months = useMemo(
    () => (chosen ? monthsOf(chosen.contract, thisMonth) : []),
    [chosen, thisMonth],
  );
  // The statements the contract has, to say which months are taken. Asked for here so that
  // a filter on the list behind this dialog cannot hide any of them.
  const taken = useSWR<{ statements: Statement[] }>(
    contractId ? `/owner-statements${query({ contractId })}` : null,
    { keepPreviousData: false },
  );
  const existing = useMemo(() => {
    const byMonth = new Map<string, Statement>();
    for (const statement of taken.data?.statements ?? []) {
      byMonth.set(monthKey(statement.periodStart), statement);
    }
    return byMonth;
  }, [taken.data]);
  const ready = taken.data !== undefined;

  const open = (month: string) => (existing.get(month)?.status ?? 'draft') === 'draft';
  // The month just ended is the one most often wanted, then the month under way.
  const suggested =
    [lastMonth, thisMonth].find((month) => months.includes(month) && !existing.has(month)) ??
    months.find((month) => !existing.has(month)) ??
    months.find(open) ??
    '';
  const month = chosenMonth && months.includes(chosenMonth) ? chosenMonth : suggested;
  const draft = existing.get(month)?.status === 'draft';

  const prepare = useAction(async () => {
    if (!chosen) {
      setProblem('Choose the villa the statement is for.');
      return;
    }
    if (!ready || !month) return;
    setProblem(null);
    const statement = await api<Statement>(`/owner-contracts/${chosen.contract.id}/statements`, {
      body: { month },
    });
    onPrepared(statement);
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Prepare a statement"
      description="Works out what a villa earned in a month and what its owner is owed, as a draft for you to check."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="prepare-form"
            variant="primary"
            loading={prepare.busy}
            disabled={Boolean(chosen) && (!ready || !month)}
          >
            {draft ? 'Prepare again' : 'Prepare'}
          </Button>
        </>
      }
    >
      <form
        id="prepare-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void prepare.run();
        }}
        className="flex flex-col gap-3"
      >
        <FormError message={prepare.error ? `Could not prepare it. ${prepare.error}` : null} />
        {contracts.length === 1 && chosen ? (
          <p className="text-sm text-ink">
            {villaName(chosen.contract)}
            <span className="text-ink-soft"> · {chosen.ownerName}</span>
          </p>
        ) : (
          <Field label="Villa" error={problem}>
            {(props) => (
              <Select
                {...props}
                value={contractId}
                onChange={(event) => {
                  setContractId(event.target.value);
                  setChosenMonth('');
                  setProblem(null);
                }}
              >
                <option value="">Choose a villa</option>
                {contracts.map(({ contract, ownerName }) => (
                  <option key={contract.id} value={contract.id}>
                    {villaName(contract)} · {ownerName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field
          label="Month"
          hint={
            !chosen
              ? 'Choose the villa first.'
              : taken.error && !ready
                ? `The statements of this contract could not be loaded. ${errorMessage(taken.error)}`
                : !ready
                  ? 'Looking up which months have a statement…'
                  : months.length === 0
                    ? 'This contract has not started yet, so there is no month to prepare.'
                    : !month
                      ? 'Every month of this contract has been issued already.'
                      : draft
                        ? 'A draft exists for this month. It is worked out again from the stays and costs as they are now; its adjustments and note are kept.'
                        : month === thisMonth
                          ? 'This month is not over: the draft shows it so far, and can be issued once the month has ended.'
                          : undefined
          }
        >
          {(props) => (
            <Select
              {...props}
              value={month}
              disabled={!chosen || !ready || !month}
              onChange={(event) => setChosenMonth(event.target.value)}
            >
              {(!ready || !month) && <option value="">{ready ? 'No month to prepare' : ''}</option>}
              {(ready ? months : []).map((value) => {
                const statement = existing.get(value);
                return (
                  <option key={value} value={value} disabled={!open(value)}>
                    {monthLabel(value)}
                    {statement && ` (${STATUS_LABELS[statement.status].toLowerCase()})`}
                  </option>
                );
              })}
            </Select>
          )}
        </Field>
        <p className="text-[13px] text-ink-faint">
          Only stays whose guests have arrived are counted: a booking still to come, a cancellation
          or a no-show adds nothing. At the start of each month a draft for the month just ended is
          prepared automatically for every contract, so this is for looking at a month early or
          bringing a draft up to date.
        </p>
      </form>
    </Dialog>
  );
}
