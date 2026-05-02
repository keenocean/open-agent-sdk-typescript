/**
 * QueryEngine - Core agentic loop
 *
 * Manages the full conversation lifecycle:
 * 1. Take user prompt
 * 2. Build system prompt with context (git status, project context, tools)
 * 3. Call LLM API with tools (via provider abstraction)
 * 4. Stream response
 * 5. Execute tool calls (concurrent for read-only, serial for mutations)
 * 6. Send results back, repeat until done
 * 7. Auto-compact when context exceeds threshold
 * 8. Retry with exponential backoff on transient errors
 */

import type {
  SDKMessage,
  QueryEngineConfig,
  ToolDefinition,
  ToolResult,
  ToolContext,
  TokenUsage,
  ToolCallBudget,
} from './types.js'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedTool,
} from './providers/types.js'
import {
  estimateMessagesTokens,
  estimateCost,
  getAutoCompactThreshold,
} from './utils/tokens.js'
import {
  shouldAutoCompact,
  compactConversation,
  microCompactMessages,
  createAutoCompactState,
  type AutoCompactState,
} from './utils/compact.js'
import {
  withRetry,
  isPromptTooLongError,
} from './utils/retry.js'
import { getSystemContext, getUserContext } from './utils/context.js'
import { normalizeMessagesForAPI } from './utils/messages.js'
import {
  getSandboxStartupError,
  getSandboxToolBlockReason,
} from './utils/sandbox.js'
import type { HookRegistry, HookInput, HookOutput } from './hooks.js'

// ============================================================================
// Tool format conversion
// ============================================================================

/** Convert a ToolDefinition to the normalized provider tool format. */
function toProviderTool(tool: ToolDefinition): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

// ============================================================================
// ToolUseBlock (internal type for extracted tool_use blocks)
// ============================================================================

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

function isUnsandboxedBashRequest(block: ToolUseBlock): boolean {
  return block.name === 'Bash' &&
    typeof block.input === 'object' &&
    block.input !== null &&
    (block.input as { dangerouslyDisableSandbox?: unknown }).dangerouslyDisableSandbox === true
}

const DEFAULT_MAX_TOOL_CALLS = 50

function createToolCallBudget(maxToolCalls?: number): ToolCallBudget {
  return {
    maxToolCalls: normalizeMaxToolCalls(maxToolCalls),
    toolCallCount: 0,
    blockedToolCallCount: 0,
    exceeded: false,
  }
}

function normalizeMaxToolCalls(maxToolCalls: number | undefined): number | undefined {
  if (maxToolCalls === undefined) return DEFAULT_MAX_TOOL_CALLS
  if (maxToolCalls === Number.POSITIVE_INFINITY) return undefined
  if (!Number.isFinite(maxToolCalls)) return DEFAULT_MAX_TOOL_CALLS
  return Math.max(0, Math.floor(maxToolCalls))
}

function normalizeMaxBudgetUsd(maxBudgetUsd: number | undefined): number | undefined {
  if (maxBudgetUsd === undefined) return undefined
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) return 0
  return maxBudgetUsd
}

// ============================================================================
// System Prompt Builder
// ============================================================================

async function buildSystemPrompt(config: QueryEngineConfig): Promise<string> {
  if (config.systemPrompt) {
    const base = config.systemPrompt
    return config.appendSystemPrompt
      ? base + '\n\n' + config.appendSystemPrompt
      : base
  }

  const parts: string[] = []

  parts.push(
    'You are an AI assistant with access to tools. Use the tools provided to help the user accomplish their tasks.',
    'You should use tools when they would help you complete the task more accurately or efficiently.',
  )

  // List available tools with descriptions
  parts.push('\n# Available Tools\n')
  for (const tool of config.tools) {
    parts.push(`- **${tool.name}**: ${tool.description}`)
  }

  // Add agent definitions
  if (config.agents && Object.keys(config.agents).length > 0) {
    parts.push('\n# Available Subagents\n')
    for (const [name, def] of Object.entries(config.agents)) {
      parts.push(`- **${name}**: ${def.description}`)
    }
  }

  // System context (git status, etc.)
  try {
    const sysCtx = await getSystemContext(config.cwd)
    if (sysCtx) {
      parts.push('\n# Environment\n')
      parts.push(sysCtx)
    }
  } catch {
    // Context is best-effort
  }

  // User context (AGENT.md, date)
  try {
    const userCtx = await getUserContext(config.cwd)
    if (userCtx) {
      parts.push('\n# Project Context\n')
      parts.push(userCtx)
    }
  } catch {
    // Context is best-effort
  }

  // Working directory
  parts.push(`\n# Working Directory\n${config.cwd}`)

  const maxToolCalls = config.toolCallBudget?.maxToolCalls ??
    normalizeMaxToolCalls(config.maxToolCalls)
  if (maxToolCalls !== undefined) {
    const usedToolCalls = config.toolCallBudget?.toolCallCount ?? 0
    parts.push(
      `\n# Tool Call Budget\nYou have ${Math.max(0, maxToolCalls - usedToolCalls)} tool calls remaining in this run.`,
    )
  }

  if (config.sandbox?.enabled) {
    parts.push(
      '\n# Sandbox\n' +
        'SDK sandbox mode is enabled, but it is an application-level guard only and not a trusted OS sandbox. ' +
        'Shell commands and MCP tools are unavailable unless the host explicitly opts into unsandboxed execution.',
    )
  }

  if (config.appendSystemPrompt) {
    parts.push('\n' + config.appendSystemPrompt)
  }

  return parts.join('\n')
}

