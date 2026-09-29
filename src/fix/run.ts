/**
 * `miii fix` — run a check, fix what it reports, run it again, until it passes.
 *
 *   miii fix                                  # infer the check (npm test, cargo test, …)
 *   miii fix --check "npx tsc --noEmit"
 *   miii fix --check "pytest -q" --max-rounds 8 --output-format json
 *
 * The shape is chosen for small models. The model never decides whether it
 * succeeded — the check's exit code does. Each round starts from a fresh, short
 * conversation holding only the trimmed failure and notes on attempts that
 * didn't work, because a small model does far better with one sharp problem
 * than with a long transcript of its own wrong turns. A round that leaves the
 * check no better off is rolled back, so the tree only ever moves toward green,
 * and a run that keeps hitting the same wall stops instead of burning tokens.
 */
import { execa } from 'execa'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { runAgent } from '../agent/loop.js'
import { HookBus } from '../hooks/bus.js'
import { initMcp, closeMcp } from '../mcp/registry.js'
import { loadConfig } from '../config.js'
import { modelContext } from '../llm/client.js'
import { loadSettings, settingsEnv, settingsProblems } from '../settings.js'
import { PERMISSION_MODES, type PermissionMode } from '../permissions/policy.js'
import { newSessionId, persistSession } from '../session/store.js'
import type { AgentEvent, MiiMessage } from '../agent/types.js'
import { digest, improved, type CheckResult, type Digest } from './digest.js'
import { RoundSnapshot, fingerprint, fingerprintDiff } from './snapshot.js'

export interface FixOptions {
  check: string
  cwd: string
  outputFormat: 'text' | 'json'
  maxRounds: number
  /** Tool-use turns per round. */
  maxTurns: number
  /** Consecutive rounds without progress before giving up. */
  maxStalls: number
  /** Seconds the check may run before it is killed. */
  checkTimeout: number
  mode: PermissionMode
  model?: string
  /** Extra direction from the user, appended to every round's prompt. */
  instruction?: string
}

export interface FixParse {
  options: FixOptions | null
  error?: string
}

const DEFAULTS = { maxRounds: 5, maxTurns: 20, maxStalls: 3, checkTimeout: 600 }

/** The test command a project most plausibly means, from the files it has. */
export function detectCheck(cwd: string): string | null {
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> }
      const test = pkg.scripts?.test
      // npm init's placeholder always fails — running it would "fix" nothing.
      if (test && !/no test specified/.test(test)) return 'npm test'
    } catch { /* malformed package.json — try the others */ }
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo test'
  if (existsSync(join(cwd, 'go.mod'))) return 'go test ./...'
  if (['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].some((f) => existsSync(join(cwd, f)))) {
    return 'python -m pytest -q'
  }
  return null
}

