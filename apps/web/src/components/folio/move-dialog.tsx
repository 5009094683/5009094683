'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDay, formatMoney, plural } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { isCharge, lineTotal } from './labels';
import type { Folio, FolioLine } from './types';

/** A charge can change folio until it is voided or put on an invoice, and only between open folios. */
export function movableLines(folio: Folio): FolioLine[] {
  if (folio.status !== 'open') return [];
  return folio.lines.filter((line) => isCharge(line) && !line.voidedAt && !line.invoiceId);
}

/** Moves charges from the reservation's other folios into this one. */
export function MoveDialog({
  target,
  folios,
  currency,
  onClose,
  onDone,
}: {
  target: Folio;
  folios: Folio[];
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [chosen, setChosen] = useState<string[]>([]);
  const sources = folios
    .filter((folio) => folio.id !== target.id)
    .map((folio) => ({ folio, lines: movableLines(folio) }))
    .filter((source) => source.lines.length > 0);
  const total = sources
    .flatMap((source) => source.lines)
    .filter((line) => chosen.includes(line.id))
    .reduce((sum, line) => sum + lineTotal(line), 0);

  const save = useAction(async () => {
    const { moved } = await api<{ moved: number }>(`/folios/${target.id}/move-lines`, {
      body: { lineIds: chosen },
    });
    toast.success(`${plural(moved, 'charge')} moved to ${target.label}`);
    onDone();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (chosen.length > 0) void save.run();
  };

  const toggle = (id: string, on: boolean) =>
    setChosen(on ? [...chosen, id] : chosen.filter((other) => other !== id));

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move charges to ${target.label}`}
      description="Choose the charges this folio should pay for. Payments stay on the folio they were made on."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="folio-move-form"
            variant="primary"
            loading={save.busy}
            disabled={chosen.length === 0}
          >
            {chosen.length === 0
              ? 'Move charges'
              : `Move ${plural(chosen.length, 'charge')} · ${formatMoney(total, currency)}`}
          </Button>
        </>
      }
    >
      <form id="folio-move-form" onSubmit={submit} className="flex flex-col gap-4">
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        {sources.length === 0 && (
          <p className="text-sm text-ink-soft">
            There is nothing to move. Charges that are voided, on an invoice or on a closed folio
            stay where they are.
          </p>
        )}
        {sources.map(({ folio, lines }) => (
          <fieldset key={folio.id} className="flex flex-col">
            <legend className="text-[13px] font-medium text-ink-soft">From {folio.label}</legend>
            <ul className="mt-1.5 divide-y divide-line rounded-md border border-line">
              {lines.map((line) => (
                <li key={line.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <Checkbox
                    className="min-w-0"
                    checked={chosen.includes(line.id)}
                    onChange={(e) => toggle(line.id, e.target.checked)}
                    label={
                      <span className="min-w-0">
                        <span className="block text-ink">{line.description}</span>
                        <span className="block text-xs text-ink-faint">
                          {formatDay(line.businessDate)}
                        </span>
                      </span>
                    }
                  />
                  <span className="tabular shrink-0 text-sm text-ink">
                    {formatMoney(lineTotal(line), currency)}
                  </span>
                </li>
              ))}
            </ul>
          </fieldset>
        ))}
        {sources.length > 0 && <p className="text-[13px] text-ink-faint">Amounts include tax.</p>}
      </form>
    </Dialog>
  );
}
