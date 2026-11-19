import { SOURCE_LABELS } from '@pms/domain/shared';
import type { Property } from '@/lib/types';
import type {
  AutomationRule,
  AutomationTrigger,
  BookingSource,
  MessageChannel,
  MessageTemplate,
} from './types';

/** The ways of reaching a guest, in the order the standard rules try them. */
export const CHANNELS: MessageChannel[] = ['whatsapp', 'email', 'ota'];

export const CHANNEL_LABELS: Record<MessageChannel, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  ota: 'Booking site message box',
};

const CHANNEL_PHRASES: Record<MessageChannel, string> = {
  whatsapp: 'by WhatsApp',
  email: 'by email',
  ota: "through the booking site's message box",
};

/** "by WhatsApp; if that cannot reach the guest, by email". Only one message is ever sent. */
export function channelOrderText(channels: MessageChannel[]): string {
  const phrases = channels.map((channel) => CHANNEL_PHRASES[channel]);
  if (phrases.length === 0) return 'by no means yet';
  if (phrases.length === 1) return `${phrases[0]} only`;
  return phrases
    .map((phrase, index) =>
      index === 0
        ? phrase
        : index === 1
          ? `if that cannot reach the guest, ${phrase}`
          : `and failing that, ${phrase}`,
    )
    .join('; ');
}

export const TRIGGERS: AutomationTrigger[] = [
  'booking_confirmed',
  'pre_arrival',
  'check_in_day',
  'post_stay',
  'booking_cancelled',
];

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  booking_confirmed: 'When a booking is made',
  pre_arrival: 'Before arrival',
  check_in_day: 'On the day of arrival',
  post_stay: 'After the stay',
  booking_cancelled: 'When a booking is cancelled',
};

/** Whether the rule waits for an hour of the day, and whether it counts days. */
export const TRIGGER_TIMING: Record<AutomationTrigger, { hour: boolean; days: boolean }> = {
  booking_confirmed: { hour: false, days: false },
  pre_arrival: { hour: true, days: true },
  check_in_day: { hour: true, days: false },
  post_stay: { hour: true, days: true },
  booking_cancelled: { hour: false, days: false },
};

