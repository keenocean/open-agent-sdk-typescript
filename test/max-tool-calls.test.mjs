import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentTool, BashTool, QueryEngine, createHookRegistry } from '../dist/index.js'
import { createSandboxPolicy } from '../dist/utils/sandbox.js'

function makeProvider(content) {
  let calls = 0
  return {
    apiType: 'anthropic-messages',
    get calls() {
      return calls
    },
    async createMessage() {
      calls++
      if (calls > 1) {
        throw new Error('provider should not be called again after maxToolCalls')
      }
      return {
        content,
        stopReason: 'tool_use',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
}

function makeToolThenDoneProvider(content) {
  let calls = 0
  return {
    apiType: 'anthropic-messages',
    get calls() {
      return calls
    },
    async createMessage() {
      calls++
      if (calls === 1) {
        return {
          content,
          stopReason: 'tool_use',
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
}

const executedInputs = []
const testTool = {
  name: 'TestTool',
  description: 'Test tool',
  inputSchema: {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async call(input) {
    executedInputs.push(input.value)
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `ran ${input.value}`,
    }
  },
}

const provider = makeProvider([
  { type: 'tool_use', id: 'tool-1', name: 'TestTool', input: { value: 'one' } },
  { type: 'tool_use', id: 'tool-2', name: 'TestTool', input: { value: 'two' } },
  { type: 'tool_use', id: 'tool-3', name: 'TestTool', input: { value: 'three' } },
])

const engine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider,
  tools: [testTool],
  maxTurns: 5,
  maxTokens: 1024,
  maxToolCalls: 2,
  canUseTool: async () => ({ behavior: 'allow' }),
  includePartialMessages: false,
})

const events = []
for await (const event of engine.submitMessage('run three tools')) {
  events.push(event)
}

const toolResults = events.filter((event) => event.type === 'tool_result')
const finalResult = events.filter((event) => event.type === 'result').pop()

assert.deepEqual(executedInputs, ['one', 'two'])
assert.equal(toolResults.length, 3)
assert.equal(toolResults[0].result.output, 'ran one')
assert.equal(toolResults[1].result.output, 'ran two')
assert.match(toolResults[2].result.output, /maxToolCalls exceeded/)
assert.equal(finalResult.subtype, 'error_max_tool_calls')
assert.equal(finalResult.is_error, true)
assert.equal(finalResult.tool_calls, 3)
assert.equal(finalResult.max_tool_calls, 2)
assert.equal(finalResult.blocked_tool_calls, 1)
assert.equal(finalResult.can_continue, true)
assert.equal(provider.calls, 1)

const zeroExecutedInputs = []
const zeroTool = {
  ...testTool,
  async call(input) {
    zeroExecutedInputs.push(input.value)
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `ran ${input.value}`,
    }
  },
}
const zeroProvider = makeProvider([
  { type: 'tool_use', id: 'zero-1', name: 'TestTool', input: { value: 'zero' } },
])
const zeroEngine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider: zeroProvider,
  tools: [zeroTool],
  maxTurns: 5,
  maxTokens: 1024,
  maxToolCalls: 0,
  canUseTool: async () => ({ behavior: 'allow' }),
  includePartialMessages: false,
})
const zeroEvents = []
for await (const event of zeroEngine.submitMessage('run no tools')) {
  zeroEvents.push(event)
}
const zeroFinalResult = zeroEvents.filter((event) => event.type === 'result').pop()
assert.deepEqual(zeroExecutedInputs, [])
assert.equal(zeroFinalResult.subtype, 'error_max_tool_calls')
assert.equal(zeroFinalResult.tool_calls, 1)
assert.equal(zeroFinalResult.max_tool_calls, 0)
assert.equal(zeroFinalResult.blocked_tool_calls, 1)

const unknownProvider = makeToolThenDoneProvider([
  { type: 'tool_use', id: 'unknown-1', name: 'MissingTool', input: {} },
])
let unknownPermissionChecks = 0
const unknownEngine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider: unknownProvider,
  tools: [testTool],
  maxTurns: 5,
  maxTokens: 1024,
  canUseTool: async () => {
    unknownPermissionChecks++
    return { behavior: 'allow' }
  },
  includePartialMessages: false,
})
const unknownEvents = []
for await (const event of unknownEngine.submitMessage('unknown tool counts')) {
  unknownEvents.push(event)
}
const unknownToolResult = unknownEvents.filter((event) => event.type === 'tool_result').pop()
const unknownFinalResult = unknownEvents.filter((event) => event.type === 'result').pop()
assert.match(unknownToolResult.result.output, /Unknown tool/)
assert.equal(unknownPermissionChecks, 0)
assert.equal(unknownFinalResult.tool_calls, 1)

