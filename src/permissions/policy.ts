/**
 * Permission policy: a persistent rule store plus the mode that decides how
 * much gets asked at all.
 *
 * Rules live in two files, both `{ rules: [{ tool, pattern }] }`:
 *   <cwd>/.miii/permissions.json   project scope — where "always" writes
 *   ~/.miii/permissions.json       user scope — applies in every project
 * Both are read on every call; the project file is written by default because a
 * rule's subject is usually project-relative. A path pattern like "src/index.ts"
 * saved globally would auto-allow that path in *every* repo you ever open, which
 * is not what anyone means by "don't ask again".
 *
 * `pattern` is a glob matched against a per-tool "subject" string:
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
 *
 * On top of the rules sits the permission MODE (shift+tab in the UI), which can
 * widen or narrow the whole gate: `plan` makes the session read-only, `default`
 * consults the rules, `acceptEdits` stops asking about file writes, and `bypass`
 * stops asking about anything.
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
  /**
   * The mode in force for this call. Passed per-call rather than stored,
   * because approving a plan changes it mid-run: the loop rebuilds the context
   * each time so a call is never judged against a stale mode.
   */
  mode?: PermissionMode
}

/**
 * How much the harness asks before acting.
 *
 * - `default`    — stored rules auto-allow; anything else prompts.
 * - `plan`       — read-only. Nothing may be written or run outside the
 *                  read-only command set; the agent researches and proposes a
 *                  plan via exit_plan_mode, which the user approves to leave.
 * - `acceptEdits`— file writes inside the workspace stop prompting; commands
 *                  still do, because a command can reach outside it.
 * - `bypass`     — nothing prompts. For a sandbox or a throwaway tree.
 */
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypass'

/** Cycle order for shift+tab. `default` is first so the cycle returns to it. */
export const PERMISSION_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypass']

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'normal',
  plan: 'plan mode',
  acceptEdits: 'auto-accept edits',
  bypass: 'bypass permissions',
}

/** One-line explanation shown when the mode changes. */
export const MODE_HINT: Record<PermissionMode, string> = {
  default: 'asks before writing files or running commands',
  plan: 'read-only — researches and proposes a plan for you to approve',
  acceptEdits: 'writes files without asking · commands still prompt',
  bypass: 'runs everything without asking — be sure about this tree',
}

export function nextMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.indexOf(mode)
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]
}

/** Where an "always" answer is persisted. */
export type RuleScope = 'project' | 'user'

const USER_RULES_DIR = join(homedir(), '.miii')

/**
 * Resolved lazily rather than at module load: the project scope follows the
 * working directory, and reading it once at import would pin it to whatever
 * directory the process happened to start in.
 */
function rulesDir(scope: RuleScope): string {
  return scope === 'user' ? USER_RULES_DIR : join(process.cwd(), '.miii')
}

function rulesPath(scope: RuleScope): string {
  return join(rulesDir(scope), 'permissions.json')
}

function readRulesFile(path: string): Rule[] {
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { rules?: Rule[] }
    return Array.isArray(data.rules) ? data.rules.filter((r) => r && r.tool && r.pattern) : []
  } catch {
    return []
  }
}

/** Rules stored in one scope. */
export function loadScopedRules(scope: RuleScope): Rule[] {
  return readRulesFile(rulesPath(scope))
}

/**
 * Every rule in force here: the project's own, then the user-wide ones. Order
 * is presentation-only — a call is allowed if any rule matches.
 */
export function loadRules(): Rule[] {
  return [...loadScopedRules('project'), ...loadScopedRules('user')]
}

function saveRules(scope: RuleScope, rules: Rule[]): void {
  const dir = rulesDir(scope)
  mkdirSync(dir, { recursive: true })
  // Write to a temp file then rename — atomic swap so a crash mid-write can't
  // corrupt the rule file.
  const path = rulesPath(scope)
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify({ rules }, null, 2), 'utf-8')
  renameSync(tmp, path)
}

export function addRule(tool: string, pattern: string, scope: RuleScope = 'project'): void {
  addRules(tool, [pattern], scope)
}

/**
 * Persist several patterns for one tool in a single load/save cycle.
 *
 * Deduplication is against the target scope only. A pattern already granted
 * user-wide is not re-written into the project file, so the check below also
 * consults the merged view.
 */
