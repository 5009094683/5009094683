'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { lineTotal } from './labels';
import type { FolioLine } from './types';

/** Voids a charge or discount. It stays on the bill, struck through, with the reason. */
export function VoidDialog({
  line,
  currency,
  onClose,
  onDone,
}: {
  line: FolioLine;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const discount = line.kind === 'discount';

  const save = useAction(async () => {
    await api(`/folio-lines/${line.id}/void`, { body: { reason: reason.trim() } });
    toast.success(discount ? 'Discount voided' : 'Charge voided', line.description);
    onDone();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={discount ? 'Void this discount?' : 'Void this charge?'}
      description={`${line.description} · ${formatMoney(lineTotal(line), currency)} with tax`}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button type="submit" form="folio-void-form" variant="danger" loading={save.busy}>
            {discount ? 'Void discount' : 'Void charge'}
          </Button>
        </>
      }
    >
      <form
        id="folio-void-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim()) void save.run();
          else setReasonError('Say why it is being voided.');
        }}
        className="flex flex-col gap-3"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <p className="text-[13px] text-ink-soft">
          It comes off the balance but stays on the bill, struck through, with your reason. This
          cannot be undone.
        </p>
        <Field label="Reason" error={reasonError}>
          {(props) => (
            <Input
              {...props}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonError(null);
              }}
              maxLength={300}
              autoFocus
              required
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
