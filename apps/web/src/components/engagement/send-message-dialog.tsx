'use client';

import { useId, useState, type FormEvent } from 'react';
import { placeholdersIn, renderTemplate } from '@/components/messaging/render';
import type { MessageChannel, MessageTemplate } from '@/components/messaging/types';
import { languageName } from '@/components/messaging/wording';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { sourceLabel } from '@/lib/format';
import { useAction, useProperties } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import { useGuestLinks, useStayMoney } from './data';
import { IntoView } from './into-view';
import { MessagePreview } from './message-preview';
import { reservationValues } from './message-values';
import type { SendResult } from './types';

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

const MONEY_NAMES = ['total', 'paid', 'balance'];
const LINK_NAMES = ['booking_link', 'checkin_link'];

/** Where the message would go. The server has the last word on whether it can. */
function destination(channel: MessageChannel, reservation: Reservation): string {
  if (channel === 'email') {
    return reservation.guest?.email
      ? `To ${reservation.guest.email}`
      : 'There is no email address on file for this guest.';
  }
  if (channel === 'whatsapp') {
    return reservation.guest?.phone
      ? `To ${reservation.guest.phone}`
      : 'There is no phone number on file for this guest.';
  }
  return `Through the message box of ${sourceLabel(reservation.source, reservation.channelCode)}`;
}

/**
 * Shows a template filled in for one reservation, and sends it once staff have seen it and
 * said how it should go.
 */
export function SendMessageDialog({
  reservation,
  template,
  severalVersions,
  onClose,
}: {
  reservation: Reservation;
  /** The version the server will pick for this guest and property. */
  template: MessageTemplate;
  /** The template has other languages or property versions, so it helps to say which this is. */
  severalVersions: boolean;
  onClose: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const formId = useId();
  const guest = reservation.guest;
  const { properties, isLoading: propertiesLoading } = useProperties();
  const property = properties.find((p) => p.id === reservation.propertyId);
  const used = [...placeholdersIn(template.subject, template.body), ...template.whatsappParams];
  const links = useGuestLinks(
    reservation.id,
    used.some((name) => LINK_NAMES.includes(name) || MONEY_NAMES.includes(name)) &&
      auth.can('reservations.read', reservation.propertyId),
  );
  const money = useStayMoney(
    links.data,
    used.some((name) => MONEY_NAMES.includes(name)),
  );
  const filling = propertiesLoading || links.isLoading || money.isLoading;

  const channels: MessageChannel[] =
    reservation.source === 'ota' ? ['email', 'whatsapp', 'ota'] : ['email', 'whatsapp'];
  const [channel, setChannel] = useState<MessageChannel>(
    guest?.email ? 'email' : guest?.phone ? 'whatsapp' : 'email',
  );
  const [refusal, setRefusal] = useState<string[] | null>(null);

  const values = reservationValues(reservation, property, links.data, money.data);
  const subject = template.subject ? renderTemplate(template.subject, values) : '';
  const body = renderTemplate(template.body, values);
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
            disabled={filling}
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
          <p className="text-[13px] break-words text-ink-soft">
            {destination(channel, reservation)}
          </p>
        </div>

        {filling ? (
          <p className="flex items-center gap-2 text-sm text-ink-faint">
            <Spinner /> Filling in the details of this booking…
          </p>
        ) : (
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
                  {template.whatsappParams.length > 0 ? ', with these values in its blanks:' : '.'}
                </p>
                {template.whatsappParams.length > 0 && (
                  <ol className="mt-1 list-decimal pl-5 text-ink">
                    {template.whatsappParams.map((name, index) => (
                      <li key={index} className="break-words">
                        {values[name] || <span className="text-ink-faint">nothing</span>}
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
            {severalVersions && (
              <p className="text-[13px] text-ink-faint">
                This is the {languageName(template.language)} version
                {template.propertyId ? ` written for ${property?.name ?? 'this property'}` : ''}:
                the one that fits this guest best.
              </p>
            )}
          </>
        )}
      </form>
    </Dialog>
  );
}
