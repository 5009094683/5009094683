'use client';

import { useState } from 'react';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { money } from './money';
import type { Statement } from './types';

/** Records that the owner has been paid what an issued statement says. */
export function PaidDialog({
  statement,
  onClose,
  onSaved,
}: {
  statement: Statement;
  onClose: () => void;
  onSaved: (statement: Statement) => void;
}) {
  const toast = useToast();
  const [reference, setReference] = useState('');
  // The day in the browser: the office and its bank are, near enough, in the same place.
  const [today] = useState(() => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  });
  const [paidOn, setPaidOn] = useState(today);

  const save = useAction(async () => {
    const saved = await api<Statement>(`/owner-statements/${statement.id}/paid`, {
      body: { reference: reference.trim() || null, paidOn },
    });
    toast.success('Marked as paid');
    onSaved(saved);
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Mark as paid"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="paid-form" variant="primary" loading={save.busy}>
            Mark as paid
          </Button>
        </>
      }
    >
      <form
        id="paid-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        <FormError message={save.error ? `Could not mark it as paid. ${save.error}` : null} />
        <p className="text-sm text-ink-soft">
          {statement.payout > 0 ? (
            <>
              This records that {statement.ownerName} has been paid{' '}
              <span className="tabular font-medium text-ink">
                {money(statement.payout, statement.currency)}
              </span>{' '}
              for statement {statement.number}.
            </>
          ) : (
            <>Nothing is payable on statement {statement.number}, so this simply closes it.</>
          )}{' '}
          It cannot be undone here.
        </p>
        <Field label="Paid on" hint="The day the money left. The owner sees it on the statement.">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={paidOn}
              max={today}
              onChange={(event) => setPaidOn(event.target.value)}
              className="sm:w-48"
              required
            />
          )}
        </Field>
        <Field
          label="Payment reference"
          optional
          hint="Such as the reference of the bank transfer. The owner sees it on the statement."
        >
          {(props) => (
            <Input
              {...props}
              maxLength={120}
              autoComplete="off"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
