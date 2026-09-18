/**
 * Unified settings — one file per scope, merged in a fixed precedence order.
 *
 * Config (`~/.miii/config.json`) stays what it is: which model, which provider,
 * which effort. That is *your* machine's setup and it does not belong in a repo.
 * Settings are the other half — what the project does, and what it is allowed to
 * do here: hooks, MCP servers, standing permission rules, the mode a session
 * starts in. Those are per-project and meant to be checked in, so they live
 * beside the code rather than in your home directory.
 *
 *   ~/.miii/settings.json            user scope   — yours, in every project
 *   <cwd>/.miii/settings.json        project      — checked in, shared
 *   <cwd>/.miii/settings.local.json  local        — yours, this project, gitignored
 *
 * Later files win. The merge is not a blind object spread: a hook list is
 * *appended* to rather than replaced, because a project adding a lint gate must
 * not silently delete the one you keep in your user settings. Same for
 * permission rules, where deny always outranks allow no matter which file it
 * came from.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { PermissionMode } from './permissions/policy.js'

/** Points in a turn a hook can run at. */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SessionStart'

export const HOOK_EVENTS: HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
]

export interface HookCommand {
  /** Only 'command' today. Named so another kind can be added without a migration. */
  type?: 'command'
  /** Shell command. Receives the event as JSON on stdin. */
  command: string
  /** Seconds before the hook is killed. Default 30. */
  timeout?: number
}

export interface HookMatcher {
  /**
   * Regex matched against the tool name (PreToolUse/PostToolUse only). Absent
   * or empty means every tool. Anchored — "edit_file" does not match
   * "edit_file_thing".
   */
  matcher?: string
  hooks: HookCommand[]
}

export interface McpStdioServer {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /**
   * Declares every tool on this server side-effect free. Read-only servers are
   * the only ones offered in plan mode — see toolsForMode(). It is a claim the
   * server's author makes and miii cannot verify, so it is opt-in per server
   * rather than inferred from a tool name.
   */
  readOnly?: boolean
  enabled?: boolean
}

export interface McpHttpServer {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
  readOnly?: boolean
  enabled?: boolean
}

export type McpServer = McpStdioServer | McpHttpServer

export interface PermissionSettings {
  /** Rules that auto-allow, as "tool(pattern)" — e.g. "run_bash(npm test *)". */
  allow?: string[]
  /** Rules that refuse outright, never prompting. Outrank allow. */
  deny?: string[]
  /** Mode a session starts in. shift+tab still moves from there. */
  defaultMode?: PermissionMode
}

export interface Settings {
  /** Environment variables exported into every run_bash call and hook. */
  env?: Record<string, string>
  hooks?: Partial<Record<HookEvent, HookMatcher[]>>
  mcpServers?: Record<string, McpServer>
  permissions?: PermissionSettings
  /** Start the input bar in vim normal mode. `/vim` toggles it per session. */
  vimMode?: boolean
  /** Snapshot files before each turn so /rewind can restore them. Default true. */
  checkpoints?: boolean
}

export type SettingsScope = 'user' | 'project' | 'local'

/** Lowest precedence first — the order they are merged in. */
export const SETTINGS_SCOPES: SettingsScope[] = ['user', 'project', 'local']

export function settingsPath(scope: SettingsScope, cwd: string = process.cwd()): string {
  if (scope === 'user') return join(homedir(), '.miii', 'settings.json')
  if (scope === 'project') return join(cwd, '.miii', 'settings.json')
  return join(cwd, '.miii', 'settings.local.json')
}

/** A settings file that exists but does not parse. Surfaced, never guessed at. */
export interface SettingsProblem {
  path: string
  message: string
}

const problems: SettingsProblem[] = []

/** Parse problems seen during the last load. Read after loadSettings(). */
export function settingsProblems(): SettingsProblem[] {
  return [...problems]
}

