'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { amountText, parseAmount } from './money';
import { useProblems } from './problems';
import type { Statement } from './types';
import { statementMonth } from './words';

/** The most adjustments the server keeps on one statement. */
const MOST = 50;

type Direction = 'add' | 'take';

interface Row {
  key: number;
  description: string;
  direction: Direction;
  amount: string;
}

/** A problem is kept by row and field, as `3:amount`. */
type Problem = `${number}:${'description' | 'amount'}`;

/** Sets the adjustments and the note on a draft statement. The server works the figures out again. */
export function AdjustmentsDialog({
  statement,
  onClose,
  onSaved,
}: {
  statement: Statement;
  onClose: () => void;
  onSaved: (statement: Statement) => void;
}) {
  const toast = useToast();
  const { currency } = statement;
  const nextKey = useRef(statement.lines.adjustments.length);
  const [rows, setRows] = useState<Row[]>(() =>
    statement.lines.adjustments.map((adjustment, index) => ({
      key: index,
      description: adjustment.description,
      direction: adjustment.amount < 0 ? 'take' : 'add',
      amount: amountText(Math.abs(adjustment.amount), currency),
    })),
  );
  const [notes, setNotes] = useState(statement.notes ?? '');
  const { problems, accept, clear, form } = useProblems<Problem>();

  const change = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const add = () => {
    const key = nextKey.current++;
    setRows((current) => [...current, { key, description: '', direction: 'add', amount: '' }]);
  };

  const save = useAction(async () => {
    const found: Partial<Record<Problem, string>> = {};
    const adjustments = rows.map((row) => {
      if (!row.description.trim()) found[`${row.key}:description`] = 'Say what it is for.';
      const minor = parseAmount(row.amount, currency);
      if (minor === null) found[`${row.key}:amount`] = 'Enter it in figures, such as 500.';
      else if (minor <= 0) found[`${row.key}:amount`] = 'Enter an amount above zero.';
      return {
        description: row.description.trim(),
        amount: row.direction === 'take' ? -(minor ?? 0) : (minor ?? 0),
      };
    });
    if (!accept(found)) return;

    const saved = await api<Statement>(`/owner-statements/${statement.id}`, {
      method: 'PATCH',
      body: { adjustments, notes: notes.trim() || null },
    });
    toast.success('Statement saved', 'Its figures have been worked out again.');
    onSaved(saved);
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Adjustments and note"
      description={`On the draft statement for ${statementMonth(statement)}.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="adjustments-form" variant="primary" loading={save.busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        ref={form}
        id="adjustments-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-5"
      >
        <FormError message={save.error ? `Could not save. ${save.error}` : null} />

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Adjustments
          </legend>
          <p className="text-[13px] text-ink-soft">
            An adjustment adds to what the owner is paid for this month or takes off it, for
            anything the stays and costs do not cover: a correction to an earlier statement, an
            advance already paid, an amount agreed between you.
          </p>
          {rows.length === 0 && (
            <p className="text-sm text-ink-faint">This statement has no adjustments.</p>
          )}
          <ul className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <li
                key={row.key}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border border-line p-3 sm:grid-cols-[minmax(0,1fr)_12rem_8rem_auto] sm:items-start sm:border-0 sm:p-0"
              >
                <Field
                  label={`What adjustment ${index + 1} is for`}
                  error={problems[`${row.key}:description`]}
                  className="col-span-2 sm:col-span-1"
                >
                  {(props) => (
                    <Input
                      {...props}
                      maxLength={200}
                      // A row that was just added is ready to type into.
                      autoFocus={row.description === '' && row.amount === ''}
                      value={row.description}
                      onChange={(event) => {
                        change(row.key, { description: event.target.value });
                        clear(`${row.key}:description`);
                      }}
                    />
                  )}
                </Field>
                <Field label="Effect" className="col-span-2 sm:col-span-1">
                  {(props) => (
                    <Select
                      {...props}
                      value={row.direction}
                      onChange={(event) =>
                        change(row.key, { direction: event.target.value as Direction })
                      }
                    >
                      <option value="add">Pay the owner more</option>
                      <option value="take">Pay the owner less</option>
                    </Select>
                  )}
                </Field>
                <Field label={`Amount (${currency})`} error={problems[`${row.key}:amount`]}>
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="decimal"
                      value={row.amount}
                      onChange={(event) => {
                        change(row.key, { amount: event.target.value });
                        clear(`${row.key}:amount`);
                      }}
                    />
                  )}
                </Field>
                <Button
                  size="icon"
                  variant="ghost"
                  className="mt-[1.4rem] h-9 w-9"
                  aria-label={`Remove adjustment ${index + 1}`}
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          {rows.length < MOST && (
            <div>
              <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={add}>
                Add an adjustment
              </Button>
            </div>
          )}
        </fieldset>

        <Field
          label="Note to the owner"
          optional
          hint="Printed on the statement, under the figures."
        >
          {(props) => (
            <Textarea
              {...props}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
