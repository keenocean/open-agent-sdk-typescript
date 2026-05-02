import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentTool,
  BashTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  WebFetchTool,
  connectMCPServer,
  createAgent,
  defineTool,
  filterTools,
  getAllBaseTools,
  getSafeBaseTools,
} from '../dist/index.js'
import {
  checkSandboxUrl,
  createSandboxPolicy,
  getSandboxStartupError,
  getSandboxToolBlockReason,
} from '../dist/utils/sandbox.js'

function tool(name) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    async call() {
      return { type: 'tool_result', tool_use_id: '', content: '' }
    },
  }
}

function assertToolError(result, pattern) {
  assert.equal(result.type, 'tool_result')
  assert.equal(result.is_error, true)
  assert.match(String(result.content), pattern)
}

function directBudget(maxToolCalls = 100) {
  return {
    maxToolCalls,
    toolCallCount: 0,
    blockedToolCallCount: 0,
    exceeded: false,
  }
}

const safeToolNames = getSafeBaseTools().map((t) => t.name)
assert.deepEqual(safeToolNames, ['Read', 'Glob', 'Grep'])
assert.equal(safeToolNames.includes('Bash'), false)

assert.deepEqual(
  filterTools(getAllBaseTools(), ['Bash(git:*)']).map((t) => t.name),
  ['Bash'],
)
assert.deepEqual(
  filterTools(
    [tool('mcp__filesystem__list'), tool('mcp__browser__open')],
    ['mcp__filesystem__*'],
  ).map((t) => t.name),
  ['mcp__filesystem__list'],
)

const root = await mkdtemp(join(tmpdir(), 'agent-sdk-sandbox-'))
const cwd = join(root, 'workspace')
await mkdir(cwd)