function readOne(path: string): Settings | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push({ path, message: 'expected a JSON object' })
      return null
    }
    return parsed as Settings
  } catch (err) {
    problems.push({ path, message: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Fold `next` over `base`. Additive where replacing would lose someone else's
 * configuration — hooks, permission rules — and last-wins for everything a
 * single value can only have one of.
 */
export function mergeSettings(base: Settings, next: Settings): Settings {
  const hooks: Partial<Record<HookEvent, HookMatcher[]>> = { ...base.hooks }
  for (const event of HOOK_EVENTS) {
    const added = next.hooks?.[event]
    if (!added?.length) continue
    hooks[event] = [...(hooks[event] ?? []), ...added]
  }
  return {
    ...base,
    ...next,
    env: { ...base.env, ...next.env },
    mcpServers: { ...base.mcpServers, ...next.mcpServers },
    hooks,
    permissions: {
      allow: [...(base.permissions?.allow ?? []), ...(next.permissions?.allow ?? [])],
      deny: [...(base.permissions?.deny ?? []), ...(next.permissions?.deny ?? [])],
      defaultMode: next.permissions?.defaultMode ?? base.permissions?.defaultMode,
    },
  }
}

/**
 * Cached because the permission gate consults settings on every tool call and
 * the palette on every keystroke. Dropped by invalidateSettings(), which the
 * places that can change a settings file call.
 */
let cache: { cwd: string; value: Settings } | null = null

export function loadSettings(cwd: string = process.cwd()): Settings {
  if (cache && cache.cwd === cwd) return cache.value
  problems.length = 0
  let merged: Settings = {}
  for (const scope of SETTINGS_SCOPES) {
    const one = readOne(settingsPath(scope, cwd))
    if (one) merged = mergeSettings(merged, one)
  }
  cache = { cwd, value: merged }
  return merged
}

export function invalidateSettings(): void {
  cache = null
}

/** Which scopes actually have a file on disk — for `/permissions` and `/context`. */
export function settingsSources(cwd: string = process.cwd()): Array<{ scope: SettingsScope; path: string }> {
  return SETTINGS_SCOPES.map((scope) => ({ scope, path: settingsPath(scope, cwd) })).filter((s) =>
    existsSync(s.path),
  )
}

/**
 * Parse a `Tool(pattern)` rule string. A bare tool name means "any arguments",
 * which is what `mcp__github__*`-style entries want — those tools have no single
 * subject worth globbing.
 */
export function parseRuleSpec(spec: string): { tool: string; pattern: string } | null {
  const trimmed = spec.trim()
  if (!trimmed) return null
  const m = /^([A-Za-z0-9_*?-]+)\s*\((.*)\)$/s.exec(trimmed)
  if (m) return { tool: m[1], pattern: m[2].trim() || '*' }
  if (/^[A-Za-z0-9_*?-]+$/.test(trimmed)) return { tool: trimmed, pattern: '*' }
  return null
}

function parseSpecs(specs: string[] | undefined): Array<{ tool: string; pattern: string }> {
  const out: Array<{ tool: string; pattern: string }> = []
  for (const spec of specs ?? []) {
    const rule = parseRuleSpec(spec)
    if (rule) out.push(rule)
  }
  return out
}

/** Standing allow rules from settings, in the same shape as saved rules. */
export function settingsAllowRules(cwd?: string): Array<{ tool: string; pattern: string }> {
  return parseSpecs(loadSettings(cwd).permissions?.allow)
}

/** Standing deny rules. These refuse without prompting — see check(). */
export function settingsDenyRules(cwd?: string): Array<{ tool: string; pattern: string }> {
  return parseSpecs(loadSettings(cwd).permissions?.deny)
}

/** The mode a fresh session starts in, if the project pins one. */
export function defaultPermissionMode(cwd?: string): PermissionMode | undefined {
  return loadSettings(cwd).permissions?.defaultMode
}

/** Extra environment for run_bash and hooks. Never overrides the real env. */
export function settingsEnv(cwd?: string): Record<string, string> {
  return loadSettings(cwd).env ?? {}
}
