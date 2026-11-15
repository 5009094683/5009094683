import type { Desk } from '../bookings/desk';
import {
  type Business,
  type Lang,
  type Service,
  type ServiceOption,
  findOption,
  findService,
} from '../business/schema';
import { countOfOption, matchOption, matchService } from '../nlu/catalog';
import { type IsoDate, diffDays, parseBareDay, parseDates, todayIn } from '../nlu/dates';
import { type Intent, detectIntents, isAbort, isNo, isSkip, isYes } from '../nlu/intents';
import { findBikes, findPeople, findPhone, parseCount, parseName } from '../nlu/numbers';
import { detectLanguage, fold, hasAnyPhrase } from '../nlu/text';
import type { Booking } from '../store';
import type { Bookings } from '../store/bookings';
import { type ChatState, type Slot, restoreState } from './state';
import { bookingMessage, viewOfDraft } from './view';
import { type Wording, WORDING } from './wording';

/** Why a chat is passed to a person. */
export type HandoffReason =
  'asked' | 'confused' | 'cancel_request' | 'change_request' | 'large_request';

export interface EngineInput {
  text: string;
  /** Photos, stickers, files, voice clips sent with or instead of the text. */
  attachments: number;
  /** The message is nothing but Messenger's thumbs-up button. */
  likeOnly?: boolean;
}

export interface EngineContext {
  threadId: string;
  /** The language of the chat so far. */
  lang: Lang;
  /** The customer's name as Facebook gives it, when known. */
  customerName: string | null;
  now: number;
}

export interface EngineResult {
  /** To be stored and handed back with the customer's next message. */
  state: ChatState;
  lang: Lang;
  replies: string[];
  /** Set when the chat passes to a person; the assistant then stays silent. */
  handoff: HandoffReason | null;
  /** The booking this message placed. */
  booking: Booking | null;
  /** Something a person should look at, though the assistant carries on. */
  attention: string | null;
}

const FREE_TEXT: Slot[] = ['name', 'phone', 'pickup'];
const SWITCH_CUES = [
  'instead', 'actually', 'rather', 'change to', 'switch to',
  'doi sang', 'chuyen sang', 'thay vi', 'thay bang',
]; // prettier-ignore

