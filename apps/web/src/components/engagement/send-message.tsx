'use client';

import { Eye } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Reservation } from '@/lib/types';
import { SendMessageDialog } from './send-message-dialog';
import type { ReservationTemplate, ReservationTemplates } from './types';

/**
 * A template about a payment request only makes sense with an amount and a link to pay:
 * those go from "Ask for a payment", not from here.
 */
const asksForPayment = (template: ReservationTemplate): boolean =>
  template.unfilled.includes('amount') || template.unfilled.includes('pay_link');

/**
 * Sends the guest of a reservation one of the organisation's templates, after showing it filled
 * in. Renders nothing for a user who may not write to guests.
 */
export function SendMessageSection({
  reservation,
  frame,
}: {
  reservation: Reservation;
  /** Puts the content inside the host's own section, heading included. */
  frame: (content: ReactNode) => ReactNode;
}) {
  const auth = useAuth();
  const canSend = auth.can('inbox.write', reservation.propertyId);
  // Each template comes as the server would send it: the wording it picks for this guest,
  // filled in with this booking's details.
  const { data, error, mutate } = useSWR<ReservationTemplates>(
    canSend ? `/reservations/${reservation.id}/templates` : null,
  );
  const [key, setKey] = useState('');
  const [previewing, setPreviewing] = useState(false);

  if (!canSend || (error instanceof ApiError && error.status === 403)) return null;

  const options = (data?.templates ?? []).filter((template) => !asksForPayment(template));
  const chosen = options.find((template) => template.key === key);

  return frame(
    <div className="flex flex-col gap-2">
      {error && !data ? (
        <Notice tone="danger" title="The templates could not be loaded">
          <p>{errorMessage(error)}</p>
          <Button size="sm" className="mt-2" onClick={() => void mutate()}>
            Try again
          </Button>
        </Notice>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner /> Loading the templates…
        </div>
      ) : options.length === 0 ? (
        <p className="text-sm text-ink-soft">
          There is no template in use for this property. Templates are kept under Settings, Guest
          messages.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Template" className="min-w-40 flex-1">
              {(props) => (
                <Select {...props} value={key} onChange={(e) => setKey(e.target.value)}>
                  <option value="">Choose a template</option>
                  {options.map((template) => (
                    <option key={template.key} value={template.key}>
                      {template.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              icon={<Eye className="size-4" />}
              disabled={!chosen}
              onClick={() => setPreviewing(true)}
            >
              Preview
            </Button>
          </div>
          <p className="text-[13px] text-ink-faint">
            You see the message filled in for {reservation.guestName} before anything is sent.
          </p>
        </>
      )}

      {previewing && chosen && (
        <SendMessageDialog
          reservation={reservation}
          template={chosen}
          onClose={() => setPreviewing(false)}
        />
      )}
    </div>,
  );
}
