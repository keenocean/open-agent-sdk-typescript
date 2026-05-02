/**
 * Core type definitions for the Agent SDK
 */

// Content block types (provider-agnostic, compatible with Anthropic format)
export type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: any }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | any[]; is_error?: boolean }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }

// --------------------------------------------------------------------------
// Message Types
// --------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant'

export interface ConversationMessage {
  role: MessageRole
  content: string | ContentBlockParam[]
}

export interface UserMessage {
  type: 'user'
  message: ConversationMessage
  uuid: string
  timestamp: string
}

export interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  uuid: string
  timestamp: string
  usage?: TokenUsage
  cost?: number
}

export type Message = UserMessage | AssistantMessage

// --------------------------------------------------------------------------
// SDK Message Types (streaming events)
// --------------------------------------------------------------------------

export type SDKMessage =
  | SDKAssistantMessage
  | SDKToolResultMessage
  | SDKResultMessage
  | SDKPartialMessage
  | SDKSystemMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKTaskNotificationMessage
  | SDKRateLimitEvent

export interface SDKAssistantMessage {
  type: 'assistant'
  uuid?: string
  session_id?: string
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  parent_tool_use_id?: string | null
}

export interface SDKToolResultMessage {
  type: 'tool_result'
  result: {
    tool_use_id: string
    tool_name: string
    output: string
  }
}

export interface SDKResultMessage {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd' | string
  uuid?: string
  session_id?: string
  is_error?: boolean
  num_turns?: number
  result?: string
  stop_reason?: string | null
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  usage?: TokenUsage
  model_usage?: Record<string, { input_tokens: number; output_tokens: number }>
  permission_denials?: Array<{ tool: string; reason: string }>
  structured_output?: unknown
  errors?: string[]
  /** Number of tool_use blocks requested by the model, including blocked calls. */
  tool_calls?: number
  /** Hard cap for tool_use blocks in this query/run. Omitted when unlimited. */
  max_tool_calls?: number
  /** Number of tool_use blocks blocked by maxToolCalls. */
  blocked_tool_calls?: number
  /** True when the run stopped at a resumable hard limit. */
  can_continue?: boolean
  /** @deprecated Use total_cost_usd */
  cost?: number
}

export interface SDKPartialMessage {
  type: 'partial_message'
  partial: {
    type: 'text' | 'tool_use'
    id?: string
    text?: string
    name?: string
    input?: string
  }
}

/** Emitted once at session start with initialization info. */
export interface SDKSystemMessage {
  type: 'system'
  subtype: 'init'
  uuid?: string
  session_id: string
  tools: string[]
  model: string
  cwd: string
  mcp_servers: Array<{ name: string; status: string }>
  permission_mode: string
  warnings?: string[]
  sandbox?: {
    enabled: boolean
    trusted: false
    unavailable_reason?: string
  }
}

/** Marks a compaction boundary in the conversation. */
export interface SDKCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  summary?: string
}

/** Status update during long operations. */
export interface SDKStatusMessage {
  type: 'system'
  subtype: 'status'
  message: string
}

/** Task lifecycle notification. */
export interface SDKTaskNotificationMessage {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  status: string
  message?: string
}

/** Rate limit event. */
export interface SDKRateLimitEvent {
  type: 'system'
  subtype: 'rate_limit'
  retry_after_ms?: number
  message: string
}

// --------------------------------------------------------------------------
// Token Usage
// --------------------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// --------------------------------------------------------------------------
// Tool Types
// --------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: any, context: ToolContext) => Promise<ToolResult>
  isReadOnly?: () => boolean
  /** True when the tool is safe to run while SDK sandbox guards are enabled. */
  sandboxAware?: () => boolean
  isConcurrencySafe?: () => boolean
  isEnabled?: () => boolean
  prompt?: (context: ToolContext) => Promise<string>
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}

export interface ToolContext {
  cwd: string
  abortSignal?: AbortSignal
  /** SDK sandbox policy. This is an application-level guard, not an OS sandbox. */
  sandbox?: SandboxRuntimePolicy
  /** Parent approval mode inherited by nested tools/subagents. */
  permissionMode?: PermissionMode
  /** Parent approval callback inherited by nested tools/subagents. */
  canUseTool?: CanUseToolFn
  /** Shared tool call budget inherited by nested tools/subagents. */
  toolCallBudget?: ToolCallBudget
  /** Current tool_use id, set by QueryEngine before invoking a tool. */
  toolUseId?: string
  /** Tool_use ids explicitly approved for unsandboxed Bash by host canUseTool. */
  approvedUnsandboxedBashToolUseIds?: Set<string>
  /** Internal marker set by QueryEngine after it has applied budget/sandbox/permission guards. */
  __sdkInternalToolCall?: boolean
  /** Parent agent's LLM provider (inherited by subagents) */
  provider?: import('./providers/types.js').LLMProvider
  /** Parent agent's model ID */
  model?: string
  /** Parent agent's API type */
  apiType?: import('./providers/types.js').ApiType
}

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | any[]
  is_error?: boolean
}