/** argv after the `fix` word. */
export function parseFixArgs(argv: string[], cwd = process.cwd()): FixParse {
  let check: string | undefined
  let outputFormat: 'text' | 'json' = 'text'
  let mode: PermissionMode = 'acceptEdits'
  let model: string | undefined
  const nums = { ...DEFAULTS }
  const words: string[] = []

  const positive = (flag: string, v: string | undefined): number | string => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 1) return `${flag} needs a positive number`
    return Math.floor(n)
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--check':
        check = next()
        if (!check) return { options: null, error: '--check needs a command, e.g. --check "npm test"' }
        break
      case '--output-format': {
        const v = next()
        if (v !== 'text' && v !== 'json') return { options: null, error: `unknown --output-format "${v}" — use text or json` }
        outputFormat = v
        break
      }
      case '--permission-mode': {
        const v = next()
        if (!v || !(PERMISSION_MODES as string[]).includes(v)) {
          return { options: null, error: `unknown --permission-mode "${v}" — use ${PERMISSION_MODES.join(', ')}` }
        }
        if (v === 'plan') return { options: null, error: 'fix cannot run in plan mode — it has to edit files' }
        mode = v as PermissionMode
        break
      }
      case '--dangerously-skip-permissions':
        mode = 'bypass'
        break
      case '--model':
        model = next()
        break
      case '--max-rounds':
      case '--max-turns':
      case '--max-stalls':
      case '--check-timeout': {
        const n = positive(arg, next())
        if (typeof n === 'string') return { options: null, error: n }
        const key = ({
          '--max-rounds': 'maxRounds',
          '--max-turns': 'maxTurns',
          '--max-stalls': 'maxStalls',
          '--check-timeout': 'checkTimeout',
        } as const)[arg]
        nums[key] = n
        break
      }
      case '--provider':
      case '-P':
        i++ // already applied by cli.tsx
        break
      default:
        if (arg.startsWith('-')) return { options: null, error: `unknown flag for fix: ${arg}` }
        words.push(arg)
    }
  }

  const resolved = check ?? detectCheck(cwd)
  if (!resolved) {
    return {
      options: null,
      error: 'could not tell how to test this project — pass one, e.g. miii fix --check "npm test"',
    }
  }
  const instruction = words.join(' ').trim()
  return {
    options: {
      check: resolved,
      cwd,
      outputFormat,
      mode,
      ...nums,
      ...(model ? { model } : {}),
      ...(instruction ? { instruction } : {}),
    },
  }
}

/** Output beyond this is cut from the front — runners put the verdict last. */
const MAX_CHECK_OUTPUT = 256 * 1024

