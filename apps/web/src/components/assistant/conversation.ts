'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { calmErrorMessage, isTransient } from './errors';
import type { AiAction, ConfirmedAction, CopilotReply, CopilotTurn } from './types';

/** The limits `POST /ai/copilot` puts on a conversation. */
const MAX_TURNS = 40;
export const MAX_TURN_LENGTH = 4000;
const MAX_ITEMS = 200;
/** Used only if a proposal's own timestamps cannot be read. */
const FALLBACK_LIFETIME_MS = 15 * 60_000;
const STORAGE_PREFIX = 'pms.assistant.';

export type Outcome =
  | { state: 'waiting' }
  | { state: 'done'; message: string }
  | { state: 'dismissed' }
  | { state: 'refused'; message: string };

export interface Proposal {
  action: AiAction;
  outcome: Outcome;
  /** When it lapses, by this device's clock. */
  lapsesAt: number;
}

export type ChatItem =
  | { id: string; kind: 'user'; text: string; error?: string }
  | { id: string; kind: 'assistant'; text: string; actionIds: string[]; rulesNote: boolean }
  /** Proposals from before this conversation that still wait for a decision. */
  | { id: string; kind: 'earlier'; actionIds: string[] };

export interface Conversation {
  items: ChatItem[];
  proposals: Record<string, Proposal>;
  /** The person has been told that no AI service is configured. Said once per conversation. */
  rulesAnnounced: boolean;
}

type Event =
  | { type: 'asked'; id: string; text: string; rulesAnnounced: boolean }
  | { type: 'retried'; id: string }
  | { type: 'failed'; id: string; message: string }
  | { type: 'answered'; id: string; reply: CopilotReply; receivedAt: number }
  | { type: 'earlier'; id: string; actions: AiAction[] }
  | { type: 'decided'; actionId: string; outcome: Outcome }
  | { type: 'reset' };

const EMPTY: Conversation = { items: [], proposals: {}, rulesAnnounced: false };

let counter = 0;
const nextId = (): string => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

function capped(state: Conversation): Conversation {
  if (state.items.length <= MAX_ITEMS) return state;
  const items = state.items.slice(-MAX_ITEMS);
  const shown = new Set(items.flatMap((item) => (item.kind === 'user' ? [] : item.actionIds)));
  return {
    ...state,
    items,
    proposals: Object.fromEntries(Object.entries(state.proposals).filter(([id]) => shown.has(id))),
  };
}

function reduce(state: Conversation, event: Event): Conversation {
  switch (event.type) {
    case 'asked':
      return capped({
        ...state,
        items: [...state.items, { id: event.id, kind: 'user', text: event.text }],
        rulesAnnounced: state.rulesAnnounced || event.rulesAnnounced,
      });
    case 'retried':
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === event.id && item.kind === 'user'
            ? { id: item.id, kind: 'user', text: item.text }
            : item,
        ),
      };
    case 'failed':
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === event.id && item.kind === 'user' ? { ...item, error: event.message } : item,
        ),
      };
    case 'answered': {
      const proposals = { ...state.proposals };
      for (const action of event.reply.actions) {
        // The server's clock and this device's can differ by minutes. The proposal was made
        // just now, so its lifetime is counted from when it arrived here.
        const lifetime = Date.parse(action.expiresAt) - Date.parse(action.createdAt);
        proposals[action.id] = {
          action,
          outcome: { state: 'waiting' },
          lapsesAt:
            event.receivedAt + (Number.isFinite(lifetime) ? lifetime : FALLBACK_LIFETIME_MS),
        };
      }
      const rules = event.reply.mode === 'rules';
      return capped({
        items: [
          ...state.items,
          {
            id: event.id,
            kind: 'assistant',
            text: event.reply.reply,
            actionIds: event.reply.actions.map((action) => action.id),
            rulesNote: rules && !state.rulesAnnounced,
          },
        ],
        proposals,
        rulesAnnounced: state.rulesAnnounced || rules,
      });
    }
    case 'earlier': {
      const fresh = event.actions.filter((action) => !(action.id in state.proposals));
      if (fresh.length === 0) return state;
      const proposals = { ...state.proposals };
      for (const action of fresh) {
        proposals[action.id] = {
          action,
          outcome: { state: 'waiting' },
          lapsesAt: Date.parse(action.expiresAt),
        };
      }
      // The server lists the newest first; a conversation reads oldest first.
      const actionIds = fresh.map((action) => action.id).reverse();
      return capped({
        ...state,
        items: [...state.items, { id: event.id, kind: 'earlier', actionIds }],
        proposals,
      });
    }
    case 'decided': {
      const proposal = state.proposals[event.actionId];
      if (!proposal) return state;
      return {
        ...state,
        proposals: {
          ...state.proposals,
          [event.actionId]: { ...proposal, outcome: event.outcome },
        },
      };
    }
    case 'reset':
      return EMPTY;
  }
}

