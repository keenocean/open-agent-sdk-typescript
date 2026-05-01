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
  NormalizedResponseBlock,
} from './types.js'

type StreamedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; inputJson: string }

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
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }

    // Add extended thinking if configured
    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    const response = await this.client.messages.create(requestParams)

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          (response.usage as any).cache_creation_input_tokens,
        cache_read_input_tokens:
          (response.usage as any).cache_read_input_tokens,
      },
    }
  }

  async *streamMessage(
    params: CreateMessageParams,
  ): AsyncIterable<CreateMessageStreamEvent> {
    const requestParams: Anthropic.MessageCreateParamsStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
      stream: true,
    }

    // Add extended thinking if configured
    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    const stream = await this.client.messages.create(
      requestParams,
      params.abortSignal ? { signal: params.abortSignal } : undefined,
    )

    const blocks = new Map<number, StreamedContentBlock>()
    let stopReason: CreateMessageResponse['stopReason'] = 'end_turn'
    let inputTokens = 0
    let outputTokens = 0
    let cacheCreationInputTokens: number | undefined
    let cacheReadInputTokens: number | undefined

    for await (const event of stream as AsyncIterable<any>) {
      switch (event.type) {
        case 'message_start': {
          const usage = event.message?.usage
          inputTokens = usage?.input_tokens ?? inputTokens
          outputTokens = usage?.output_tokens ?? outputTokens
          cacheCreationInputTokens =
            usage?.cache_creation_input_tokens ?? cacheCreationInputTokens
          cacheReadInputTokens =
            usage?.cache_read_input_tokens ?? cacheReadInputTokens
          break
        }

        case 'content_block_start': {
          const index = event.index as number
          const block = event.content_block

          if (block?.type === 'text') {
            blocks.set(index, { type: 'text', text: block.text ?? '' })
          } else if (block?.type === 'tool_use') {
            const inputJson = this.stringifyInitialToolInput(block.input)
            blocks.set(index, {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              inputJson,
            })
            yield {
              type: 'tool_use_delta',
              id: block.id,
              name: block.name,
            }
          }
          break
        }

        case 'content_block_delta': {
          const index = event.index as number
          const delta = event.delta

          if (delta?.type === 'text_delta') {
            const text = delta.text ?? ''
            const current = this.ensureTextBlock(blocks, index)
            current.text += text
            if (text) yield { type: 'text_delta', text }
          } else if (delta?.type === 'input_json_delta') {
            const input = delta.partial_json ?? ''
            const current = blocks.get(index)
            if (current?.type === 'tool_use') {
              current.inputJson += input
              yield {
                type: 'tool_use_delta',
                id: current.id,
                name: current.name,
                input,
              }
            }
          }
          break
        }

        case 'message_delta': {
          stopReason = event.delta?.stop_reason ?? stopReason
          outputTokens = event.usage?.output_tokens ?? outputTokens
          break
        }
      }
    }

    const content: NormalizedResponseBlock[] = []
    for (const block of [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)) {
      if (block.type === 'text') {
        if (block.text) content.push({ type: 'text', text: block.text })
        continue
      }

      let input: any
      try {
        input = block.inputJson ? JSON.parse(block.inputJson) : {}
      } catch {
        input = block.inputJson
      }

      content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input,
      })
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    yield {
      type: 'message_stop',
      response: {
        content,
        stopReason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreationInputTokens,
          cache_read_input_tokens: cacheReadInputTokens,
        },
      },
    }
  }

  private ensureTextBlock(
    blocks: Map<number, StreamedContentBlock>,
    index: number,
  ): Extract<StreamedContentBlock, { type: 'text' }> {
    const current = blocks.get(index)
    if (current?.type === 'text') return current

    const next: Extract<StreamedContentBlock, { type: 'text' }> = {
      type: 'text',
      text: '',
    }
    blocks.set(index, next)
    return next
  }

  private stringifyInitialToolInput(input: unknown): string {
    if (!input || (typeof input === 'object' && Object.keys(input).length === 0)) {
      return ''
    }

    return typeof input === 'string' ? input : JSON.stringify(input)
  }
}
