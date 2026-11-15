import type { IsoDate } from '../nlu/dates';

/** The details a booking needs, in the order the assistant asks for them. */
export type Slot =
  'service' | 'option' | 'startDate' | 'days' | 'quantity' | 'name' | 'phone' | 'pickup';

export interface Draft {
  serviceId?: string;
  optionId?: string;
  startDate?: IsoDate;
  days?: number;
  quantity?: number;
  /** Counts heard before the service was known: "2 people" may be 2 travellers or 2 passengers. */
  people?: number;
  bikes?: number;
  name?: string;
  /** null: the customer chose not to give one. */
  phone?: string | null;
  pickup?: string | null;
}

export interface Topic {
  serviceId: string;
  optionId?: string;
  at: number;
}

export interface ChatState {
  /**
   * idle:       nothing in progress
   * collecting: a booking is being put together
   * confirming: the summary was shown; waiting for "yes"
   */
  stage: 'idle' | 'collecting' | 'confirming';
  draft: Draft;
  /** The question asked last, so that a bare "2" or "20/11" is understood. */
  asked: Slot | null;
  /** How many messages in a row the assistant could do nothing with. */
  misses: number;
  /** Whether the customer has been told they are talking to an automatic assistant. */
  greeted: boolean;
  /** What was spoken of last, for "ok, 2 days from tomorrow then". */
  topic: Topic | null;
  /** When the booking in progress was last worked on. */
  touchedAt: number;
}

export function freshState(): ChatState {
  return {
    stage: 'idle',
    draft: {},
    asked: null,
    misses: 0,
    greeted: false,
    topic: null,
    touchedAt: 0,
  };
}

/**
 * A booking left unfinished this long is dropped, and what was spoken of is
 * forgotten; the next message starts afresh.
 */
export const DRAFT_EXPIRY_MS = 12 * 60 * 60 * 1000;

const SLOTS: Slot[] = ['service', 'option', 'startDate', 'days', 'quantity', 'name', 'phone', 'pickup']; // prettier-ignore

/** Reads a state back from storage, whatever an older version of the program wrote. */
export function restoreState(stored: unknown, now: number): ChatState {
  const state = freshState();
  if (typeof stored !== 'object' || stored === null) return state;
  const from = stored as Partial<ChatState>;

  state.greeted = from.greeted === true;
  state.misses = typeof from.misses === 'number' ? from.misses : 0;

  const topic = from.topic as Partial<Topic> | null | undefined;
  if (
    topic &&
    typeof topic.serviceId === 'string' &&
    typeof topic.at === 'number' &&
    now - topic.at <= DRAFT_EXPIRY_MS
  ) {
    state.topic = {
      serviceId: topic.serviceId,
      optionId: typeof topic.optionId === 'string' ? topic.optionId : undefined,
      at: topic.at,
    };
  }

  const stage = from.stage;
  const touchedAt = typeof from.touchedAt === 'number' ? from.touchedAt : 0;
  const inProgress = stage === 'collecting' || stage === 'confirming';
  if (!inProgress || now - touchedAt > DRAFT_EXPIRY_MS) return state;

  state.stage = stage;
  state.draft = typeof from.draft === 'object' && from.draft !== null ? { ...from.draft } : {};
  state.asked = SLOTS.includes(from.asked as Slot) ? (from.asked as Slot) : null;
  state.touchedAt = touchedAt;
  return state;
}
