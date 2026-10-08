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
 * A wildcard rule never spans a command boundary ("npm test && rm -rf ~"): see
 * ruleAllows(). A compound command is instead split into its parts, and runs
 * only when every part is allowed on its own — by a rule, or because it only
 * reads inside the project (see commandAllowed()). "Always" persists one rule
 * per part, so approving `cd x && npm test | tail` remembers `npm test *`, not
 * the whole line.
 *
 * On top of the rules sits the permission MODE (shift+tab in the UI), which can
 * widen or narrow the whole gate: `plan` makes the session read-only, `default`
 * consults the rules, `acceptEdits` stops asking about file writes, and `bypass`
 * stops asking about anything.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'
import { homedir } from 'os'
import { settingsAllowRules, settingsDenyRules } from '../settings.js'
import { isProjectTrusted, trustProject } from '../trust.js'

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

/**
 * "Always" answers given in a folder that is not trusted, keyed by cwd. They
 * cannot go in the project file — an untrusted project file is never read, so
 * the approval would vanish — and they must not go user-wide either.
 */
const sessionRules = new Map<string, Rule[]>()

/**
 * Rules stored in one scope. The project file is checked in like settings.json,
 * so it only counts once the folder is trusted (see trust.ts).
 */
export function loadScopedRules(scope: RuleScope): Rule[] {
  if (scope === 'project' && !isProjectTrusted()) return sessionRules.get(process.cwd()) ?? []
  return readRulesFile(rulesPath(scope))
}

/**
 * Every rule in force here: the project's own, then the user-wide ones, then
 * whatever `permissions.allow` in the settings files declares. Order is
 * presentation-only — a call is allowed if any rule matches.
 *
 * Settings rules are read-only from the store's point of view: "always" never
 * writes into settings.json, because that file is checked in and an approval is
 * a record of what *you* agreed to on *this* machine.
 */
export function loadRules(): Rule[] {
  return [...loadScopedRules('project'), ...loadScopedRules('user'), ...settingsAllowRules()]
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
  if (!changed) return
  if (scope === 'project' && !isProjectTrusted()) {
    sessionRules.set(process.cwd(), rules)
    return
  }
  saveRules(scope, rules)
  // Our own write changes the hash trust is pinned to; re-pin it, or the next
  // start would ask whether to trust the rule you just approved.
  if (scope === 'project') trustProject()
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
 * Split a shell command into the commands it chains — on unquoted `&&`, `||`,
 * `;`, `|`, `&` and newlines — so each can be judged on its own.
 *
 * Returns null when the line does something a per-part check can't see:
 * command substitution (`$(…)`, backticks) or a redirect that reads or writes
 * a file. The harmless redirects (`2>&1`, `>/dev/null`, `2>/dev/null`,
 * `&>/dev/null`) are dropped instead, since they're on half the commands a
 * model writes.
 */
export function splitCommand(command: string): string[] | null {
  const parts: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  const push = () => {
    if (cur.trim()) parts.push(cur.trim())
    cur = ''
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\\' && quote !== "'") {
      cur += ch + (command[i + 1] ?? '')
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else if (quote === '"' && (ch === '`' || (ch === '$' && command[i + 1] === '('))) return null
      cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) return null
    if (ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      const rest = command.slice(i)
      const safe = /^(?:>&\d|&?>>?\s*\/dev\/null(?![^\s;&|]))/.exec(rest)
      if (!safe) return null
      // The fd number belongs to the redirect: "2>&1", not a "2" argument.
      if (/(?:^|\s)\d$/.test(cur)) cur = cur.slice(0, -1)
      i += safe[0].length - 1
      continue
    }
    if (ch === '<') return null
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      push()
      if ((ch === '|' || ch === '&') && (command[i + 1] === ch || (ch === '|' && command[i + 1] === '&'))) i++
      continue
    }
    cur += ch
  }
  if (quote) return null
  push()
  return parts
}

/** Programs isReadOnlyCommand lists that can still run arbitrary code or print secrets. */
const NOT_AUTO_SAFE = new Set(['node', 'python', 'python3', 'env', 'printenv'])

/** xargs flags that take a separate argument: `-n 1`, `-I {}`. */
const XARGS_ARG_FLAGS = new Set(['-n', '-I', '-L', '-P', '-d', '-s', '-E', '-a'])

function unquote(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, '$2')
}

