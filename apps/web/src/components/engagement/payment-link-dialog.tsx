'use client';

import { useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { displayMoney } from '@pms/domain/shared';
import { AMOUNT_ERROR, AmountField } from '@/components/folio/amount-field';
import { parseAmount } from '@/components/folio/labels';
import { renderTemplate } from '@/components/messaging/render';
import { CopyField } from '@/components/settings/fields';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatMoney, fromMinor } from '@/lib/format';
import { useAction, useProperties } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import { useGuestLinks, useStayMoney } from './data';
import { useFirstProblem } from './first-problem';
import { IntoView } from './into-view';
import { MessagePreview } from './message-preview';
import type { NewPaymentLink, ReservationTemplates } from './types';

/** The template the server sends a payment link with. */
const TEMPLATE_KEY = 'payment_request';
const DEFAULT_HOURS = 48;

const VALIDITY: { hours: number; label: string }[] = [
  { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 48, label: '2 days' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 336, label: '14 days' },
];

const CHANNEL_WORDS: Record<string, string> = {
  whatsapp: 'by WhatsApp',
  email: 'by email',
  ota: "through the booking site's message box",
};

function sendingTo(reservation: Reservation): string {
  const phone = reservation.guest?.phone;
  const email = reservation.guest?.email;
  if (phone && email) {
    return `By WhatsApp to ${phone}, or by email to ${email} when WhatsApp cannot reach the guest.`;
  }
  if (phone) return `By WhatsApp to ${phone}. The guest has no email address on file.`;
  if (email) return `By email to ${email}. The guest has no phone number on file.`;
  return 'The guest has no phone number or email address on file, so there is nowhere to send it.';
}

