import { NUMBER_WORDS, parseDates } from './dates';
import { fold } from './text';

const EN_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const VI_WORDS = 'mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi';

const PEOPLE_UNIT =
  '(?:people|persons?|pax|adults?|guests?|travell?ers?|passengers?|friends|ppl|of us|nguoi|khach|ban)';
const BIKE_UNIT_EN = '(?:motor\\s?bikes?|motorcycles?|bikes?|scooters?)';
const BIKE_UNIT_VI = '(?:xe may|xe|chiec)';
// "for 2 days" speaks of days, "for 2" of people.
const NOT_ANOTHER_UNIT =
  '(?!\\s*(?:days?|nights?|weeks?|hours?|ngay|dem|tuan|motor|bikes?|scooters?|xe|chiec|[/.:-]\\s*\\d|\\d|k\\b|vnd|usd|dong|\\$|million|trieu))';

function numberOf(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  if (/^\d+$/.test(token)) return Number(token);
  if (token === 'a' || token === 'an') return 1;
  return NUMBER_WORDS[token];
}

function firstMatch(folded: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(folded);
    const n = numberOf(match?.[1]);
    if (n !== undefined && n >= 1 && n <= 99) return n;
  }
  return undefined;
}

/** How many people a message speaks of: "2 people", "we are 3", "just me", "hai người". */
export function findPeople(folded: string): number | undefined {
  if (
    /(?<![a-z])(?:just me|only me|myself|alone|solo|on my own|mot minh|1 minh|minh toi|co minh toi)(?![a-z])/.test(
      folded,
    )
  ) {
    return 1;
  }
  const counted = firstMatch(folded, [
    new RegExp(`(?<![\\d/.])(\\d{1,2})\\s*${PEOPLE_UNIT}(?![a-z])`),
    new RegExp(`(?<![a-z])(${EN_WORDS})\\s+${PEOPLE_UNIT}(?![a-z])`),
    new RegExp(`(?<![a-z])(${VI_WORDS})\\s+(?:nguoi|khach)(?![a-z])`),
    new RegExp(
      `(?<![a-z])(?:we are|we're|group of|party of|family of|there are|there will be)\\s+(\\d{1,2}|${EN_WORDS})(?![a-z0-9])${NOT_ANOTHER_UNIT}`,
    ),
    new RegExp(`(?<![a-z])for\\s+(\\d{1,2})(?![a-z0-9])${NOT_ANOTHER_UNIT}`),
    new RegExp(
      `(?<![a-z])(?:bon|tui|chung)\\s+(?:minh|em|toi|anh|chi)\\s+(?:co|di)\\s+(\\d{1,2})(?![a-z0-9])${NOT_ANOTHER_UNIT}`,
    ),
  ]);
  if (counted !== undefined) return counted;
  if (
    /(?<![a-z])(?:couple(?!\s+of\s+(?:days|nights|weeks|hours|bikes|motorbikes|scooters|questions|things|times))|two of us|both of us|me and my (?:wife|husband|girlfriend|boyfriend|partner|friend|son|daughter|mom|mum|dad|brother|sister)|my (?:wife|husband|girlfriend|boyfriend|partner|friend|son|daughter|mom|mum|dad|brother|sister) and (?:i|me)|(?:hai|2) vo chong|vo chong (?:toi|minh|em)|(?:hai|2) dua)(?![a-z])/.test(
      folded,
    )
  ) {
    return 2;
  }
  return undefined;
}

/** How many motorbikes a message speaks of: "2 bikes", "a scooter", "hai xe". */
export function findBikes(folded: string): number | undefined {
  return firstMatch(folded, [
    new RegExp(`(?<![\\d/.])(\\d{1,2})\\s*${BIKE_UNIT_EN}(?![a-z])`),
    new RegExp(`(?<![\\d/.])(\\d{1,2})\\s*${BIKE_UNIT_VI}(?![a-z])`),
    new RegExp(`(?<![a-z])(a|an|${EN_WORDS})\\s+${BIKE_UNIT_EN}(?![a-z])`),
    new RegExp(`(?<![a-z])(${VI_WORDS})\\s+${BIKE_UNIT_VI}(?![a-z])`),
  ]);
}

/** A message that is nothing but a count, in answer to "how many?": "2", "two", "hai", "2 xe". */
export function parseCount(text: string): number | undefined {
  const folded = fold(text).replace(/[.!,]+$/, '');
  const match = new RegExp(
    `^(?:just |only |chi |co )?(\\d{1,2}|${EN_WORDS}|${VI_WORDS})(?:\\s*(?:${PEOPLE_UNIT}|${BIKE_UNIT_EN}|${BIKE_UNIT_VI}|days?|ngay))?$`,
  ).exec(folded);
  const n = numberOf(match?.[1]);
  if (n !== undefined && n >= 1) return n;
  return findPeople(folded);
}

/**
 * A phone number in the message, as typed. With `lenient`, in answer to "your
 * phone number?", shorter numbers are taken too.
 */
export function findPhone(text: string, lenient = false): string | undefined {
  const candidates = text.match(/(?:\+|00)?\(?\d[\d\s().-]{5,20}\d/g) ?? [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, '');
    const minimum = lenient ? 7 : 9;
    if (digits.length < minimum || digits.length > 15) continue;
    if (!lenient && !/^(?:\+|00|0|\(?\+?\d{1,3}\)?[\s.-])/.test(candidate) && digits.length < 10)
      continue;
    // "20.11.2026" and "20-22.11" are dates, not phone numbers.
    if (parseDates(candidate, '2000-01-01').start !== undefined) continue;
    return candidate.replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

const NAME_PREFIX =
  /^(?:(?:hi|hello|hey)[,!. ]+)?(?:my (?:full )?name(?:'s| is)|i am|i'm|im|it's|it is|this is|name\s*[:-]|(?:the )?name is|tên (?:của )?(?:tôi|mình|em|anh|chị)(?: là)?|(?:tôi|mình|em|anh|chị)(?: tên)?(?: là)|tên(?: là)?\s*[:-]?|ten (?:cua )?(?:toi|minh|em|anh|chi)(?: la)?|(?:toi|minh|em|anh|chi)(?: ten)?(?: la)|ten(?: la)?\s*[:-]?)\s+/i;

/** The name given in answer to "your name?". Keeps the spelling, drops "my name is". */
export function parseName(text: string): string | undefined {
  let name = text.replace(/\s+/g, ' ').trim();
  name = name.replace(NAME_PREFIX, '');
  name = name.replace(/[.!,;]+$/, '').trim();
  if (name.length < 2 || name.length > 60) return undefined;
  if (/\d/.test(name) || /[?@/\\:;()[\]{}<>=+*_|~^%$#]/.test(name)) return undefined;
  if (!/\p{L}/u.test(name)) return undefined;
  if (name.split(' ').length > 6) return undefined;
  return name;
}
