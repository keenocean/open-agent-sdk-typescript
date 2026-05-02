/**
 * FileWriteTool - Write/create files
 */

import { writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { defineTool } from './types.js'
import {
  checkSandboxWrite,
  claimDirectToolCallBudget,
  requireSandboxContext,
} from '../utils/sandbox.js'

export const FileWriteTool = defineTool({
  name: 'Write',
  description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does. Creates parent directories as needed.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },
  isReadOnly: false,
  sandboxAware: true,
  isConcurrencySafe: false,
  async call(input, context) {
    const contextBlockReason = requireSandboxContext(context.sandbox, 'Write')
    if (contextBlockReason) {
      return { data: contextBlockReason, is_error: true }
    }
    if (!context.__sdkInternalToolCall) {
      const budgetBlockReason = claimDirectToolCallBudget(context.toolCallBudget, 'Write')
      if (budgetBlockReason) {
        return { data: budgetBlockReason, is_error: true }
      }
    }
    const filePath = resolve(context.cwd, input.file_path)
    const sandboxBlockReason = checkSandboxWrite(context.sandbox, context.cwd, filePath)
    if (sandboxBlockReason) {
      return { data: sandboxBlockReason, is_error: true }
    }
    if (!context.__sdkInternalToolCall) {
      if (!context.canUseTool) {
        return { data: 'Write requires explicit host approval through context.canUseTool.', is_error: true }
      }
      const permission = await context.canUseTool(FileWriteTool, input)
      if (permission.behavior === 'deny') {
        return { data: permission.message || 'Write was denied by host approval.', is_error: true }
      }
      if (permission.updatedInput !== undefined) {
        input = permission.updatedInput
      }
    }

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, input.content, 'utf-8')

      const lines = input.content.split('\n').length
      const bytes = Buffer.byteLength(input.content, 'utf-8')
      return `File written: ${filePath} (${lines} lines, ${bytes} bytes)`
    } catch (err: any) {
      return { data: `Error writing file: ${err.message}`, is_error: true }
    }
  },
})