const deniedProvider = makeToolThenDoneProvider([
  { type: 'tool_use', id: 'denied-1', name: 'TestTool', input: { value: 'denied' } },
])
let deniedPermissionChecks = 0
let deniedExecutions = 0
const deniedTool = {
  ...testTool,
  async call() {
    deniedExecutions++
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: 'should not run',
    }
  },
}
const deniedEngine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider: deniedProvider,
  tools: [deniedTool],
  maxTurns: 5,
  maxTokens: 1024,
  canUseTool: async () => {
    deniedPermissionChecks++
    return { behavior: 'deny', message: 'denied by host' }
  },
  includePartialMessages: false,
})
const deniedEvents = []
for await (const event of deniedEngine.submitMessage('permission denied counts')) {
  deniedEvents.push(event)
}
const deniedToolResult = deniedEvents.filter((event) => event.type === 'tool_result').pop()
const deniedFinalResult = deniedEvents.filter((event) => event.type === 'result').pop()
assert.equal(deniedToolResult.result.output, 'denied by host')
assert.equal(deniedPermissionChecks, 1)
assert.equal(deniedExecutions, 0)
assert.equal(deniedFinalResult.tool_calls, 1)

const sandboxDeniedProvider = makeToolThenDoneProvider([
  { type: 'tool_use', id: 'sandbox-denied-1', name: 'Bash', input: { command: 'echo blocked' } },
])
let sandboxDeniedPermissionChecks = 0
const sandboxDeniedEngine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider: sandboxDeniedProvider,
  tools: [BashTool],
  maxTurns: 5,
  maxTokens: 1024,
  sandbox: createSandboxPolicy({ enabled: true }, process.cwd()),
  canUseTool: async () => {
    sandboxDeniedPermissionChecks++
    return { behavior: 'allow' }
  },
  includePartialMessages: false,
})
const sandboxDeniedEvents = []
for await (const event of sandboxDeniedEngine.submitMessage('sandbox denied counts')) {
  sandboxDeniedEvents.push(event)
}
const sandboxDeniedToolResult = sandboxDeniedEvents.filter((event) => event.type === 'tool_result').pop()
const sandboxDeniedFinalResult = sandboxDeniedEvents.filter((event) => event.type === 'result').pop()
assert.match(sandboxDeniedToolResult.result.output, /Bash is blocked/)
assert.equal(sandboxDeniedPermissionChecks, 0)
assert.equal(sandboxDeniedFinalResult.tool_calls, 1)

const hookProvider = makeToolThenDoneProvider([
  { type: 'tool_use', id: 'hook-1', name: 'TestTool', input: { value: 'hooked' } },
])
const hookRegistry = createHookRegistry({
  PreToolUse: [{
    handler: async () => ({ block: true, message: 'blocked by test hook' }),
  }],
})
let hookExecutions = 0
const hookTool = {
  ...testTool,
  async call() {
    hookExecutions++
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: 'should not run',
    }
  },
}
const hookEngine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider: hookProvider,
  tools: [hookTool],
  maxTurns: 5,
  maxTokens: 1024,
  canUseTool: async () => ({ behavior: 'allow' }),
  hookRegistry,
  includePartialMessages: false,
})
const hookEvents = []
for await (const event of hookEngine.submitMessage('pre hook blocked counts')) {
  hookEvents.push(event)
}
const hookToolResult = hookEvents.filter((event) => event.type === 'tool_result').pop()
const hookFinalResult = hookEvents.filter((event) => event.type === 'result').pop()
assert.equal(hookToolResult.result.output, 'blocked by test hook')
assert.equal(hookExecutions, 0)
assert.equal(hookFinalResult.tool_calls, 1)

const exceededProbeProvider = makeProvider([
  { type: 'tool_use', id: 'probe-1', name: 'ProbeTool', input: { value: 'one' } },
  { type: 'tool_use', id: 'probe-2', name: 'Bash', input: { command: 'echo should-not-check-sandbox' } },
])
let exceededPermissionChecks = 0
let exceededHookChecks = 0
let exceededExecutions = 0
const exceededHookRegistry = createHookRegistry({
  PreToolUse: [{
    handler: async () => {
      exceededHookChecks++
    },
  }],
})
const probeTool = {
  name: 'ProbeTool',
  description: 'Probe tool',
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: () => false,
  sandboxAware: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async call() {
    exceededExecutions++
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: 'probe ran',
    }
  },
}
const exceededProbeEngine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider: exceededProbeProvider,
  tools: [probeTool, BashTool],
  maxTurns: 5,
  maxTokens: 1024,
  maxToolCalls: 1,
  sandbox: createSandboxPolicy({ enabled: true }, process.cwd()),
  canUseTool: async () => {
    exceededPermissionChecks++
    return { behavior: 'allow' }
  },
  hookRegistry: exceededHookRegistry,
  includePartialMessages: false,
})
const exceededProbeEvents = []
for await (const event of exceededProbeEngine.submitMessage('exceeded skips safety stages')) {
  exceededProbeEvents.push(event)
}
const exceededProbeToolResults = exceededProbeEvents.filter((event) => event.type === 'tool_result')
const exceededProbeFinalResult = exceededProbeEvents.filter((event) => event.type === 'result').pop()
assert.equal(exceededProbeToolResults[0].result.output, 'probe ran')
assert.match(exceededProbeToolResults[1].result.output, /maxToolCalls exceeded/)
assert.doesNotMatch(exceededProbeToolResults[1].result.output, /Bash is blocked/)
assert.equal(exceededPermissionChecks, 1)
assert.equal(exceededHookChecks, 1)
assert.equal(exceededExecutions, 1)
assert.equal(exceededProbeFinalResult.tool_calls, 2)
assert.equal(exceededProbeFinalResult.blocked_tool_calls, 1)

