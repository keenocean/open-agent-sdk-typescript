import { homedir, tmpdir } from 'os'
import { lookup } from 'dns/promises'
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'fs'
import { isIP } from 'net'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'path'
import type {
  SandboxRuntimePolicy,
  SandboxSettings,
  ToolCallBudget,
  ToolDefinition,
} from '../types.js'

const SDK_SANDBOX_UNAVAILABLE =
  'SDK sandbox is an application-level guard only; no trusted OS sandbox runtime is bundled.'

const SANDBOX_AWARE_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
])

export function createSandboxPolicy(
  settings: SandboxSettings | undefined,
  cwd: string,
): SandboxRuntimePolicy {
  const enabled = settings?.enabled === true
  const warnings: string[] = []
  const unavailableReason = enabled ? SDK_SANDBOX_UNAVAILABLE : undefined

  if (unavailableReason) {
    warnings.push(unavailableReason)
  }

  return {
    enabled,
    trusted: false,
    failIfUnavailable: settings?.failIfUnavailable ?? false,
    autoAllowBashIfSandboxed: settings?.autoAllowBashIfSandboxed ?? false,
    allowUnsandboxedCommands: settings?.allowUnsandboxedCommands ?? false,
    unavailableReason,
    warnings,
    network: {
      ...(settings?.network ?? {}),
    },
    filesystem: {
      allowRead: settings?.filesystem?.allowRead ?? ['.'],
      allowWrite: settings?.filesystem?.allowWrite ?? ['.', tmpdir()],
      denyWrite: settings?.filesystem?.denyWrite,
      denyRead: settings?.filesystem?.denyRead,
    },
  }
}

export function getSandboxStartupError(
  policy: SandboxRuntimePolicy | undefined,
): string | undefined {
  if (!policy?.enabled || !policy.failIfUnavailable) return undefined
  return policy.unavailableReason ?? SDK_SANDBOX_UNAVAILABLE
}

export function getSandboxToolBlockReason(
  toolName: string,
  input: unknown,
  policy: SandboxRuntimePolicy | undefined,
  tool?: ToolDefinition,
): string | undefined {
  if (!policy?.enabled) return undefined
  if (policy.failIfUnavailable) {
    return policy.unavailableReason ?? SDK_SANDBOX_UNAVAILABLE
  }

  if (toolName === 'Bash') {
    const wantsUnsandboxed =
      typeof input === 'object' &&
      input !== null &&
      (input as { dangerouslyDisableSandbox?: unknown }).dangerouslyDisableSandbox === true

    if (!wantsUnsandboxed) {
      return [
        'Bash is blocked because SDK sandbox mode is enabled but no trusted OS sandbox runtime is available.',
        'Set dangerouslyDisableSandbox: true only when you intentionally want an unsandboxed command.',
      ].join(' ')
    }

    if (!policy.allowUnsandboxedCommands) {
      return 'Bash requested dangerouslyDisableSandbox, but sandbox.allowUnsandboxedCommands is false.'
    }

    return undefined
  }

  if (toolName.startsWith('mcp__')) {
    return 'MCP tools are blocked while SDK sandbox mode is enabled because the SDK cannot confine external MCP tool execution.'
  }

  const sandboxAware = tool
    ? tool.sandboxAware?.() === true
    : SANDBOX_AWARE_TOOLS.has(toolName)
  if (!sandboxAware) {
    return `Tool "${toolName}" is blocked while SDK sandbox mode is enabled because it is not sandbox-aware.`
  }

  return undefined
}

export function checkSandboxRead(
  policy: SandboxRuntimePolicy | undefined,
  cwd: string,
  targetPath: string,
): string | undefined {
  if (!policy?.enabled) return undefined
  const absolute = resolve(cwd, targetPath)
  const effective = resolveEffectivePath(absolute)

  if (
    matchesAnyPath(absolute, policy.filesystem.denyRead, cwd) ||
    matchesAnyPath(effective, policy.filesystem.denyRead, cwd)
  ) {
    return `Read blocked by sandbox.filesystem.denyRead: ${effective}`
  }

  const allowRead = policy.filesystem.allowRead
  if (allowRead && allowRead.length > 0 && !matchesAnyPath(effective, allowRead, cwd)) {
    return `Read blocked by sandbox.filesystem.allowRead: ${effective}`
  }

  return undefined
}

