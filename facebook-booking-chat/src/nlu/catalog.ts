import type { Business, Service, ServiceKind, ServiceOption } from '../business/schema';
import { fold, hasPhrase } from './text';

/*
  Words that point at a kind of service. A strong word names the service
  ("rent", "easy rider", "tour"); a weak one only leans towards it ("scooter").
  Written folded: lower case, no Vietnamese marks.
*/
// prettier-ignore
const STRONG: Record<ServiceKind, string[]> = {
  rental: [
    'rent', 'rental', 'rentals', 'renting', 'rents', 'hire', 'hiring', 'self drive',
    'self-drive', 'self ride', 'self-ride', 'ride myself', 'drive myself', 'ride by myself',
    'drive by myself', 'thue xe', 'cho thue', 'thue', 'tu lai', 'tu di',
  ],
  easy_rider: [
    'easy rider', 'easy riders', 'easyrider', 'easy-rider', 'with driver', 'with a driver',
    'with drivers', 'driver', 'drivers', 'pillion', 'as a passenger', 'as passenger',
    "can't ride", 'cannot ride', "can't drive", 'cannot drive', "don't ride", "don't drive",
    'no licence', 'no license', 'xe om', 'co tai xe', 'tai xe', 'nguoi cho', 'nguoi lai',
    'co nguoi lai', 'khong biet lai', 'khong biet di xe',
  ],
  tour: [
    'tour', 'tours', 'trip', 'trips', 'package', 'packages', 'itinerary', 'guided',
    'sightseeing', 'excursion', 'trek', 'trekking', 'tham quan', 'du lich', 'huong dan vien',
    'tron goi',
  ],
};

// prettier-ignore
const WEAK: Record<ServiceKind, string[]> = {
  rental: [
    'motorbike', 'motorbikes', 'motorcycle', 'motorcycles', 'scooter', 'scooters', 'bike',
    'bikes', 'xe may', 'xe so', 'xe ga',
  ],
  easy_rider: [],
  tour: ['guide', 'visit'],
};

function countHits(folded: string, phrases: readonly string[]): number {
  return phrases.filter((phrase) => hasPhrase(folded, phrase)).length;
}

function optionPhrases(option: ServiceOption): string[] {
  const phrases = [option.name.en, option.name.vi, ...option.aliases, option.id.replace(/-/g, ' ')];
  // "Honda Wave 110 (semi-automatic)" is also found by "honda wave 110".
  for (const name of [option.name.en, option.name.vi]) {
    const withoutBrackets = name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (withoutBrackets !== name) phrases.push(withoutBrackets);
  }
  return [...new Set(phrases.map(fold).filter((phrase) => phrase.length >= 2))];
}

const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10,
}; // prettier-ignore

/** The count put before an option's name: "2 Honda Wave", "hai chiếc Vision", "3 x XR 150". */
export function countOfOption(folded: string, option: ServiceOption): number | undefined {
  const numbers = `(\\d{1,2}|${Object.keys(COUNT_WORDS).join('|')})`;
  for (const phrase of optionPhrases(option)) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(
      `(?<![\\d/.a-z])${numbers}\\s*(?:x\\s*|chiec\\s+|xe\\s+)?${escaped}(?![a-z0-9])`,
    ).exec(folded);
    if (!match) continue;
    const n = /^\d+$/.test(match[1]!) ? Number(match[1]) : COUNT_WORDS[match[1]!];
    if (n !== undefined && n >= 1) return n;
  }
  return undefined;
}

export type OptionMatch =
  | { kind: 'one'; option: ServiceOption }
  | { kind: 'several'; options: ServiceOption[] }
  | { kind: 'none' };

/** The option of a service a message names: a motorbike model, a tour. */
export function matchOption(folded: string, service: Service): OptionMatch {
  const found: Array<{ option: ServiceOption; phrase: string }> = [];
  for (const option of service.options) {
    const phrase = optionPhrases(option)
      .filter((candidate) => hasPhrase(folded, candidate))
      .sort((a, b) => b.length - a.length)[0];
    if (phrase !== undefined) found.push({ option, phrase });
  }
  // "Honda Wave Alpha" names the Wave Alpha, although "Honda Wave" is in it too.
  const matches = found
    .filter(
      (entry) =>
        !found.some(
          (other) =>
            other !== entry && other.phrase !== entry.phrase && other.phrase.includes(entry.phrase),
        ),
    )
    .map((entry) => entry.option);
  if (matches.length === 1) return { kind: 'one', option: matches[0]! };
  if (matches.length > 1) return { kind: 'several', options: matches };
  return { kind: 'none' };
}

export interface ServiceMatch {
  service?: Service;
  option?: ServiceOption;
  /**
   * The message names the service ("rent", "easy rider", a tour by name)
   * rather than only leaning towards it ("scooter").
   */
  strong: boolean;
  /** Services the message fits equally well, when it does not settle on one. */
  unsure: Service[];
}

/** The service a message is about, and the option of it when one is named. */
export function matchService(folded: string, business: Business): ServiceMatch {
  const scored = business.services.map((service) => {
    const option = matchOption(folded, service);
    const named = [service.name.en, service.name.vi].some((name) =>
      hasPhrase(folded, fold(name.replace(/\s*\(.*?\)\s*/g, ' '))),
    );
    const score =
      Math.min(2, countHits(folded, STRONG[service.kind])) * 3 +
      Math.min(1, countHits(folded, WEAK[service.kind])) +
      Math.min(1, countHits(folded, service.keywords.map(fold))) * 3 +
      (named ? 6 : 0) +
      (option.kind === 'none' ? 0 : 4);
    return { service, option, score };
  });

  // "Motorbike tour with a driver", "rent a motorbike with a driver": the driver
  // decides, whatever else the message says. A car with a driver is another matter.
  const withDriver = scored.filter(
    (entry) => entry.service.kind === 'easy_rider' && countHits(folded, STRONG.easy_rider) > 0,
  );
  const byCar = countHits(folded, ['car', 'cars', 'van', 'minivan', 'bus', 'o to', 'xe hoi']) > 0;
  if (withDriver.length === 1 && !byCar) {
    const entry = withDriver[0]!;
    return {
      service: entry.service,
      option: entry.option.kind === 'one' ? entry.option.option : undefined,
      strong: true,
      unsure: [],
    };
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score === 0) return { strong: false, unsure: [] };

  const rivals = scored.filter((entry) => entry.score === top.score);
  if (rivals.length > 1) {
    return { strong: false, unsure: rivals.map((entry) => entry.service) };
  }

  return {
    service: top.service,
    option: top.option.kind === 'one' ? top.option.option : undefined,
    strong: top.score >= 3,
    unsure: [],
  };
}