export interface ToolCallBudget {
  /** Omitted means unlimited; callers must opt into unlimited explicitly. */
  maxToolCalls?: number
  /** Counts model-requested tool_use blocks, including blocked calls. */
  toolCallCount: number
  /** Counts calls blocked specifically because maxToolCalls was exceeded. */
  blockedToolCallCount: number
  /** Set once the hard cap has blocked at least one tool_use. */
  exceeded: boolean
}

// --------------------------------------------------------------------------
// Permission Types
// --------------------------------------------------------------------------

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export type PermissionBehavior = 'allow' | 'deny'

export type CanUseToolResult = {
  behavior: PermissionBehavior
  updatedInput?: unknown
  message?: string
}

export type CanUseToolFn = (
  tool: ToolDefinition,
  input: unknown,
) => Promise<CanUseToolResult>

// --------------------------------------------------------------------------
// MCP Types
// --------------------------------------------------------------------------

export type McpServerConfig =
  | McpStdioConfig
  | McpSseConfig
  | McpHttpConfig

export interface McpStdioConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSseConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHttpConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

// --------------------------------------------------------------------------
// Agent Types
// --------------------------------------------------------------------------

export interface AgentDefinition {
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string
  mcpServers?: Array<string | { name: string; tools?: string[] }>
  skills?: string[]
  maxTurns?: number
  criticalSystemReminder_EXPERIMENTAL?: string
}

export interface ThinkingConfig {
  type: 'adaptive' | 'enabled' | 'disabled'
  budgetTokens?: number
}

// --------------------------------------------------------------------------
// Sandbox Types
// --------------------------------------------------------------------------

export interface SandboxSettings {
  enabled?: boolean
  /**
   * Fail the query if sandbox.enabled is true but no trusted OS sandbox runtime
   * is available. The TypeScript SDK currently provides app-level guards only.
   */
  failIfUnavailable?: boolean
  autoAllowBashIfSandboxed?: boolean
  excludedCommands?: string[]
  allowUnsandboxedCommands?: boolean
  network?: SandboxNetworkConfig
  filesystem?: SandboxFilesystemConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  ripgrep?: { command: string; args?: string[] }
}

export interface SandboxNetworkConfig {
  allowedDomains?: string[]
  deniedDomains?: string[]
  allowManagedDomainsOnly?: boolean
  allowLocalBinding?: boolean
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  httpProxyPort?: number
  socksProxyPort?: number
}

export interface SandboxFilesystemConfig {
  allowRead?: string[]
  allowWrite?: string[]
  denyWrite?: string[]
  denyRead?: string[]
}

export interface SandboxRuntimePolicy {
  enabled: boolean
  trusted: false
  failIfUnavailable: boolean
  autoAllowBashIfSandboxed: boolean
  allowUnsandboxedCommands: boolean
  unavailableReason?: string
  warnings: string[]
  network: SandboxNetworkConfig
  filesystem: SandboxFilesystemConfig
}

// --------------------------------------------------------------------------
// Output Format
// --------------------------------------------------------------------------

export interface OutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Setting Sources
// --------------------------------------------------------------------------

export type SettingSource = 'user' | 'project' | 'local'

