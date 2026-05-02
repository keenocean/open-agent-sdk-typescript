/**
 * WebFetchTool - Fetch web content
 */

import { defineTool } from './types.js'
import {
  checkSandboxUrl,
  checkSandboxUrlForFetch,
  claimDirectToolCallBudget,
  requireSandboxContext,
} from '../utils/sandbox.js'

const MAX_SANDBOX_REDIRECTS = 5

export const WebFetchTool = defineTool({
  name: 'WebFetch',
  description: 'Fetch content from a URL and return it as text. Supports HTML pages, JSON APIs, and plain text. Strips HTML tags for readability.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers',
      },
    },
    required: ['url'],
  },
  isReadOnly: true,
  sandboxAware: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { url, headers } = input
    const contextBlockReason = requireSandboxContext(context.sandbox, 'WebFetch')
    if (contextBlockReason) {
      return { data: contextBlockReason, is_error: true }
    }
    if (!context.__sdkInternalToolCall) {
      const budgetBlockReason = claimDirectToolCallBudget(context.toolCallBudget, 'WebFetch')
      if (budgetBlockReason) {
        return { data: budgetBlockReason, is_error: true }
      }
    }
    const sandboxBlockReason = await checkSandboxUrlForFetch(context.sandbox, url)
    if (sandboxBlockReason) {
      return { data: sandboxBlockReason, is_error: true }
    }

    try {
      const response = await fetchWithSandboxRedirects(url, context.sandbox, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AgentSDK/1.0)',
          ...headers,
        },
        signal: AbortSignal.timeout(30000),
      })

      if (!response.ok) {
        return { data: `HTTP ${response.status}: ${response.statusText}`, is_error: true }
      }

      const contentType = response.headers.get('content-type') || ''
      let text = await response.text()

      // Strip HTML tags for readability
      if (contentType.includes('text/html')) {
        // Remove script and style blocks
        text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        // Remove HTML tags
        text = text.replace(/<[^>]+>/g, ' ')
        // Clean up whitespace
        text = text.replace(/\s+/g, ' ').trim()
      }

      // Truncate very large responses
      if (text.length > 100000) {
        text = text.slice(0, 100000) + '\n...(truncated)'
      }

      return text || '(empty response)'
    } catch (err: any) {
      return { data: `Error fetching ${url}: ${err.message}`, is_error: true }
    }
  },
})

async function fetchWithSandboxRedirects(
  initialUrl: string,
  sandbox: Parameters<typeof checkSandboxUrl>[0],
  init: RequestInit,
): Promise<Response> {
  let currentUrl = initialUrl

  for (let redirects = 0; redirects <= MAX_SANDBOX_REDIRECTS; redirects++) {
    const response = await fetch(currentUrl, {
      ...init,
      redirect: 'manual',
    })

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response
    }

    const location = response.headers.get('location')
    if (!location) return response

    const nextUrl = new URL(location, currentUrl).toString()
    const sandboxBlockReason = await checkSandboxUrlForFetch(sandbox, nextUrl)
    if (sandboxBlockReason) {
      throw new Error(sandboxBlockReason)
    }

    currentUrl = nextUrl
  }

  throw new Error(`Too many redirects; maximum is ${MAX_SANDBOX_REDIRECTS}`)
}
