/**
 * WebSearchTool - Web search (via web fetch of search engines)
 */

import { defineTool } from './types.js'
import {
  checkSandboxUrlForFetch,
  claimDirectToolCallBudget,
  requireSandboxContext,
} from '../utils/sandbox.js'

export const WebSearchTool = defineTool({
  name: 'WebSearch',
  description: 'Search the web for information. Returns search results with titles, URLs, and snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      num_results: {
        type: 'number',
        description: 'Number of results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  isReadOnly: true,
  sandboxAware: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { query } = input
    const contextBlockReason = requireSandboxContext(context.sandbox, 'WebSearch')
    if (contextBlockReason) {
      return { data: contextBlockReason, is_error: true }
    }
    if (!context.__sdkInternalToolCall) {
      const budgetBlockReason = claimDirectToolCallBudget(context.toolCallBudget, 'WebSearch')
      if (budgetBlockReason) {
        return { data: budgetBlockReason, is_error: true }
      }
    }

    try {
      // Use DuckDuckGo HTML search as a free fallback
      const encoded = encodeURIComponent(query)
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`
      const sandboxBlockReason = await checkSandboxUrlForFetch(context.sandbox, url)
      if (sandboxBlockReason) {
        return { data: sandboxBlockReason, is_error: true }
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AgentSDK/1.0)',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'manual',
      })

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (location) {
          const nextUrl = new URL(location, url).toString()
          const redirectBlockReason = await checkSandboxUrlForFetch(context.sandbox, nextUrl)
          if (redirectBlockReason) {
            return { data: redirectBlockReason, is_error: true }
          }
        }
        return { data: `Search redirected: HTTP ${response.status}`, is_error: true }
      }

      if (!response.ok) {
        return { data: `Search failed: HTTP ${response.status}`, is_error: true }
      }

      const html = await response.text()

      // Parse search results from DuckDuckGo HTML
      const results: string[] = []
      const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
      const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi

      let match
      const links: Array<{ title: string; url: string }> = []

      while ((match = resultRegex.exec(html)) !== null) {
        const href = match[1]
        const title = match[2].replace(/<[^>]+>/g, '').trim()
        if (href && title && !href.includes('duckduckgo.com')) {
          links.push({ title, url: href })
        }
      }

      const snippets: string[] = []
      while ((match = snippetRegex.exec(html)) !== null) {
        snippets.push(match[1].replace(/<[^>]+>/g, '').trim())
      }

      const numResults = Math.min(input.num_results || 5, links.length)
      for (let i = 0; i < numResults; i++) {
        const link = links[i]
        if (!link) continue
        let entry = `${i + 1}. ${link.title}\n   ${link.url}`
        if (snippets[i]) {
          entry += `\n   ${snippets[i]}`
        }
        results.push(entry)
      }

      return results.length > 0
        ? results.join('\n\n')
        : `No results found for "${query}"`
    } catch (err: any) {
      return { data: `Search error: ${err.message}`, is_error: true }
    }
  },
})