export async function runCheck(command: string, cwd: string, timeoutSec: number, signal?: AbortSignal): Promise<CheckResult> {
  const isWin = process.platform === 'win32'
  const started = Date.now()
  const child = execa(isWin ? 'cmd' : 'bash', isWin ? ['/c', command] : ['-c', command], {
    cwd,
    reject: false,
    all: true,
    detached: !isWin,
    // CI=1 turns off watch modes and interactive reporters in most runners —
    // `vitest` without it waits for file changes forever.
    env: { ...process.env, ...settingsEnv(), CI: process.env.CI ?? '1', FORCE_COLOR: '0' },
  })
  let timedOut = false
  const kill = () => {
    try {
      if (isWin) execa('taskkill', ['/pid', String(child.pid), '/T', '/F'], { reject: false })
      else if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch { /* already gone */ }
  }
  const timer = setTimeout(() => { timedOut = true; kill() }, timeoutSec * 1000)
  signal?.addEventListener('abort', kill, { once: true })
  try {
    const { all, exitCode } = await child
    let output = all ?? ''
    if (output.length > MAX_CHECK_OUTPUT) output = '…\n' + output.slice(-MAX_CHECK_OUTPUT)
    return { exitCode: exitCode ?? null, output, timedOut, durationMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', kill)
  }
}

export interface Attempt {
  round: number
  /** Kept moves the tree forward; rolled_back undoes it; no_change never touched a file. */
  outcome: 'kept' | 'rolled_back' | 'no_change' | 'error'
  failuresBefore: number | null
  failuresAfter: number | null
  changed: string[]
  /** Files changed through the shell that could not be put back. */
  unrestorable?: string[]
  summary: string
  error?: string
  sessionId?: string
}

export function buildPrompt(opts: {
  check: string
  failure: string
  notes: string[]
  instruction?: string
  canRunCheck: boolean
}): string {
  const parts = [
    `The check \`${opts.check}\` is failing. Make it pass by fixing the code.`,
    `<failure>\n${opts.failure}\n</failure>`,
  ]
  if (opts.instruction) parts.push(`Direction from the user: ${opts.instruction}`)
  parts.push(
    [
      'Rules:',
      '- Fix the cause in the source code. Do not edit, delete, skip or loosen tests to make them pass.',
      '- Keep the change as small as it can be. Read the file before you edit it.',
      opts.canRunCheck
        ? `- You may run \`${opts.check}\` to check your work. I will run it again afterwards either way.`
        : `- You cannot run commands here. When you stop, I run \`${opts.check}\` myself and tell you what failed.`,
      '- When you are done, say in one or two sentences what you changed and why.',
    ].join('\n'),
  )
  if (opts.notes.length) {
    parts.push(
      'Earlier attempts that did not fix it — they were undone, so the files are back as they were. Try something different:\n' +
        opts.notes.map((n, i) => `${i + 1}. ${n}`).join('\n'),
    )
  }
  return parts.join('\n\n')
}

/** What one round of the agent did. */
export interface AgentRoundResult {
  summary: string
  error?: string
  denied: string[]
  history: MiiMessage[]
}

/**
 * The seams the loop needs, so it can be tested without a model or a shell.
 * `attempt` runs the agent with `onPreTool` registered on its hook bus.
 */
export interface FixDeps {
  runCheck: () => Promise<CheckResult>
  attempt: (prompt: string, onPreTool: RoundSnapshot['onPreTool']) => Promise<AgentRoundResult>
  readFile: (absPath: string) => string | null
  fingerprint: () => Map<string, string> | null
  log: (line: string) => void
  persist?: (history: MiiMessage[], round: number) => string | undefined
  aborted?: () => boolean
}

export interface FixReport {
  passed: boolean
  check: string
  rounds: number
  initialFailures: number | null
  finalFailures: number | null
  stoppedBecause: 'passed' | 'already_passing' | 'max_rounds' | 'stalled' | 'aborted'
  attempts: Attempt[]
  changedFiles: string[]
  lastFailure?: string
  deniedTools: string[]
}

const fmt = (n: number | null) => (n === null ? '?' : String(n))

export async function fixLoop(opts: FixOptions, deps: FixDeps): Promise<FixReport> {
  const readDigest = (r: CheckResult) => digest(r, { cwd: opts.cwd, readFile: deps.readFile })

  deps.log(`running ${opts.check}`)
  let result = await deps.runCheck()
  let current: Digest = readDigest(result)
  const initialFailures = current.failures
  const attempts: Attempt[] = []
  const kept = new Set<string>()
  const denied = new Set<string>()
  const notes: string[] = []
  let stalls = 0

  const report = (stoppedBecause: FixReport['stoppedBecause']): FixReport => ({
    passed: current.passed,
    check: opts.check,
    rounds: attempts.length,
    initialFailures,
    finalFailures: current.failures,
    stoppedBecause,
    attempts,
    changedFiles: [...kept].sort(),
    ...(current.passed ? {} : { lastFailure: current.text }),
    deniedTools: [...denied],
  })

  if (current.passed) {
    deps.log('check already passes — nothing to fix')
    return report('already_passing')
  }
  deps.log(`failing (${fmt(current.failures)} failure${current.failures === 1 ? '' : 's'})`)

  for (let round = 1; round <= opts.maxRounds; round++) {
    if (deps.aborted?.()) return report('aborted')
    deps.log(`round ${round}/${opts.maxRounds}: working on it`)

    const snap = new RoundSnapshot(opts.cwd)
    const fpBefore = deps.fingerprint()
    const prompt = buildPrompt({
      check: opts.check,
      failure: current.text,
      notes,
      ...(opts.instruction ? { instruction: opts.instruction } : {}),
      canRunCheck: true,
    })

    let agent: AgentRoundResult
    try {
      agent = await deps.attempt(prompt, snap.onPreTool)
    } catch (err) {
      agent = { summary: '', error: err instanceof Error ? err.message : String(err), denied: [], history: [] }
    }
    for (const t of agent.denied) denied.add(t)
    const sessionId = deps.persist?.(agent.history, round)
    const other = fingerprintDiff(fpBefore, deps.fingerprint())
    const changed = [...new Set([...snap.changed(), ...other])].sort()
    const summary = agent.summary.trim().split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 400)
    const base = {
      round,
      failuresBefore: current.failures,
      summary,
      ...(sessionId ? { sessionId } : {}),
      ...(agent.error ? { error: agent.error } : {}),
    }

    if (deps.aborted?.()) {
      const rb = snap.rollback(other)
      attempts.push({ ...base, outcome: 'rolled_back', failuresAfter: null, changed, ...unrestorable(rb.unrestorable) })
      deps.log('interrupted — undid this round\'s changes')
      return report('aborted')
    }

    if (!changed.length) {
      attempts.push({ ...base, outcome: agent.error ? 'error' : 'no_change', failuresAfter: current.failures, changed })
      notes.push(`Changed no files${summary ? ` (said: "${summary}")` : ''}. You have to edit the code.`)
      deps.log(`round ${round}: no files changed${agent.error ? ` (${agent.error})` : ''}`)
      if (++stalls >= opts.maxStalls) return report('stalled')
      continue
    }

    const prevLen = result.output.length
    const next = await deps.runCheck()
    const nextDigest = readDigest(next)

    if (improved(current, nextDigest, prevLen, next.output.length)) {
      for (const f of changed) kept.add(f)
      attempts.push({ ...base, outcome: 'kept', failuresAfter: nextDigest.failures, changed })
      deps.log(
        `round ${round}: ${fmt(current.failures)} → ${nextDigest.passed ? '0' : fmt(nextDigest.failures)} failing, kept (${changed.join(', ')})`,
      )
      result = next
      current = nextDigest
      stalls = 0
      // A kept round's notes described a tree that no longer exists.
      notes.length = 0
      if (current.passed) return report('passed')
    } else {
      const rb = snap.rollback(other)
      attempts.push({
        ...base,
        outcome: 'rolled_back',
        failuresAfter: nextDigest.failures,
        changed,
        ...unrestorable(rb.unrestorable),
      })
      const what = summary || `edited ${changed.join(', ')}`
      const after = nextDigest.signature === current.signature ? 'the same failure remained' : `it then failed with: ${nextDigest.signature}`
      notes.push(`${what} — ${after}.`)
      deps.log(
        `round ${round}: ${fmt(current.failures)} → ${fmt(nextDigest.failures)} failing, rolled back` +
          (rb.unrestorable.length ? ` (could not undo: ${rb.unrestorable.join(', ')})` : ''),
      )
      if (++stalls >= opts.maxStalls) return report('stalled')
    }
  }
  return report('max_rounds')
}

function unrestorable(paths: string[]): { unrestorable?: string[] } {
  return paths.length ? { unrestorable: paths } : {}
}

/** Wire the loop to the real agent, shell and disk. Returns the exit code. */
export async function runFix(opts: FixOptions): Promise<number> {
  const cfg = loadConfig()
  const model = opts.model ?? cfg.model
  if (!model) {
    process.stderr.write('miii: no model configured. Run `miii` once to pick one, or pass --model.\n')
    return 2
  }
  loadSettings(opts.cwd)
  for (const problem of settingsProblems()) {
    process.stderr.write(`miii: ignoring ${problem.path} (${problem.message})\n`)
  }

  const controller = new AbortController()
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130)
    process.stderr.write('\nmiii: stopping after undoing the current round… (Ctrl-C again to quit now)\n')
    controller.abort()
  }
  process.on('SIGINT', onSigint)

  const mcp = await initMcp(opts.cwd)
  for (const server of mcp) {
    if (!server.connected) process.stderr.write(`miii: MCP server "${server.name}" unavailable — ${server.error}\n`)
  }
  let num_ctx: number | undefined
  try {
    num_ctx = await modelContext(model)
  } catch { /* unreported window */ }

  const started = Date.now()
  const log = (line: string) => process.stderr.write(`miii fix: ${line}\n`)

  const attempt: FixDeps['attempt'] = async (prompt, onPreTool) => {
    const sessionId = newSessionId()
    const hooks = new HookBus({ id: sessionId, cwd: opts.cwd })
    hooks.onPreTool(onPreTool)
    const denied: string[] = []
    const permissions = {
      // The user already vouched for the check by naming it; anything else
      // needs a mode or a saved rule, same as any headless run.
      ask: async (toolName: string, input: unknown) => {
        if (toolName === 'run_bash' && (input as { command?: unknown })?.command === opts.check) return 'yes' as const
        // A plan list touches nothing on disk.
        if (toolName === 'write_todos') return 'yes' as const
        denied.push(toolName)
        return 'no' as const
      },
    }
    let summary = ''
    let error: string | undefined
    let history: MiiMessage[] = []
    const gen = runAgent({
      model,
      cwd: opts.cwd,
      history: [],
      userText: prompt,
      permissions,
      mode: opts.mode,
      hooks,
      signal: controller.signal,
      maxTurns: opts.maxTurns,
      ...(num_ctx !== undefined ? { num_ctx } : {}),
    })
    for (;;) {
      const step = await gen.next()
      if (step.done) { history = step.value; break }
      const ev: AgentEvent = step.value
      if (ev.type === 'text-delta') summary += ev.text
      else if (ev.type === 'turn-end' && ev.stop_reason === 'tool_use') summary = ''
      else if (ev.type === 'tool-use') logTool(ev.block.name, ev.block.input)
      else if (ev.type === 'error') error = ev.message
      else if (ev.type === 'aborted') error = 'aborted'
    }
    return { summary, denied, history, ...(error ? { error } : {}) }
  }

  // Tool names are a cheap live signal that the round is doing something.
  function logTool(name: string, input: Record<string, unknown>) {
    const arg = input?.path ?? input?.command ?? input?.pattern ?? ''
    log(`  ${name}${arg ? ` ${String(arg).split('\n')[0].slice(0, 80)}` : ''}`)
  }

  let report: FixReport
  try {
    report = await fixLoop(opts, {
      runCheck: () => runCheck(opts.check, opts.cwd, opts.checkTimeout, controller.signal),
      attempt,
      readFile: (p) => { try { return readFileSync(p, 'utf-8') } catch { return null } },
      fingerprint: () => fingerprint(opts.cwd),
      log,
      persist: (history, round) => {
        if (!history.length) return undefined
        const id = newSessionId()
        persistSession(id, history, `fix round ${round}: ${opts.check}`)
        return id
      },
      aborted: () => controller.signal.aborted,
    })
  } finally {
    process.off('SIGINT', onSigint)
    await closeMcp()
  }

  if (report.deniedTools.length) {
    log(
      `refused calls to ${report.deniedTools.join(', ')} — fix runs in acceptEdits by default. ` +
        'Pass --permission-mode bypass to let it run other commands.',
    )
  }

  if (opts.outputFormat === 'json') {
    process.stdout.write(JSON.stringify({ type: 'fix_result', ...report, duration_ms: Date.now() - started }) + '\n')
  } else {
    const lines = [
      report.passed
        ? report.stoppedBecause === 'already_passing'
          ? `✓ ${opts.check} already passes.`
          : `✓ ${opts.check} passes after ${report.rounds} round${report.rounds === 1 ? '' : 's'}.`
        : `✗ ${opts.check} still fails (${fmt(report.initialFailures)} → ${fmt(report.finalFailures)}) — stopped: ${report.stoppedBecause.replace('_', ' ')}.`,
    ]
    if (report.changedFiles.length) lines.push(`Changed: ${report.changedFiles.join(', ')}`)
    const stuck = report.attempts.flatMap((a) => a.unrestorable ?? [])
    if (stuck.length) lines.push(`Changed by shell commands and not undone: ${[...new Set(stuck)].join(', ')}`)
    if (!report.passed && report.lastFailure) lines.push('', 'Last failure:', report.lastFailure)
    process.stdout.write(lines.join('\n') + '\n')
  }

  if (report.stoppedBecause === 'aborted') return 130
  return report.passed ? 0 : 1
}