// ============================================================================
// QueryEngine
// ============================================================================

export class QueryEngine {
  private config: QueryEngineConfig
  private provider: LLMProvider
  public messages: NormalizedMessageParam[] = []
  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  private totalCost = 0
  private turnCount = 0
  private compactState: AutoCompactState
  private sessionId: string
  private apiTimeMs = 0
  private hookRegistry?: HookRegistry
  private toolCallBudget: ToolCallBudget

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.provider = config.provider
    this.compactState = createAutoCompactState()
    this.sessionId = config.sessionId || crypto.randomUUID()
    this.hookRegistry = config.hookRegistry
    this.toolCallBudget = config.toolCallBudget ?? createToolCallBudget(config.maxToolCalls)
    this.config.toolCallBudget = this.toolCallBudget
  }

  /**
   * Execute hooks for a lifecycle event.
   * Returns hook outputs; never throws.
   */
  private async executeHooks(
    event: import('./hooks.js').HookEvent,
    extra?: Partial<HookInput>,
  ): Promise<HookOutput[]> {
    if (!this.hookRegistry?.hasHooks(event)) return []
    try {
      return await this.hookRegistry.execute(event, {
        event,
        sessionId: this.sessionId,
        cwd: this.config.cwd,
        ...extra,
      })
    } catch {
      return []
    }
  }

  /**
   * Submit a user message and run the agentic loop.
   * Yields SDKMessage events as the agent works.
   */
  async *submitMessage(
    prompt: string | any[],
  ): AsyncGenerator<SDKMessage> {
    // Hook: SessionStart
    await this.executeHooks('SessionStart')

    // Hook: UserPromptSubmit
    const userHookResults = await this.executeHooks('UserPromptSubmit', {
      toolInput: prompt,
    })
    // Check if any hook blocks the submission
    if (userHookResults.some((r) => r.block)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: this.totalUsage,
        num_turns: 0,
        cost: 0,
        errors: ['Blocked by UserPromptSubmit hook'],
      }
      return
    }

    const sandboxStartupError = getSandboxStartupError(this.config.sandbox)
    if (sandboxStartupError) {
      yield {
        type: 'result',
        subtype: 'error_sandbox_unavailable',
        is_error: true,
        usage: this.totalUsage,
        num_turns: 0,
        cost: 0,
        total_cost_usd: 0,
        tool_calls: this.toolCallBudget.toolCallCount,
        max_tool_calls: this.toolCallBudget.maxToolCalls,
        blocked_tool_calls: this.toolCallBudget.blockedToolCallCount,
        errors: [sandboxStartupError],
      }
      return
    }

    // Add user message
    this.messages.push({ role: 'user', content: prompt as any })

    // Build tool definitions for provider
    const tools = this.config.tools.map(toProviderTool)

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(this.config)

    // Emit init system message
    yield {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      tools: this.config.tools.map(t => t.name),
      model: this.config.model,
      cwd: this.config.cwd,
      mcp_servers: [],
      permission_mode: this.config.permissionMode ?? 'default',
      warnings: this.config.sandbox?.warnings,
      sandbox: this.config.sandbox
        ? {
            enabled: this.config.sandbox.enabled,
            trusted: false,
            unavailable_reason: this.config.sandbox.unavailableReason,
          }
        : undefined,
    } as SDKMessage

    // Agentic loop
    let turnsRemaining = this.config.maxTurns
    let budgetExceeded = false
    let maxOutputRecoveryAttempts = 0
    const MAX_OUTPUT_RECOVERY = 3
    const maxBudgetUsd = normalizeMaxBudgetUsd(this.config.maxBudgetUsd)

    while (turnsRemaining > 0) {
      if (this.config.abortSignal?.aborted) break

      // Check budget
      if (maxBudgetUsd !== undefined && this.totalCost >= maxBudgetUsd) {
        budgetExceeded = true
        break
      }

      // Auto-compact if context is too large
      if (shouldAutoCompact(this.messages as any[], this.config.model, this.compactState)) {
        await this.executeHooks('PreCompact')
        try {
          const result = await compactConversation(
            this.provider,
            this.config.model,
            this.messages as any[],
            this.compactState,
          )
          this.messages = result.compactedMessages as NormalizedMessageParam[]
          this.compactState = result.state
          await this.executeHooks('PostCompact')
        } catch {
          // Continue with uncompacted messages
        }
      }

      // Micro-compact: truncate large tool results
      const apiMessages = microCompactMessages(
        normalizeMessagesForAPI(this.messages as any[]),
      ) as NormalizedMessageParam[]

      this.turnCount++
      turnsRemaining--

      const request: CreateMessageParams = {
        model: this.config.model,
        maxTokens: this.config.maxTokens,
        system: systemPrompt,
        messages: apiMessages,
        tools: tools.length > 0 ? tools : undefined,
        thinking:
          this.config.thinking?.type === 'enabled' &&
          this.config.thinking.budgetTokens
            ? {
                type: 'enabled',
                budget_tokens: this.config.thinking.budgetTokens,
              }
            : undefined,
        abortSignal: this.config.abortSignal,
      }

      // Make API call via provider.
      let response: CreateMessageResponse
      const apiStart = performance.now()
      try {
        response = yield* this.createMessageWithOptionalPartials(request)
      } catch (err: any) {
        // Handle prompt-too-long by compacting
        if (isPromptTooLongError(err) && !this.compactState.compacted) {
          try {
            const result = await compactConversation(
              this.provider,
              this.config.model,
              this.messages as any[],
              this.compactState,
            )
            this.messages = result.compactedMessages as NormalizedMessageParam[]
            this.compactState = result.state
            turnsRemaining++ // Retry this turn
            this.turnCount--
            continue
          } catch {
            // Can't compact, give up
          }
        }

        yield {
          type: 'result',
          subtype: 'error',
          usage: this.totalUsage,
          num_turns: this.turnCount,
          cost: this.totalCost,
        }
        return
      }

      // Track API timing
      this.apiTimeMs += performance.now() - apiStart

      // Track usage (normalized by provider)
      if (response.usage) {
        this.totalUsage.input_tokens += response.usage.input_tokens
        this.totalUsage.output_tokens += response.usage.output_tokens
        if (response.usage.cache_creation_input_tokens) {
          this.totalUsage.cache_creation_input_tokens =
            (this.totalUsage.cache_creation_input_tokens || 0) +
            response.usage.cache_creation_input_tokens
        }
        if (response.usage.cache_read_input_tokens) {
          this.totalUsage.cache_read_input_tokens =
            (this.totalUsage.cache_read_input_tokens || 0) +
            response.usage.cache_read_input_tokens
        }
        this.totalCost += estimateCost(this.config.model, response.usage)
      }

      // Add assistant message to conversation
      this.messages.push({ role: 'assistant', content: response.content as any })

      // Yield assistant message
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: response.content as any,
        },
      }

      // Handle max_output_tokens recovery
      if (
        response.stopReason === 'max_tokens' &&
        maxOutputRecoveryAttempts < MAX_OUTPUT_RECOVERY
      ) {
        maxOutputRecoveryAttempts++
        // Add continuation prompt
        this.messages.push({
          role: 'user',
          content: 'Please continue from where you left off.',
        })
        continue
      }

      // Check for tool use
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      )

      if (toolUseBlocks.length === 0) {
        break // No tool calls - agent is done
      }

      // Reset max_output recovery counter on successful tool use
      maxOutputRecoveryAttempts = 0

      // Execute tools (concurrent read-only, serial mutations)
      const toolResults = await this.executeTools(toolUseBlocks)

      // Yield tool results
      for (const result of toolResults) {
        yield {
          type: 'tool_result',
          result: {
            tool_use_id: result.tool_use_id,
            tool_name: result.tool_name || '',
            output:
              typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content),
          },
        }
      }

      // Add tool results to conversation
      this.messages.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.tool_use_id,
          content:
            typeof r.content === 'string'
              ? r.content
              : JSON.stringify(r.content),
          is_error: r.is_error,
        })),
      })

      if (this.toolCallBudget.exceeded) break

      if (response.stopReason === 'end_turn') break
    }

    // Hook: Stop (end of agentic loop)
    await this.executeHooks('Stop')

    // Hook: SessionEnd
    await this.executeHooks('SessionEnd')

    // Yield enriched final result
    const endSubtype = budgetExceeded
      ? 'error_max_budget_usd'
      : this.toolCallBudget.exceeded
        ? 'error_max_tool_calls'
        : turnsRemaining <= 0
          ? 'error_max_turns'
          : 'success'

    yield {
      type: 'result',
      subtype: endSubtype,
      session_id: this.sessionId,
      is_error: endSubtype !== 'success',
      num_turns: this.turnCount,
      total_cost_usd: this.totalCost,
      duration_api_ms: Math.round(this.apiTimeMs),
      usage: this.totalUsage,
      model_usage: { [this.config.model]: { input_tokens: this.totalUsage.input_tokens, output_tokens: this.totalUsage.output_tokens } },
      tool_calls: this.toolCallBudget.toolCallCount,
      max_tool_calls: this.toolCallBudget.maxToolCalls,
      blocked_tool_calls: this.toolCallBudget.blockedToolCallCount,
      can_continue: this.toolCallBudget.exceeded || undefined,
      cost: this.totalCost,
    }
  }

  private async *createMessageWithOptionalPartials(
    request: CreateMessageParams,
  ): AsyncGenerator<SDKMessage, CreateMessageResponse> {
    if (!this.config.includePartialMessages || !this.provider.streamMessage) {
      return await withRetry(
        () => this.provider.createMessage(request),
        undefined,
        this.config.abortSignal,
      )
    }

    let sawStreamEvent = false
    try {
      for await (const event of this.provider.streamMessage(request)) {
        sawStreamEvent = true

        if (event.type === 'message_stop') {
          return event.response
        }

        if (event.type === 'text_delta') {
          if (event.text) {
            yield {
              type: 'partial_message',
              partial: {
                type: 'text',
                text: event.text,
              },
            }
          }
          continue
        }

        if (event.type === 'tool_use_delta') {
          yield {
            type: 'partial_message',
            partial: {
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
            },
          }
        }
      }
    } catch (err) {
      // If streaming fails before any bytes arrive, keep the older retry path.
      // Once partials have been emitted, retrying could duplicate user-visible text.
      if (!sawStreamEvent) {
        return await withRetry(
          () => this.provider.createMessage(request),
          undefined,
          this.config.abortSignal,
        )
      }
      throw err
    }

    return await withRetry(
      () => this.provider.createMessage(request),
      undefined,
      this.config.abortSignal,
    )
  }

  /**
   * Execute tool calls with concurrency control.
   *
   * Read-only tools run concurrently (up to 10 at a time).
   * Mutation tools run sequentially.
   */
  private async executeTools(
    toolUseBlocks: ToolUseBlock[],
  ): Promise<(ToolResult & { tool_name?: string })[]> {
    const context: ToolContext = {
      cwd: this.config.cwd,
      abortSignal: this.config.abortSignal,
      provider: this.provider,
      model: this.config.model,
      apiType: this.provider.apiType,
      sandbox: this.config.sandbox,
      permissionMode: this.config.permissionMode,
      canUseTool: this.config.canUseTool,
      toolCallBudget: this.toolCallBudget,
      approvedUnsandboxedBashToolUseIds: new Set(),
    }

    const MAX_CONCURRENCY = parseInt(
      process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY || '10',
    )

    // Partition into read-only (concurrent) and mutation (serial), while
    // preserving a result slot for every model-requested tool_use block.
    const readOnly: Array<{ index: number; block: ToolUseBlock; tool?: ToolDefinition }> = []
    const mutations: Array<{ index: number; block: ToolUseBlock; tool?: ToolDefinition }> = []
    const results = new Array<ToolResult & { tool_name?: string }>(toolUseBlocks.length)

    for (const [index, block] of toolUseBlocks.entries()) {
      if (!this.claimToolCall()) {
        results[index] = this.createMaxToolCallsResult(block)
        continue
      }

      const tool = this.config.tools.find((t) => t.name === block.name)
      if (tool?.isReadOnly?.()) {
        readOnly.push({ index, block, tool })
      } else {
        mutations.push({ index, block, tool })
      }
    }

    // Execute read-only tools concurrently (batched by MAX_CONCURRENCY)
    for (let i = 0; i < readOnly.length; i += MAX_CONCURRENCY) {
      const batch = readOnly.slice(i, i + MAX_CONCURRENCY)
      const batchResults = await Promise.all(
        batch.map((item) =>
          this.executeSingleTool(item.block, item.tool, context),
        ),
      )
      for (let j = 0; j < batch.length; j++) {
        results[batch[j].index] = batchResults[j]
      }
    }

    // Execute mutation tools sequentially
    for (const item of mutations) {
      results[item.index] = await this.executeSingleTool(item.block, item.tool, context)
    }

    return results.filter((result): result is ToolResult & { tool_name?: string } => Boolean(result))
  }

  private claimToolCall(): boolean {
    this.toolCallBudget.toolCallCount++

    const maxToolCalls = this.toolCallBudget.maxToolCalls
    if (maxToolCalls === undefined || this.toolCallBudget.toolCallCount <= maxToolCalls) {
      return true
    }

    this.toolCallBudget.exceeded = true
    this.toolCallBudget.blockedToolCallCount++
    return false
  }

  private createMaxToolCallsResult(block: ToolUseBlock): ToolResult & { tool_name?: string } {
    const maxToolCalls = this.toolCallBudget.maxToolCalls ?? 0
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content:
        `Error: maxToolCalls exceeded (${maxToolCalls} allowed; ` +
        `${this.toolCallBudget.toolCallCount} requested). ` +
        `Tool "${block.name}" was not executed.`,
      is_error: true,
      tool_name: block.name,
    }
  }

  /**
   * Execute a single tool with permission checking.
   */
  private async executeSingleTool(
    block: ToolUseBlock,
    tool: ToolDefinition | undefined,
    context: ToolContext,
  ): Promise<ToolResult & { tool_name?: string }> {
    if (!tool) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: Unknown tool "${block.name}"`,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Check enabled
    if (tool.isEnabled && !tool.isEnabled()) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: Tool "${block.name}" is not enabled`,
        is_error: true,
        tool_name: block.name,
      }
    }

    const sandboxBlockReason = getSandboxToolBlockReason(
      block.name,
      block.input,
      this.config.sandbox,
      tool,
    )
    if (sandboxBlockReason) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: sandboxBlockReason,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Check permissions
    if (this.config.canUseTool) {
      try {
        const permission = await this.config.canUseTool(tool, block.input)
        if (permission.behavior === 'deny') {
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: permission.message || `Permission denied for tool "${block.name}"`,
            is_error: true,
            tool_name: block.name,
          }
        }
        if (permission.updatedInput !== undefined) {
          block = { ...block, input: permission.updatedInput }
        }
        if (isUnsandboxedBashRequest(block)) {
          context.approvedUnsandboxedBashToolUseIds?.add(block.id)
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Permission check error: ${err.message}`,
          is_error: true,
          tool_name: block.name,
        }
      }
    }

    // Hook: PreToolUse
    const preHookResults = await this.executeHooks('PreToolUse', {
      toolName: block.name,
      toolInput: block.input,
      toolUseId: block.id,
    })
    // Check if any hook blocks this tool
    if (preHookResults.some((r) => r.block)) {
      const msg = preHookResults.find((r) => r.message)?.message || 'Blocked by PreToolUse hook'
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: msg,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Execute the tool
    try {
      const toolContext: ToolContext = {
        ...context,
        toolUseId: block.id,
        __sdkInternalToolCall: true,
      }
      if (isUnsandboxedBashRequest(block)) {
        const inheritedCanUseTool = context.canUseTool
        toolContext.canUseTool = async (requestedTool, requestedInput) => {
          if (
            requestedTool.name === 'Bash' &&
            toolContext.approvedUnsandboxedBashToolUseIds?.has(block.id)
          ) {
            return { behavior: 'allow' }
          }
          return inheritedCanUseTool
            ? inheritedCanUseTool(requestedTool, requestedInput)
            : { behavior: 'deny', message: 'No host approval handler is available.' }
        }
      }
      const result = await tool.call(block.input, toolContext)

      // Hook: PostToolUse
      await this.executeHooks('PostToolUse', {
        toolName: block.name,
        toolInput: block.input,
        toolOutput: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        toolUseId: block.id,
      })

      return { ...result, tool_use_id: block.id, tool_name: block.name }
    } catch (err: any) {
      // Hook: PostToolUseFailure
      await this.executeHooks('PostToolUseFailure', {
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
        error: err.message,
      })

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool execution error: ${err.message}`,
        is_error: true,
        tool_name: block.name,
      }
    }
  }

  /**
   * Get current messages for session persistence.
   */
  getMessages(): NormalizedMessageParam[] {
    return [...this.messages]
  }

  /**
   * Get total usage across all turns.
   */
  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }

  /**
   * Get total cost.
   */
  getCost(): number {
    return this.totalCost
  }
}
