import {
  llmRequest,
  type LlmMessage,
  type LlmPart,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../provider';

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface MessagesResponse {
  content: (Block | { type: string })[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toBlock(part: LlmPart): Block {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType, data: part.data.toString('base64') },
      };
    case 'tool_use':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolUseId,
        content: part.content,
        ...(part.isError ? { is_error: true } : {}),
      };
  }
}

const toMessage = (message: LlmMessage) => ({
  role: message.role,
  content: typeof message.content === 'string' ? message.content : message.content.map(toBlock),
});

/** Anthropic's Messages API. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly vision = true;
  readonly model: string;

  constructor(
    private readonly config: { apiKey: string; model: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.model = config.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await llmRequest<MessagesResponse>(
      this.name,
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: this.model,
        max_tokens: request.maxTokens ?? 2048,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map(toMessage),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
              ...(request.toolChoice && request.toolChoice !== 'auto'
                ? {
                    tool_choice:
                      request.toolChoice === 'required'
                        ? { type: 'any' }
                        : { type: 'tool', name: request.toolChoice.name },
                  }
                : {}),
            }
          : {}),
      },
      this.fetchImpl,
    );
    const blocks = response.content as Block[];
    return {
      text: blocks
        .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim(),
      toolCalls: blocks
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
      stopReason:
        response.stop_reason === 'tool_use'
          ? 'tool_use'
          : response.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence'
              ? 'end'
              : 'other',
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }
}
