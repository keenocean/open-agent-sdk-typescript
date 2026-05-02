/**
 * BashTool - Execute shell commands
 */

import { spawn } from 'child_process'
import { defineTool } from './types.js'
import {
  claimDirectToolCallBudget,
  getSandboxToolBlockReason,
  requireSandboxContext,
} from '../utils/sandbox.js'

export const BashTool = defineTool({
  name: 'Bash',
  description: 'Execute a bash command and return its output. Use for running shell commands, scripts, and system operations.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000, default 120000)',
      },
      dangerouslyDisableSandbox: {
        type: 'boolean',
        description: 'Run the command without SDK sandbox protection. Requires sandbox.allowUnsandboxedCommands and host approval.',
      },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    const { command, timeout: userTimeout } = input
    const contextBlockReason = requireSandboxContext(context.sandbox, 'Bash')
    if (contextBlockReason) {
      return { data: contextBlockReason, is_error: true }
    }
    if (!context.__sdkInternalToolCall) {
      const budgetBlockReason = claimDirectToolCallBudget(context.toolCallBudget, 'Bash')
      if (budgetBlockReason) {
        return { data: budgetBlockReason, is_error: true }
      }
    }

    const sandboxBlockReason = getSandboxToolBlockReason('Bash', input, context.sandbox)
    if (sandboxBlockReason) {
      return { data: sandboxBlockReason, is_error: true }
    }
    let directPermissionAllowed = false
    if (!context.__sdkInternalToolCall) {
      if (!context.canUseTool) {
        return {
          data: 'Bash requires explicit host approval through context.canUseTool.',
          is_error: true,
        }
      }
      const permission = await context.canUseTool(BashTool, input)
      if (permission.behavior === 'deny') {
        return {
          data: permission.message || 'Bash was denied by host approval.',
          is_error: true,
        }
      }
      directPermissionAllowed = true
    }
    if (
      context.sandbox?.enabled &&
      input.dangerouslyDisableSandbox === true &&
      !directPermissionAllowed &&
      (!context.canUseTool ||
        (await context.canUseTool(BashTool, input)).behavior !== 'allow')
    ) {
      return {
        data: 'Unsandboxed Bash requires explicit host approval for this tool_use.',
        is_error: true,
      }
    }

    const timeoutMs = Math.min(userTimeout || 120000, 600000)

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []

      const proc = spawn('bash', ['-c', command], {
        cwd: context.cwd,
        env: { ...process.env },
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      proc.stdout?.on('data', (data: Buffer) => chunks.push(data))
      proc.stderr?.on('data', (data: Buffer) => errChunks.push(data))

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', () => {
          proc.kill('SIGTERM')
        }, { once: true })
      }

      proc.on('close', (code) => {
        const stdout = Buffer.concat(chunks).toString('utf-8')
        const stderr = Buffer.concat(errChunks).toString('utf-8')

        let output = ''
        if (stdout) output += stdout
        if (stderr) output += (output ? '\n' : '') + stderr
        if (code !== 0 && code !== null) {
          output += `\nExit code: ${code}`
        }

        // Truncate very large outputs
        if (output.length > 100000) {
          output = output.slice(0, 50000) + '\n...(truncated)...\n' + output.slice(-50000)
        }

        resolve(output || '(no output)')
      })

      proc.on('error', (err) => {
        resolve(`Error executing command: ${err.message}`)
      })
    })
  },
})
