import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { OpenAIProvider } from '../src/providers/openai.js'
import type {
  CreateMessageParams,
  CreateMessageStreamEvent,
} from '../src/providers/types.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function sseResponse(events: unknown[], splitAt: number[]): Response {
  const payload = [
    ': OPENROUTER PROCESSING\n\n',
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')
  const boundaries = [...splitAt, payload.length]
  let offset = 0
  const chunks = boundaries.map((end) => {
    const chunk = new TextEncoder().encode(payload.slice(offset, end))
    offset = end
    return chunk
  })

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function request(signal?: AbortSignal): CreateMessageParams {
  return {
    model: 'deepseek/deepseek-v4-flash-0731',
    maxTokens: 512,
    system: 'Be concise.',
    messages: [{ role: 'user', content: 'Create a cat image.' }],
    tools: [
      {
        name: 'generate_image',
        description: 'Generate an image',
        input_schema: {
          type: 'object',
          properties: { prompt: { type: 'string' } },
          required: ['prompt'],
        },
      },
    ],
    abortSignal: signal,
  }
}

test('streams OpenRouter text and assembles fragmented tool calls', async () => {
  const controller = new AbortController()
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return sseResponse(
      [
        {
          choices: [
            { index: 0, delta: { content: 'Hello ' }, finish_reason: null },
          ],
        },
        {
          choices: [
            { index: 0, delta: { content: 'world' }, finish_reason: null },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'generate_',
                      arguments: '{"prompt":',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: 'image', arguments: '"cat"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 4,
            total_tokens: 11,
          },
        },
      ],
      [1, 9, 73, 151, 287],
    )
  }

  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    baseURL: 'https://openrouter.ai/api/v1',
  })
  const events: CreateMessageStreamEvent[] = []
  for await (const event of provider.streamMessage!(
    request(controller.signal),
  )) {
    events.push(event)
  }

  assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(capturedInit?.signal, controller.signal)
  const body = JSON.parse(String(capturedInit?.body))
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })

  assert.deepEqual(
    events.filter((event) => event.type === 'text_delta'),
    [
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
    ],
  )

  const completed = events.at(-1)
  assert.equal(completed?.type, 'message_stop')
  if (completed?.type !== 'message_stop') assert.fail('missing message_stop')
  assert.deepEqual(completed.response, {
    content: [
      { type: 'text', text: 'Hello world' },
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'generate_image',
        input: { prompt: 'cat' },
      },
    ],
    stopReason: 'tool_use',
    usage: { input_tokens: 7, output_tokens: 4 },
  })
})

test('surfaces malformed OpenRouter stream events', async () => {
  globalThis.fetch = async () =>
    new Response('data: {not-json}\n\ndata: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })

  const provider = new OpenAIProvider({ apiKey: 'test-key' })
  await assert.rejects(async () => {
    for await (const _event of provider.streamMessage!(request())) {
      // Drain the stream.
    }
  }, SyntaxError)
})

test('surfaces OpenRouter errors that arrive after partial text', async () => {
  globalThis.fetch = async () =>
    sseResponse(
      [
        {
          choices: [
            { index: 0, delta: { content: 'Partial' }, finish_reason: null },
          ],
        },
        {
          error: {
            code: 429,
            message: 'Rate limit exceeded',
            metadata: { error_type: 'rate_limit_exceeded' },
          },
          choices: [
            { index: 0, delta: { content: '' }, finish_reason: 'error' },
          ],
        },
      ],
      [17, 83],
    )

  const provider = new OpenAIProvider({ apiKey: 'test-key' })
  const iterator = provider.streamMessage!(request())[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'text_delta', text: 'Partial' },
  })
  await assert.rejects(
    () => iterator.next(),
    /OpenAI API stream error: 429: Rate limit exceeded/,
  )
})

test('rejects a stream that disconnects before a finish reason', async () => {
  globalThis.fetch = async () =>
    new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )

  const provider = new OpenAIProvider({ apiKey: 'test-key' })
  const iterator = provider.streamMessage!(request())[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'text_delta', text: 'Partial' },
  })
  await assert.rejects(
    () => iterator.next(),
    /OpenAI API stream ended before completion/,
  )
})
