import {
  addDays,
  displayMoney,
  getPropertyConfig,
  listProperties,
  todayIn,
  type PropertyConfig,
  type PropertyRow,
} from '@pms/domain';
import type { AiActionRow, CopilotReply } from './copilot';
import { runTool } from './copilot';
import type { ToolContext } from './tools';

/**
 * The assistant without a language model: a handful of commands, recognised
 * by their wording. They go through the same tools as the model would use,
 * so permissions, validation and the confirm step are identical.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** The same, without a capture group, for use inside larger patterns. */
const MONTH_NAME = MONTH.replace('(', '(?:');
const DATE_TOKEN = `(?:today|tomorrow|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_NAME}(?:\\s+\\d{4})?|${MONTH_NAME}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}/\\d{1,2}(?:/\\d{4})?)`;
const SEPARATOR = '(?:to|until|till|through|-|\u2013)';

const iso = (year: number, month: number, day: number): string | null => {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
};

/** Reads one date as a person writes it. A date without a year is the next one on or after today. */
export function parseDate(text: string, today: string): string | null {
  const t = text.trim().toLowerCase().replace(/,/g, '');
  if (t === 'today') return today;
  if (t === 'tomorrow') return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return iso(Number(t.slice(0, 4)), Number(t.slice(5, 7)), Number(t.slice(8, 10)));
  }
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  let m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+(\\d{4}))?$`).exec(t);
  if (m) {
    day = Number(m[1]);
    month = MONTHS.indexOf(m[2]!.slice(0, 3)) + 1;
    year = m[3] ? Number(m[3]) : undefined;
  } else if (
    (m = new RegExp(`^${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?$`).exec(t))
  ) {
    day = Number(m[2]);
    month = MONTHS.indexOf(m[1]!.slice(0, 3)) + 1;
    year = m[3] ? Number(m[3]) : undefined;
  } else if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(t))) {
    // Day first, as dates are written in India.
    day = Number(m[1]);
    month = Number(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
  }
  if (!day || !month) return null;
  if (year) return iso(year, month, day);
  const thisYear = Number(today.slice(0, 4));
  const candidate = iso(thisYear, month, day);
  if (candidate && candidate >= today) return candidate;
  return iso(thisYear + 1, month, day);
}

/** "12 to 15 Dec" means "12 Dec to 15 Dec": give the first number its month. */
function expandRanges(text: string): string {
  return text.replace(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*${SEPARATOR}\\s*(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_NAME}(?:\\s+\\d{4})?)`,
      'i',
    ),
    (_all, first: string, second: string) => {
      const month = new RegExp(MONTH_NAME, 'i').exec(second)![0];
      const year = /\d{4}/.exec(second)?.[0];
      return `${first} ${month}${year ? ` ${year}` : ''} to ${second}`;
    },
  );
}

interface Period {
  from: string;
  /** Exclusive. */
  to: string;
  /** What is left of the sentence once the dates are taken out. */
  rest: string;
  /** True when the user named both ends. */
  explicitEnd: boolean;
}

