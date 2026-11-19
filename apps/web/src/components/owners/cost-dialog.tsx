'use client';

import { useState } from 'react';
import { isValidDate } from '@pms/domain/shared';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { parseAmount } from './money';
import { useProblems } from './problems';
import type { Contract, Expense, ExpenseCategory } from './types';
import { CATEGORIES, CATEGORY_LABELS, monthKey, monthLabel, villaName } from './words';

type Problem = 'date' | 'description' | 'amount';

/** Records a cost the owner bears. It is taken off the statement of the month it is dated in. */
export function CostDialog({
  contract,
  defaultDate,
  onClose,
  onSaved,
}: {
  contract: Contract;
  defaultDate: string;
  onClose: () => void;
  onSaved: (expense: Expense) => void;
}) {
  const [date, setDate] = useState(defaultDate);
  const [category, setCategory] = useState<ExpenseCategory>('maintenance');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const { problems, accept, clear, form } = useProblems<Problem>();

  const save = useAction(async () => {
    const found: Partial<Record<Problem, string>> = {};
    if (!isValidDate(date)) {
      found.date = 'Choose the date of the cost.';
    } else if (date < contract.startsOn) {
      found.date = `The contract started on ${formatDate(contract.startsOn)}. Choose that day or a later one.`;
    } else if (contract.endsOn && date > contract.endsOn) {
      found.date = `The contract ended on ${formatDate(contract.endsOn)}. Choose that day or an earlier one.`;
    }
    if (!description.trim()) found.description = 'Say what the cost was for.';
    const minor = parseAmount(amount, contract.currency);
    if (minor === null) found.amount = 'Enter the amount in figures, such as 4500 or 4500.50.';
    else if (minor <= 0) found.amount = 'Enter an amount above zero.';
    if (!accept(found) || minor === null) return;

    const expense = await api<Expense>(`/owner-contracts/${contract.id}/expenses`, {
      body: { date, category, description: description.trim(), amount: minor },
    });
    onSaved(expense);
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a cost"
      description={`Charged to the owner of ${villaName(contract)}.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="cost-form" variant="primary" loading={save.busy}>
            Add cost
          </Button>
        </>
      }
    >
      <form
        ref={form}
        id="cost-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        <FormError message={save.error ? `Could not add the cost. ${save.error}` : null} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Date"
            hint={
              isValidDate(date)
                ? `Taken off the statement for ${monthLabel(monthKey(date))}.`
                : 'It is taken off the statement for the month of this date.'
            }
            error={problems.date}
          >
            {(props) => (
              <Input
                {...props}
                type="date"
                required
                min={contract.startsOn}
                max={contract.endsOn ?? undefined}
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                  clear('date');
                }}
              />
            )}
          </Field>
          <Field label="Kind of cost">
            {(props) => (
              <Select
                {...props}
                value={category}
                onChange={(event) => setCategory(event.target.value as ExpenseCategory)}
              >
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABELS[value]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field
          label="What it was for"
          hint="The owner reads this on their statement."
          error={problems.description}
        >
          {(props) => (
            <Input
              {...props}
              required
              autoFocus
              maxLength={300}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                clear('description');
              }}
            />
          )}
        </Field>
        <Field
          label={`Amount (${contract.currency})`}
          error={problems.amount}
          className="sm:max-w-[14rem]"
        >
          {(props) => (
            <Input
              {...props}
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                clear('amount');
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