export function addRules(tool: string, patterns: string[], scope: RuleScope = 'project'): void {
  const existing = loadRules()
  const rules = loadScopedRules(scope)
  let changed = false
  for (const pattern of patterns) {
    if (existing.some((r) => r.tool === tool && r.pattern === pattern)) continue
    if (rules.some((r) => r.tool === tool && r.pattern === pattern)) continue
    rules.push({ tool, pattern })
    changed = true
  }
  if (changed) saveRules(scope, rules)
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

/** Tools that write to the workspace — what `acceptEdits` stops asking about. */
export const EDIT_TOOLS = new Set(['write_file', 'edit_file'])

/**
 * Programs that only report. The list is deliberately short and boring: it is
 * the set of things plan mode will even offer to run, so anything whose
 * read-only-ness depends on an argument (`sed -i`, `find -delete`) stays off it.
 */
const READ_ONLY_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'pwd', 'which', 'whoami', 'date', 'env', 'printenv', 'echo',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'tree', 'diff', 'cmp',
  'find', 'sort', 'uniq', 'cut', 'tr', 'nl',
  'node', 'python', 'python3', 'jq', 'basename', 'dirname', 'realpath',
])

/**
 * git subcommands that only report. `log`/`diff`/`show` are the ones that make
 * planning useful — what changed recently is most of the answer to "why is this
 * like this".
 */
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'ls-files',
  'blame', 'describe', 'rev-parse', 'tag', 'shortlog',
])

/**
 * Flags that turn a listed program into a writing one. `find` is the reason
 * this exists: it only reports until you hand it -delete or -exec.
 *
 * Deliberately no bare `-i`. It means "in place" to sed and perl, which are not
 * on the list above and never will be — but it means "ignore case" to grep,
 * which is on it, and blocking `grep -i` would make plan mode useless for the
 * searching it is mostly for.
 */
const WRITING_FLAGS = [
  /(?:^|\s)--in-place\b/,
  /(?:^|\s)--write\b/,
  /(?:^|\s)-delete\b/,
  /(?:^|\s)-exec\b/,
  /(?:^|\s)-execdir\b/,
  /(?:^|\s)-fprint\b/,
]

/**
 * Is this shell command safe to run while planning — does it only report?
 *
 * A compound command is never read-only however innocent its first token, since
 * `ls && rm -rf x` starts with `ls`. That is the same command-boundary rule that
 * stops a wildcard permission rule spanning a `&&` (see ruleAllows), and it
 * rules out redirections too, which write by definition.
 *
 * `node` and `python` are listed because a plan often needs a version or a `-e`
 * one-liner, and they can obviously write if told to. Which is why plan mode
 * still sends them through the normal prompt rather than auto-allowing them:
 * read-only here means "may be offered", never "is safe".
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (hasUnquotedShellOperator(trimmed)) return false
  if (WRITING_FLAGS.some((re) => re.test(trimmed))) return false
  const tokens = trimmed.split(/\s+/)
  const prog = tokens[0]
  if (prog === 'git') return tokens.length > 1 && READ_ONLY_GIT.has(tokens[1])
  return READ_ONLY_PROGRAMS.has(prog)
}

/**
 * The gate every tool call passes through.
 *
 * Plan mode is NOT enforced here — the agent loop blocks mutating tools before
 * this point, with a message steering the model back to proposing a plan. By
 * the time a call reaches `check` in plan mode it is already something plan
 * mode permits, and it still has to be approved like anything else.
 */
export async function check(
  toolName: string,
  input: unknown,
  ctx: PermissionContext,
): Promise<Decision> {
  const mode = ctx.mode ?? 'default'
  if (mode === 'bypass') return 'allow'
  if (ALWAYS_ALLOW.has(toolName)) return 'allow'
  // Edits are already confined to the workspace by the file tools, so
  // auto-accepting them is bounded in a way auto-accepting a command is not.
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return 'allow'

  const subject = subjectFor(toolName, input)
  const rules = loadRules()
  if (rules.some((r) => ruleAllows(r, toolName, subject))) return 'allow'

  const answer = await ctx.ask(toolName, input)
  if (answer === 'no') return 'deny'
  if (answer === 'always') addRules(toolName, patternsToPersist(toolName, subject))
  return 'allow'
}