function Created({ link, guestName }: { link: NewPaymentLink; guestName: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">
        <span className="font-semibold">{formatMoney(link.amount, link.currency)}</span>, to be paid
        by {formatDateTime(link.expiresAt)}.
      </p>
      <CopyField label="Payment link" value={link.payUrl} />
      {link.sent === null ? (
        <Notice tone="info">
          Nothing was sent to {guestName}. Copy the link and pass it on yourself.
        </Notice>
      ) : link.sent.channel ? (
        <Notice tone="success" title={`On its way to ${guestName}`}>
          The link is being sent {CHANNEL_WORDS[link.sent.channel] ?? `by ${link.sent.channel}`}.
          The inbox shows whether it arrived.
        </Notice>
      ) : (
        <Notice tone="warning" title={`The link was created, but not sent to ${guestName}`}>
          <ul className="flex flex-col gap-0.5">
            {link.sent.problems.map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
          <p className="mt-1">Copy the link and pass it on yourself.</p>
        </Notice>
      )}
      <p className="text-[13px] text-ink-faint">
        The bill is updated automatically once the guest has paid.
      </p>
    </div>
  );
}

/** Asks the guest of a reservation for an amount, to be paid online through a link. */
export function PaymentLinkDialog({
  reservation,
  onClose,
  onCreated,
}: {
  reservation: Reservation;
  onClose: () => void;
  /** A link was made: the list behind the dialog is out of date. */
  onCreated: () => void;
}) {
  const auth = useAuth();
  const currency = reservation.currency;
  const { properties } = useProperties();
  const property = properties.find((p) => p.id === reservation.propertyId);
  const links = useGuestLinks(
    reservation.id,
    auth.can('reservations.read', reservation.propertyId),
  );
  const money = useStayMoney(links.data);

  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [hours, setHours] = useState(DEFAULT_HOURS);
  const [send, setSend] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [created, setCreated] = useState<NewPaymentLink | null>(null);
  const firstProblem = useFirstProblem();

  const canSeeWording = auth.can('inbox.read', reservation.propertyId);
  // The wording the server would send, with what it puts in each blank for this booking.
  const templates = useSWR<ReservationTemplates>(
    send && canSeeWording ? `/reservations/${reservation.id}/templates` : null,
  );
  const wording = templates.data?.templates.find((template) => template.key === TEMPLATE_KEY);

  const minor = parseAmount(amount, currency);
  const owed = money.data ? Math.max(0, money.data.balance) : null;
  const defaultDescription = `${property?.name ?? 'The property'}, booking ${reservation.code}`;
  const values = {
    ...templates.data?.values,
    amount: minor ? displayMoney(minor, currency) : '(the amount)',
    pay_link: '(the payment link)',
  };

  const create = useAction(async (toPay: number) => {
    const link = await api<NewPaymentLink>(`/reservations/${reservation.id}/payment-links`, {
      body: {
        amount: toPay,
        description: description.trim() || null,
        validHours: hours,
        send,
      },
    });
    setCreated(link);
    onCreated();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (minor === null) {
      setAmountError(AMOUNT_ERROR);
      firstProblem.show();
      return;
    }
    void create.run(minor);
  };

  if (created) {
    return (
      <Dialog
        open
        onClose={onClose}
        size="sm"
        title="Payment link ready"
        description={`${reservation.guestName}, booking ${reservation.code}`}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <Created link={created} guestName={reservation.guestName} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Ask for a payment"
      description={`${reservation.guestName}, booking ${reservation.code}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="payment-link-form" variant="primary" loading={create.busy}>
            {send ? 'Create link and send it' : 'Create link'}
          </Button>
        </>
      }
    >
      <form
        ref={firstProblem.form}
        id="payment-link-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
      >
        {create.error && (
          <IntoView>
            <Notice tone="danger">{create.error}</Notice>
          </IntoView>
        )}
        <div className="flex flex-col gap-1">
          <AmountField
            label="Amount"
            currency={currency}
            value={amount}
            onChange={(next) => {
              setAmount(next);
              setAmountError(null);
            }}
            error={amountError}
            autoFocus
          />
          {owed !== null && owed > 0 && (
            <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-soft">
              Still to pay for the stay: {formatMoney(owed, currency)}.
              {minor !== owed && (
                <button
                  type="button"
                  className="font-medium text-brand-700 underline-offset-2 hover:underline"
                  onClick={() => {
                    setAmount(String(fromMinor(owed, currency)));
                    setAmountError(null);
                  }}
                >
                  Ask for this amount
                </button>
              )}
            </p>
          )}
          {owed === 0 && (
            <p className="text-[13px] text-ink-soft">The stay is paid for in full so far.</p>
          )}
        </div>
        {owed !== null && minor !== null && minor > owed && (
          <Notice tone="warning">
            That is {formatMoney(minor - owed, currency)} more than is still to pay for the stay.
          </Notice>
        )}
        <Field
          label="What it is for"
          optional
          hint={`The guest reads this on the payment page. Empty: \u201c${defaultDescription}\u201d.`}
        >
          {(props) => (
            <Input
              {...props}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              placeholder="Deposit for your stay"
            />
          )}
        </Field>
        <Field
          label="The link works for"
          hint={`Until about ${formatDateTime(new Date(Date.now() + hours * 3_600_000))}. After that it can no longer be paid.`}
        >
          {(props) => (
            <Select {...props} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {VALIDITY.map((choice) => (
                <option key={choice.hours} value={choice.hours}>
                  {choice.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="rounded-lg border border-line p-3">
          <Checkbox
            label="Also send the link to the guest now"
            checked={send}
            onChange={(e) => setSend(e.target.checked)}
          />
          {send ? (
            <div className="mt-2 flex flex-col gap-2 text-[13px] text-ink-soft">
              <p>{sendingTo(reservation)}</p>
              {canSeeWording &&
                (templates.error ? (
                  <p>The wording could not be shown. It is the template “Payment request”.</p>
                ) : !templates.data ? (
                  <p className="flex items-center gap-2 text-ink-faint">
                    <Spinner /> Loading the wording…
                  </p>
                ) : wording ? (
                  <MessagePreview
                    label="The message the guest is sent"
                    subject={
                      wording.subjectText ? renderTemplate(wording.subjectText, values) : undefined
                    }
                    body={renderTemplate(wording.bodyText, values)}
                  />
                ) : (
                  <Notice tone="warning">
                    There is no template “Payment request” in use for this property, so the link
                    cannot be sent. Create the link and pass it on yourself, or add the template
                    under Settings, Guest messages.
                  </Notice>
                ))}
            </div>
          ) : (
            <p className="mt-1 text-[13px] text-ink-faint">
              Left unticked, nothing is sent: you get the link to pass on yourself.
            </p>
          )}
        </div>
        <p className="text-[13px] text-ink-faint">
          The guest pays on the payment provider&apos;s own page. No card details are entered or
          kept here.
        </p>
      </form>
    </Dialog>
  );
}