/** Finds "D1 to D2" or a single date in a sentence. `inclusiveEnd` treats the second date as the last day included. */
function findPeriod(text: string, today: string, inclusiveEnd: boolean): Period | null {
  const expanded = expandRanges(text);
  const range = new RegExp(
    `(?:from\\s+|on\\s+|for\\s+)?(${DATE_TOKEN})\\s*${SEPARATOR}\\s*(${DATE_TOKEN})`,
    'i',
  ).exec(expanded);
  if (range) {
    const from = parseDate(range[1]!, today);
    // The end is read from the start, so "28 Dec to 2 Jan" ends in the January after that December.
    const to = from ? parseDate(range[2]!, from) : null;
    if (from && to) {
      return {
        from,
        to: inclusiveEnd ? addDays(to, 1) : to,
        rest: expanded.replace(range[0], ' ').replace(/\s+/g, ' ').trim(),
        explicitEnd: true,
      };
    }
  }
  const single = new RegExp(`(?:from\\s+|on\\s+|for\\s+)?(${DATE_TOKEN})`, 'i').exec(expanded);
  if (single) {
    const from = parseDate(single[1]!, today);
    if (from) {
      return {
        from,
        to: addDays(from, 1),
        rest: expanded.replace(single[0], ' ').replace(/\s+/g, ' ').trim(),
        explicitEnd: false,
      };
    }
  }
  return null;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface Loaded {
  properties: PropertyRow[];
  configs: Map<string, PropertyConfig>;
}

async function load(context: ToolContext): Promise<Loaded> {
  const properties = (await listProperties(context.db, context.actor)).filter((p) => p.active);
  const configs = new Map<string, PropertyConfig>();
  for (const property of properties.slice(0, 40)) {
    configs.set(property.id, await getPropertyConfig(context.db, context.actor.orgId, property.id));
  }
  return { properties, configs };
}

/** The property a sentence is about: the only one, or the one whose name or code it mentions. */
function propertyIn(text: string, loaded: Loaded): PropertyRow | 'ambiguous' | null {
  if (loaded.properties.length === 1) return loaded.properties[0]!;
  const haystack = ` ${norm(text)} `;
  const hits = loaded.properties.filter(
    (p) => haystack.includes(` ${norm(p.name)} `) || haystack.includes(` ${norm(p.code)} `),
  );
  if (hits.length === 1) return hits[0]!;
  return hits.length > 1 ? 'ambiguous' : null;
}

const which = (loaded: Loaded): string =>
  `Which property? ${loaded.properties.map((p) => p.name).join(', ')}.`;

interface Named<T> {
  item: T;
  property: PropertyRow;
  name: string;
}

/** Things whose name appears in the sentence; the longest name wins, so "Deluxe Sea View" beats "Deluxe". */
function mentioned<T>(text: string, candidates: Named<T>[]): Named<T>[] {
  const haystack = ` ${norm(text)} `;
  const hits = candidates.filter((c) => norm(c.name) && haystack.includes(` ${norm(c.name)} `));
  if (hits.length <= 1) return hits;
  const longest = Math.max(...hits.map((h) => norm(h.name).length));
  return hits.filter((h) => norm(h.name).length === longest);
}

const money = (amount: number, currency: string): string => displayMoney(amount, currency);

const reply = (
  text: string,
  actions: AiActionRow[] = [],
  toolsUsed: string[] = [],
): CopilotReply => ({ reply: text, actions, mode: 'rules', toolsUsed });

const HELP = [
  'No AI service is configured, so I understand a fixed set of requests:',
  '- "arrivals today", "departures today" (add "at <property>" when there are several)',
  '- "availability 12 Dec to 15 Dec at <property>"',
  '- "occupancy 1 Dec to 8 Dec at <property>"',
  '- "find reservation <name or booking code>"',
  '- "block <room or villa> from 12 Dec to 15 Dec for maintenance"',
  '- "close <room type> on 31 Dec", "open <room type> from 1 Jan to 5 Jan"',
  '- "set rate of <room type> to 5500 from 20 Dec to 2 Jan"',
  '- "alerts", "housekeeping at <property>", "groups at <property>"',
  'Changes are proposed first; nothing happens until you confirm.',
].join('\n');

export async function answerByRules(context: ToolContext, message: string): Promise<CopilotReply> {
  const text = message.trim();
  const lower = text.toLowerCase();
  const loaded = await load(context);
  if (loaded.properties.length === 0) return reply('You do not have access to any property.');
  const todayOf = (p?: PropertyRow) =>
    todayIn(p?.timezone ?? loaded.properties[0]!.timezone, context.now);
  const use = async (name: string, input: Record<string, unknown>) => {
    const outcome = await runTool(context, name, input);
    if (outcome.isError) {
      throw new RuleRefusal(
        String((outcome.result as { error?: string }).error ?? 'That did not work'),
      );
    }
    return outcome;
  };

  try {
    if (/^(help|\?|what can you do)/.test(lower)) return reply(HELP);

    // --- Block a unit ---------------------------------------------------------
    if (/^(please\s+)?block\b/.test(lower)) {
      const period = findPeriod(text, todayOf(), false);
      if (!period || !period.explicitEnd) {
        return reply('Say which dates, for example "block Villa Azure from 12 Dec to 15 Dec".');
      }
      const unitsByName: Named<{ id: string }>[] = [...loaded.configs.values()].flatMap((c) =>
        c.roomTypes.flatMap((t) =>
          t.units
            .filter((u) => u.active)
            .map((u) => ({ item: u, property: c.property, name: u.name })),
        ),
      );
      let hits = mentioned(period.rest, unitsByName);
      const property = propertyIn(period.rest, loaded);
      if (hits.length > 1 && property && property !== 'ambiguous') {
        hits = hits.filter((h) => h.property.id === property.id);
      }
      if (hits.length === 0) {
        // A villa is often called by its property's name.
        if (property && property !== 'ambiguous') {
          const own = unitsByName.filter((u) => u.property.id === property.id);
          if (own.length === 1) hits = own;
        }
      }
      if (hits.length === 0)
        return reply(
          'I could not tell which room or villa to block. Use its name as it appears on the calendar.',
        );
      if (hits.length > 1) {
        return reply(
          `More than one unit has that name: ${hits.map((h) => `${h.name} at ${h.property.name}`).join(', ')}. Say which property.`,
        );
      }
      const reason = /\b(?:for|because of|due to|:)\s+(.+)$/i.exec(period.rest)?.[1]?.trim();
      const kind = /maint|repair|paint|plumb|fix/i.test(period.rest)
        ? 'maintenance'
        : /owner/i.test(period.rest)
          ? 'owner_stay'
          : 'block';
      const outcome = await use('block_dates', {
        propertyId: hits[0]!.property.id,
        unitId: hits[0]!.item.id,
        from: period.from,
        to: period.to,
        kind,
        ...(reason ? { reason: reason.slice(0, 200) } : {}),
      });
      return reply(
        'I have prepared this. Confirm it to go ahead.',
        [outcome.action!],
        ['block_dates'],
      );
    }

    // --- Close or open a room type --------------------------------------------
    const sale = /^(close|stop\s*sell|stop selling|open)\b/.exec(lower);
    if (sale) {
      const period = findPeriod(text, todayOf(), true);
      if (!period) return reply('Say which dates, for example "close Deluxe Room on 31 Dec".');
      const types: Named<PropertyConfig['roomTypes'][number]>[] = [
        ...loaded.configs.values(),
      ].flatMap((c) =>
        c.roomTypes
          .filter((t) => t.active)
          .map((t) => ({ item: t, property: c.property, name: t.name })),
      );
      let hits = mentioned(period.rest, types);
      const property = propertyIn(period.rest, loaded);
      if (hits.length > 1 && property && property !== 'ambiguous') {
        hits = hits.filter((h) => h.property.id === property.id);
      }
      if (hits.length === 0)
        return reply(
          'I could not tell which room type you mean. Use its name as it appears under Rates.',
        );
      if (hits.length > 1)
        return reply(`Several properties have a ${hits[0]!.name}. ${which(loaded)}`);
      const plans = hits[0]!.item.ratePlans.filter((p) => p.active);
      const actions: AiActionRow[] = [];
      for (const plan of plans) {
        const outcome = await use('set_rates', {
          propertyId: hits[0]!.property.id,
          ratePlanId: plan.id,
          from: period.from,
          to: period.to,
          stopSell: sale[1] !== 'open',
        });
        actions.push(outcome.action!);
      }
      return reply(
        actions.length === 1
          ? 'I have prepared this. Confirm it to go ahead.'
          : `I have prepared one change for each of the ${actions.length} rate plans. Confirm each to go ahead.`,
        actions,
        ['set_rates'],
      );
    }

    // --- Set a rate -----------------------------------------------------------
    const rate =
      /^set\s+(?:the\s+)?(?:rate|price)\s+(?:of|for)\s+(.+?)\s+to\s+(?:rs\.?|inr|\u20b9)?\s*([\d,]+(?:\.\d{1,2})?)\b(.*)$/i.exec(
        text,
      );
    if (rate) {
      const period = findPeriod(rate[3] ?? '', todayOf(), true);
      if (!period)
        return reply(
          'Say which dates, for example "set rate of Deluxe Room to 5500 from 20 Dec to 2 Jan".',
        );
      const plans: Named<{ id: string; parentRatePlanId: string | null; isDefault: boolean }>[] = [
        ...loaded.configs.values(),
      ].flatMap((c) =>
        c.roomTypes.flatMap((t) =>
          t.ratePlans
            .filter((p) => p.active)
            .flatMap((p) => [
              { item: p, property: c.property, name: `${t.name} ${p.name}` },
              // The room type alone means its main rate plan.
              ...(p.isDefault ? [{ item: p, property: c.property, name: t.name }] : []),
            ]),
        ),
      );
      let hits = mentioned(rate[1]!, plans);
      const property = propertyIn(`${rate[1]} ${period.rest}`, loaded);
      if (hits.length > 1 && property && property !== 'ambiguous') {
        hits = hits.filter((h) => h.property.id === property.id);
      }
      if (hits.length === 0)
        return reply('I could not tell which room type or rate plan you mean.');
      if (hits.length > 1) return reply(`That name fits more than one rate. ${which(loaded)}`);
      const amount = Math.round(Number(rate[2]!.replace(/,/g, '')) * 100);
      const outcome = await use('set_rates', {
        propertyId: hits[0]!.property.id,
        ratePlanId: hits[0]!.item.id,
        from: period.from,
        to: period.to,
        rate: amount,
      });
      return reply(
        'I have prepared this. Confirm it to go ahead.',
        [outcome.action!],
        ['set_rates'],
      );
    }

    // --- Alerts ---------------------------------------------------------------
    if (/\balerts?\b|needs? attention|problems?\b/.test(lower)) {
      const { result } = await use('list_alerts', {});
      const alerts = (result as { alerts: { severity: string; title: string }[] }).alerts;
      return reply(
        alerts.length === 0
          ? 'Nothing needs attention.'
          : alerts
              .map((a) => `- ${a.severity === 'critical' ? 'Urgent: ' : ''}${a.title}`)
              .join('\n'),
        [],
        ['list_alerts'],
      );
    }

    // --- Find a reservation ---------------------------------------------------
    const find =
      /^(?:find|search(?: for)?|look up|show)\s+(?:the\s+)?(?:reservation|booking)s?\s+(?:for\s+|of\s+)?(.+)$/i.exec(
        text,
      ) ?? /^(?:reservation|booking)\s+(.+)$/i.exec(text);
    if (find) {
      const { result } = await use('search_reservations', {
        search: find[1]!.trim().slice(0, 100),
      });
      const found = result as {
        total: number;
        reservations: {
          code: string;
          guestName: string;
          status: string;
          checkIn: string;
          checkOut: string;
          rooms: string[];
          total: number;
          currency: string;
        }[];
      };
      if (found.reservations.length === 0)
        return reply('No reservation matches that.', [], ['search_reservations']);
      return reply(
        found.reservations
          .slice(0, 10)
          .map(
            (r) =>
              `- ${r.code}: ${r.guestName}, ${r.checkIn} to ${r.checkOut}, ${r.rooms.join(', ')}, ${r.status.replace('_', ' ')}, ${money(r.total, r.currency)}`,
          )
          .join('\n') +
          (found.total > 10 ? `\n(${found.total} in all; the first 10 are shown)` : ''),
        [],
        ['search_reservations'],
      );
    }

    // Everything below is about one property.
    const property = propertyIn(text, loaded);
    const needProperty = (): CopilotReply | null =>
      !property || property === 'ambiguous' ? reply(which(loaded)) : null;

    // --- Front desk -----------------------------------------------------------
    if (
      /\b(arrivals?|arriving|check-?ins?|departures?|leaving|check-?outs?|in[- ]house)\b/.test(
        lower,
      )
    ) {
      const ask = needProperty();
      if (ask) return ask;
      const { result } = await use('front_desk_today', {
        propertyId: (property as PropertyRow).id,
      });
      const board = result as {
        date: string;
        counts: {
          arrivals: number;
          arrived: number;
          departures: number;
          departed: number;
          inHouse: number;
        };
        arrivals: { guestName: string; code: string; room: string }[];
        departures: { guestName: string; code: string; room: string }[];
      };
      const wantsDepartures = /departures?|leaving|check-?outs?/.test(lower);
      const list = wantsDepartures ? board.departures : board.arrivals;
      const head = wantsDepartures
        ? `${board.counts.departures} departure${board.counts.departures === 1 ? '' : 's'} on ${board.date} (${board.counts.departed} gone)`
        : `${board.counts.arrivals} arrival${board.counts.arrivals === 1 ? '' : 's'} on ${board.date} (${board.counts.arrived} checked in), ${board.counts.inHouse} in house`;
      return reply(
        [head, ...list.slice(0, 25).map((s) => `- ${s.guestName} (${s.code}), ${s.room}`)].join(
          '\n',
        ),
        [],
        ['front_desk_today'],
      );
    }

    // --- Occupancy ------------------------------------------------------------
    if (/\boccupancy\b/.test(lower)) {
      const ask = needProperty();
      if (ask) return ask;
      const p = property as PropertyRow;
      const period = findPeriod(text, todayOf(p), true) ?? {
        from: todayOf(p),
        to: addDays(todayOf(p), 7),
      };
      const to =
        'explicitEnd' in period && !period.explicitEnd ? addDays(period.from, 7) : period.to;
      const { result } = await use('occupancy_summary', {
        propertyId: p.id,
        from: period.from,
        to,
      });
      const days = (
        result as {
          nights: {
            date: string;
            sold: number;
            rooms: number;
            occupancyPercent: number;
            revenue: number;
          }[];
        }
      ).nights;
      const sold = days.reduce((s, d) => s + d.sold, 0);
      const rooms = days.reduce((s, d) => s + d.rooms, 0);
      const revenue = days.reduce((s, d) => s + d.revenue, 0);
      return reply(
        [
          `${p.name}, ${period.from} to ${addDays(to, -1)}: ${rooms ? Math.round((sold * 100) / rooms) : 0}% occupied, ${sold} room nights sold, ${money(revenue, p.currency)} room revenue on the books.`,
          ...days
            .slice(0, 31)
            .map((d) => `- ${d.date}: ${d.occupancyPercent}% (${d.sold}/${d.rooms})`),
        ].join('\n'),
        [],
        ['occupancy_summary'],
      );
    }

    // --- Availability ---------------------------------------------------------
    if (/\b(availability|available|rooms?\s+(?:free|left)|vacan)/.test(lower)) {
      const ask = needProperty();
      if (ask) return ask;
      const p = property as PropertyRow;
      const period = findPeriod(text, todayOf(p), true) ?? {
        from: todayOf(p),
        to: addDays(todayOf(p), 1),
      };
      const { result } = await use('get_availability', {
        propertyId: p.id,
        from: period.from,
        to: period.to,
      });
      const types = (
        result as { roomTypes: { name: string; nights: { date: string; available: number }[] }[] }
      ).roomTypes;
      const span =
        addDays(period.to, -1) === period.from
          ? period.from
          : `${period.from} to ${addDays(period.to, -1)}`;
      return reply(
        [
          `${p.name}, ${span} (rooms free on every night):`,
          ...types.map(
            (t) => `- ${t.name}: ${Math.max(0, Math.min(...t.nights.map((n) => n.available)))}`,
          ),
        ].join('\n'),
        [],
        ['get_availability'],
      );
    }

    // --- Groups ---------------------------------------------------------------
    if (/\bgroups?\b/.test(lower)) {
      const ask = needProperty();
      if (ask) return ask;
      const { result } = await use('list_groups', { propertyId: (property as PropertyRow).id });
      const { groups } = result as {
        groups: {
          code: string;
          name: string;
          firstNight: string | null;
          leavingOn: string | null;
          cutoffDate: string | null;
          heldRoomNights: number;
          heldRoomNightsStillToBook: number;
          bookings: number;
        }[];
      };
      if (groups.length === 0) {
        return reply(
          `No group is holding rooms at ${(property as PropertyRow).name}.`,
          [],
          ['list_groups'],
        );
      }
      return reply(
        groups
          .map((g) => {
            const dates = g.firstNight && g.leavingOn ? `, ${g.firstNight} to ${g.leavingOn}` : '';
            const held =
              g.heldRoomNights > 0
                ? `${g.heldRoomNights - g.heldRoomNightsStillToBook} of ${g.heldRoomNights} held room nights booked`
                : 'no rooms held';
            const cutoff = g.cutoffDate
              ? `; unbooked rooms go back on sale after ${g.cutoffDate}`
              : '';
            return `${g.name} (${g.code})${dates}: ${held}, ${g.bookings} booking${g.bookings === 1 ? '' : 's'}${cutoff}`;
          })
          .join('\n'),
        [],
        ['list_groups'],
      );
    }

    // --- Housekeeping ---------------------------------------------------------
    if (/\b(housekeeping|dirty|not cleaned|to clean)\b/.test(lower)) {
      const ask = needProperty();
      if (ask) return ask;
      const { result } = await use('housekeeping_status', {
        propertyId: (property as PropertyRow).id,
      });
      const board = result as {
        counts: { clean: number; dirty: number; inspected: number; out_of_service: number };
        notClean: { name: string }[];
      };
      return reply(
        `${board.counts.dirty} not cleaned, ${board.counts.clean} clean, ${board.counts.inspected} inspected, ${board.counts.out_of_service} out of service.` +
          (board.notClean.length
            ? `\nTo clean: ${board.notClean.map((u) => u.name).join(', ')}`
            : ''),
        [],
        ['housekeeping_status'],
      );
    }

    return reply(`I did not understand that.\n\n${HELP}`);
  } catch (err) {
    if (err instanceof RuleRefusal) return reply(err.message);
    throw err;
  }
}

/** A tool said no (no permission, nothing found, dates that make no sense): shown to the user as the answer. */
class RuleRefusal extends Error {}