export function checkSandboxWrite(
  policy: SandboxRuntimePolicy | undefined,
  cwd: string,
  targetPath: string,
): string | undefined {
  if (!policy?.enabled) return undefined
  const absolute = resolve(cwd, targetPath)
  const effective = resolveEffectivePath(absolute)

  if (
    matchesAnyPath(absolute, policy.filesystem.denyWrite, cwd) ||
    matchesAnyPath(effective, policy.filesystem.denyWrite, cwd)
  ) {
    return `Write blocked by sandbox.filesystem.denyWrite: ${effective}`
  }

  const allowWrite = policy.filesystem.allowWrite ?? ['.', tmpdir()]
  if (!matchesAnyPath(effective, allowWrite, cwd)) {
    return `Write blocked by sandbox.filesystem.allowWrite: ${effective}`
  }

  return undefined
}

export function checkSandboxUrl(
  policy: SandboxRuntimePolicy | undefined,
  url: string,
): string | undefined {
  if (!policy?.enabled) return undefined

  if (policy.network.allowManagedDomainsOnly) {
    return 'Network blocked: sandbox.network.allowManagedDomainsOnly is not supported without a managed network gateway.'
  }

  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return `Invalid URL: ${url}`
  }

  if (!policy.network.allowLocalBinding && isLocalNetworkHost(host)) {
    return `Network blocked by sandbox.network.allowLocalBinding: ${host}`
  }

  const denied = policy.network.deniedDomains ?? []
  if (denied.some(pattern => hostMatches(pattern, host))) {
    return `Network blocked by sandbox.network.deniedDomains: ${host}`
  }

  const allowed = policy.network.allowedDomains ?? []
  if (allowed.length > 0 && !allowed.some(pattern => hostMatches(pattern, host))) {
    return `Network blocked by sandbox.network.allowedDomains: ${host}`
  }

  return undefined
}

export async function checkSandboxUrlForFetch(
  policy: SandboxRuntimePolicy | undefined,
  url: string,
): Promise<string | undefined> {
  const blockReason = checkSandboxUrl(policy, url)
  if (blockReason || !policy?.enabled) return blockReason

  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return `Invalid URL: ${url}`
  }

  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(normalized)) return undefined

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(normalized, { all: true, verbatim: true })
  } catch (err: any) {
    return `Network blocked by sandbox DNS resolution failure for ${host}: ${err.message}`
  }

  if (!policy.network.allowLocalBinding) {
    const localAddress = addresses.find(record => isLocalNetworkHost(record.address))
    if (localAddress) {
      return `Network blocked by sandbox.network.allowLocalBinding: ${host} resolved to ${localAddress.address}`
    }
  }

  return undefined
}

export function requireSandboxContext(
  policy: SandboxRuntimePolicy | undefined,
  toolName: string,
): string | undefined {
  if (policy) return undefined
  return `Tool "${toolName}" requires an explicit sandbox context. Pass sandbox.enabled=false only when the host provides its own boundary.`
}

export function claimDirectToolCallBudget(
  budget: ToolCallBudget | undefined,
  toolName: string,
): string | undefined {
  if (!budget) {
    return `Tool "${toolName}" requires an explicit toolCallBudget for direct execution.`
  }

  budget.toolCallCount++
  const maxToolCalls = budget.maxToolCalls
  if (maxToolCalls === undefined || budget.toolCallCount <= maxToolCalls) {
    return undefined
  }

  budget.exceeded = true
  budget.blockedToolCallCount++
  return `Error: maxToolCalls exceeded (${maxToolCalls} allowed; ${budget.toolCallCount} requested). Tool "${toolName}" was not executed.`
}