for (const maxBudgetUsd of [0, -1, Number.NaN]) {
  let budgetProviderCalls = 0
  const budgetProvider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      budgetProviderCalls++
      return {
        content: [{ type: 'text', text: 'should not run' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
  const budgetEngine = new QueryEngine({
    cwd: process.cwd(),
    model: 'test-model',
    provider: budgetProvider,
    tools: [testTool],
    maxTurns: 5,
    maxTokens: 1024,
    maxBudgetUsd,
    canUseTool: async () => ({ behavior: 'allow' }),
    includePartialMessages: false,
  })
  const budgetEvents = []
  for await (const event of budgetEngine.submitMessage('no spend')) {
    budgetEvents.push(event)
  }
  const budgetFinalResult = budgetEvents.filter((event) => event.type === 'result').pop()
  assert.equal(budgetProviderCalls, 0)
  assert.equal(budgetFinalResult.subtype, 'error_max_budget_usd')
  assert.equal(budgetFinalResult.num_turns, 0)
}

let sandboxProviderCalls = 0
const sandboxProvider = {
  apiType: 'anthropic-messages',
  async createMessage() {
    sandboxProviderCalls++
    throw new Error('provider should not run when sandbox is unavailable')
  },
}
const sandboxEngine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider: sandboxProvider,
  tools: [testTool],
  maxTurns: 5,
  maxTokens: 1024,
  sandbox: createSandboxPolicy({ enabled: true, failIfUnavailable: true }, process.cwd()),
  canUseTool: async () => ({ behavior: 'allow' }),
  includePartialMessages: false,
})
const sandboxEvents = []
for await (const event of sandboxEngine.submitMessage('fail closed')) {
  sandboxEvents.push(event)
}
const sandboxFinalResult = sandboxEvents.filter((event) => event.type === 'result').pop()
assert.equal(sandboxProviderCalls, 0)
assert.equal(sandboxFinalResult.subtype, 'error_sandbox_unavailable')

let approvedBashCalls = 0
const approvedBashProvider = {
  apiType: 'anthropic-messages',
  async createMessage() {
    approvedBashCalls++
    if (approvedBashCalls === 1) {
      return {
        content: [{
          type: 'tool_use',
          id: 'bash-1',
          name: 'Bash',
          input: {
            command: 'printf approved-unsandboxed',
            dangerouslyDisableSandbox: true,
          },
        }],
        stopReason: 'tool_use',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }
    return {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  },
}
const approvedBashEngine = new QueryEngine({
  cwd: process.cwd(),
  model: 'test-model',
  provider: approvedBashProvider,
  tools: [BashTool],
  maxTurns: 5,
  maxTokens: 1024,
  sandbox: createSandboxPolicy({
    enabled: true,
    allowUnsandboxedCommands: true,
  }, process.cwd()),
  canUseTool: async () => ({ behavior: 'allow' }),
  includePartialMessages: false,
})
const approvedBashEvents = []
for await (const event of approvedBashEngine.submitMessage('approved bash')) {
  approvedBashEvents.push(event)
}
const approvedBashToolResult = approvedBashEvents
  .filter((event) => event.type === 'tool_result')
  .pop()
assert.equal(approvedBashToolResult.result.output, 'approved-unsandboxed')

const root = await mkdtemp(join(tmpdir(), 'agent-sdk-tool-budget-'))
const cwd = join(root, 'workspace')
await mkdir(cwd)
await writeFile(join(cwd, 'one.txt'), 'one', 'utf8')
await writeFile(join(cwd, 'two.txt'), 'two', 'utf8')

try {
  const sharedBudget = {
    maxToolCalls: 2,
    toolCallCount: 0,
    blockedToolCallCount: 0,
    exceeded: false,
  }
  const subagentProvider = makeProvider([
    { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'one.txt' } },
    { type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: 'two.txt' } },
  ])

  const subagentResult = await AgentTool.call(
    {
      prompt: 'read two files',
      description: 'budget inheritance',
      subagent_type: 'Explore',
    },
    {
      cwd,
      provider: subagentProvider,
      model: 'test-model',
      apiType: 'anthropic-messages',
      sandbox: createSandboxPolicy({ enabled: true }, cwd),
      canUseTool: async () => ({ behavior: 'allow' }),
      toolCallBudget: sharedBudget,
    },
  )

  assert.equal(subagentResult.type, 'tool_result')
  assert.equal(sharedBudget.toolCallCount, 3)
  assert.equal(sharedBudget.blockedToolCallCount, 1)
  assert.equal(sharedBudget.exceeded, true)
  assert.equal(subagentProvider.calls, 1)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('maxToolCalls hard-cap tests passed')
