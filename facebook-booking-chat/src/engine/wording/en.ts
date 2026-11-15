/*
  ENGLISH WORDING of everything the assistant says to customers.

  Change a sentence here and restart; the Vietnamese twin of each sentence is
  in vi.ts. Keep to plain text: Messenger shows it exactly as written.
*/
import { formatMoney } from '../../bookings/pricing';
import type { Business, ServiceKind } from '../../business/schema';
import { formatDate } from '../../nlu/dates';
import type { BookingStatus } from '../../store';
import type { BookingView, Wording } from './types';

const money = (amount: number) => formatMoney(amount, 'en');
const date = (day: string) => formatDate(day, 'en');
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const UNIT: Record<ServiceKind, { one: string; many: string; label: string; per: string }> = {
  rental: { one: 'motorbike', many: 'motorbikes', label: 'Motorbikes', per: 'per motorbike per day' },
  tour: { one: 'person', many: 'people', label: 'Travellers', per: 'per person' },
  easy_rider: { one: 'passenger', many: 'passengers', label: 'Passengers', per: 'per passenger per day' },
}; // prettier-ignore

const STATUS: Record<BookingStatus, string> = {
  pending: 'waiting for our team to confirm',
  confirmed: 'confirmed',
  declined: 'not accepted',
  cancelled: 'cancelled',
};

function list(items: string[], last: string): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
}

function menu(business: Business): string {
  return business.services.map((service, i) => `${i + 1}. ${service.name.en}`).join('\n');
}

function contactLine(business: Business): string {
  const contacts = business.company.contacts.map((c) => `${c.label} ${c.value}`);
  return contacts.length > 0 ? ` You can also reach us on ${list(contacts, 'or')}.` : '';
}

function priceLine(view: BookingView): string {
  if (view.total === null) return 'Price: our team will confirm the price with you.';
  if (view.unitPrice === null) return `Price: ${money(view.total)}`;
  const unit = UNIT[view.kind];
  const units = count(view.quantity, unit.one, unit.many);
  const days = view.kind === 'tour' ? '' : ` × ${count(view.days, 'day', 'days')}`;
  return `Price: ${money(view.unitPrice)} × ${units}${days} = ${money(view.total)}`;
}

function details(view: BookingView): string[] {
  const lines = [
    `Service: ${view.serviceName}${view.optionName ? ` – ${view.optionName}` : ''}`,
    view.days === 1
      ? `Date: ${date(view.startDate)} (1 day)`
      : `Dates: ${date(view.startDate)} to ${date(view.endDate)} (${view.days} days)`,
    `${UNIT[view.kind].label}: ${view.quantity}`,
    `Name: ${view.name}`,
  ];
  if (view.phone) lines.push(`Phone: ${view.phone}`);
  if (view.pickup) lines.push(`Pick-up: ${view.pickup}`);
  lines.push(priceLine(view));
  return lines;
}

function depositLine(view: BookingView, business: Business): string {
  if (view.depositPercent <= 0) return '';
  const methods = list(business.payment.methods.en, 'or');
  const how = methods ? ` by ${methods}` : '';
  const instructions =
    business.payment.instructions.en || 'Our team will send you the payment details here.';
  const amount = view.deposit === null ? '' : ` (${money(view.deposit)})`;
  return (
    `Deposit: please pay ${view.depositPercent}%${amount}${how} to secure your booking; ` +
    `the balance is paid before the start. ${instructions}`
  );
}