/** The conversation as the API takes it: what was said, leaving out questions that never got an answer. */
export function turnsFor(items: ChatItem[], question: string): CopilotTurn[] {
  const turns: CopilotTurn[] = [];
  for (const item of items) {
    if (item.kind === 'user' && !item.error) {
      turns.push({ role: 'user', content: item.text.slice(0, MAX_TURN_LENGTH) });
    } else if (item.kind === 'assistant' && item.text.trim()) {
      turns.push({ role: 'assistant', content: item.text.slice(0, MAX_TURN_LENGTH) });
    }
  }
  turns.push({ role: 'user', content: question });
  const recent = turns.slice(-MAX_TURNS);
  // Cutting an old conversation can leave an answer without its question at the start.
  return recent[0]?.role === 'assistant' ? recent.slice(1) : recent;
}

function readStored(userId: string): Conversation {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + userId);
    if (!raw) return EMPTY;
    const stored = JSON.parse(raw) as Partial<Conversation> | null;
    if (!stored || !Array.isArray(stored.items) || !stored.proposals) return EMPTY;
    return {
      items: stored.items,
      proposals: stored.proposals,
      rulesAnnounced: stored.rulesAnnounced === true,
    };
  } catch {
    return EMPTY;
  }
}

function writeStored(userId: string, conversation: Conversation): void {
  try {
    if (conversation.items.length === 0) window.sessionStorage.removeItem(STORAGE_PREFIX + userId);
    else window.sessionStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(conversation));
  } catch {
    // Storage full or blocked: the conversation lasts until the page is reloaded.
  }
}

/** Removes every stored conversation except, optionally, one person's. */
function forgetStored(exceptUserId?: string): void {
  try {
    const storage = window.sessionStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key?.startsWith(STORAGE_PREFIX) && key !== STORAGE_PREFIX + exceptUserId) {
        storage.removeItem(key);
      }
    }
  } catch {
    // Nothing to remove if storage cannot be reached.
  }
}

export interface ConversationApi {
  conversation: Conversation;
  /** True while a question waits for its answer. */
  asking: boolean;
  /** Proposals being confirmed or dismissed right now. */
  deciding: Record<string, 'confirm' | 'dismiss'>;
  /** Why a confirm or dismiss did not get through, where trying again can work. */
  cardErrors: Record<string, string>;
  /** Why the proposals still waiting from earlier could not be loaded. */
  earlierError: string | null;
  /** `rulesAnnounced`: the person can see, as they ask, that no AI service is configured. */
  ask(text: string, rulesAnnounced: boolean): void;
  retry(itemId: string): void;
  confirm(actionId: string): void;
  dismiss(actionId: string): void;
  loadEarlier(): void;
  reset(): void;
}

/**
 * The assistant's conversation and the changes it has proposed. It is kept for the browser
 * tab, so it survives moving between pages and a reload, and is removed when the person
 * signs out: it can contain guest names.
 */
