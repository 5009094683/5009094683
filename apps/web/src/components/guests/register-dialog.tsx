'use client';

import { useState, type FormEvent } from 'react';
import { addDays, diffDays, isValidDate, todayIn } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { query } from '@/lib/api';
import { downloadFromApi } from '@/lib/download';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';

/** The longest period the server gives a register for. */
const MAX_DAYS = 366;

/**
 * Takes the guest register of a property as a file: everyone who arrived in a period with
 * the identity and travel details on file, for the police or the foreigners' registration
 * portal. Nothing of it is shown on screen, and taking it is recorded.
 */
export function GuestRegisterDialog({
  properties,
  onClose,
}: {
  /** The properties where the signed-in person may see identity details. */
  properties: Property[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '');
  const property = properties.find((p) => p.id === propertyId);
  const today = todayIn(property?.timezone ?? 'UTC');
  const [from, setFrom] = useState(addDays(today, -1));
  const [to, setTo] = useState(today);
  const [foreignOnly, setForeignOnly] = useState(false);

  const valid = isValidDate(from) && isValidDate(to) && to >= from;
  const tooLong = valid && diffDays(from, to) + 1 > MAX_DAYS;

  const take = useAction(async () => {
    // The server's period ends on the first day not covered.
    await downloadFromApi(
      `/properties/${propertyId}/guest-register${query({
        from,
        to: addDays(to, 1),
        foreignOnly: foreignOnly ? 'true' : undefined,
        format: 'csv',
      })}`,
    );
    toast.success('Guest register downloaded', 'It holds identity numbers: keep the file safe.');
    onClose();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void take.run();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Guest register"
      description="Everyone who arrived in a period, with the identity and travel details on file, as a file for the police or the foreigners’ registration portal."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="guest-register-form"
            variant="primary"
            loading={take.busy}
            disabled={!propertyId || !valid || tooLong}
          >
            Download CSV
          </Button>
        </>
      }
    >
      <form id="guest-register-form" onSubmit={submit} className="flex flex-col gap-4">
        {take.error && <Notice tone="danger">{take.error}</Notice>}
        {properties.length > 1 && (
          <Field label="Property">
            {(props) => (
              <Select
                {...props}
                value={propertyId}
                onChange={(event) => setPropertyId(event.target.value)}
                required
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Arrived from">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={from}
                max={to}
                onChange={(event) => setFrom(event.target.value)}
                required
              />
            )}
          </Field>
          <Field label="To" error={tooLong ? 'A register covers at most a year at a time.' : null}>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={to}
                min={from}
                onChange={(event) => setTo(event.target.value)}
                required
              />
            )}
          </Field>
        </div>
        <Checkbox
          checked={foreignOnly}
          onChange={(event) => setForeignOnly(event.target.checked)}
          label="Only guests from another country"
        />
        <Notice>
          The file holds names, addresses and identity document numbers in full. Who took it, and
          for which dates, is written to the audit trail. Nothing is sent to any authority from
          here: the file is yours to hand over or to enter in their portal.
        </Notice>
      </form>
    </Dialog>
  );
}
