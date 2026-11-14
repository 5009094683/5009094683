'use client';

import { useState } from 'react';
import { isValidDate } from '@pms/domain/shared';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { Contract } from './types';
import { localToday, villaName } from './words';

/** Ends a contract by giving it a last day. */
export function EndContractDialog({
  contract,
  onClose,
  onSaved,
}: {
  contract: Contract;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const today = localToday();
  const [endsOn, setEndsOn] = useState(today >= contract.startsOn ? today : contract.startsOn);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useAction(async () => {
    if (!isValidDate(endsOn)) {
      setProblem('Choose the last day of the contract.');
      return;
    }
    if (endsOn < contract.startsOn) {
      setProblem(
        `The contract started on ${formatDate(contract.startsOn)}. Choose that day or a later one.`,
      );
      return;
    }
    setProblem(null);
    await api(`/owner-contracts/${contract.id}`, { method: 'PATCH', body: { endsOn } });
    toast.success(`Contract ends ${formatDate(endsOn)}`);
    onSaved();
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`End the contract for ${villaName(contract)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="end-contract-form" variant="primary" loading={save.busy}>
            End contract
          </Button>
        </>
      }
    >
      <form
        id="end-contract-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        <FormError message={save.error ? `Could not end the contract. ${save.error}` : null} />
        <Field
          label="Last day of the contract"
          hint="The contract covers this day and none after it."
          error={problem}
        >
          {(props) => (
            <Input
              {...props}
              type="date"
              required
              min={contract.startsOn}
              value={endsOn}
              onChange={(event) => {
                setEndsOn(event.target.value);
                setProblem(null);
              }}
            />
          )}
        </Field>
        <p className="text-[13px] text-ink-soft">
          Stays and costs after that day no longer count for the owner, and their calendar in the
          owner portal stops there. Statements for the months up to it can still be prepared and
          issued, and those already issued stay as they are. The last day can be changed later under
          Edit terms.
        </p>
      </form>
    </Dialog>
  );
}
