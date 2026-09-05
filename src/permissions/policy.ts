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
 * prompting. Otherwise we ask the user. If they answer 'always' we persist both
 * the exact subject and a generalized glob, so neither the same call nor a close
 * variant is asked again. This makes the "persists as a Tool(pattern) rule"
 * promise in the system prompt true. Globs (e.g. "npm test *") can also be added
 * by hand-editing the JSON file.
 *
 * A wildcard rule never authorizes a compound command ("npm test && rm -rf ~"):
 * see ruleAllows(). That holds for hand-edited globs too.
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
  addRules(tool, [pattern])
}

/** Persist several patterns for one tool in a single load/save cycle. */
export function addRules(tool: string, patterns: string[]): void {
  const rules = loadRules()
  let changed = false
  for (const pattern of patterns) {
    if (rules.some((r) => r.tool === tool && r.pattern === pattern)) continue
    rules.push({ tool, pattern })
    changed = true
  }
  if (changed) saveRules(rules)
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
 * Does `command` contain a shell control operator OUTSIDE quotes — something
 * that chains another command (`;` `&` `&&` `||` `|`, a newline), substitutes
 * one (`` ` `` , `$(`), or redirects a stream (`>` `<`)?
 *
 * Quoting is respected so the everyday false positives don't fire: the `&&` in
 * `git commit -m "fix a && b"` and the `|` in `grep "a|b" file` are literal
 * text, not operators. Inside double quotes only command substitution still
 * counts, since the shell keeps expanding it there.
 *
 * Used to keep a wildcard rule from spanning a command boundary — see ruleAllows().
 */
export function hasUnquotedShellOperator(command: string): boolean {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    // A backslash escapes the next char everywhere except inside single quotes.
    if (ch === '\\' && quote !== "'") {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      // Single quotes are fully literal; double quotes still expand $() and ``.
      else if (quote === '"' && (ch === '`' || (ch === '$' && command[i + 1] === '('))) return true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '>' || ch === '<' || ch === '`') return true
    if (ch === '$' && command[i + 1] === '(') return true
  }
  return false
}

/**
 * Turn a concrete command into a generalized glob to persist on "always".
 * "npm run build" → "npm run *", "npx tsc --noEmit" → "npx tsc *",
 * "git commit -m '...'" → "git commit *". Destructive commands (rm, dd, sudo,
 * "git reset", …) are NOT generalized — the exact command is persisted so a
 * single approval can't blanket-authorize a whole dangerous program.
 *
 * A compound command (`a && b`, `a | b`) is never generalized either: its first
 * token says nothing about what the rest of the line does, so widening it would
 * hand out a rule far broader than what the user actually read and approved.
 */
export function generalizeCommand(command: string): string {
  const trimmed = command.trim()
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0 || tokens[0] === '') return command
  const prog = tokens[0]
  if (NEVER_GENERALIZE.has(prog)) return trimmed
  if (hasUnquotedShellOperator(trimmed)) return trimmed
  if (prog === 'git' && tokens.length > 1 && DESTRUCTIVE_GIT_SUBCOMMANDS.has(tokens[1])) {
    return trimmed
  }
  const prefixLen = WRAPPER_PROGRAMS.has(prog) && tokens.length > 1 ? 2 : 1
  const prefix = tokens.slice(0, prefixLen).join(' ')
  return `${prefix} *`
}

/**
 * The rules to persist when the user answers "always" for a tool call.
 *
 * For run_bash this is BOTH the exact command and its generalized glob. The
 * glob alone is not enough: "npm test" generalizes to "npm test *", which needs
 * a space and at least one more character, so the very command the user just
 * approved would keep re-prompting forever. Destructive commands generalize to
 * themselves, so the list collapses to the single exact rule.
 */
export function patternsToPersist(toolName: string, subject: string): string[] {
  if (toolName !== 'run_bash') return [subject]
  const exact = subject.trim()
  const glob = generalizeCommand(subject)
  return glob === exact ? [exact] : [exact, glob]
}

/**
 * The widest rule an "always" answer would persist — what the prompt shows the
 * user as the blast radius of that choice.
 */
export function widestPattern(toolName: string, subject: string): string {
  const patterns = patternsToPersist(toolName, subject)
  return patterns[patterns.length - 1] ?? ''
}

/** Convert a glob (only `*` and `?` special) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${pattern}$`)
}

/**
 * A wildcard rule must never span a command boundary. `*` compiles to `.*`,
 * which happily swallows "&& rm -rf ~" — so an approval of "npm test" would
 * silently auto-allow "npm test && rm -rf ~". Refuse to satisfy a wildcard rule
 * from a compound command; the user gets prompted for the real thing instead.
 *
 * Exact (wildcard-free) rules are unaffected, so a user who deliberately
 * approved a specific pipeline still has it auto-allowed on the next identical
 * call. Only run_bash subjects are commands — path subjects match literally.
 */
function outOfWildcardScope(rule: Rule, toolName: string, subject: string): boolean {
  if (toolName !== 'run_bash') return false
  if (!rule.pattern.includes('*') && !rule.pattern.includes('?')) return false
  return hasUnquotedShellOperator(subject)
}

/** Does this stored rule authorize this call? The whole auto-allow decision. */
export function ruleAllows(rule: Rule, toolName: string, subject: string): boolean {
  if (rule.tool !== toolName) return false
  if (outOfWildcardScope(rule, toolName, subject)) return false
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
  if (rules.some((r) => ruleAllows(r, toolName, subject))) return 'allow'

  const answer = await ctx.ask(toolName, input)
  if (answer === 'no') return 'deny'
  if (answer === 'always') addRules(toolName, patternsToPersist(toolName, subject))
  return 'allow'
}