try {
  const unsafeAgent = createAgent({ permissionMode: 'bypassPermissions' })
  const unsafeSandbox = createSandboxPolicy({
    enabled: true,
    allowUnsandboxedCommands: true,
  }, cwd)
  const unsafeDecision = await unsafeAgent.createDefaultPermissionHandler(
    'bypassPermissions',
    unsafeSandbox,
  )(BashTool, { command: 'echo bypassed', dangerouslyDisableSandbox: true })
  assert.equal(unsafeDecision.behavior, 'deny')

  let capturedToolNames
  const captureProvider = {
    apiType: 'anthropic-messages',
    async createMessage(params) {
      capturedToolNames = (params.tools ?? []).map((tool) => tool.name)
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
  const boundedAgent = createAgent({
    allowedTools: ['Read'],
    permissionMode: 'bypassPermissions',
  })
  boundedAgent.provider = captureProvider
  for await (const _event of boundedAgent.query('capture tools', { tools: ['Bash'] })) {}
  assert.deepEqual(capturedToolNames, [])

  let constructorToolCapture
  const constructorToolAgent = createAgent({
    tools: ['Read'],
    permissionMode: 'bypassPermissions',
  })
  constructorToolAgent.provider = {
    apiType: 'anthropic-messages',
    async createMessage(params) {
      constructorToolCapture = (params.tools ?? []).map((tool) => tool.name)
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
  for await (const _event of constructorToolAgent.query('capture query tools', { tools: ['Bash'] })) {}
  assert.deepEqual(constructorToolCapture, [])

  const sandbox = createSandboxPolicy({
    enabled: true,
    filesystem: {
      allowRead: ['.'],
      allowWrite: ['.'],
      denyRead: ['secret.txt'],
    },
    network: {
      allowedDomains: ['example.com'],
    },
  }, cwd)

  assert.equal(sandbox.enabled, true)
  assert.equal(sandbox.trusted, false)
  assert.match(sandbox.warnings.join('\n'), /application-level guard/)

  const failClosed = createSandboxPolicy({ enabled: true, failIfUnavailable: true }, cwd)
  assert.match(getSandboxStartupError(failClosed), /no trusted OS sandbox runtime/)
  assert.match(
    getSandboxToolBlockReason('mcp__filesystem__list', {}, sandbox),
    /MCP tools are blocked/,
  )
  assert.equal(getSandboxToolBlockReason('Read', {}, sandbox, FileReadTool), undefined)
  assert.match(
    getSandboxToolBlockReason('Read', {}, sandbox, tool('Read')),
    /not sandbox-aware/,
  )
  assert.equal(getSandboxToolBlockReason('Agent', {}, sandbox, AgentTool), undefined)

  const skippedMcpMarker = join(root, 'skipped-mcp-marker.txt')
  let skippedMcpProviderCalls = 0
  const skippedMcpAgent = createAgent({
    cwd,
    maxTurns: 1,
    mcpServers: {
      blocked: {
        command: '/bin/sh',
        args: ['-c', 'printf spawned > "$MCP_MARKER"'],
        env: { MCP_MARKER: skippedMcpMarker },
      },
    },
  })
  skippedMcpAgent.provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      skippedMcpProviderCalls++
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
  for await (const _event of skippedMcpAgent.query('default sandbox skips external mcp')) {}
  assert.equal(skippedMcpProviderCalls, 1)
  await assert.rejects(stat(skippedMcpMarker))
  for await (const _event of skippedMcpAgent.query(
    'explicit sandbox disable can connect external mcp later',
    { sandbox: { enabled: false } },
  )) {}
  await stat(skippedMcpMarker)

  const failClosedMcpMarker = join(root, 'fail-closed-mcp-marker.txt')
  let failClosedProviderCalls = 0
  const failClosedMcpAgent = createAgent({
    cwd,
    maxTurns: 1,
    sandbox: { enabled: true, failIfUnavailable: true },
    mcpServers: {
      blocked: {
        command: '/bin/sh',
        args: ['-c', 'printf spawned > "$MCP_MARKER"'],
        env: { MCP_MARKER: failClosedMcpMarker },
      },
    },
  })
  failClosedMcpAgent.provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      failClosedProviderCalls++
      throw new Error('provider should not run when sandbox fails closed')
    },
  }
  const failClosedEvents = []
  for await (const event of failClosedMcpAgent.query('fail before mcp setup')) {
    failClosedEvents.push(event)
  }
  const failClosedResult = failClosedEvents.filter((event) => event.type === 'result').pop()
  assert.equal(failClosedProviderCalls, 0)
  assert.equal(failClosedResult.subtype, 'error_sandbox_unavailable')
  await assert.rejects(stat(failClosedMcpMarker))

  await writeFile(join(root, 'outside-read.txt'), 'outside', 'utf8')
  const defaultReadSandbox = createSandboxPolicy({ enabled: true }, cwd)
  const readOutside = await FileReadTool.call(
    { file_path: '../outside-read.txt' },
    { cwd, sandbox: defaultReadSandbox, toolCallBudget: directBudget() },
  )
  assertToolError(readOutside, /allowRead/)

  let defaultReadToolOutput = ''
  let defaultAgentCalls = 0
  const defaultReadAgent = createAgent({
    cwd,
    maxTurns: 2,
  })
  defaultReadAgent.provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      defaultAgentCalls++
      if (defaultAgentCalls === 1) {
        return {
          content: [{
            type: 'tool_use',
            id: 'read-outside',
            name: 'Read',
            input: { file_path: '../outside-read.txt' },
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
  for await (const event of defaultReadAgent.query('try to read outside cwd')) {
    if (event.type === 'tool_result') {
      defaultReadToolOutput = event.result.output
    }
  }
  assert.match(defaultReadToolOutput, /allowRead/)

  let partialSandboxReadOutput = ''
  let partialSandboxCalls = 0
  const partialSandboxAgent = createAgent({
    cwd,
    maxTurns: 2,
    sandbox: {
      filesystem: {
        allowRead: ['.'],
      },
    },
  })
  partialSandboxAgent.provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      partialSandboxCalls++
      if (partialSandboxCalls === 1) {
        return {
          content: [{
            type: 'tool_use',
            id: 'partial-sandbox-read-outside',
            name: 'Read',
            input: { file_path: '../outside-read.txt' },
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
  for await (const event of partialSandboxAgent.query('try partial sandbox config')) {
    if (event.type === 'tool_result') {
      partialSandboxReadOutput = event.result.output
    }
  }
  assert.match(partialSandboxReadOutput, /allowRead/)

  let disabledSandboxReadOutput = ''
  let disabledSandboxCalls = 0
  const disabledSandboxAgent = createAgent({
    cwd,
    maxTurns: 2,
    sandbox: {
      enabled: false,
      filesystem: {
        allowRead: ['.'],
      },
    },
  })
  disabledSandboxAgent.provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      disabledSandboxCalls++
      if (disabledSandboxCalls === 1) {
        return {
          content: [{
            type: 'tool_use',
            id: 'disabled-sandbox-read-outside',
            name: 'Read',
            input: { file_path: '../outside-read.txt' },
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
  for await (const event of disabledSandboxAgent.query('try explicit disabled sandbox')) {
    if (event.type === 'tool_result') {
      disabledSandboxReadOutput = event.result.output
    }
  }
  assert.match(disabledSandboxReadOutput, /outside/)

  const mcpServerScript = `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js'
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
    import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

    const server = new Server(
      { name: 'echo-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: 'echo',
        description: 'Echo a value',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      }],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: 'text', text: 'echo ' + request.params.arguments.value }],
    }))
    await server.connect(new StdioServerTransport())
  `
  const mcpConnection = await connectMCPServer('echo', {
    command: process.execPath,
    args: ['--input-type=module', '-e', mcpServerScript],
  })
  try {
    assert.equal(mcpConnection.status, 'connected')
    assert.equal(mcpConnection.tools.length, 1)
    const mcpTool = mcpConnection.tools[0]

    const missingSandboxContext = await mcpTool.call({ value: 'direct' }, { cwd })
    assertToolError(missingSandboxContext, /requires an explicit sandbox context/)

    const sandboxedMcpCall = await mcpTool.call(
      { value: 'blocked' },
      { cwd, sandbox: defaultReadSandbox },
    )
    assertToolError(sandboxedMcpCall, /MCP tools are blocked/)

    const unsandboxedMcpCall = await mcpTool.call(
      { value: 'allowed' },
      {
        cwd,
        sandbox: createSandboxPolicy({ enabled: false }, cwd),
        toolCallBudget: {
          maxToolCalls: 1,
          toolCallCount: 0,
          blockedToolCallCount: 0,
          exceeded: false,
        },
        canUseTool: async () => ({ behavior: 'allow' }),
      },
    )
    assert.equal(unsandboxedMcpCall.is_error, false)
    assert.equal(unsandboxedMcpCall.content, 'echo allowed')
  } finally {
    await mcpConnection.close()
  }

  const sandboxAwareCalculator = defineTool({
    name: 'Calculator',
    description: 'Evaluate a validated arithmetic expression',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    isReadOnly: true,
    sandboxAware: true,
    async call(input) {
      return `${input.expression} = 4`
    },
  })
  let calculatorOutput = ''
  let calculatorCalls = 0
  const customToolAgent = createAgent({
    cwd,
    maxTurns: 2,
    tools: [sandboxAwareCalculator],
  })
  customToolAgent.provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      calculatorCalls++
      if (calculatorCalls === 1) {
        return {
          content: [{
            type: 'tool_use',
            id: 'calculator-call',
            name: 'Calculator',
            input: { expression: '2 + 2' },
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
  for await (const event of customToolAgent.query('use custom calculator')) {
    if (event.type === 'tool_result') {
      calculatorOutput = event.result.output
    }
  }
  assert.equal(calculatorOutput, '2 + 2 = 4')

  const unmarkedReadOnlyTool = defineTool({
    name: 'UnmarkedReadOnly',
    description: 'Read-only but not declared sandbox-aware',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    async call() {
      return 'should not run'
    },
  })
  let unmarkedOutput = ''
  let unmarkedCalls = 0
  const unmarkedToolAgent = createAgent({
    cwd,
    maxTurns: 2,
    tools: [unmarkedReadOnlyTool],
  })
  unmarkedToolAgent.provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      unmarkedCalls++
      if (unmarkedCalls === 1) {
        return {
          content: [{
            type: 'tool_use',
            id: 'unmarked-read-only-call',
            name: 'UnmarkedReadOnly',
            input: {},
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
  for await (const event of unmarkedToolAgent.query('use unmarked custom tool')) {
    if (event.type === 'tool_result') {
      unmarkedOutput = event.result.output
    }
  }
  assert.match(unmarkedOutput, /not sandbox-aware/)

  await symlink('../outside-read.txt', join(cwd, 'outside-link.txt'))
  const readSymlinkOutside = await FileReadTool.call(
    { file_path: 'outside-link.txt' },
    { cwd, sandbox: defaultReadSandbox, toolCallBudget: directBudget() },
  )
  assertToolError(readSymlinkOutside, /allowRead/)

  const globParentOutside = await GlobTool.call(
    { pattern: '../outside-read.txt' },
    { cwd, sandbox: defaultReadSandbox, toolCallBudget: directBudget() },
  )
  assertToolError(globParentOutside, /parent-directory glob/)

  const globSymlinkOutside = await GlobTool.call(
    { pattern: 'outside-link.txt' },
    { cwd, sandbox: defaultReadSandbox, toolCallBudget: directBudget() },
  )
  assert.equal(globSymlinkOutside.is_error, false)
  assert.match(String(globSymlinkOutside.content), /No files matching/)

  const writeOutside = await FileWriteTool.call(
    { file_path: '../outside.txt', content: 'blocked' },
    { cwd, sandbox, toolCallBudget: directBudget() },
  )
  assertToolError(writeOutside, /allowWrite/)
  await assert.rejects(stat(join(root, 'outside.txt')))

  await symlink('../broken-symlink-write.txt', join(cwd, 'broken-write-link.txt'))
  const writeBrokenSymlinkOutside = await FileWriteTool.call(
    { file_path: 'broken-write-link.txt', content: 'blocked' },
    { cwd, sandbox, toolCallBudget: directBudget() },
  )
  assertToolError(writeBrokenSymlinkOutside, /allowWrite/)
  await assert.rejects(stat(join(root, 'broken-symlink-write.txt')))

  await writeFile(join(cwd, 'secret.txt'), 'secret', 'utf8')
  const readDenied = await FileReadTool.call(
    { file_path: 'secret.txt' },
    { cwd, sandbox, toolCallBudget: directBudget() },
  )
  assertToolError(readDenied, /denyRead/)

  const webDenied = await WebFetchTool.call(
    { url: 'https://not-example.test/' },
    { cwd, sandbox, toolCallBudget: directBudget() },
  )
  assertToolError(webDenied, /allowedDomains/)

  assert.match(
    checkSandboxUrl(createSandboxPolicy({ enabled: true }, cwd), 'http://127.0.0.1/'),
    /allowLocalBinding/,
  )
  assert.match(
    checkSandboxUrl(createSandboxPolicy({ enabled: true }, cwd), 'http://[fd00::1]/'),
    /allowLocalBinding/,
  )
  assert.match(
    checkSandboxUrl(createSandboxPolicy({ enabled: true }, cwd), 'http://[::ffff:127.0.0.1]/'),
    /allowLocalBinding/,
  )
  assert.match(
    checkSandboxUrl(
      createSandboxPolicy({ enabled: true, network: { allowManagedDomainsOnly: true } }, cwd),
      'https://example.com/',
    ),
    /allowManagedDomainsOnly/,
  )

  const redirectServer = createServer((_req, res) => {
    res.statusCode = 302
    res.setHeader('Location', 'https://blocked.example/final')
    res.end()
  })
  await new Promise((resolve) => redirectServer.listen(0, '127.0.0.1', resolve))
  try {
    const address = redirectServer.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const redirectSandbox = createSandboxPolicy({
      enabled: true,
      network: {
        allowLocalBinding: true,
        allowedDomains: ['127.0.0.1'],
      },
    }, cwd)
    const redirectDenied = await WebFetchTool.call(
      { url: `http://127.0.0.1:${port}/redirect` },
      { cwd, sandbox: redirectSandbox, toolCallBudget: directBudget() },
    )
    assertToolError(redirectDenied, /allowedDomains/)
  } finally {
    await new Promise((resolve) => redirectServer.close(resolve))
  }

  const bashDenied = await BashTool.call(
    { command: 'echo unsafe' },
    {
      cwd,
      sandbox,
      toolCallBudget: {
        maxToolCalls: 1,
        toolCallCount: 0,
        blockedToolCallCount: 0,
        exceeded: false,
      },
    },
  )
  assertToolError(bashDenied, /Bash is blocked/)

  const bashUnsafeDenied = await BashTool.call(
    { command: 'echo unsafe', dangerouslyDisableSandbox: true },
    {
      cwd,
      sandbox,
      toolCallBudget: {
        maxToolCalls: 1,
        toolCallCount: 0,
        blockedToolCallCount: 0,
        exceeded: false,
      },
    },
  )
  assertToolError(bashUnsafeDenied, /allowUnsandboxedCommands/)

  const directUnsandboxedDenied = await BashTool.call(
    { command: 'printf direct-bypass', dangerouslyDisableSandbox: true },
    {
      cwd,
      sandbox: createSandboxPolicy({
        enabled: true,
        allowUnsandboxedCommands: true,
      }, cwd),
      toolCallBudget: {
        maxToolCalls: 1,
        toolCallCount: 0,
        blockedToolCallCount: 0,
        exceeded: false,
      },
    },
  )
  assertToolError(directUnsandboxedDenied, /host approval/)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('sandbox hardening tests passed')
