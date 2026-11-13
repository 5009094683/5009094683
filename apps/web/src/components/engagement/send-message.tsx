'use client';

import { Eye } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import type { MessageTemplate, TemplatesAnswer } from '@/components/messaging/types';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Reservation } from '@/lib/types';
import { asksForPayment, versionFor } from './message-values';
import { SendMessageDialog } from './send-message-dialog';

/**
 * The templates that can be sent about this reservation, each as the version the server would
 * pick for its guest. Payment requests are left out: they go with a link, from "Ask for a payment".
 */
function choices(
  templates: MessageTemplate[],
  reservation: Reservation,
): { template: MessageTemplate; several: boolean }[] {
  const keys = [...new Set(templates.map((template) => template.key))];
  return keys
    .flatMap((key) => {
      const template = versionFor(
        templates,
        key,
        reservation.propertyId,
        reservation.guest?.language,
      );
      if (!template || asksForPayment(template)) return [];
      const usable = templates.filter(
        (other) =>
          other.key === key &&
          other.active &&
          (!other.propertyId || other.propertyId === reservation.propertyId),
      );
      return [{ template, several: usable.length > 1 }];
    })
    .sort((a, b) => a.template.name.localeCompare(b.template.name));
}

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
  const { data, error, mutate } = useSWR<TemplatesAnswer>(canSend ? '/messaging/templates' : null);
  const [key, setKey] = useState('');
  const [previewing, setPreviewing] = useState(false);

  if (!canSend || (error instanceof ApiError && error.status === 403)) return null;

  const options = data ? choices(data.templates, reservation) : [];
  const chosen = options.find((option) => option.template.key === key);

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
                  {options.map(({ template }) => (
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
          template={chosen.template}
          severalVersions={chosen.several}
          onClose={() => setPreviewing(false)}
        />
      )}
    </div>,
  );
}
