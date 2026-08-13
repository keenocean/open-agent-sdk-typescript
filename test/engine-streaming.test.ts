import assert from 'node:assert/strict'
import { test } from 'node:test'

import { QueryEngine } from '../src/engine.js'
import type {
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
  LLMProvider,
} from '../src/providers/types.js'
import type { SDKMessage } from '../src/types.js'

const finalResponse: CreateMessageResponse = {
  content: [{ type: 'text', text: 'Hello world' }],
  stopReason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
}

function engine(provider: LLMProvider) {
  return new QueryEngine({
    cwd: process.cwd(),
    model: 'deepseek/deepseek-v4-flash-0731',
    provider,
    tools: [],
    systemPrompt: 'Test system prompt',
    maxTurns: 2,
    maxTokens: 512,
    canUseTool: async () => ({ behavior: 'allow' }),
    includePartialMessages: true,
  })
}

async function collect(iterable: AsyncIterable<SDKMessage>) {
  const events: SDKMessage[] = []
  for await (const event of iterable) events.push(event)
  return events
}

test('emits partial text while retaining one complete assistant message', async () => {
  let blockingCalls = 0
  const provider: LLMProvider = {
    apiType: 'openai-completions',
    async createMessage(_params: CreateMessageParams) {
      blockingCalls += 1
      return finalResponse
    },
    async *streamMessage(): AsyncIterable<CreateMessageStreamEvent> {
      yield { type: 'text_delta', text: 'Hello ' }
      yield { type: 'text_delta', text: 'world' }
      yield { type: 'message_stop', response: finalResponse }
    },
  }

  const queryEngine = engine(provider)
  const events = await collect(queryEngine.submitMessage('Hi'))
  assert.equal(blockingCalls, 0)
  assert.deepEqual(
    events.filter((event) => event.type === 'partial_message'),
    [
      { type: 'partial_message', partial: { type: 'text', text: 'Hello ' } },
      { type: 'partial_message', partial: { type: 'text', text: 'world' } },
    ],
  )

  const assistant = events.find((event) => event.type === 'assistant')
  assert.deepEqual(assistant, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    },
  })
  assert.deepEqual(queryEngine.getMessages(), [
    { role: 'user', content: 'Hi' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    },
  ])
})

test('does not retry after a visible partial response', async () => {
  let blockingCalls = 0
  const provider: LLMProvider = {
    apiType: 'openai-completions',
    async createMessage() {
      blockingCalls += 1
      return finalResponse
    },
    async *streamMessage(): AsyncIterable<CreateMessageStreamEvent> {
      yield { type: 'text_delta', text: 'Visible' }
      throw new Error('stream disconnected')
    },
  }

  const events = await collect(engine(provider).submitMessage('Hi'))
  assert.equal(blockingCalls, 0)
  assert.deepEqual(
    events.filter((event) => event.type === 'partial_message'),
    [
      { type: 'partial_message', partial: { type: 'text', text: 'Visible' } },
    ],
  )
  const result = events.at(-1)
  assert.equal(result?.type, 'result')
  if (result?.type !== 'result') assert.fail('missing error result')
  assert.equal(result.subtype, 'error')
  assert.deepEqual(result.errors, ['stream disconnected'])
})

test('falls back to the blocking provider before any partial is visible', async () => {
  let blockingCalls = 0
  const provider: LLMProvider = {
    apiType: 'openai-completions',
    async createMessage() {
      blockingCalls += 1
      return finalResponse
    },
    async *streamMessage(): AsyncIterable<CreateMessageStreamEvent> {
      throw new Error('stream rejected')
    },
  }

  const events = await collect(engine(provider).submitMessage('Hi'))
  assert.equal(blockingCalls, 1)
  assert.ok(events.some((event) => event.type === 'assistant'))
  assert.equal(events.at(-1)?.type, 'result')
})
