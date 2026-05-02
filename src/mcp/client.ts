/**
 * MCP Client - Connect to Model Context Protocol servers
 */

import type { ToolDefinition, McpServerConfig, ToolContext, ToolResult } from '../types.js'
import {
  claimDirectToolCallBudget,
  getSandboxToolBlockReason,
} from '../utils/sandbox.js'

export interface MCPConnection {
  name: string
  status: 'connected' | 'disconnected' | 'error'
  tools: ToolDefinition[]
  close: () => Promise<void>
}

/**
 * Connect to an MCP server and fetch its tools.
 */
export async function connectMCPServer(
  name: string,
  config: McpServerConfig,
): Promise<MCPConnection> {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')

    let transport: any

    if (!config.type || config.type === 'stdio') {
      const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> }
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      transport = new StdioClientTransport({
        command: stdioConfig.command,
        args: stdioConfig.args || [],
        env: { ...process.env, ...stdioConfig.env } as Record<string, string>,
      })
    } else if (config.type === 'sse') {
      const sseConfig = config as { url: string; headers?: Record<string, string> }
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
      transport = new SSEClientTransport(new URL(sseConfig.url), {
        requestInit: sseConfig.headers ? { headers: sseConfig.headers } : undefined,
      } as any)
    } else if (config.type === 'http') {
      const httpConfig = config as { url: string; headers?: Record<string, string> }
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      transport = new StreamableHTTPClientTransport(new URL(httpConfig.url), {
        requestInit: httpConfig.headers ? { headers: httpConfig.headers } : undefined,
      } as any)
    } else {
      throw new Error(`Unsupported MCP transport type: ${(config as any).type}`)
    }

    const client = new Client(
      { name: `agent-sdk-${name}`, version: '1.0.0' },
      { capabilities: {} },
    )

    await client.connect(transport)

    // Fetch available tools
    const toolList = await client.listTools()
    const tools: ToolDefinition[] = (toolList.tools || []).map((mcpTool: any) =>
      createMCPToolDefinition(name, mcpTool, client),
    )

    return {
      name,
      status: 'connected',
      tools,
      async close() {
        try {
          await client.close()
        } catch {
          // ignore close errors
        }
      },
    }
  } catch (err: any) {
    console.error(`[MCP] Failed to connect to "${name}": ${err.message}`)
    return {
      name,
      status: 'error',
      tools: [],
      async close() {},
    }
  }
}

/**
 * Create a ToolDefinition wrapping an MCP server tool.
 */
function createMCPToolDefinition(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema?: any },
  client: any,
): ToolDefinition {
  const toolName = `mcp__${serverName}__${mcpTool.name}`

  const toolDefinition: ToolDefinition = {
    name: toolName,
    description: mcpTool.description || `MCP tool: ${mcpTool.name} from ${serverName}`,
    inputSchema: mcpTool.inputSchema || { type: 'object', properties: {} },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return mcpTool.description || ''
    },
    async call(input: any, context?: ToolContext): Promise<ToolResult> {
      const sandboxBlockReason = context?.sandbox
        ? getSandboxToolBlockReason(toolName, input, context.sandbox)
        : `MCP tool "${toolName}" requires an explicit sandbox context. Pass sandbox.enabled=false only when the host provides its own boundary.`
      if (sandboxBlockReason) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: sandboxBlockReason,
          is_error: true,
        }
      }
      if (!context?.__sdkInternalToolCall) {
        const budgetBlockReason = claimDirectToolCallBudget(context?.toolCallBudget, toolName)
        if (budgetBlockReason) {
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: budgetBlockReason,
            is_error: true,
          }
        }
        if (!context?.canUseTool) {
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: `MCP tool "${toolName}" requires explicit host approval through context.canUseTool.`,
            is_error: true,
          }
        }
        const permission = await context.canUseTool(toolDefinition, input)
        if (permission.behavior === 'deny') {
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: permission.message || `MCP tool "${toolName}" was denied by host approval.`,
            is_error: true,
          }
        }
      }

      try {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input,
        })

        // Extract text content from MCP result
        let output = ''
        if (result.content) {
          for (const block of result.content) {
            if (block.type === 'text') {
              output += block.text
            } else {
              output += JSON.stringify(block)
            }
          }
        } else {
          output = JSON.stringify(result)
        }

        return {
          type: 'tool_result',
          tool_use_id: '',
          content: output,
          is_error: result.isError || false,
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `MCP tool error: ${err.message}`,
          is_error: true,
        }
      }
    },
  }
  return toolDefinition
}

/**
 * Close all MCP connections.
 */
export async function closeAllConnections(connections: MCPConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.close()))
}