function matchesAnyPath(
  absolutePath: string,
  patterns: string[] | undefined,
  cwd: string,
): boolean {
  return (patterns ?? []).some(pattern => pathMatchesPattern(absolutePath, pattern, cwd))
}

function pathMatchesPattern(absolutePath: string, pattern: string, cwd: string): boolean {
  const expanded = expandPath(pattern, cwd)
  if (hasGlob(expanded)) {
    return globToRegExp(expanded).test(normalizePath(absolutePath))
  }

  const base = resolveEffectivePath(resolve(cwd, expanded))
  const rel = relative(base, absolutePath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function resolveEffectivePath(absolutePath: string): string {
  const symlinkResolved = resolveSymlinks(resolve(absolutePath))
  const existingPath = findNearestExistingPath(symlinkResolved)
  if (!existingPath) return symlinkResolved

  const realExistingPath = realpathSync(existingPath)
  const suffix = relative(existingPath, symlinkResolved)
  return suffix ? resolve(realExistingPath, suffix) : realExistingPath
}

function resolveSymlinks(absolutePath: string, seen = new Set<string>()): string {
  const normalized = resolve(absolutePath)
  const parsed = parse(normalized)
  const parts = normalized
    .slice(parsed.root.length)
    .split(sep)
    .filter(Boolean)

  let current = parsed.root
  for (let i = 0; i < parts.length; i++) {
    const candidate = resolve(current, parts[i])
    let stat
    try {
      stat = lstatSync(candidate)
    } catch {
      return resolve(candidate, ...parts.slice(i + 1))
    }

    if (!stat.isSymbolicLink()) {
      current = candidate
      continue
    }

    if (seen.has(candidate)) {
      return resolve(candidate, ...parts.slice(i + 1))
    }
    seen.add(candidate)

    const target = readlinkSync(candidate)
    const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(candidate), target)
    return resolveSymlinks(resolve(resolvedTarget, ...parts.slice(i + 1)), seen)
  }

  return current
}

function findNearestExistingPath(absolutePath: string): string | undefined {
  let current = absolutePath
  while (true) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function expandPath(pattern: string, cwd: string): string {
  if (pattern === '~') return homedir()
  if (pattern.startsWith(`~${sep}`) || pattern.startsWith('~/')) {
    return resolve(homedir(), pattern.slice(2))
  }
  return isAbsolute(pattern) ? pattern : resolve(cwd, pattern)
}

function hasGlob(pattern: string): boolean {
  return /[*?[\]]/.test(pattern)
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern)
  let source = ''
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    const next = normalized[i + 1]
    if (char === '*' && next === '*') {
      source += '.*'
      i++
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegExp(char ?? '')
    }
  }
  return new RegExp(`^${source}$`)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hostMatches(pattern: string, host: string): boolean {
  const normalized = pattern.toLowerCase()
  if (normalized === host) return true
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(1)
    return host.endsWith(suffix)
  }
  return host.endsWith(`.${normalized}`)
}

function isLocalNetworkHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::1') return true

  const mappedIpv4 = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedIpv4) {
    return isLocalIpv4(mappedIpv4[1])
  }
  const mappedIpv4Hex = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]+):([0-9a-f]+)$/i)
  if (mappedIpv4Hex) {
    const high = parseInt(mappedIpv4Hex[1], 16)
    const low = parseInt(mappedIpv4Hex[2], 16)
    if (high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff) {
      return isLocalIpv4([
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff,
      ].join('.'))
    }
  }

  if (isIP(normalized) === 4) return isLocalIpv4(normalized)

  if (isIP(normalized) === 6) {
    const firstSegment = parseInt(normalized.split(':')[0] || '0', 16)
    // fc00::/7 unique local addresses and fe80::/10 link-local addresses.
    return (firstSegment & 0xfe00) === 0xfc00 ||
      (firstSegment & 0xffc0) === 0xfe80
  }

  return false
}

function isLocalIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}
