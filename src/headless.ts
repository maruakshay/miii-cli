/**
 * Headless mode — one prompt in, one answer out, no TUI.
 *
 *   miii -p "what does the retry budget default to"
 *   git diff | miii -p "review this for correctness bugs"
 *   miii -p "fix the failing test" --permission-mode acceptEdits --output-format json
 *
 * Everything the interactive session can do runs through the same agent loop;
 * what changes is who answers the permission prompts. Nobody is watching, so the
 * default is to refuse anything not already covered by a saved rule and say so
 * in the output, rather than hang forever on a prompt no one will see or — far
 * worse — assume yes. Scripts that mean yes say so with --permission-mode.
 */
import { fstatSync } from 'fs'
import { runAgent } from './agent/loop.js'
import { HookBus } from './hooks/bus.js'
import { initMcp, closeMcp } from './mcp/registry.js'
import { loadConfig } from './config.js'
import { modelContext } from './llm/client.js'
import { defaultPermissionMode, settingsProblems, loadSettings } from './settings.js'
import { PERMISSION_MODES, type PermissionMode } from './permissions/policy.js'
import { listSessions, loadSession, persistSession, newSessionId } from './session/store.js'
import { snapshotForTurn } from './session/checkpoint.js'
import type { AgentEvent, MiiMessage } from './agent/types.js'

export type OutputFormat = 'text' | 'json' | 'stream-json'

export interface HeadlessOptions {
  prompt: string
  outputFormat: OutputFormat
  mode?: PermissionMode
  model?: string
  maxTurns?: number
  /** Restrict the agent to these tools, by name. */
  allowedTools?: string[]
  /** Resume a specific session, or the most recent one. */
  resume?: string
  continueLast?: boolean
  cwd: string
}

/** Parsed shape of the flags headless mode understands. */
export interface HeadlessParse {
  options: HeadlessOptions | null
  /** Set when the flags themselves are wrong — printed, exit 2. */
  error?: string
}

function isMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as string[]).includes(value)
}

/**
 * Pull the headless flags out of argv. Returns options only when `-p`/`--print`
 * is present; otherwise null, and the caller launches the TUI as before.
 */
export function parseHeadlessArgs(argv: string[], cwd = process.cwd()): HeadlessParse {
  let print = false
  let prompt = ''
  let outputFormat: OutputFormat = 'text'
  let mode: PermissionMode | undefined
  let model: string | undefined
  let maxTurns: number | undefined
  let allowedTools: string[] | undefined
  let resume: string | undefined
  let continueLast = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '-p':
      case '--print':
        print = true
        // The prompt may follow the flag or arrive on stdin. A following token
        // that looks like another flag belongs to the flag list, not the prompt.
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) prompt = next()
        break
      case '--output-format': {
        const v = next()
        if (v !== 'text' && v !== 'json' && v !== 'stream-json') {
          return { options: null, error: `unknown --output-format "${v}" — use text, json or stream-json` }
        }
        outputFormat = v
        break
      }
      case '--permission-mode': {
        const v = next()
        if (!v || !isMode(v)) {
          return { options: null, error: `unknown --permission-mode "${v}" — use ${PERMISSION_MODES.join(', ')}` }
        }
        mode = v
        break
      }
      case '--dangerously-skip-permissions':
        mode = 'bypass'
        break
      case '--model':
        model = next()
        break
      case '--max-turns': {
        const v = Number(next())
        if (!Number.isFinite(v) || v < 1) return { options: null, error: '--max-turns needs a positive number' }
        maxTurns = Math.floor(v)
        break
      }
      case '--allowed-tools':
      case '--allowedTools':
        allowedTools = (next() ?? '').split(',').map((t) => t.trim()).filter(Boolean)
        break
      case '--resume':
        resume = next()
        break
      case '-c':
      case '--continue':
        continueLast = true
        break
      default:
        // A bare word with --print already seen and no prompt yet is the prompt.
        if (print && !prompt && !arg.startsWith('-')) prompt = arg
        break
    }
  }

  if (!print) return { options: null }
  return {
    options: {
      prompt,
      outputFormat,
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(resume ? { resume } : {}),
      continueLast,
      cwd,
    },
  }
}

/**
 * Is stdin something that will actually end?
 *
 * `!isTTY` is not enough. Under a supervisor, a CI runner, or `nohup`, stdin is
 * often an open socket or an inherited descriptor nobody will ever close, and
 * reading it to EOF blocks forever — miii sits there at 0% CPU having printed
 * nothing, which reads as a hang rather than as "waiting for input you did not
 * know it wanted". Only a pipe or a redirected file is guaranteed to end, so
 * those are the only two we read.
 */
function stdinIsReadable(): boolean {
  if (process.stdin.isTTY) return false
  try {
    const st = fstatSync(0)
    return st.isFIFO() || st.isFile()
  } catch {
    return false
  }
}

