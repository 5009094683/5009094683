import { describe, expect, it } from 'vitest';
import { parseEnv } from '@pms/config';
import { DomainError } from '@pms/domain';
import { createProvider, DEFAULT_MODELS, type LlmRequest } from '../provider';
import { AnthropicProvider } from './anthropic';
import { OpenAiProvider } from './openai';

function fake(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** A conversation that uses everything: system text, an image, a tool call and its result. */
const request: LlmRequest = {
  system: 'You are a hotel assistant.',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read this passport.' },
        { type: 'image', mediaType: 'image/jpeg', data: Buffer.from('jpeg-bytes') },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking it up.' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { code: 'ABCD1234' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'call_1', content: '{"found":true}' }],
    },
  ],
  tools: [
    {
      name: 'lookup',
      description: 'Find a reservation',
      inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
    },
  ],
  toolChoice: { name: 'lookup' },
  maxTokens: 500,
};

describe('Anthropic', () => {
  it('sends the conversation in the Messages format and reads text and tool calls back', async () => {
    const { calls, fetchImpl } = fake(200, {
      content: [
        { type: 'text', text: 'Here you go.' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { code: 'ZZZZ9999' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    const provider = new AnthropicProvider(
      { apiKey: 'sk-ant-secret', model: 'claude-test' },
      fetchImpl,
    );
    const response = await provider.complete(request);
    expect(response).toEqual({
      text: 'Here you go.',
      toolCalls: [{ id: 'toolu_1', name: 'lookup', input: { code: 'ZZZZ9999' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers).toMatchObject({
      'x-api-key': 'sk-ant-secret',
      'anthropic-version': '2023-06-01',
    });
    expect(call.body).toMatchObject({
      model: 'claude-test',
      max_tokens: 500,
      system: 'You are a hotel assistant.',
      tool_choice: { type: 'tool', name: 'lookup' },
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    });
    const messages = call.body.messages as { role: string; content: unknown[] }[];
    expect(messages[0]!.content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: Buffer.from('jpeg-bytes').toString('base64'),
      },
    });
    expect(messages[1]!.content[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'lookup',
      input: { code: 'ABCD1234' },
    });
    expect(messages[2]!.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: '{"found":true}',
    });
  });

  it('turns a refusal into an error that says why, without the key', async () => {
    const { fetchImpl } = fake(401, { type: 'error', error: { message: 'invalid x-api-key' } });
    const provider = new AnthropicProvider(
      { apiKey: 'sk-ant-secret', model: 'claude-test' },
      fetchImpl,
    );
    const error = await provider
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('upstream_failed');
    expect((error as DomainError).message).toBe(
      'The AI service refused the request: invalid x-api-key',
    );
    expect(JSON.stringify(error)).not.toContain('sk-ant-secret');
    const busy = await new AnthropicProvider(
      { apiKey: 'k', model: 'm' },
      fake(429, { error: { message: 'slow down' } }).fetchImpl,
    )
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect((busy as DomainError).code).toBe('rate_limited');
  });
});

describe('OpenAI', () => {
  it('sends the conversation in the Chat Completions format and reads text and tool calls back', async () => {
    const { calls, fetchImpl } = fake(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'lookup', arguments: '{"code":"ZZZZ9999"}' },
              },
              {
                id: 'call_10',
                type: 'function',
                function: { name: 'lookup', arguments: 'not json' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 12 },
    });
    const provider = new OpenAiProvider(
      { apiKey: 'sk-openai-secret', model: 'gpt-test' },
      fetchImpl,
    );
    const response = await provider.complete(request);
    expect(response).toEqual({
      text: '',
      toolCalls: [
        { id: 'call_9', name: 'lookup', input: { code: 'ZZZZ9999' } },
        // Arguments that are not JSON become none; the tool's own check then says what is missing.
        { id: 'call_10', name: 'lookup', input: {} },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 80, outputTokens: 12 },
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-openai-secret');
    expect(call.body).toMatchObject({
      model: 'gpt-test',
      max_completion_tokens: 500,
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    });
    const messages = call.body.messages as Record<string, unknown>[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: 'Read this passport.' },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`,
        },
      },
    ]);
    expect(messages[2]).toMatchObject({
      content: 'Looking it up.',
      tool_calls: [
        { id: 'call_1', function: { name: 'lookup', arguments: '{"code":"ABCD1234"}' } },
      ],
    });
    expect(messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"found":true}',
    });
  });
});

describe('choosing a model', () => {
  const env = (extra: Record<string, string>) => parseEnv({ NODE_ENV: 'test', ...extra });

  it('uses whichever service has a key, and none without one', () => {
    expect(createProvider(env({}))).toBeNull();
    expect(createProvider(env({ ANTHROPIC_API_KEY: 'k' }))).toMatchObject({
      name: 'anthropic',
      model: DEFAULT_MODELS.anthropic,
    });
    expect(createProvider(env({ OPENAI_API_KEY: 'k', AI_MODEL: 'my-model' }))).toMatchObject({
      name: 'openai',
      model: 'my-model',
    });
    // With both keys the choice is explicit or Anthropic; switching AI off wins over any key.
    expect(createProvider(env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }))!.name).toBe(
      'anthropic',
    );
    expect(
      createProvider(env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', AI_PROVIDER: 'openai' }))!
        .name,
    ).toBe('openai');
    expect(createProvider(env({ ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'none' }))).toBeNull();
  });
});