const EXPLICIT_NAME =
  /(?:my name is|my name's|name\s*:|tên (?:của )?(?:tôi|mình|em|anh|chị) là|tên\s*:|ten (?:cua )?(?:toi|minh|em|anh|chi) la|ten\s*:)\s*([^,.;!?\n]{2,60})/i;
const EXPLICIT_PICKUP =
  /(?:pick(?:-|\s)?up (?:at|from|is|place is|point is)|pick(?:-|\s)?up\s*:|staying at|stay at|my hotel is|hotel\s*:|đón (?:ở|tại)|điểm đón\s*:|don (?:o|tai)|diem don\s*:|khách sạn\s*:)\s*([^.;!?\n]{3,120})/i;

// "We are staying at Primrose Homestay" is noted as "Primrose Homestay".
const PICKUP_LEAD_IN =
  /^(?:(?:we|i)(?: am|'m| are|'re| will be)? (?:stay(?:ing)?|living) (?:at|in)|(?:please )?pick (?:me|us) up (?:at|from)|(?:my|our) (?:hotel|hostel|homestay|address) is|(?:it is|it's|at|from)|(?:mình|em|tôi|anh|chị|bọn mình|tụi mình|chúng tôi) (?:đang )?ở|đón (?:mình|em|tôi|anh|chị)? ?(?:ở|tại)|(?:ở|tại))\s+/i;

/**
 * Decides what the assistant says to each message. It keeps nothing itself:
 * what it remembers of a chat comes in and goes out as the state.
 */
export class Engine {
  constructor(
    private readonly business: Business,
    private readonly desk: Desk,
    private readonly bookings: Bookings,
  ) {}

  handle(stored: unknown, input: EngineInput, context: EngineContext): EngineResult {
    return new Turn(this.business, this.desk, this.bookings, stored, input, context).run();
  }
}

/** One message from a customer and the working out of the answer to it. */
class Turn {
  private readonly state: ChatState;
  private readonly lang: Lang;
  private readonly w: Wording;
  private readonly today: IsoDate;
  private readonly text: string;
  private readonly folded: string;
  private readonly intents: Set<Intent>;

  private parts: string[] = [];
  private handoff: HandoffReason | null = null;
  private booking: Booking | null = null;
  private attention: string | null = null;
  /** The message moved things on: a detail was taken, a question answered. */
  private productive = false;
  private welcomed = false;
  private undecided: Service[] = [];
  /** The message named a date, whether or not it could be taken. */
  private gaveDate = false;

  constructor(
    private readonly business: Business,
    private readonly desk: Desk,
    private readonly bookings: Bookings,
    stored: unknown,
    private readonly input: EngineInput,
    private readonly context: EngineContext,
  ) {
    this.state = restoreState(stored, context.now);
    this.text = input.text.trim();
    this.folded = fold(this.text);
    this.lang = detectLanguage(this.text) ?? context.lang;
    this.w = WORDING[this.lang];
    this.today = todayIn(business.timezone, new Date(context.now));
    this.intents = detectIntents(this.folded);
  }

  run(): EngineResult {
    const confirming = this.state.stage === 'confirming';
    if (this.text === '') {
      // A thumbs-up sticker or a lone "like" needs no answer; anything else sent
      // without words (a photo, a file, a voice clip) is for a person to look at.
      if (this.input.attachments > 0 && !this.input.likeOnly) {
        this.attention = 'The customer sent a photo, sticker or file.';
        this.say(this.w.attachmentOnly());
      } else if (this.input.likeOnly && confirming) {
        this.place();
      }
    } else if (!/[\p{L}\p{N}]/u.test(this.text)) {
      // Emoji only. A thumbs-up to the summary is a yes; otherwise nothing to answer.
      if (confirming && isYes(this.folded, this.text)) this.place();
    } else {
      if (this.input.attachments > 0) {
        this.attention = 'The customer sent a photo, sticker or file.';
      }
      this.route();
    }
    return this.finish();
  }

  private finish(): EngineResult {
    const { state } = this;
    if (this.productive) state.misses = 0;
    if (state.stage !== 'idle') state.touchedAt = this.context.now;
    this.rememberTopic();

    let parts = this.parts;
    if (parts.length > 0 && !state.greeted) {
      if (!this.welcomed && this.handoff === null) parts = [this.w.intro(this.business), ...parts];
      state.greeted = true;
    }
    return {
      state,
      lang: this.lang,
      replies: parts.length > 0 ? [parts.join('\n\n')] : [],
      handoff: this.handoff,
      booking: this.booking,
      attention: this.attention,
    };
  }

  private route(): void {
    const { intents, state, w } = this;

    if (intents.has('human')) {
      return this.passOn('asked', w.handoff(this.business));
    }
    if (intents.has('cancel_booking') || intents.has('change_booking')) {
      return this.aboutAnExistingBooking();
    }
    if (state.stage !== 'idle' && isAbort(this.folded)) {
      return this.dropDraft();
    }
    switch (state.stage) {
      case 'confirming':
        return this.whileConfirming();
      case 'collecting':
        return this.whileCollecting();
      default:
        return this.whileIdle();
    }
  }

  // ---------------------------------------------------------------- stages

  private whileIdle(): void {
    const { state, w, intents } = this;
    this.absorb();
    const draft = state.draft;

    const hasDetails =
      this.gaveDate ||
      draft.days !== undefined ||
      draft.people !== undefined ||
      draft.bikes !== undefined;
    if (hasDetails && this.undecided.length === 0) {
      // "20/11, 2 days" after "how much is a scooter?": about what was just spoken of.
      this.takeUpTopic();
    }
    const answers = this.answerQuestions();
    // A wish to book, a service with a detail, or a date on its own ("20/11?").
    const startsBooking =
      intents.has('book') || (hasDetails && (draft.serviceId !== undefined || this.gaveDate));

    if (startsBooking) {
      this.productive = true;
      this.say(...answers);
      return this.advance();
    }

    // Not a booking yet: remember what was spoken of, drop the rest.
    const service = this.service();
    this.rememberTopic();
    state.draft = {};

    if (answers.length > 0) {
      this.productive = true;
      this.say(...answers);
      if (intents.has('price') || intents.has('included') || intents.has('services')) {
        this.say(w.offerToBook());
      }
      return;
    }
    if (service) {
      // "Do you have scooters?": tell what it costs and offer to book.
      this.productive = true;
      return this.say(w.prices(service), w.offerToBook());
    }
    if (this.undecided.length > 1) {
      this.productive = true;
      return this.ask('service', w.askService(this.business));
    }
    if (intents.has('greeting')) {
      this.productive = true;
      if (state.greeted) return this.say(w.askService(this.business));
      this.welcomed = true;
      return this.say(w.welcome(this.business));
    }
    const pleasantry = this.pleasantry();
    if (pleasantry !== null) {
      this.productive = true;
      return this.say(pleasantry);
    }
    this.stuck(() => {
      // A first message that cannot be used gets the welcome, which says what can be.
      if (state.greeted) return this.say(w.notUnderstood(this.business));
      this.welcomed = true;
      this.say(w.welcome(this.business));
    });
  }

  private whileCollecting(): void {
    const { state, w } = this;
    const asked = state.asked;
    let changed = false;
    let answers: string[] = [];

    if (asked !== null && FREE_TEXT.includes(asked)) {
      // A name or an address is taken as written, unless the message asks something.
      if (this.asksSomething()) answers = this.answerQuestions();
      else changed = this.answerTo(asked);
    } else {
      if (asked !== null) changed = this.answerTo(asked);
      changed = this.absorb() || changed;
      answers = this.answerQuestions();
    }

    this.say(...answers);
    if (changed || answers.length > 0) {
      this.productive = true;
      return this.advance();
    }
    const pleasantry = this.pleasantry();
    if (pleasantry !== null) {
      this.say(pleasantry);
      return this.advance();
    }
    this.stuck(() => {
      this.say(w.sorry());
      this.advance();
    });
  }

  private whileConfirming(): void {
    const { state, w } = this;
    if (isYes(this.folded, this.text)) return this.place();

    const service = this.service();
    if (isNo(this.folded) && service) {
      this.productive = true;
      state.stage = 'collecting';
      state.asked = null;
      return this.say(w.whatToChange(service.kind));
    }

    const changed = this.absorb();
    const answers = this.answerQuestions();
    this.say(...answers);
    if (changed) {
      this.productive = true;
      return this.advance();
    }
    if (answers.length > 0) {
      this.productive = true;
      return this.say(w.remindConfirm());
    }
    const pleasantry = this.pleasantry();
    if (pleasantry !== null) return this.say(pleasantry, w.remindConfirm());
    this.stuck(() => this.say(w.sorry(), w.remindConfirm()));
  }

  // ------------------------------------------------- what the message says

  /** Takes every booking detail the message gives. True when it gave any. */
  private absorb(): boolean {
    const { state, text, folded } = this;
    const draft = state.draft;
    const before = JSON.stringify(draft);
    const said = this.parts.length;

    const match = matchService(folded, this.business);
    this.undecided = match.unsure;
    if (match.service) {
      if (draft.serviceId === undefined) this.setService(match.service);
      else if (match.service.id !== draft.serviceId && match.strong && this.wantsAnotherService()) {
        this.setService(match.service);
      }
    }

    const service = this.service();
    let counted: number | undefined;
    if (service) {
      const named =
        match.service?.id === service.id && match.option
          ? match.option
          : this.singleOption(matchOption(folded, service));
      if (named) {
        this.setOption(named);
        // "2 Honda Wave": the count stands before the model, not before "motorbikes".
        if (service.kind === 'rental') counted = countOfOption(folded, named);
      }
    }

    const dates = parseDates(text, this.today);
    if (dates.start !== undefined) this.setStart(dates.start);
    if (dates.days !== undefined) this.setDays(dates.days);

    const people = findPeople(folded);
    const bikes = findBikes(folded) ?? counted;
    if (people !== undefined) draft.people = people;
    if (bikes !== undefined) draft.bikes = bikes;
    this.syncQuantity(people !== undefined || bikes !== undefined);

    const phone = findPhone(text);
    if (phone !== undefined) draft.phone = phone;
    const name = EXPLICIT_NAME.exec(text);
    if (name) draft.name = parseName(name[1]!) ?? draft.name;
    const pickup = EXPLICIT_PICKUP.exec(text);
    if (pickup) draft.pickup = pickup[1]!.trim();

    // A date that had to be refused was still understood.
    return JSON.stringify(draft) !== before || this.parts.length > said;
  }

  /** Reads the message as the answer to the question asked last. True when it was one. */
  private answerTo(slot: Slot): boolean {
    const { state, text, folded } = this;
    const draft = state.draft;
    const before = JSON.stringify(draft);
    const said = this.parts.length;
    const service = this.service();

    switch (slot) {
      case 'service': {
        const n = this.pickNumber(this.business.services.length);
        if (n !== undefined) this.setService(this.business.services[n - 1]!);
        break;
      }
      case 'option': {
        const n = service ? this.pickNumber(service.options.length) : undefined;
        if (service && n !== undefined) this.setOption(service.options[n - 1]!);
        break;
      }
      case 'startDate': {
        if (parseDates(text, this.today).start === undefined) {
          const day = parseBareDay(text, this.today);
          if (day !== undefined) this.setStart(day);
        }
        break;
      }
      case 'days': {
        if (parseDates(text, this.today).days === undefined) {
          const n = /^(?:just |only )?(?:a|the|one) day$/.test(folded) ? 1 : parseCount(text);
          if (n !== undefined) this.setDays(n);
        }
        break;
      }
      case 'quantity': {
        const n = parseCount(text);
        if (n !== undefined) {
          draft.quantity = n;
          if (service?.kind === 'rental') draft.bikes = n;
          else draft.people = n;
        }
        break;
      }
      case 'name': {
        const filler =
          isYes(folded, text) || isNo(folded) || isSkip(folded) || this.pleasantry() !== null;
        if (!filler) draft.name = parseName(text) ?? draft.name;
        break;
      }
      case 'phone': {
        if (isSkip(folded)) draft.phone = null;
        else draft.phone = findPhone(text, true) ?? draft.phone;
        break;
      }
      case 'pickup': {
        if (isSkip(folded)) draft.pickup = null;
        else if (text.length <= 200) {
          draft.pickup = text.replace(/\s+/g, ' ').replace(PICKUP_LEAD_IN, '') || draft.pickup;
        }
        break;
      }
    }
    return JSON.stringify(draft) !== before || this.parts.length > said;
  }

  /** The answers to whatever the message asks, at most three. */
  private answerQuestions(): string[] {
    const { intents, w, state, business, folded } = this;
    const answers: string[] = [];
    const service =
      this.service() ?? (state.topic ? findService(business, state.topic.serviceId) : undefined);

    const code = this.codeNamed();
    if (intents.has('status') || code !== undefined) {
      const mine = this.bookings.ofThread(this.context.threadId);
      const named = code === undefined ? undefined : mine.filter((b) => b.code === code);
      const shown = named ?? mine.slice(0, 3);
      answers.push(shown.length > 0 ? w.status(shown) : w.noBookings());
    }
    if (intents.has('services') && state.stage === 'idle') {
      answers.push(w.askService(business));
    }
    if (intents.has('price')) {
      answers.push(
        service ? w.prices(service) : business.services.map((s) => w.prices(s)).join('\n\n'),
      );
    }
    if (intents.has('included')) {
      answers.push(
        service ? w.included(service) : business.services.map((s) => w.included(s)).join('\n'),
      );
    }
    if (intents.has('discount')) {
      // Only a person can agree a price; the assistant says so and carries on.
      answers.push(w.discount());
      this.attention = 'The customer asks about a discount.';
    }
    if (intents.has('payment')) answers.push(w.payment(business));
    if (intents.has('cancel_policy')) answers.push(w.cancellation(business));
    if (intents.has('documents')) answers.push(w.documents());
    // "My WhatsApp is +44..." gives a number; it does not ask for ours.
    if (intents.has('contact') && state.asked !== 'phone' && findPhone(this.text) === undefined) {
      answers.push(w.contact(business));
    }
    if (intents.has('location') && state.asked !== 'pickup') answers.push(w.location(business));
    for (const entry of business.faq) {
      if (hasAnyPhrase(folded, entry.keywords.map(fold))) answers.push(entry.answer[this.lang]);
    }
    return answers.slice(0, 3);
  }

  /** In answer to "your name?" or "where to pick you up?": is this a question instead? */
  private asksSomething(): boolean {
    if (this.text.includes('?')) return true;
    const questions: Intent[] = ['price', 'included', 'payment', 'cancel_policy', 'services', 'status']; // prettier-ignore
    return questions.some((intent) => this.intents.has(intent));
  }

  private pleasantry(): string | null {
    if (this.intents.has('thanks')) return this.w.thanks();
    if (this.intents.has('bye')) return this.w.bye();
    return null;
  }

  private wantsAnotherService(): boolean {
    return this.intents.has('book') || hasAnyPhrase(this.folded, SWITCH_CUES);
  }

  /** "2", "no. 2", "option 2", "số 2": a choice from a numbered list. */
  private pickNumber(max: number): number | undefined {
    const match = /^(?:number |no\.? ?|option |so |#)?(\d{1,2})[.)]?$/.exec(this.folded);
    const n = match ? Number(match[1]) : NaN;
    return n >= 1 && n <= max ? n : undefined;
  }

  /** The booking number written in the message, if any: "CB-7K3FQ", "cb 7k3fq". */
  private codeNamed(): string | undefined {
    const prefix = this.business.booking.codePrefix;
    const match = new RegExp(`(?<![a-z0-9])${prefix}[- ]?([a-z0-9]{5})(?![a-z0-9])`, 'i').exec(
      this.text,
    );
    return match ? `${prefix}-${match[1]!.toUpperCase()}` : undefined;
  }

  // ------------------------------------------------------------ the draft

  private service(): Service | undefined {
    const id = this.state.draft.serviceId;
    return id === undefined ? undefined : findService(this.business, id);
  }

  private option(): ServiceOption | undefined {
    const service = this.service();
    const id = this.state.draft.optionId;
    return service && id !== undefined ? findOption(service, id) : undefined;
  }

  private singleOption(match: ReturnType<typeof matchOption>): ServiceOption | undefined {
    return match.kind === 'one' ? match.option : undefined;
  }

  private setService(service: Service): void {
    const draft = this.state.draft;
    if (draft.serviceId !== service.id) {
      draft.serviceId = service.id;
      delete draft.optionId;
      delete draft.quantity;
      if (service.options.length === 1) this.setOption(service.options[0]!);
    }
    this.syncQuantity(false);
  }

  /** Keeps the service and option in mind for the customer's next message. */
  private rememberTopic(): void {
    const service = this.service();
    if (!service) return;
    this.state.topic = {
      serviceId: service.id,
      optionId: this.option()?.id,
      at: this.context.now,
    };
  }

  /** Fills the service, and the option of it, from what was last spoken of. */
  private takeUpTopic(): void {
    const topic = this.state.topic;
    const draft = this.state.draft;
    const service = topic ? findService(this.business, topic.serviceId) : undefined;
    if (!topic || !service) return;
    if (draft.serviceId === undefined) this.setService(service);
    if (draft.serviceId !== service.id || draft.optionId !== undefined) return;
    const option = topic.optionId ? findOption(service, topic.optionId) : undefined;
    if (option) this.setOption(option);
  }

  private setOption(option: ServiceOption): void {
    const draft = this.state.draft;
    draft.optionId = option.id;
    if (option.days !== undefined) draft.days = option.days;
  }

  private setStart(date: IsoDate): void {
    const { w, business } = this;
    this.gaveDate = true;
    if (date < this.today) {
      this.say(w.dateInPast(date));
    } else if (diffDays(this.today, date) > business.booking.maxAdvanceDays) {
      this.say(w.dateTooFar(business.booking.maxAdvanceDays));
    } else {
      this.state.draft.startDate = date;
    }
  }

  private setDays(days: number): void {
    // A tour of fixed length keeps its length whatever the message says.
    if (this.option()?.days !== undefined) return;
    this.state.draft.days = days;
  }

  /** Motorbikes are counted for a rental, people for a tour or an Easy Rider trip. */
  private syncQuantity(fromThisMessage: boolean): void {
    const draft = this.state.draft;
    const service = this.service();
    if (!service) return;
    const counted = service.kind === 'rental' ? draft.bikes : draft.people;
    if (counted !== undefined && (fromThisMessage || draft.quantity === undefined)) {
      draft.quantity = counted;
    }
  }

  private dropDraft(): void {
    const { state } = this;
    this.productive = true;
    state.stage = 'idle';
    state.draft = {};
    state.asked = null;
    this.say(this.w.draftDropped());
  }

  // ----------------------------------------------------------- next steps

  /** Asks for the next missing detail, or shows the summary when none is missing. */
  private advance(): void {
    const { state, w, business } = this;
    const draft = state.draft;
    state.stage = 'collecting';

    const service = this.service();
    if (!service) return this.ask('service', w.askService(business));

    let option = this.option();
    if (!option) {
      if (service.options.length > 1) return this.ask('option', w.askOption(service));
      option = service.options[0]!;
      this.setOption(option);
    }
    if (option.days !== undefined) draft.days = option.days;

    if (draft.startDate === undefined) return this.ask('startDate', w.askStartDate(service.kind));
    if (draft.days === undefined) return this.ask('days', w.askDays(service.kind));
    if (draft.quantity === undefined) return this.ask('quantity', w.askQuantity(service.kind));

    if (draft.days > business.booking.maxDays || draft.quantity > business.booking.maxQuantity) {
      return this.passOn('large_request', w.needsPerson(business));
    }

    const availability = this.desk.availability(
      service.id,
      option.id,
      draft.startDate,
      draft.days,
      draft.quantity,
    );
    if (availability.state === 'full') {
      // The draft stays as it is: another date or a smaller number both fit in.
      state.asked = 'startDate';
      return this.say(w.full(service.kind, availability.left));
    }

    if (draft.name === undefined) {
      if (!this.context.customerName) return this.ask('name', w.askName());
      draft.name = this.context.customerName;
    }
    if (draft.phone === undefined && business.booking.askPhone) {
      return this.ask('phone', w.askPhone());
    }
    if (draft.pickup === undefined && business.booking.askPickup) {
      return this.ask('pickup', w.askPickup(service.kind));
    }

    state.stage = 'confirming';
    state.asked = null;
    this.say(
      w.summary(
        viewOfDraft(this.lang, service, option, {
          startDate: draft.startDate,
          days: draft.days,
          quantity: draft.quantity,
          name: draft.name,
          phone: draft.phone ?? null,
          pickup: draft.pickup ?? null,
        }),
      ),
    );
  }

  /** The customer said yes to the summary. */
  private place(): void {
    const { state, w } = this;
    const draft = state.draft;
    const service = this.service();
    const option = this.option();
    if (
      !service ||
      !option ||
      draft.startDate === undefined ||
      draft.days === undefined ||
      draft.quantity === undefined ||
      draft.name === undefined
    ) {
      // The settings changed under a booking in progress; ask again for what is missing.
      return this.advance();
    }

    this.productive = true;
    const result = this.desk.place({
      threadId: this.context.threadId,
      lang: this.lang,
      serviceId: service.id,
      optionId: option.id,
      startDate: draft.startDate,
      days: draft.days,
      quantity: draft.quantity,
      customerName: draft.name,
      phone: draft.phone ?? null,
      pickup: draft.pickup ?? null,
    });
    if (!result.ok) {
      // Someone else took the last ones while this customer was deciding.
      state.stage = 'collecting';
      state.asked = 'startDate';
      return this.say(w.full(service.kind, result.left));
    }

    this.booking = result.booking;
    state.stage = 'idle';
    state.draft = {};
    state.asked = null;
    this.say(bookingMessage(result.booking, this.business));
  }

  /** A request about a booking already made goes to a person, with the terms that apply. */
  private aboutAnExistingBooking(): void {
    const { w, state, intents } = this;
    const active = this.bookings
      .ofThread(this.context.threadId)
      .filter((booking) => booking.status === 'pending' || booking.status === 'confirmed');

    if (active.length === 0) {
      // "I want to cancel" while a booking is being put together means: drop it.
      if (state.stage !== 'idle') return this.dropDraft();
      this.productive = true;
      return this.say(w.noBookings());
    }

    const code = this.codeNamed();
    const booking =
      active.find((candidate) => candidate.code === code) ??
      (active.length === 1 ? active[0]! : null);

    if (intents.has('cancel_booking')) {
      const service = booking ? findService(this.business, booking.serviceId) : undefined;
      const terms = service ? w.cancellationOf(service) : '';
      return this.passOn('cancel_request', w.cancelRequest(booking, terms));
    }
    this.passOn('change_request', w.changeRequest(booking));
  }

  private ask(slot: Slot, question: string): void {
    this.state.stage = 'collecting';
    this.state.asked = slot;
    this.say(question);
  }

  private passOn(reason: HandoffReason, message: string): void {
    this.productive = true;
    this.handoff = reason;
    this.say(message);
  }

  /** The message could not be used. The second time in a row, a person is called in. */
  private stuck(otherwise: () => void): void {
    this.state.misses += 1;
    if (this.state.misses >= 2) {
      this.passOn('confused', this.w.handoffConfused(this.business));
      this.productive = false;
      return;
    }
    otherwise();
  }

  private say(...parts: string[]): void {
    this.parts.push(...parts.filter((part) => part !== ''));
  }
}
