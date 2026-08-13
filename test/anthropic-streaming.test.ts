import assert from 'node:assert/strict'
import test from 'node:test'

import { AnthropicProvider } from '../src/providers/anthropic.js'
import type {
  CreateMessageParams,
  CreateMessageStreamEvent,
} from '../src/providers/types.js'

function request(signal?: AbortSignal): CreateMessageParams {
  return {
    model: 'claude-sonnet-4-6',
    maxTokens: 4096,
    system: 'Be concise.',
    messages: [{ role: 'user', content: 'Check the weather.' }],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    thinking: { type: 'enabled', budget_tokens: 1024 },
    abortSignal: signal,
  }
}

test('streams Anthropic thinking, text, and fragmented tool input', async () => {
  const controller = new AbortController()
  let capturedParams: Record<string, unknown> | undefined
  let capturedOptions: { signal?: AbortSignal } | undefined
  let finalMessageCalled = false

  const finalMessage = {
    content: [
      { type: 'thinking', thinking: 'I should check.', signature: 'sig-1' },
      { type: 'text', text: 'I will check.' },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'get_weather',
        input: { city: 'Shanghai' },
      },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 12,
      output_tokens: 9,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    },
  }

  const provider = new AnthropicProvider({ apiKey: 'test-key' })
  ;(provider as any).client = {
    messages: {
      stream(
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) {
        capturedParams = params
        capturedOptions = options
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'thinking',
                thinking: '',
                signature: '',
              },
            }
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'I should check.' },
            }
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig-1' },
            }
            yield {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'text', text: '', citations: null },
            }
            yield {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'text_delta', text: 'I will check.' },
            }
            yield {
              type: 'content_block_start',
              index: 2,
              content_block: {
                type: 'tool_use',
                id: 'tool-1',
                name: 'get_weather',
                input: {},
              },
            }
            yield {
              type: 'content_block_delta',
              index: 2,
              delta: { type: 'input_json_delta', partial_json: '{"city":' },
            }
            yield {
              type: 'content_block_delta',
              index: 2,
              delta: { type: 'input_json_delta', partial_json: '"Shanghai"}' },
            }
            yield { type: 'message_stop' }
          },
          async finalMessage() {
            finalMessageCalled = true
            return finalMessage
          },
        }
      },
    },
  }

  const events: CreateMessageStreamEvent[] = []
  for await (const event of provider.streamMessage!(
    request(controller.signal),
  )) {
    events.push(event)
  }

  assert.deepEqual(capturedParams, {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: 'Be concise.',
    messages: [{ role: 'user', content: 'Check the weather.' }],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    thinking: { type: 'enabled', budget_tokens: 1024 },
  })
  assert.equal(capturedOptions?.signal, controller.signal)
  assert.equal(finalMessageCalled, true)
  assert.deepEqual(events, [
    { type: 'thinking_delta', thinking: 'I should check.' },
    { type: 'text_delta', text: 'I will check.' },
    { type: 'tool_use_delta', id: 'tool-1', name: 'get_weather' },
    {
      type: 'tool_use_delta',
      id: 'tool-1',
      name: 'get_weather',
      input: '{"city":',
    },
    {
      type: 'tool_use_delta',
      id: 'tool-1',
      name: 'get_weather',
      input: '"Shanghai"}',
    },
    {
      type: 'message_stop',
      response: {
        content: finalMessage.content,
        stopReason: 'tool_use',
        usage: {
          input_tokens: 12,
          output_tokens: 9,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      },
    },
  ])
})

test('propagates Anthropic stream errors before producing a final message', async () => {
  let finalMessageCalled = false
  const provider = new AnthropicProvider({ apiKey: 'test-key' })
  ;(provider as any).client = {
    messages: {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Partial' },
            }
            throw new Error('Anthropic stream failed')
          },
          async finalMessage() {
            finalMessageCalled = true
            return undefined
          },
        }
      },
    },
  }

  const iterator = provider.streamMessage!(request())[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'text_delta', text: 'Partial' },
  })
  await assert.rejects(() => iterator.next(), /Anthropic stream failed/)
  assert.equal(finalMessageCalled, false)
})

test('passes the abort signal to blocking Anthropic requests', async () => {
  const controller = new AbortController()
  let capturedOptions: { signal?: AbortSignal } | undefined
  const provider = new AnthropicProvider({ apiKey: 'test-key' })
  ;(provider as any).client = {
    messages: {
      async create(
        _params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) {
        capturedOptions = options
        return {
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 1 },
        }
      },
    },
  }

  await provider.createMessage(request(controller.signal))
  assert.equal(capturedOptions?.signal, controller.signal)
})