export function useConversation(userId: string): ConversationApi {
  const [conversation, dispatch] = useReducer(reduce, userId, readStored);
  const [asking, setAsking] = useState(false);
  const [deciding, setDeciding] = useState<Record<string, 'confirm' | 'dismiss'>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [earlierError, setEarlierError] = useState<string | null>(null);

  const latest = useRef(conversation);
  useEffect(() => {
    latest.current = conversation;
  });
  /** The question in flight. Starting a new conversation abandons it. */
  const question = useRef<object | null>(null);
  const inFlight = useRef(new Set<string>());

  useEffect(() => writeStored(userId, conversation), [userId, conversation]);
  useEffect(() => {
    forgetStored(userId);
    // Leaving the signed-in pages (signing out, or the session ending) unmounts this.
    return () => forgetStored();
  }, [userId]);

  const send = useCallback(async (text: string, rulesAnnounced: boolean, retryId?: string) => {
    const content = text.trim().slice(0, MAX_TURN_LENGTH);
    if (!content || question.current) return;
    const { items } = latest.current;
    const index = retryId ? items.findIndex((item) => item.id === retryId) : items.length;
    if (index < 0) return;
    const id = retryId ?? nextId();
    const mine = {};
    question.current = mine;
    setAsking(true);
    dispatch(
      retryId ? { type: 'retried', id } : { type: 'asked', id, text: content, rulesAnnounced },
    );
    try {
      const reply = await api<CopilotReply>('/ai/copilot', {
        body: { messages: turnsFor(items.slice(0, index), content) },
      });
      if (question.current !== mine) {
        // The conversation it belonged to is gone, but what it proposed still waits.
        dispatch({ type: 'earlier', id: nextId(), actions: reply.actions });
        return;
      }
      dispatch({ type: 'answered', id: nextId(), reply, receivedAt: Date.now() });
    } catch (err) {
      if (question.current === mine) {
        dispatch({ type: 'failed', id, message: calmErrorMessage(err) });
      }
    } finally {
      if (question.current === mine) {
        question.current = null;
        setAsking(false);
      }
    }
  }, []);

  const decide = useCallback(async (actionId: string, kind: 'confirm' | 'dismiss') => {
    if (inFlight.current.has(actionId)) return;
    inFlight.current.add(actionId);
    setDeciding((current) => ({ ...current, [actionId]: kind }));
    setCardErrors(({ [actionId]: _cleared, ...rest }) => rest);
    try {
      if (kind === 'confirm') {
        const done = await api<ConfirmedAction>(`/ai/actions/${actionId}/confirm`, {
          method: 'POST',
        });
        dispatch({ type: 'decided', actionId, outcome: { state: 'done', message: done.message } });
      } else {
        await api(`/ai/actions/${actionId}/reject`, { method: 'POST' });
        dispatch({ type: 'decided', actionId, outcome: { state: 'dismissed' } });
      }
    } catch (err) {
      if (isTransient(err)) {
        setCardErrors((current) => ({ ...current, [actionId]: calmErrorMessage(err) }));
      } else {
        // A refusal is final: the server has closed the proposal.
        dispatch({
          type: 'decided',
          actionId,
          outcome: { state: 'refused', message: errorMessage(err) },
        });
      }
    } finally {
      inFlight.current.delete(actionId);
      setDeciding(({ [actionId]: _finished, ...rest }) => rest);
    }
  }, []);

  const loadEarlier = useCallback(async () => {
    setEarlierError(null);
    try {
      const { actions } = await api<{ actions: AiAction[] }>('/ai/actions');
      dispatch({ type: 'earlier', id: nextId(), actions });
    } catch (err) {
      setEarlierError(calmErrorMessage(err));
    }
  }, []);

  const reset = useCallback(() => {
    question.current = null;
    setAsking(false);
    setCardErrors({});
    dispatch({ type: 'reset' });
    // Proposals of the conversation just cleared still wait: bring them back into view.
    void loadEarlier();
  }, [loadEarlier]);

  return {
    conversation,
    asking,
    deciding,
    cardErrors,
    earlierError,
    ask: useCallback(
      (text: string, rulesAnnounced: boolean) => void send(text, rulesAnnounced),
      [send],
    ),
    retry: useCallback(
      (itemId: string) => {
        const item = latest.current.items.find((entry) => entry.id === itemId);
        if (item?.kind === 'user') void send(item.text, false, itemId);
      },
      [send],
    ),
    confirm: useCallback((actionId: string) => void decide(actionId, 'confirm'), [decide]),
    dismiss: useCallback((actionId: string) => void decide(actionId, 'dismiss'), [decide]),
    loadEarlier: useCallback(() => void loadEarlier(), [loadEarlier]),
    reset,
  };
}