/** Read piped stdin, if anything is piped. Empty string otherwise. */
export async function readStdin(): Promise<string> {
  if (!stdinIsReadable()) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

interface Usage {
  input_tokens: number
  output_tokens: number
}

/**
 * Run one headless turn. Returns the process exit code: 0 for a completed
 * answer, 1 for an agent-level error, 2 for a setup problem (no model, bad
 * flags) — so a script can tell "the agent says no" from "miii is misconfigured".
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const out = process.stdout
  const emit = (obj: unknown) => { out.write(JSON.stringify(obj) + '\n') }
  const streaming = opts.outputFormat === 'stream-json'

  const cfg = loadConfig()
  const model = opts.model ?? cfg.model
  if (!model) {
    process.stderr.write('miii: no model configured. Run `miii` once to pick one, or pass --model.\n')
    return 2
  }

  // Settings problems are worth a word even here: a hook that never fires
  // because its file does not parse is a silent wrong answer otherwise.
  loadSettings(opts.cwd)
  for (const problem of settingsProblems()) {
    process.stderr.write(`miii: ignoring ${problem.path} (${problem.message})\n`)
  }

  const history: MiiMessage[] = opts.resume
    ? loadSession(opts.resume)
    : opts.continueLast
      ? loadSession(listSessions()[0]?.id ?? '')
      : []
  const sessionId = opts.resume ?? (opts.continueLast ? listSessions()[0]?.id : undefined) ?? newSessionId()

  const mode: PermissionMode = opts.mode ?? defaultPermissionMode(opts.cwd) ?? 'default'
  const hooks = new HookBus({ id: sessionId, cwd: opts.cwd })
  await hooks.fireSessionStart(history.length ? 'resume' : 'startup')

  const mcp = await initMcp(opts.cwd)
  for (const server of mcp) {
    if (!server.connected) process.stderr.write(`miii: MCP server "${server.name}" unavailable — ${server.error}\n`)
  }

  // Nobody can answer a prompt, so anything not already permitted is refused.
  // The refusals are collected and reported at the end: a run that did half the
  // job because six calls were denied must not look like a run that finished.
  const denied: string[] = []
  const permissions = {
    ask: async (toolName: string) => {
      denied.push(toolName)
      return 'no' as const
    },
  }

  let num_ctx: number | undefined
  try {
    num_ctx = await modelContext(model)
  } catch { /* unreported window — the loop sends the full prompt */ }

  const started = Date.now()
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }
  let answer = ''
  let errorMessage: string | null = null
  let turns = 0
  let finalHistory = history

  try {
    const gen = runAgent({
      model,
      cwd: opts.cwd,
      history,
      userText: opts.prompt,
      permissions,
      mode,
      hooks,
      ...(num_ctx !== undefined ? { num_ctx } : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.allowedTools
        ? { toolFilter: (name: string) => opts.allowedTools!.includes(name) }
        : {}),
    })

    for (;;) {
      const step = await gen.next()
      if (step.done) { finalHistory = step.value; break }
      const ev: AgentEvent = step.value
      if (streaming) emit(ev)

      switch (ev.type) {
        case 'text-delta':
          answer += ev.text
          // Text mode streams as it arrives — a long answer should not sit in a
          // buffer until the run ends, and a pipe consumer can act on it early.
          if (opts.outputFormat === 'text') out.write(ev.text)
          break
        case 'turn-end':
          if (ev.stop_reason === 'tool_use') {
            turns++
            // Each tool turn is a checkpoint boundary, the same as interactive.
            snapshotForTurn(sessionId, finalHistory.length)
            if (opts.outputFormat === 'text') answer = ''
          }
          break
        case 'done':
          usage.input_tokens = ev.prompt_tokens
          usage.output_tokens = ev.eval_tokens
          break
        case 'aborted':
          usage.input_tokens = ev.prompt_tokens
          usage.output_tokens = ev.eval_tokens
          errorMessage = 'aborted'
          break
        case 'error':
          errorMessage = ev.message
          break
        case 'hook-notice':
          process.stderr.write(`miii: ${ev.message}\n`)
          break
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
  } finally {
    await closeMcp()
  }

  if (finalHistory.length) persistSession(sessionId, finalHistory)

  if (denied.length) {
    const unique = [...new Set(denied)]
    process.stderr.write(
      `miii: refused ${denied.length} call(s) to ${unique.join(', ')} — headless runs approve nothing by default. ` +
      `Pass --permission-mode acceptEdits (file writes) or bypass (everything), or save rules with /permissions.\n`,
    )
  }

  const isError = errorMessage !== null
  if (opts.outputFormat === 'json') {
    emit({
      type: 'result',
      subtype: isError ? 'error' : 'success',
      is_error: isError,
      result: answer.trim(),
      ...(errorMessage ? { error: errorMessage } : {}),
      session_id: sessionId,
      num_turns: turns,
      duration_ms: Date.now() - started,
      usage,
      ...(denied.length ? { denied_tools: [...new Set(denied)] } : {}),
    })
  } else if (opts.outputFormat === 'text') {
    if (!answer.endsWith('\n')) out.write('\n')
    if (errorMessage) process.stderr.write(`miii: ${errorMessage}\n`)
  } else if (errorMessage) {
    process.stderr.write(`miii: ${errorMessage}\n`)
  }

  return isError ? 1 : 0
}
