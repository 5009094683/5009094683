import type { Env } from '@pms/config';
import { DomainError } from '@pms/domain';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiProvider } from './providers/openai';

/**
 * The one thing the AI features need from a language model: given a
 * conversation and, optionally, tools it may ask to have run, return text and
 * tool requests. Each vendor's API is adapted to this, so features are
 * written once and a model can be swapped by configuration.
 */
export interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'fake';
  readonly model: string;
  /** Whether images can be sent (identity documents). */
  readonly vision: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: Buffer }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmPart[];
}

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  /** `required`: the model must call some tool. A name: it must call that one. */
  toolChoice?: 'auto' | 'required' | { name: string };
  maxTokens?: number;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other';
  usage: { inputTokens: number; outputTokens: number };
}

export type AiEnv = Pick<
  Env,
  | 'AI_PROVIDER'
  | 'AI_MODEL'
  | 'ANTHROPIC_API_KEY'
  | 'OPENAI_API_KEY'
  | 'AI_DOCUMENT_CAPTURE_ENABLED'
>;

/** Models used when `AI_MODEL` is not set. */
export const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-6.1-terra' } as const;

/**
 * The configured model, or null when none is: every feature then falls back
 * to its rule-based behaviour instead of failing.
 */
export function createProvider(env: AiEnv, fetchImpl: typeof fetch = fetch): LlmProvider | null {
  if (env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(
      { apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL ?? DEFAULT_MODELS.anthropic },
      fetchImpl,
    );
  }
  if (env.AI_PROVIDER === 'openai' && env.OPENAI_API_KEY) {
    return new OpenAiProvider(
      { apiKey: env.OPENAI_API_KEY, model: env.AI_MODEL ?? DEFAULT_MODELS.openai },
      fetchImpl,
    );
  }
  return null;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** One HTTP call to a model API. Failures become `upstream_failed` with the vendor's explanation, never the key. */
export async function llmRequest<T>(
  vendor: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DomainError('upstream_failed', 'The AI service could not be reached', {
      vendor,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok || json === undefined) {
    const detail =
      (json as { error?: { message?: string } } | undefined)?.error?.message ??
      `HTTP ${response.status}`;
    throw new DomainError(
      response.status === 429 ? 'rate_limited' : 'upstream_failed',
      `The AI service refused the request: ${detail}`,
      { vendor, status: response.status },
    );
  }
  return json as T;
}

export const textOf = (content: string | LlmPart[]): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((p): p is Extract<LlmPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