// --------------------------------------------------------------------------
// Model Info
// --------------------------------------------------------------------------

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export interface AgentOptions {
  /** LLM model ID */
  model?: string
  /**
   * API type: 'anthropic-messages' or 'openai-completions'.
   * Falls back to CODEANY_API_TYPE env var. Default: 'anthropic-messages'.
   */
  apiType?: import('./providers/types.js').ApiType
  /** API key. Falls back to CODEANY_API_KEY env var. */
  apiKey?: string
  /** API base URL override */
  baseURL?: string
  /** Working directory for file/shell tools */
  cwd?: string
  /** System prompt override or preset */
  systemPrompt?: string | { type: 'preset'; preset: 'default'; append?: string }
  /** Append to default system prompt */
  appendSystemPrompt?: string
  /** Available tools (ToolDefinition[] or string[] preset) */
  tools?: ToolDefinition[] | string[] | { type: 'preset'; preset: 'default' }
  /** Allow per-query tools overrides to expand beyond the constructor tool pool. Defaults to false. */
  allowQueryToolExpansion?: boolean
  /** Maximum number of agentic turns per query */
  maxTurns?: number
  /** Maximum USD budget per query */
  maxBudgetUsd?: number
  /**
   * Hard cap on model-requested tool_use blocks per query. Defaults to 50.
   * Set to Infinity to opt out intentionally.
   */
  maxToolCalls?: number
  /** Extended thinking configuration */
  thinking?: ThinkingConfig
  /** Maximum thinking tokens (deprecated, use thinking.budgetTokens) */
  maxThinkingTokens?: number
  /** Structured output JSON schema */
  jsonSchema?: Record<string, unknown>
  /** Structured output format */
  outputFormat?: OutputFormat
  /** Permission handler callback */
  canUseTool?: CanUseToolFn
  /** Permission mode controlling tool approval behavior */
  permissionMode?: PermissionMode
  /** Abort controller for cancellation */
  abortController?: AbortController
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Whether to include partial streaming events */
  includePartialMessages?: boolean
  /** Environment variables */
  env?: Record<string, string | undefined>
  /** Tool names to pre-approve without prompting */
  allowedTools?: string[]
  /** Tool names to deny */
  disallowedTools?: string[]
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig | any> // supports McpSdkServerConfig
  /** Custom subagent definitions */
  agents?: Record<string, AgentDefinition>
  /** Maximum tokens for responses */
  maxTokens?: number
  /** Effort level for reasoning */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Fallback model if primary is unavailable */
  fallbackModel?: string
  /** Continue the most recent session in cwd */
  continue?: boolean
  /** Resume a specific session by ID */
  resume?: string
  /** Fork a session instead of continuing it */
  forkSession?: boolean
  /** Persist session to disk */
  persistSession?: boolean
  /** Explicit session ID */
  sessionId?: string
  /** Enable file checkpointing (for rewindFiles) */
  enableFileCheckpointing?: boolean
  /** Sandbox configuration */
  sandbox?: SandboxSettings
  /** Load settings from filesystem */
  settingSources?: SettingSource[]
  /** Plugin configurations */
  plugins?: Array<{ name: string; config?: Record<string, unknown> }>
  /** Additional working directories */
  additionalDirectories?: string[]
  /** Default agent to use */
  agent?: string
  /** Debug mode */
  debug?: boolean
  /** Debug log file */
  debugFile?: string
  /** Tool-specific configuration */
  toolConfig?: Record<string, unknown>
  /** Enable prompt suggestions */
  promptSuggestions?: boolean
  /** Strict MCP config validation */
  strictMcpConfig?: boolean
  /** Extra CLI arguments */
  extraArgs?: Record<string, string | null>
  /** SDK betas to enable */
  betas?: string[]
  /** Permission prompt tool name override */
  permissionPromptToolName?: string
  /** Hook configurations */
  hooks?: Record<string, Array<{
    matcher?: string
    hooks: Array<(input: any, toolUseId: string, context: { signal: AbortSignal }) => Promise<any>>
    timeout?: number
  }>>
}

export interface QueryResult {
  /** Final text output from the assistant */
  text: string
  /** Token usage */
  usage: TokenUsage
  /** Number of agentic turns */
  num_turns: number
  /** Number of tool_use blocks requested by the model, including blocked calls. */
  tool_calls?: number
  /** Hard cap for tool_use blocks in this query/run. Omitted when unlimited. */
  max_tool_calls?: number
  /** Number of tool_use blocks blocked by maxToolCalls. */
  blocked_tool_calls?: number
  /** True when the run stopped at a resumable hard limit. */
  can_continue?: boolean
  /** Duration in milliseconds */
  duration_ms: number
  /** All conversation messages */
  messages: Message[]
}

// --------------------------------------------------------------------------
// Query Engine Types
// --------------------------------------------------------------------------

export interface QueryEngineConfig {
  cwd: string
  model: string
  /** LLM provider instance (created from apiType) */
  provider: import('./providers/types.js').LLMProvider
  tools: ToolDefinition[]
  systemPrompt?: string
  appendSystemPrompt?: string
  maxTurns: number
  maxBudgetUsd?: number
  maxToolCalls?: number
  toolCallBudget?: ToolCallBudget
  maxTokens: number
  permissionMode?: PermissionMode
  sandbox?: SandboxRuntimePolicy
  thinking?: ThinkingConfig
  jsonSchema?: Record<string, unknown>
  canUseTool: CanUseToolFn
  includePartialMessages: boolean
  abortSignal?: AbortSignal
  agents?: Record<string, AgentDefinition>
  /** Hook registry for lifecycle events */
  hookRegistry?: import('./hooks.js').HookRegistry
  /** Session ID for hook context */
  sessionId?: string
}
