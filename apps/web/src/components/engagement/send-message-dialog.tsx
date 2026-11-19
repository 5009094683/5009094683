'use client';

import { useId, useState, type FormEvent } from 'react';
import type { MessageChannel } from '@/components/messaging/types';
import { languageName } from '@/components/messaging/wording';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { sourceLabel } from '@/lib/format';
import { useAction, useProperties } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import { IntoView } from './into-view';
import { MessagePreview } from './message-preview';
import type { ReservationTemplate, SendResult } from './types';

const CHANNEL_LABELS: Record<MessageChannel, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  ota: 'Booking site',
};

const SEND_LABELS: Record<MessageChannel, string> = {
  email: 'Send by email',
  whatsapp: 'Send by WhatsApp',
  ota: 'Send through the booking site',
};

const SENT_WORDS: Record<MessageChannel, string> = {
  email: 'By email.',
  whatsapp: 'By WhatsApp.',
  ota: "Through the booking site's message box.",
};

/** Where the message would go by a way that can be used now. */
function destination(channel: MessageChannel, reservation: Reservation): string {
  if (channel === 'email') return `To ${reservation.guest?.email ?? 'the guest'}`;
  if (channel === 'whatsapp') return `To ${reservation.guest?.phone ?? 'the guest'}`;
  return `Through the message box of ${sourceLabel(reservation.source, reservation.channelCode)}`;
}

/**
 * Shows a template filled in for one reservation, and sends it once staff have seen it and
 * said how it should go.
 */
export function SendMessageDialog({
  reservation,
  template,
  onClose,
}: {
  reservation: Reservation;
  /** The wording the server picks for this guest and property, already filled in. */
  template: ReservationTemplate;
  onClose: () => void;
}) {
  const toast = useToast();
  const formId = useId();
  const { properties } = useProperties();
  const property = properties.find((p) => p.id === reservation.propertyId);

  const channels = template.ways.map((way) => way.channel);
  const [channel, setChannel] = useState<MessageChannel>(
    template.ways.find((way) => !way.problem)?.channel ?? channels[0] ?? 'email',
  );
  const [refusal, setRefusal] = useState<string[] | null>(null);

  const problem = template.ways.find((way) => way.channel === channel)?.problem ?? null;
  const subject = template.subject ?? '';
  const body = template.body;
  const approved = channel === 'whatsapp' ? template.whatsappTemplate : null;

  const send = useAction(async () => {
    setRefusal(null);
    const result = await api<SendResult>(`/reservations/${reservation.id}/send-template`, {
      body: { templateKey: template.key, channels: [channel] },
    });
    if (!result.sent) {
      setRefusal(result.problems);
      return;
    }
    toast.success(
      `\u201c${template.name}\u201d is on its way to ${reservation.guestName}`,
      `${SENT_WORDS[result.sent.channel]} The inbox shows whether it arrived.`,
    );
    onClose();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send.run();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Send \u201c${template.name}\u201d`}
      description={`To ${reservation.guestName}, about booking ${reservation.code}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={send.busy}
            disabled={problem !== null}
          >
            {SEND_LABELS[channel]}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
        {send.error && (
          <IntoView>
            <Notice tone="danger">{send.error}</Notice>
          </IntoView>
        )}
        {refusal && (
          <IntoView>
            <Notice tone="danger" title="Not sent">
              <ul className="flex flex-col gap-0.5">
                {refusal.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            </Notice>
          </IntoView>
        )}

        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] font-medium text-ink-soft">Send it by</p>
          <div>
            <Segmented
              label="Send it by"
              value={channel}
              onChange={(next) => {
                setChannel(next);
                setRefusal(null);
              }}
              options={channels.map((value) => ({ value, label: CHANNEL_LABELS[value] }))}
            />
          </div>
          {problem ? (
            <p role="status" className="text-[13px] break-words text-danger-700">
              It cannot go this way: {problem.replace(/\.$/, '')}.
            </p>
          ) : (
            <p className="text-[13px] break-words text-ink-soft">
              {destination(channel, reservation)}
            </p>
          )}
        </div>

        {
          <>
            <MessagePreview
              label="The message as the guest will read it"
              subject={channel === 'email' && subject ? subject : undefined}
              body={body}
            />
            {channel === 'email' && !subject && (
              <p className="text-[13px] text-ink-soft">
                This template has no subject of its own. The email goes out as “Message from{' '}
                {property?.name ?? 'the property'}”, or as a reply when the guest has written
                before.
              </p>
            )}
            {approved && (
              <div className="rounded-lg border border-line p-3 text-[13px] text-ink-soft">
                <p>
                  On WhatsApp the guest does not receive the text above but the wording WhatsApp
                  approved as <span className="font-mono break-all text-ink">{approved}</span>
                  {template.whatsappValues.length > 0 ? ', with these values in its blanks:' : '.'}
                </p>
                {template.whatsappValues.length > 0 && (
                  <ol className="mt-1 list-decimal pl-5 text-ink">
                    {template.whatsappValues.map((value, index) => (
                      <li key={index} className="break-words">
                        {value || <span className="text-ink-faint">nothing</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
            {channel === 'whatsapp' && !approved && (
              <p className="text-[13px] text-ink-soft">
                This template has no wording approved by WhatsApp, so WhatsApp only lets it through
                within 24 hours of the guest&apos;s last message.
              </p>
            )}
            {template.severalVersions && (
              <p className="text-[13px] text-ink-faint">
                This is the {languageName(template.language)} version
                {template.propertyId ? ` written for ${property?.name ?? 'this property'}` : ''}:
                the one that fits this guest best.
              </p>
            )}
          </>
        }
      </form>
    </Dialog>
  );
}
