import { z } from 'zod';
import { aiRuns, type DbOrTx } from '@pms/db';
import { DomainError } from '@pms/domain';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider';

export interface RunContext {
  orgId: string;
  userId?: string | null;
  /** Which feature is asking, for the usage log. */
  feature: string;
  /** What it concerned (ids only, no guest data). */
  meta?: Record<string, unknown>;
}

/**
 * Calls the model and records the call: who, for what, how many tokens, how
 * long, and whether it worked. The prompt and the answer are not recorded.
 */
export async function trackedComplete(
  db: DbOrTx,
  provider: LlmProvider,
  context: RunContext,
  request: LlmRequest,
): Promise<LlmResponse> {
  const started = Date.now();
  const record = async (
    outcome: { ok: true; response: LlmResponse } | { ok: false; error: string },
  ): Promise<void> => {
    try {
      await db.insert(aiRuns).values({
        orgId: context.orgId,
        userId: context.userId ?? null,
        feature: context.feature,
        provider: provider.name,
        model: provider.model,
        inputTokens: outcome.ok ? outcome.response.usage.inputTokens : 0,
        outputTokens: outcome.ok ? outcome.response.usage.outputTokens : 0,
        durationMs: Date.now() - started,
        ok: outcome.ok,
        error: outcome.ok ? null : outcome.error.slice(0, 500),
        meta: context.meta ?? {},
      });
    } catch {
      // The usage log must never be the reason a feature fails.
    }
  };
  try {
    const response = await provider.complete(request);
    await record({ ok: true, response });
    return response;
  } catch (err) {
    await record({ ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Asks the model for one structured answer. The shape is given to the model
 * as a tool it must call, and what comes back is checked against the same
 * schema, so a malformed answer is an error here rather than bad data later.
 */
export async function extract<S extends z.ZodType>(
  db: DbOrTx,
  provider: LlmProvider,
  context: RunContext,
  input: {
    system: string;
    content: LlmRequest['messages'][number]['content'];
    schema: S;
    /** Name and purpose of the answer, as the model sees them. */
    name: string;
    description: string;
    maxTokens?: number;
  },
): Promise<z.infer<S>> {
  const response = await trackedComplete(db, provider, context, {
    system: input.system,
    messages: [{ role: 'user', content: input.content }],
    tools: [
      {
        name: input.name,
        description: input.description,
        inputSchema: z.toJSONSchema(input.schema) as Record<string, unknown>,
      },
    ],
    toolChoice: { name: input.name },
    maxTokens: input.maxTokens ?? 1500,
  });
  const call = response.toolCalls.find((c) => c.name === input.name);
  if (!call) {
    throw new DomainError('upstream_failed', 'The AI service did not answer in the expected form');
  }
  const parsed = input.schema.safeParse(call.input);
  if (!parsed.success) {
    throw new DomainError(
      'upstream_failed',
      'The AI service gave an answer that could not be read',
      {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    );
  }
  return parsed.data;
}