/** `08:00` from 8. */
export function hourText(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export interface RuleTiming {
  trigger: AutomationTrigger;
  offsetDays: number;
  sendHour: number;
}

/** The moment a rule sends, as the start of a sentence: "2 days before arrival, from 10:00". */
export function whenText({ trigger, offsetDays, sendHour }: RuleTiming): string {
  const from = `from ${hourText(sendHour)}`;
  switch (trigger) {
    case 'booking_confirmed':
      return 'When a booking is made';
    case 'booking_cancelled':
      return 'When a booking is cancelled';
    case 'pre_arrival':
      return offsetDays === 1
        ? `The day before arrival, ${from}`
        : `${offsetDays} days before arrival, ${from}`;
    case 'check_in_day':
      return `On the day of arrival, ${from}`;
    case 'post_stay':
      return offsetDays === 0
        ? `On the day of departure, ${from}`
        : offsetDays === 1
          ? `The day after departure, ${from}`
          : `${offsetDays} days after departure, ${from}`;
  }
}

/** What else decides whether and when the message goes out. The server works exactly like this. */
export function timingNote({ trigger, offsetDays }: RuleTiming): string {
  switch (trigger) {
    case 'booking_confirmed':
      return 'Sent within about a minute of the booking being made and confirmed.';
    case 'booking_cancelled':
      return 'Sent within about a minute. Not sent when an unpaid website booking simply runs out of time.';
    case 'pre_arrival':
      return offsetDays === 1
        ? "The hour is the property's own time. A booking made later than that still gets the message, straight away, until the end of the day before arrival."
        : "The hour is the property's own time. A booking made later than that still gets the message, straight away, until the day before arrival.";
    case 'check_in_day':
      return "The hour is the property's own time. Not sent to a guest who has already checked in by then.";
    case 'post_stay':
      return "The hour is the property's own time. Sent only once the guest has checked out.";
  }
}

export const SOURCES: BookingSource[] = [
  'website',
  'direct',
  'phone',
  'walk_in',
  'ota',
  'corporate',
  'travel_agent',
  'owner',
  'group',
];

export function sourceLabel(source: BookingSource): string {
  return SOURCE_LABELS[source] ?? source;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "every booking", or "website, direct and phone bookings only". */
export function sourcesText(sources: BookingSource[] | null): string {
  if (!sources || sources.length === 0) return 'every booking';
  const ordered = SOURCES.filter((source) => sources.includes(source));
  return `${list(ordered.map((source) => sourceLabel(source).toLowerCase()))} bookings only`;
}

/** Where something applies, to read inside a sentence. */
export function propertyText(propertyId: string | null, properties: Property[]): string {
  if (!propertyId) return 'all properties';
  return properties.find((property) => property.id === propertyId)?.name ?? 'one property';
}

/** Where something applies, to stand on its own in a list. */
export function propertyLabel(propertyId: string | null, properties: Property[]): string {
  if (!propertyId) return 'All properties';
  return properties.find((property) => property.id === propertyId)?.name ?? 'One property';
}

/**
 * The version of a template that stands for its key in lists: the organisation's English one
 * when there is one, since that is what a guest gets when nothing fits better.
 */
export function mainVersion(
  key: string,
  templates: MessageTemplate[],
): MessageTemplate | undefined {
  const versions = templates.filter((template) => template.key === key);
  const rank = (template: MessageTemplate): number =>
    (template.active ? 0 : 4) +
    (template.propertyId ? 2 : 0) +
    (template.language === 'en' ? 0 : 1);
  return [...versions].sort((a, b) => rank(a) - rank(b))[0];
}

export interface RuleWords extends RuleTiming {
  templateKey: string;
  channels: MessageChannel[];
  sources: BookingSource[] | null;
  propertyId: string | null;
}

/** A rule as one sentence: when, what and how. Who it applies to is said by `ruleScope`. */
export function ruleSentence(rule: RuleWords, templates: MessageTemplate[]): string {
  const template = mainVersion(rule.templateKey, templates);
  const name = template
    ? `\u201c${template.name}\u201d`
    : `the template \u201c${rule.templateKey}\u201d`;
  return `${whenText(rule)}: the guest is sent ${name} ${channelOrderText(rule.channels)}.`;
}

/** "For every booking at all properties." */
export function ruleScope(rule: RuleWords, properties: Property[]): string {
  const where = rule.propertyId
    ? `at ${propertyText(rule.propertyId, properties)}`
    : 'at all properties';
  return `For ${sourcesText(rule.sources)} ${where}.`;
}

/** The fields of a stored rule that the wording is made from. */
export function ruleWords(rule: AutomationRule): RuleWords {
  return {
    trigger: rule.trigger,
    offsetDays: rule.offsetDays,
    sendHour: rule.sendHour,
    templateKey: rule.templateKey,
    channels: rule.channels,
    sources: rule.sources,
    propertyId: rule.propertyId,
  };
}

/** Why a rule that is switched on would still send nothing, or null when its template is in order. */
export function templateProblem(
  rule: Pick<RuleWords, 'templateKey' | 'propertyId'>,
  templates: MessageTemplate[],
): string | null {
  const versions = templates.filter((template) => template.key === rule.templateKey);
  if (versions.length === 0) {
    return `The template \u201c${rule.templateKey}\u201d no longer exists, so nothing is sent. Choose another template.`;
  }
  const active = versions.filter((template) => template.active);
  if (active.length === 0) {
    return 'Its template is switched off, so nothing is sent. Switch the template on or choose another.';
  }
  if (active.some((template) => !template.propertyId)) return null;
  if (!rule.propertyId) {
    return 'Its template only has versions written for single properties, so guests of the other properties are sent nothing.';
  }
  if (!active.some((template) => template.propertyId === rule.propertyId)) {
    return 'Its template has no version for this property, so nothing is sent. Add one or choose another template.';
  }
  return null;
}

const LANGUAGE_CODES = [
  'en',
  'hi',
  'mr',
  'gu',
  'kn',
  'ml',
  'ta',
  'te',
  'bn',
  'pa',
  'ur',
  'ar',
  'zh',
  'nl',
  'fr',
  'de',
  'he',
  'id',
  'it',
  'ja',
  'ko',
  'pl',
  'pt',
  'ru',
  'es',
  'sv',
  'th',
  'tr',
];

let languageNames: Intl.DisplayNames | null | undefined;

/** `Hindi` from `hi`. The code itself when the browser has no name for it. */
export function languageName(code: string): string {
  if (languageNames === undefined) {
    try {
      languageNames = new Intl.DisplayNames(['en-GB'], { type: 'language' });
    } catch {
      languageNames = null;
    }
  }
  try {
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Languages to offer for a template: English first, then by name. A stored one is always among them. */
export function languageOptions(current: string): { code: string; name: string }[] {
  const codes =
    LANGUAGE_CODES.includes(current) || !current ? LANGUAGE_CODES : [current, ...LANGUAGE_CODES];
  return codes
    .map((code) => ({ code, name: languageName(code) }))
    .sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.name.localeCompare(b.name)));
}