export const en: Wording = {
  welcome: (business) =>
    `Hello! I am the automatic booking assistant of ${business.company.name}. I can help you with:\n` +
    `${menu(business)}\n` +
    'Tell me what you would like and when, for example "2 motorbikes for 3 days from 20/11". ' +
    'To reach a person, type "staff".',

  intro: (business) =>
    `Hello! I am the automatic booking assistant of ${business.company.name}. To reach a person, type "staff".`,

  askService: (business) => `What would you like to book?\n${menu(business)}`,

  askOption: (service) => {
    const question: Record<ServiceKind, string> = {
      rental: 'Which motorbike would you like?',
      tour: 'Which tour would you like?',
      easy_rider: 'Which option would you like?',
    };
    const options = service.options.map((option, i) => {
      const price =
        option.price === null ? '' : ` – ${money(option.price)} ${UNIT[service.kind].per}`;
      return `${i + 1}. ${option.name.en}${price}`;
    });
    return `${question[service.kind]}\n${options.join('\n')}`;
  },

  askStartDate: (kind) =>
    ({
      rental: 'From which date do you need the motorbike? (for example 20/11)',
      tour: 'On which date would you like to start the tour? (for example 20/11)',
      easy_rider: 'On which date would you like to start? (for example 20/11)',
    })[kind],

  askDays: (kind) =>
    ({
      rental: 'For how many days?',
      tour: 'How many days should the tour be?',
      easy_rider: 'For how many days?',
    })[kind],

  askQuantity: (kind) =>
    ({
      rental: 'How many motorbikes do you need?',
      tour: 'How many people are travelling?',
      easy_rider: 'How many passengers? (each passenger rides with their own driver)',
    })[kind],

  askName: () => 'Under which name should I make the booking?',

  askPhone: () =>
    'Which phone number can we reach you on (WhatsApp or Zalo)? Type "skip" to stay on Messenger only.',

  askPickup: (kind) =>
    kind === 'rental'
      ? 'Where are you staying? (hotel name or address, or type "skip")'
      : 'Where should we pick you up? (hotel name or address, or type "skip")',

  summary: (view) => {
    const deposit =
      view.depositPercent > 0
        ? `\nA deposit of ${view.depositPercent}%${view.deposit === null ? '' : ` (${money(view.deposit)})`} is asked for when the booking is confirmed.`
        : '';
    return `Please check your booking:\n${details(view).join('\n')}${deposit}\n\nReply YES to book, or tell me what to change.`;
  },

  remindConfirm: () => 'Reply YES to book, or tell me what to change.',

  whatToChange: (kind) =>
    `Of course. What would you like to change? (for example the date, the number of days or the number of ${UNIT[kind].many})`,

  bookingReceived: (view) =>
    `Thank you, ${view.name}! Your request ${view.code} has been passed to our team. ` +
    (view.total === null
      ? 'A person will confirm it here shortly, together with the price.'
      : 'A person will confirm it here shortly.'),

  bookingConfirmed: (view, business, service) => {
    const parts = [`Your booking ${view.code} is confirmed.`, details(view).join('\n')];
    const deposit = depositLine(view, business);
    if (deposit) parts.push(deposit);
    const terms = service ? en.cancellationOf(service) : '';
    if (terms) parts.push(terms);
    parts.push(
      view.kind === 'rental'
        ? 'Please bring your passport or ID card and your driving licence.'
        : 'Please bring your passport or ID card: the original is required in the border area.',
    );
    const signature = business.company.signature
      ? `${business.company.signature}, ${business.company.name}`
      : business.company.name;
    parts.push(`Thank you, and see you on ${date(view.startDate)}!\n${signature}`);
    return parts.join('\n\n');
  },

  bookingDeclined: (code, note) =>
    `We are sorry: we cannot take booking ${code}.${note ? ` ${note}` : ''}\n` +
    'If other dates would suit you, tell me and I will gladly check.',

  bookingCancelled: (code, note) =>
    `Your booking ${code} has been cancelled.${note ? ` ${note}` : ''}\n` +
    'Tell me whenever you would like to book again.',

  prices: (service) => {
    const per = UNIT[service.kind].per;
    const note = service.note.en ? `\n${service.note.en}` : '';
    const priced = service.options.filter((option) => option.price !== null);
    if (priced.length === 0) {
      return `${service.name.en}: our team will confirm the price for your dates.${note}`;
    }
    if (service.options.length === 1) {
      return `${service.name.en}: ${money(priced[0]!.price!)} ${per}.${note}`;
    }
    const lines = service.options.map(
      (option) =>
        `- ${option.name.en}: ${option.price === null ? 'our team will confirm the price' : money(option.price)}`,
    );
    return `${service.name.en}, price ${per}:\n${lines.join('\n')}${note}`;
  },

  offerToBook: () => 'Would you like to book? Tell me the date and how many.',

  included: (service) => {
    const note = service.note.en ? ` ${service.note.en}` : '';
    if (service.included.en.length === 0) {
      return `What ${service.name.en} includes depends on the trip; our team will send you the details.${note}`;
    }
    return `${service.name.en} includes: ${list(service.included.en, 'and')}.${note}`;
  },

  payment: (business) => {
    const parts: string[] = [];
    const methods = list(business.payment.methods.en, 'or');
    if (methods) parts.push(`You can pay by ${methods}.`);
    const byPercent = new Map<number, string[]>();
    for (const service of business.services) {
      if (service.depositPercent <= 0) continue;
      byPercent.set(service.depositPercent, [
        ...(byPercent.get(service.depositPercent) ?? []),
        service.name.en,
      ]);
    }
    for (const [percent, names] of byPercent) {
      parts.push(
        `For ${list(names, 'and')}, a deposit of ${percent}% confirms the booking and the balance is paid before the start.`,
      );
    }
    if (business.payment.instructions.en) parts.push(business.payment.instructions.en);
    if (parts.length === 0) parts.push('Our team will send you the payment details.');
    return parts.join(' ');
  },

  cancellationOf: (service) => {
    const terms = service.cancellation;
    if (!terms) return '';
    return (
      `Cancellation: free up to ${terms.freeHours} hours before the start; ` +
      `between ${terms.freeHours} and ${terms.lateHours} hours before, ${terms.midChargePercent}% of the total price is charged; ` +
      `less than ${terms.lateHours} hours before, or if you do not show up, 100%.`
    );
  },

  cancellation: (business) => {
    const byTerms = new Map<string, string[]>();
    const without: string[] = [];
    for (const service of business.services) {
      const terms = en.cancellationOf(service);
      if (!terms) without.push(service.name.en);
      else byTerms.set(terms, [...(byTerms.get(terms) ?? []), service.name.en]);
    }
    const parts = [...byTerms].map(([terms, names]) => `${list(names, 'and')}. ${terms}`);
    if (without.length > 0) {
      parts.push(`${list(without, 'and')}: our team will tell you the terms. Type "staff" to ask.`);
    }
    return parts.join('\n');
  },

  documents: () =>
    'Please bring your passport or ID card: the original is required in the border area. ' +
    'For motorbike rental, your driving licence is also noted on the rental agreement.',

  contact: (business) => {
    const contacts = business.company.contacts.map((c) => `${c.label}: ${c.value}`);
    return contacts.length > 0
      ? `You can reach our team on:\n${contacts.join('\n')}`
      : 'You can reach our team right here: type "staff" and a person will reply.';
  },

  location: (business) => {
    const address = business.company.address.en;
    if (!address) return 'Our team will send you our exact location here.';
    return `We are at: ${address}${business.company.mapUrl ? `\n${business.company.mapUrl}` : ''}`;
  },

  status: (bookings) => {
    const lines = bookings.map(
      (booking) =>
        `- ${booking.code}: ${booking.serviceName}, ${date(booking.startDate)}, ` +
        `${count(booking.days, 'day', 'days')}: ${STATUS[booking.status]}`,
    );
    return `Your bookings:\n${lines.join('\n')}`;
  },

  statusWord: (status) => STATUS[status],

  noBookings: () =>
    'I cannot find a booking made in this chat. If you booked another way, type "staff" and our team will check.',

  handoff: (business) =>
    `I have asked our team to join this chat. A person will reply here as soon as possible.${contactLine(business)}`,

  handoffConfused: (business) =>
    `I am not sure I understand, so I have asked our team to join this chat. A person will reply here as soon as possible.${contactLine(business)}`,

  needsPerson: (business) =>
    `Our team arranges a request of this size personally, so I have asked them to join this chat. A person will reply here as soon as possible.${contactLine(business)}`,

  discount: () =>
    'Our team decides on special prices. I have let them know, and a person will reply here. ' +
    'In the meantime I can still take your booking.',

  cancelRequest: (booking, terms) =>
    (booking
      ? `I have passed your request to cancel booking ${booking.code} to our team. A person will confirm it here.`
      : 'I have passed your request to our team. A person will reply here.') +
    (terms ? `\n${terms}` : ''),

  changeRequest: (booking) =>
    booking
      ? `I have passed your request to change booking ${booking.code} to our team. A person will reply here.`
      : 'I have passed your request to our team. A person will reply here.',

  notUnderstood: (business) =>
    'Sorry, I did not understand that. I can help you book:\n' +
    `${menu(business)}\n` +
    'For example: "2 motorbikes for 3 days from 20/11". To reach a person, type "staff".',

  sorry: () => 'Sorry, I did not get that.',

  draftDropped: () =>
    'No problem, I have dropped that request. Tell me whenever you would like to book.',

  dateInPast: (day) => `${date(day)} has already passed.`,

  dateTooFar: (maxAdvanceDays) => `I can take bookings up to ${maxAdvanceDays} days ahead.`,

  full: (kind, left) =>
    left > 0
      ? `Sorry, on those dates only ${count(left, UNIT[kind].one, UNIT[kind].many)} ${left === 1 ? 'is' : 'are'} left. ` +
        'Would another date suit you, or a smaller number? You can also type "staff" to ask our team.'
      : 'Sorry, we are fully booked on those dates. Would another date suit you? You can also type "staff" to ask our team.',

  attachmentOnly: () =>
    'Thank you. I can only read text, so I have asked our team to look at what you sent.',

  thanks: () => 'You are welcome! Tell me if there is anything else I can help with.',

  bye: () => 'Goodbye, and have a great trip!',
};
