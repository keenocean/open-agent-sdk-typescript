/**
 * Anthropic Messages API Provider
 *
 * Wraps the @anthropic-ai/sdk client. Since our internal format is
 * Anthropic-like, this is mostly a thin pass-through.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
} from './types.js'

function toRequestParams(
  params: CreateMessageParams,
): Anthropic.MessageStreamParams {
  const requestParams: Anthropic.MessageStreamParams = {
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages as Anthropic.MessageParam[],
    tools: params.tools ? (params.tools as Anthropic.Tool[]) : undefined,
  }

  if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
    requestParams.thinking = {
      type: 'enabled',
      budget_tokens: params.thinking.budget_tokens,
    }
  }

  return requestParams
}

function toResponse(response: Anthropic.Message): CreateMessageResponse {
  return {
    content: response.content as CreateMessageResponse['content'],
    stopReason: response.stop_reason || 'end_turn',
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens:
        response.usage.cache_read_input_tokens ?? undefined,
    },
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  private client: Anthropic

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const response = await this.client.messages.create(
      toRequestParams(params) as Anthropic.MessageCreateParamsNonStreaming,
      params.abortSignal ? { signal: params.abortSignal } : undefined,
    )

    return toResponse(response)
  }

  async *streamMessage(
    params: CreateMessageParams,
  ): AsyncIterable<CreateMessageStreamEvent> {
    const stream = this.client.messages.stream(
      toRequestParams(params),
      params.abortSignal ? { signal: params.abortSignal } : undefined,
    )
    const toolBlocks = new Map<number, { id: string; name: string }>()

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block
        if (block.type === 'tool_use') {
          const tool = { id: block.id, name: block.name }
          toolBlocks.set(event.index, tool)
          yield { type: 'tool_use_delta', ...tool }
        } else if (block.type === 'text' && block.text) {
          yield { type: 'text_delta', text: block.text }
        } else if (block.type === 'thinking' && block.thinking) {
          yield { type: 'thinking_delta', thinking: block.thinking }
        }
        continue
      }

      if (event.type !== 'content_block_delta') continue

      const delta = event.delta
      if (delta.type === 'text_delta') {
        if (delta.text) yield { type: 'text_delta', text: delta.text }
      } else if (delta.type === 'thinking_delta') {
        if (delta.thinking) {
          yield { type: 'thinking_delta', thinking: delta.thinking }
        }
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        yield {
          type: 'tool_use_delta',
          ...toolBlocks.get(event.index),
          input: delta.partial_json,
        }
      }
    }

    yield { type: 'message_stop', response: toResponse(await stream.finalMessage()) }
  }
}
