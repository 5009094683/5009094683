import type { LlmProvider, LlmRequest, LlmResponse } from './provider';

type Scripted = Partial<LlmResponse> | ((request: LlmRequest) => Partial<LlmResponse>);

/**
 * A language model for tests: answers from a script, in order, and keeps what
 * it was asked so a test can check what was (and was not) sent to it.
 */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake' as const;
  readonly model = 'fake-model';
  vision = true;
  readonly requests: LlmRequest[] = [];
  private script: Scripted[] = [];
  fail: Error | null = null;

  /** Queues answers for the next calls. */
  answer(...responses: Scripted[]): this {
    this.script.push(...responses);
    return this;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(request));
    if (this.fail) throw this.fail;
    const next = this.script.shift();
    if (!next) throw new Error('FakeProvider has no scripted answer left');
    const partial = typeof next === 'function' ? next(request) : next;
    return {
      text: partial.text ?? '',
      toolCalls: partial.toolCalls ?? [],
      stopReason: partial.stopReason ?? (partial.toolCalls?.length ? 'tool_use' : 'end'),
      usage: partial.usage ?? { inputTokens: 10, outputTokens: 5 },
    };
  }

  /** Everything sent to the model so far, as one string, for "this must not have been sent" checks. */
  sentText(): string {
    return JSON.stringify(this.requests, (_key, value: unknown) =>
      Buffer.isBuffer(value) ? '[binary]' : value,
    );
  }
}
