'use client';

import { addDays, isValidDate } from '@pms/domain/shared';
import { Field, Input } from '@/components/ui/field';
import { offSaleProblem } from './labels';
import type { OffSale } from './types';

/** The two dates of a closure. The second is the first night the room can be sold again. */
export function OffSaleFields({
  value,
  onChange,
}: {
  value: OffSale;
  onChange: (value: OffSale) => void;
}) {
  const problem = value.from && value.to ? offSaleProblem(value) : null;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Off sale from">
        {(props) => (
          <Input
            {...props}
            type="date"
            required
            value={value.from}
            onChange={(event) => {
              const from = event.target.value;
              const to = isValidDate(from) && value.to <= from ? addDays(from, 1) : value.to;
              onChange({ from, to });
            }}
          />
        )}
      </Field>
      <Field label="Back on sale" hint="The first night it can be sold again." error={problem}>
        {(props) => (
          <Input
            {...props}
            type="date"
            required
            min={isValidDate(value.from) ? addDays(value.from, 1) : undefined}
            value={value.to}
            onChange={(event) => onChange({ from: value.from, to: event.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

/** What taking a room off sale does, for the person about to do it. */
export function OffSaleExplanation() {
  return (
    <p className="text-[13px] text-ink-soft">
      The room closes on every connected booking site within seconds. In a hotel, a stay already
      booked into it is moved to another free room of the same kind, or left without a room number
      if none is free. A stay that cannot be moved, such as a guest who has checked in or a villa
      booking, stops the change: nothing is saved and you are told which stay it is.
    </p>
  );
}
