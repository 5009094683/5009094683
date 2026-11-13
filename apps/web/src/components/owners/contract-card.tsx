'use client';

import { ChevronLeft, ChevronRight, FilePlus2, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Badge, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDay } from '@/lib/format';
import { ConfirmDialog } from './confirm-dialog';
import { ContractDialog } from './contract-dialog';
import { CostDialog } from './cost-dialog';
import { EndContractDialog } from './end-contract-dialog';
import { KeepFocus } from './keep-focus';
import { money, percentText } from './money';
import { PrepareDialog } from './prepare-dialog';
import type { Contract, Expense, Owner, Statement } from './types';
import {
  CATEGORY_LABELS,
  CONTRACT_STATE_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  basisWords,
  contractState,
  contractStateWords,
  feeWords,
  monthBounds,
  monthKey,
  monthLabel,
  ownerStayWords,
  periodWords,
  shiftMonth,
  statementMonth,
  villaName,
} from './words';

export type StatementsLoad = 'ready' | 'loading' | 'failed';

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="break-words text-ink">{children}</dd>
    </div>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold text-ink">{children}</h4>;
}

/** The costs charged to the owner on one contract, a month at a time. */
function Costs({
  contract,
  statements,
  today,
  onStatementsChanged,
}: {
  contract: Contract;
  statements: Statement[];
  today: string;
  onStatementsChanged: () => void;
}) {
  const toast = useToast();
  const first = monthKey(contract.startsOn);
  const last = contract.endsOn ? monthKey(contract.endsOn) : null;
  // Opens on the month under way, or the nearest month the contract covers.
  const [month, setMonth] = useState(() => {
    const current = monthKey(today);
    if (current < first) return first;
    return last && current > last ? last : current;
  });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Expense | null>(null);

  const { start, end } = monthBounds(month);
  const { data, error, isLoading, mutate } = useSWR<{ expenses: Expense[] }>(
    `/owner-contracts/${contract.id}/expenses?from=${start}&to=${end}`,
    // The costs of another month must not stand in for this one while it loads.
    { keepPreviousData: false },
  );
  const expenses = data?.expenses ?? [];
  const statement = statements.find((s) => s.contractId === contract.id && s.periodStart === start);
  const closed = statement !== undefined && statement.status !== 'draft';

  /** A draft holds the costs it was worked out with, so it is worked out again when they change. */
  const refreshDraft = async (changedMonth: string) => {
    const draft = statements.find(
      (s) =>
        s.contractId === contract.id &&
        s.status === 'draft' &&
        monthKey(s.periodStart) === changedMonth,
    );
    if (!draft) return;
    try {
      await api(`/owner-contracts/${contract.id}/statements`, { body: { month: changedMonth } });
    } catch (err) {
      toast.error(
        `The draft statement for ${monthLabel(changedMonth)} could not be brought up to date. Open it and choose Prepare again. ${errorMessage(err)}`,
      );
    }
    onStatementsChanged();
  };

  const defaultDate = (() => {
    const inMonth = today >= start && today < end ? today : start;
    if (inMonth < contract.startsOn) return contract.startsOn;
    return contract.endsOn && inMonth > contract.endsOn ? contract.endsOn : inMonth;
  })();

  return (
    <KeepFocus label={`Costs for ${villaName(contract)}`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SubHeading>Costs charged to the owner</SubHeading>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous month"
            disabled={month <= first}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="min-w-28 text-center text-sm font-medium text-ink" aria-live="polite">
            {monthLabel(month)}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next month"
            disabled={last !== null && month >= last}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {error && !data ? (
        <p className="text-sm text-ink-soft">
          The costs could not be loaded. {errorMessage(error)}{' '}
          <button
            type="button"
            className="font-medium text-brand-700 hover:underline"
            onClick={() => void mutate()}
          >
            Try again
          </button>
        </p>
      ) : isLoading || !data ? (
        <p className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner /> Loading costs…
        </p>
      ) : expenses.length === 0 ? (
        <p className="text-sm text-ink-soft">
          No costs in {monthLabel(month)}.
          {!closed &&
            ' Add what you paid on the owner\u2019s behalf, such as a repair or a utility bill, and it is taken off their statement for the month.'}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {expenses.map((expense) => (
            <li key={expense.id} className="flex items-start gap-3 px-3 py-2 text-sm">
              <span className="w-14 shrink-0 text-ink-soft">{formatDay(expense.date)}</span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-ink">{expense.description}</span>
                <span className="block text-[13px] text-ink-faint">
                  {CATEGORY_LABELS[expense.category]}
                </span>
              </span>
              <span className="tabular shrink-0 text-ink">
                {money(expense.amount, contract.currency)}
              </span>
              {expense.statementId ? (
                <span className="w-8 shrink-0" />
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  className="-my-1 shrink-0"
                  aria-label={`Remove the cost ${expense.description}`}
                  onClick={() => setRemoving(expense)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-60 text-[13px] text-ink-faint">
          {closed
            ? `The statement for ${monthLabel(month)} has been issued, so its costs can no longer change. Date a late cost in a later month and it goes on that statement.`
            : statement
              ? `Taken off the draft statement for ${monthLabel(month)}, which is worked out again when a cost changes.`
              : `Taken off the statement for ${monthLabel(month)} when it is prepared.`}
        </p>
        {!closed && (
          <Button
            size="sm"
            icon={<Plus className="size-4" aria-hidden />}
            onClick={() => setAdding(true)}
          >
            Add cost
          </Button>
        )}
      </div>

      {adding && (
        <CostDialog
          contract={contract}
          defaultDate={defaultDate}
          onClose={() => setAdding(false)}
          onSaved={(expense) => {
            toast.success(
              'Cost added',
              `On the statement for ${monthLabel(monthKey(expense.date))}.`,
            );
            // Show the month the cost went to, which need not be the one that was open.
            setMonth(monthKey(expense.date));
            void mutate();
            void refreshDraft(monthKey(expense.date));
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Remove this cost?"
          confirmLabel="Remove cost"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`/owner-expenses/${removing.id}`, { method: 'DELETE' });
            setRemoving(null);
            toast.success('Cost removed');
            void mutate();
            void refreshDraft(monthKey(removing.date));
          }}
        >
          <p>
            <span className="font-medium text-ink">{removing.description}</span>,{' '}
            {money(removing.amount, contract.currency)} on {formatDay(removing.date)}, will no
            longer be charged to the owner.
          </p>
        </ConfirmDialog>
      )}
    </KeepFocus>
  );
}

/** The statements of one contract, newest first, and the way to prepare one. */
function Statements({
  owner,
  contract,
  statements,
  load,
  today,
}: {
  owner: Owner;
  contract: Contract;
  /** Every statement of this owner that is known. */
  statements: Statement[];
  /** Whether the statements have been loaded. */
  load: StatementsLoad;
  today: string;
}) {
  const router = useRouter();
  const [preparing, setPreparing] = useState(false);
  const mine = statements.filter((s) => s.contractId === contract.id);
  const started = contract.startsOn <= today;

  return (
    <section aria-label={`Statements for ${villaName(contract)}`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SubHeading>Statements</SubHeading>
        {started && load === 'ready' && (
          <Button
            size="sm"
            icon={<FilePlus2 className="size-4" aria-hidden />}
            onClick={() => setPreparing(true)}
          >
            Prepare a statement
          </Button>
        )}
      </div>
      {load === 'failed' ? (
        <p className="text-sm text-ink-soft">The statements could not be loaded.</p>
      ) : load === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner /> Loading statements…
        </p>
      ) : mine.length === 0 ? (
        <p className="text-sm text-ink-soft">
          {started
            ? 'No statement yet. A draft for each month is prepared automatically once the month has ended; you can also prepare one now to see how the month is going.'
            : 'No statement yet: the contract has not started.'}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {mine.map((statement) => (
            <li key={statement.id}>
              <Link
                href={`/owners/statements/${statement.id}`}
                className="flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-brand-50/60"
              >
                <span className="min-w-0 flex-1 font-medium text-ink">
                  {statementMonth(statement)}
                  {statement.number && (
                    <span className="block text-[13px] font-normal text-ink-faint">
                      {statement.number}
                    </span>
                  )}
                </span>
                <Badge tone={STATUS_TONES[statement.status]}>
                  {STATUS_LABELS[statement.status]}
                </Badge>
                <span className="tabular shrink-0 text-right text-ink">
                  {money(statement.payout, statement.currency)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {preparing && (
        <PrepareDialog
          contracts={[{ contract, ownerName: owner.name }]}
          onClose={() => setPreparing(false)}
          onPrepared={(statement) => router.push(`/owners/statements/${statement.id}`)}
        />
      )}
    </section>
  );
}

/** One contract of an owner: its terms, the costs charged on it, and its statements. */
export function ContractCard({
  owner,
  contract,
  statements,
  statementsLoad,
  today,
  onChanged,
  onStatementsChanged,
}: {
  owner: Owner;
  contract: Contract;
  statements: Statement[];
  statementsLoad: StatementsLoad;
  today: string;
  onChanged: () => void;
  onStatementsChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [ending, setEnding] = useState(false);
  const state = contractState(contract, today);
  const share = contract.model === 'revenue_share';
  const hasIssued = statements.some((s) => s.contractId === contract.id && s.status !== 'draft');

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink">
            <span className="break-words">{villaName(contract)}</span>
            <Badge tone={CONTRACT_STATE_TONES[state]}>{contractStateWords(contract, today)}</Badge>
          </h3>
          <p className="text-sm text-ink-soft">
            {contract.unitName ? 'One unit of the property' : 'The whole property'} ·{' '}
            {periodWords(contract)}
          </p>
        </div>
        <KeepFocus
          label={`Contract for ${villaName(contract)}`}
          className="flex flex-wrap items-center gap-2"
        >
          <Button
            size="sm"
            icon={<Pencil className="size-3.5" aria-hidden />}
            onClick={() => setEditing(true)}
          >
            Edit terms
          </Button>
          {contract.endsOn === null && (
            <Button size="sm" onClick={() => setEnding(true)}>
              End contract
            </Button>
          )}
        </KeepFocus>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Term label="How the owner is paid">
          {share ? (
            <>
              The room revenue, less a management fee of {percentText(contract.managementFeeBp)}%{' '}
              {basisWords(contract.feeBasis)}
              {contract.feeTaxBp !== 0 && `, and ${percentText(contract.feeTaxBp)}% tax on the fee`}
            </>
          ) : (
            feeWords(contract)
          )}
        </Term>
        {share && (
          <Term label="Commission to booking sites and travel agents">
            {contract.commissionOnOwner
              ? 'Taken off the owner\u2019s share'
              : 'Not taken off the owner\u2019s share'}
          </Term>
        )}
        <Term label={'The owner\u2019s own stays'}>{ownerStayWords(contract)}</Term>
        {contract.notes && (
          <Term label="Notes">
            <span className="whitespace-pre-line">{contract.notes}</span>
          </Term>
        )}
      </dl>

      <div className="mt-5 grid grid-cols-1 gap-6 border-t border-line pt-4 xl:grid-cols-2">
        <Costs
          contract={contract}
          statements={statements}
          today={today}
          onStatementsChanged={onStatementsChanged}
        />
        <Statements
          owner={owner}
          contract={contract}
          statements={statements}
          load={statementsLoad}
          today={today}
        />
      </div>

      {editing && (
        <ContractDialog
          owner={owner}
          contract={contract}
          hasIssued={hasIssued}
          onClose={() => setEditing(false)}
          onSaved={() => {
            onChanged();
            onStatementsChanged();
          }}
        />
      )}
      {ending && (
        <EndContractDialog
          contract={contract}
          onClose={() => setEnding(false)}
          onSaved={onChanged}
        />
      )}
    </Card>
  );
}
