/**
 * The text side of message templates: which placeholders exist and how they
 * are filled in. Pure, so the back office can show a template exactly as the
 * server will send it.
 */

/** The names that can be used as `{{name}}` in a template, with what each stands for. */
export const TEMPLATE_VARIABLES: Record<string, string> = {
  guest_name: 'The guest\u2019s full name',
  guest_first_name: 'The guest\u2019s first name',
  property_name: 'The property\u2019s name',
  property_address: 'The property\u2019s address',
  property_phone: 'The property\u2019s phone number',
  property_email: 'The property\u2019s email address',
  booking_code: 'The booking reference',
  check_in: 'Arrival date',
  check_out: 'Departure date',
  check_in_time: 'Time from which guests can check in',
  check_out_time: 'Time by which guests check out',
  nights: 'Number of nights',
  rooms: 'The rooms booked, e.g. "2 x Deluxe Room"',
  guests: 'The number of guests, e.g. "2 adults, 1 child"',
  total: 'The price of the stay with tax',
  paid: 'What has been paid',
  balance: 'What is still to pay',
  booking_link: 'Link where the guest sees and manages the booking',
  checkin_link: 'Link to online check-in',
  arrival_instructions: 'The property\u2019s arrival instructions',
  amount: 'For a payment request: the amount asked for',
  pay_link: 'For a payment request: the link to pay',
};

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** Fills `{{name}}` placeholders. A name with no value is left out, and the gaps it leaves are closed up. */
export function renderTemplate(text: string, variables: Record<string, string>): string {
  return text
    .replace(PLACEHOLDER, (_match, name: string) => variables[name.toLowerCase()] ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The placeholder names a text uses that there is nothing to put in for, in the order they appear. */
export function unfilledVariables(text: string, variables: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]!.toLowerCase();
    if (!variables[name]) names.add(name);
  }
  return [...names];
}

/** A made-up booking to show a template with while it is being written. */
export const SAMPLE_TEMPLATE_VALUES: Record<string, string> = {
  guest_name: 'Asha Menon',
  guest_first_name: 'Asha',
  property_name: 'Sea Breeze Candolim',
  property_address: '12 Beach Road, Candolim, Goa, 403515',
  property_phone: '+91 832 555 0100',
  property_email: 'stay@seabreeze.example',
  booking_code: 'K7M2QX4P',
  check_in: 'Saturday, 12 December 2026',
  check_out: 'Tuesday, 15 December 2026',
  check_in_time: '14:00',
  check_out_time: '11:00',
  nights: '3 nights',
  rooms: '1 x Deluxe Room',
  guests: '2 adults',
  total: '\u20b918,900',
  paid: '\u20b95,000',
  balance: '\u20b913,900',
  booking_link: 'https://book.example.com/booking/sample',
  checkin_link: 'https://book.example.com/booking/sample/check-in',
  arrival_instructions: 'Reception is open all day. Parking is behind the building.',
  amount: '\u20b95,000',
  pay_link: 'https://book.example.com/pay/sample',
};
