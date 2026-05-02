/**
 * GlobTool - File pattern matching
 */

import { isAbsolute, resolve } from 'path'
import { defineTool } from './types.js'
import {
  checkSandboxRead,
  claimDirectToolCallBudget,
  requireSandboxContext,
} from '../utils/sandbox.js'

export const GlobTool = defineTool({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Supports patterns like "**/*.ts", "src/**/*.js".',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against',
      },
      path: {
        type: 'string',
        description: 'The directory to search in (defaults to cwd)',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  sandboxAware: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const contextBlockReason = requireSandboxContext(context.sandbox, 'Glob')
    if (contextBlockReason) {
      return { data: contextBlockReason, is_error: true }
    }
    if (!context.__sdkInternalToolCall) {
      const budgetBlockReason = claimDirectToolCallBudget(context.toolCallBudget, 'Glob')
      if (budgetBlockReason) {
        return { data: budgetBlockReason, is_error: true }
      }
    }
    const searchDir = input.path ? resolve(context.cwd, input.path) : context.cwd
    const { pattern } = input
    const sandboxBlockReason = checkSandboxRead(context.sandbox, context.cwd, searchDir)
    if (sandboxBlockReason) {
      return { data: sandboxBlockReason, is_error: true }
    }
    const patternBlockReason = getSandboxGlobPatternBlockReason(pattern, context.sandbox?.enabled)
    if (patternBlockReason) {
      return { data: patternBlockReason, is_error: true }
    }

    try {
      // Use Node.js glob (available in Node 22+) or fall back to bash find
      const { glob } = await import('fs/promises')

      // @ts-ignore - glob is available in Node 22+
      if (typeof glob === 'function') {
        const matches: string[] = []
        // @ts-ignore
        for await (const entry of glob(pattern, { cwd: searchDir })) {
          const entryBlockReason = checkSandboxRead(
            context.sandbox,
            context.cwd,
            resolve(searchDir, entry),
          )
          if (entryBlockReason) continue
          matches.push(entry)
          if (matches.length >= 500) break
        }
        if (matches.length === 0) {
          return `No files matching pattern "${pattern}" in ${searchDir}`
        }
        return matches.join('\n')
      }
    } catch {
      // Fall through to bash-based approach
    }

    if (context.sandbox?.enabled) {
      return {
        data: 'Error: Node.js glob API unavailable; bash fallback is disabled while SDK sandbox mode is enabled.',
        is_error: true,
      }
    }

    // Fallback: use bash find/glob
    const { spawn } = await import('child_process')
    return new Promise<string>((resolvePromise) => {
      // Use bash glob expansion or find
      const cmd = `shopt -s globstar nullglob 2>/dev/null; cd ${JSON.stringify(searchDir)} && ls -1d ${pattern} 2>/dev/null | head -500`
      const proc = spawn('bash', ['-c', cmd], {
        cwd: searchDir,
        timeout: 30000,
      })

      const chunks: Buffer[] = []
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d))
      proc.on('close', () => {
        const result = Buffer.concat(chunks).toString('utf-8').trim()
        if (!result) {
          resolvePromise(`No files matching pattern "${pattern}" in ${searchDir}`)
        } else {
          resolvePromise(result)
        }
      })
      proc.on('error', () => {
        resolvePromise(`Error searching for files with pattern "${pattern}"`)
      })
    })
  },
})

function getSandboxGlobPatternBlockReason(
  pattern: string,
  sandboxEnabled: boolean | undefined,
): string | undefined {
  if (!sandboxEnabled) return undefined
  if (isAbsolute(pattern)) {
    return 'Error: absolute glob patterns are blocked while SDK sandbox mode is enabled.'
  }
  if (pattern.split(/[\\/]+/).includes('..')) {
    return 'Error: parent-directory glob patterns are blocked while SDK sandbox mode is enabled.'
  }
  return undefined
}
