/**
 * Permission policy with a persistent rule store.
 *
 * Rules live in ~/.miii/permissions.json as { tool, pattern } pairs. `pattern`
 * is a glob matched against a per-tool "subject" string:
 *   run_bash                 → the command
 *   read/write/edit_file     → the path
 *   grep/glob                → the search root path
 *
 * On a tool call we first consult stored rules; a match auto-allows without
 * prompting. Otherwise we ask the user. If they answer 'always' we persist a
 * rule for the exact subject so the same call is never asked again. This makes
 * the "persists as a Tool(pattern) rule" promise in the system prompt true.
 * Globs (e.g. "npm test *") can also be added by hand-editing the JSON file.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type Decision = 'allow' | 'deny'
export type AskAnswer = 'yes' | 'no' | 'always'

export interface Rule {
  tool: string
  pattern: string
}

export type AskFn = (toolName: string, input: unknown) => Promise<AskAnswer>

export interface PermissionContext {
  ask: AskFn
}

const RULES_DIR = join(homedir(), '.miii')
const RULES_PATH = join(RULES_DIR, 'permissions.json')

export function loadRules(): Rule[] {
  if (!existsSync(RULES_PATH)) return []
  try {
    const data = JSON.parse(readFileSync(RULES_PATH, 'utf-8')) as { rules?: Rule[] }
    return Array.isArray(data.rules) ? data.rules : []
  } catch {
    return []
  }
}

function saveRules(rules: Rule[]): void {
  mkdirSync(RULES_DIR, { recursive: true })
  // Write to a temp file then rename — atomic swap so a crash mid-write can't
  // corrupt the rule file.
  const tmp = RULES_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify({ rules }, null, 2), 'utf-8')
  renameSync(tmp, RULES_PATH)
}

export function addRule(tool: string, pattern: string): void {
  const rules = loadRules()
  if (rules.some((r) => r.tool === tool && r.pattern === pattern)) return
  rules.push({ tool, pattern })
  saveRules(rules)
}

/** Extract the string a rule pattern matches against for a given tool call. */
export function subjectFor(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'run_bash') return typeof obj.command === 'string' ? obj.command : ''
  if (typeof obj.path === 'string') return obj.path
  return ''
}

/**
 * Wrapper programs that dispatch to a subcommand. For these we keep the first
 * two tokens (e.g. "npm run", "npx tsc") so the persisted rule scopes to that
 * subcommand rather than the whole program. `git` is included so an approval of
 * "git commit" does not widen into "git *" — which would silently auto-allow
 * "git reset --hard" / "git clean -fd" on later turns.
 */
const WRAPPER_PROGRAMS = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'brew',
  'pip',
  'pip3',
  'cargo',
  'docker',
  'kubectl',
  'go',
  'git',
])

/**
 * Programs destructive enough that one "always" must never become a wildcard —
 * we persist the exact command instead, so only that literal invocation is
 * auto-allowed and anything else re-prompts.
 */
const NEVER_GENERALIZE = new Set([
  'rm',
  'rmdir',
  'dd',
  'mkfs',
  'shred',
  'truncate',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'kill',
  'killall',
  'pkill',
  'chmod',
  'chown',
  'mv',
  'sudo',
  'doas',
])

/**
 * git subcommands that irreversibly discard work or rewrite history. Approving
 * one of these must not widen to "git <sub> *" (e.g. "git push" → "git push
 * --force"): persist the exact command so only that invocation is auto-allowed.
 * Deliberately narrow — checkout/restore/branch are everyday operations and stay
 * on the normal "git <sub> *" scoping so they don't nag on every variant.
 */
const DESTRUCTIVE_GIT_SUBCOMMANDS = new Set([
  'reset',
  'clean',
  'push',
  'rebase',
  'filter-branch',
])

/**
 * Turn a concrete command into a generalized glob to persist on "always".
 * "npm run build" → "npm run *", "npx tsc --noEmit" → "npx tsc *",
 * "git commit -m '...'" → "git commit *". Destructive commands (rm, dd, sudo,
 * "git reset", …) are NOT generalized — the exact command is persisted so a
 * single approval can't blanket-authorize a whole dangerous program.
 */
export function generalizeCommand(command: string): string {
  const trimmed = command.trim()
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0 || tokens[0] === '') return command
  const prog = tokens[0]
  if (NEVER_GENERALIZE.has(prog)) return trimmed
  if (prog === 'git' && tokens.length > 1 && DESTRUCTIVE_GIT_SUBCOMMANDS.has(tokens[1])) {
    return trimmed
  }
  const prefixLen = WRAPPER_PROGRAMS.has(prog) && tokens.length > 1 ? 2 : 1
  const prefix = tokens.slice(0, prefixLen).join(' ')
  return `${prefix} *`
}

/** The pattern to persist when the user answers "always" for a tool call. */
export function patternToPersist(toolName: string, subject: string): string {
  return toolName === 'run_bash' ? generalizeCommand(subject) : subject
}

/** Convert a glob (only `*` and `?` special) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${pattern}$`)
}

function matches(rule: Rule, toolName: string, subject: string): boolean {
  if (rule.tool !== toolName) return false
  try {
    return globToRegExp(rule.pattern).test(subject)
  } catch {
    return false
  }
}

/** Read-only tools are always allowed — never prompt for these. */
const ALWAYS_ALLOW = new Set(['read_file', 'grep', 'glob'])

export async function check(
  toolName: string,
  input: unknown,
  ctx: PermissionContext,
): Promise<Decision> {
  if (ALWAYS_ALLOW.has(toolName)) return 'allow'

  const subject = subjectFor(toolName, input)
  const rules = loadRules()
  if (rules.some((r) => matches(r, toolName, subject))) return 'allow'

  const answer = await ctx.ask(toolName, input)
  if (answer === 'no') return 'deny'
  if (answer === 'always') addRule(toolName, patternToPersist(toolName, subject))
  return 'allow'
}