function inside(dir: string, root: string): boolean {
  const rel = relative(root, dir)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Where a path argument points, resolved from `dir`. `~` is home. */
function resolveArg(arg: string, dir: string): string {
  if (arg === '~' || arg.startsWith('~/')) return join(homedir(), arg.slice(1))
  return resolve(dir, arg)
}

/**
 * Does one part of a command only read, and only inside the project?
 *
 * Built on isReadOnlyCommand, minus the programs that merely *may* be read-only
 * (node, python) or that print the environment. Any argument that looks like a
 * path — absolute, `~`, or with `..` — must resolve inside the project, so
 * `cat ~/.ssh/id_rsa` still asks. `xargs` is as safe as what it runs.
 */
function isAutoSafe(part: string, dir: string, root: string): boolean {
  const tokens = part.trim().split(/\s+/)
  let prog = tokens[0]
  let args = tokens.slice(1)
  if (prog === 'xargs') {
    let i = 1
    while (i < tokens.length && tokens[i].startsWith('-')) i += XARGS_ARG_FLAGS.has(tokens[i]) ? 2 : 1
    if (i >= tokens.length) return false
    prog = tokens[i]
    args = tokens.slice(i + 1)
  }
  if (NOT_AUTO_SAFE.has(prog)) return false
  if (prog === 'sort' && args.some((a) => a === '-o' || a.startsWith('--output'))) return false
  if (!isReadOnlyCommand([prog, ...args].join(' '))) return false
  return args.every((raw) => {
    const a = unquote(raw)
    if (a.startsWith('-')) return true
    if (!(a.startsWith('/') || a.startsWith('~') || a.split('/').includes('..'))) return true
    return inside(resolveArg(a, dir), root)
  })
}

/**
 * Is this run_bash command allowed without asking? True when an exact rule
 * matches the whole line, or when every part of it is either covered by a rule
 * or only reads inside the project. A `cd` that stays inside the project is
 * allowed too, and moves where the parts after it are judged from.
 *
 * `uncovered`, when passed, collects the parts that are not allowed — what the
 * prompt should offer to remember.
 */
export function commandAllowed(
  command: string,
  rules: Rule[],
  root: string = process.cwd(),
  uncovered?: string[],
): boolean {
  if (rules.some((r) => ruleAllows(r, 'run_bash', command))) return true
  const parts = splitCommand(command)
  if (!parts || parts.length === 0) {
    uncovered?.push(command.trim())
    return false
  }
  let dir = root
  let ok = true
  for (const part of parts) {
    const tokens = part.split(/\s+/)
    if (tokens[0] === 'cd' && tokens.length === 2) {
      const target = resolveArg(unquote(tokens[1]), dir)
      if (inside(target, root)) {
        dir = target
        continue
      }
    }
    if (isAutoSafe(part, dir, root)) continue
    if (rules.some((r) => ruleAllows(r, 'run_bash', part))) continue
    ok = false
    if (!uncovered) return false
    uncovered.push(part)
  }
  return ok
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
export function patternsToPersist(toolName: string, subject: string, rules: Rule[] = []): string[] {
  if (toolName !== 'run_bash') return [subject]
  return partsToRemember(subject, rules).flatMap((part) => {
    const glob = generalizeCommand(part)
    return glob === part ? [part] : [part, glob]
  })
}

/**
 * The parts of a command an "always" answer is about: the ones not already
 * allowed. A line that can't be split (it redirects into a file, or runs a
 * substitution) is one part — remembered exact, as before.
 */
function partsToRemember(command: string, rules: Rule[]): string[] {
  const uncovered: string[] = []
  commandAllowed(command, rules, process.cwd(), uncovered)
  return uncovered.length ? uncovered : [command.trim()]
}

/**
 * The widest rule an "always" answer would persist, per part — what the prompt
 * shows as the blast radius of that choice: "npm run *, cargo build *".
 */
export function widestPatterns(toolName: string, subject: string, rules: Rule[] = loadRules()): string[] {
  if (toolName !== 'run_bash') return subject ? [subject] : []
  return partsToRemember(subject, rules).map(generalizeCommand)
}

/** The prompt's wording for those rules, kept short enough for one line. */
export function describePatterns(patterns: string[]): string {
  const short = patterns.map((p) => (p.length > 48 ? p.slice(0, 47) + '…' : p))
  return short.length > 3 ? `${short.slice(0, 3).join(', ')} +${short.length - 3} more` : short.join(', ')
}

/** Single-pattern form, kept for callers that show one rule. */
export function widestPattern(toolName: string, subject: string): string {
  return describePatterns(widestPatterns(toolName, subject, []))
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

/**
 * Does a `permissions.deny` rule in the settings files refuse this call?
 *
 * Exported so the caller can say *why* it was refused: "the user declined" and
 * "your settings forbid this" call for different next moves from the model, and
 * a bare `deny` cannot tell them apart.
 */
export function deniedBySettings(toolName: string, input: unknown): boolean {
  const subject = subjectFor(toolName, input)
  return settingsDenyRules().some((r) => ruleAllows(r, toolName, subject))
}

/**
 * Never prompt for these.
 *
 * The read-only three are obvious. `task` is here for a different reason: it
 * does nothing itself. Every tool the subagent reaches for passes through this
 * same gate with the same context, so a prompt on the delegation is a prompt for
 * a decision that has not been made yet — and then you get asked again for the
 * call that actually does something. In headless it was worse than noise: it
 * refused delegation outright while leaving the subagent's tools ungated anyway.
 */
const ALWAYS_ALLOW = new Set(['read_file', 'grep', 'glob', 'task'])

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
  // Deny is checked before everything, bypass included. A project that writes
  // `"deny": ["run_bash(git push *)"]` means it in the sandbox too — otherwise
  // the rule would be one shift+tab away from doing nothing, which is worse
  // than not having it.
  const subject = subjectFor(toolName, input)
  if (deniedBySettings(toolName, input)) return 'deny'
  if (mode === 'bypass') return 'allow'
  if (ALWAYS_ALLOW.has(toolName)) return 'allow'
  // Edits are already confined to the workspace by the file tools, so
  // auto-accepting them is bounded in a way auto-accepting a command is not.
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return 'allow'

  const rules = loadRules()
  if (toolName === 'run_bash' ? commandAllowed(subject, rules) : rules.some((r) => ruleAllows(r, toolName, subject))) {
    return 'allow'
  }

  const answer = await ctx.ask(toolName, input)
  if (answer === 'no') return 'deny'
  if (answer === 'always') addRules(toolName, patternsToPersist(toolName, subject, rules))
  return 'allow'
}
