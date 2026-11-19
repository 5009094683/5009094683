import {
  llmRequest,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../provider';

type ChatMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user';
      content:
        | string
        | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
    }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatResponse {
  choices: {
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Our message shape allows tool results and text in one turn; Chat Completions wants them as separate messages. */
function toChatMessages(message: LlmMessage): ChatMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }
  if (message.role === 'assistant') {
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n');
    const calls = message.content.flatMap((p) =>
      p.type === 'tool_use'
        ? [
            {
              id: p.id,
              type: 'function' as const,
              function: { name: p.name, arguments: JSON.stringify(p.input) },
            },
          ]
        : [],
    );
    return [
      { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
    ];
  }
  const out: ChatMessage[] = [];
  const parts: Extract<ChatMessage, { role: 'user' }>['content'] = [];
  for (const part of message.content) {
    if (part.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: part.toolUseId, content: part.content });
    } else if (part.type === 'text') {
      (parts as { type: 'text'; text: string }[]).push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      (parts as unknown[]).push({
        type: 'image_url',
        image_url: { url: `data:${part.mediaType};base64,${part.data.toString('base64')}` },
      });
    }
  }
  if (parts.length > 0) out.push({ role: 'user', content: parts });
  return out;
}

/** OpenAI's Chat Completions API. */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly vision = true;
  readonly model: string;

  constructor(
    private readonly config: { apiKey: string; model: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.model = config.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await llmRequest<ChatResponse>(
      this.name,
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${this.config.apiKey}` },
      {
        model: this.model,
        max_completion_tokens: request.maxTokens ?? 2048,
        messages: [
          ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
          ...request.messages.flatMap(toChatMessages),
        ],
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
              ...(request.toolChoice && request.toolChoice !== 'auto'
                ? {
                    tool_choice:
                      request.toolChoice === 'required'
                        ? 'required'
                        : { type: 'function', function: { name: request.toolChoice.name } },
                  }
                : {}),
            }
          : {}),
      },
      this.fetchImpl,
    );
    const choice = response.choices[0];
    const calls = choice?.message.tool_calls ?? [];
    return {
      text: (choice?.message.content ?? '').trim(),
      toolCalls: calls.map((c) => {
        let input: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(c.function.arguments || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // Arguments that are not valid JSON are treated as none; the tool's own validation reports what is missing.
        }
        return { id: c.id, name: c.function.name, input };
      }),
      stopReason:
        choice?.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice?.finish_reason === 'length'
            ? 'max_tokens'
            : choice?.finish_reason === 'stop'
              ? 'end'
              : 'other',
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
