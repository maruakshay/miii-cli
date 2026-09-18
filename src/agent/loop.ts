import { existsSync, statSync } from 'fs'
import { chat } from '../llm/client.js'
import { confinePath } from '../tools/paths.js'
import { getTool, toOllamaTools, toolsForMode } from '../tools/registry.js'
import { validateInput, exampleInput } from '../tools/validate.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { loadProjectContext } from '../prompt/context.js'
import { check, deniedBySettings, isReadOnlyCommand, type PermissionContext, type PermissionMode } from '../permissions/policy.js'
import { loadConfig, EFFORT_OPTIONS, DEFAULT_NUM_CTX_CAP } from '../config.js'
import { HookBus } from '../hooks/bus.js'
import {
  toOllamaMessages,
  blocksFromOllama,
  looksLikeLeakedToolCall,
} from './adapter.js'
import { resolveToolName, normalizeToolInput } from './normalize.js'
import { bashWriteTargets } from './bashWrites.js'
import type { Tool } from '../tools/types.js'
import type {
  MiiMessage,
  AgentEvent,
  ToolRepair,
  ToolUse,
  ToolResultBlock,
  ContentBlock,
} from './types.js'

const MAX_TURNS = 25
const REPEAT_TAIL = 120
const REPEAT_KILL = 4
// Max times to ask the model to re-emit a leaked text tool call via the native
// interface before giving up and ending the turn.
const MAX_LEAK_NUDGES = 2
// How many times one byte-identical call may fail before the harness stops
// running it. 1st failure: the plain error. 2nd: the error plus an escalation
// that names a different action. 3rd: refused without ever reaching the tool.
const MAX_IDENTICAL_FAILURES = 2
// How many times a Stop hook may send the model back to work before the turn
// ends anyway. A gate the model cannot satisfy must not cost the whole run.
const MAX_STOP_NUDGES = 2

/**
 * Fingerprint of a file's state on disk — mtime and size. Cheap enough to take
 * on every read and every guard check, and precise enough for the one question
 * being asked: is this still the file the model looked at? Null means gone or
 * unreadable, which never compares equal to a real stamp.
 */
function fileStamp(abs: string): string | null {
  try {
    const st = statSync(abs)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

/**
 * Harness-enforced read-before-write. The system prompt asks the model to read
 * a file before editing it, but weak local models ignore prose invariants — so
 * we enforce it mechanically. `seen` maps canonical paths the model has read
 * (or written) this run to the file's stamp at that moment. Returns an
 * actionable error string to block the call, or null to allow it.
 *
 * - edit_file always targets an existing file → requires a prior read.
 * - write_file creating a NEW file is allowed (nothing to read); overwriting an
 *   existing file requires a prior read.
 * - A path the model HAS read, whose stamp has since moved, is stale: a command
 *   it ran, a formatter, or the user rewrote the file after it looked. Editing
 *   from a stale copy silently reverts whatever landed in between, so the call
 *   is blocked and the model is sent back to re-read. This is the case the
 *   path-only version of this guard used to wave straight through.
 * Path/confinement problems are left to the tool handler to report.
 */
function readGuard(name: string, input: unknown, seen: Map<string, string>): string | null {
  if (name === 'run_bash') return bashGuard(input, seen)
  if (name !== 'edit_file' && name !== 'write_file') return null
  const p = (input as { path?: unknown }).path
  if (typeof p !== 'string' || !p) return null
  let abs: string
  try { abs = confinePath(p) } catch { return null }
  const verb = name === 'edit_file' ? 'edit' : 'overwrite'

  const stamp = seen.get(abs)
  if (stamp === undefined) {
    if (name === 'write_file' && !existsSync(abs)) return null
    return `I won't ${verb} ${p} without seeing it first — I don't want to clobber something. Read it with read_file, then retry the ${name}.`
  }

  const now = fileStamp(abs)
  // Vanished since the read — that's the handler's error to report, not ours.
  if (now === null || now === stamp) return null
  return (
    `${p} changed on disk after you read it — a command you ran, a formatter, or the user ` +
    `rewrote it — so the copy you're working from is stale and this ${name} would revert ` +
    `whatever landed in between. Nothing was written. Read it again, then redo the ${verb} ` +
    `against what's actually there now.`
  )
}

/**
 * The same guard for run_bash. A heredoc or `sed -i` writes the file just as
 * edit_file would, but names no `path` argument, so without this the model can
 * clobber a file it never read by routing around the tool that checks.
 *
 * Only paths the command plainly truncates are considered, and only when they
 * already exist inside the project — creating a file is allowed here exactly as
 * it is for write_file. Anything unparseable is waved through: this narrows the
 * hole, it does not seal it, and blocking a legitimate command would cost more
 * than the writes it still misses.
 */
function bashGuard(input: unknown, seen: Map<string, string>): string | null {
  const cmd = (input as { command?: unknown }).command
  if (typeof cmd !== 'string' || !cmd) return null
  for (const raw of bashWriteTargets(cmd)) {
    let abs: string
    try {
      abs = confinePath(raw)
    } catch {
      continue // outside the project, or not a path at all — not this guard's business
    }
    if (!existsSync(abs)) continue

    const stamp = seen.get(abs)
    if (stamp === undefined) {
      return (
        `This command would overwrite ${raw}, and you haven't read it — I don't want to clobber ` +
        `something unseen. Nothing ran. Read it with read_file first, or make the change with ` +
        `edit_file, which matches on the existing text instead of replacing the whole file.`
      )
    }
    const now = fileStamp(abs)
    if (now !== null && now !== stamp) {
      return (
        `${raw} changed on disk after you read it, so this command would overwrite it from a ` +
        `stale copy and revert whatever landed in between. Nothing ran. Read it again, then redo ` +
        `the change against what's actually there now.`
      )
    }
  }
  return null
}

/**
 * The tools plan mode advertises — the set planGuard holds the model to.
 *
 * Computed per call rather than once at import: MCP servers connect after this
 * module loads, so a set frozen here would refuse every server tool in plan
 * mode, including the ones whose server declared itself read-only.
 */
function planTools(): Set<string> {
  return new Set(toolsForMode('plan').map((t) => t.name))
}

/**
 * Harness-enforced plan mode, the mechanical twin of the prompt's "READ-ONLY".
 *
 * Withholding the write tools from the schema stops most of this, but a small
 * model that has seen `edit_file` earlier in the transcript will call it anyway,
 * and a model asked not to write will still reach for `run_bash` to do it. So
 * the boundary is enforced here rather than trusted to the prompt: a mutating
 * call in plan mode never reaches the tool handler, and the model is told what
 * to do instead of being left to guess from a bare refusal.
 *
 * Returns an actionable error string to block the call, or null to allow it.
 */
function planGuard(name: string, input: unknown, mode: PermissionMode): string | null {
  if (mode !== 'plan') return null
  if (!planTools().has(name)) {
    return (
      `You're in plan mode, which is read-only, so ${name} did not run and nothing changed. ` +
      `Finish researching with read_file, grep, glob and read-only run_bash commands, then ` +
      `call exit_plan_mode with your plan. The user approves it before any of it happens.`
    )
  }
  if (name === 'run_bash') {
    const command = (input as { command?: unknown }).command
    if (typeof command === 'string' && !isReadOnlyCommand(command)) {
      return (
        `You're in plan mode, so only commands that report can run — this one was refused ` +
        `and nothing happened. Use ls, cat, grep, git status/log/diff and the like (one ` +
        `command at a time, no pipes or &&). Anything that builds, installs, writes or ` +
        `deletes belongs in the plan you hand to exit_plan_mode, not in this turn.`
      )
    }
  }
  return null
}

/**
 * Repair a turn's tool calls in place, before anything else looks at them.
 *
 * A small model usually gets the intent right and the spelling wrong: it calls
 * `readFile`, passes `file_path`, sends `"20"` where a number is declared, or
 * wraps the arguments in a `{name, arguments}` envelope. Left alone each of
 * those burns a full round trip — a rejected call, an error, a retry — which on
 * a small context window is the difference between finishing and running out of
 * room. Repairing here means the corrected call is what the UI shows, what
 * loop-detection compares, and what gets persisted to history, so the model
 * never re-reads its own mistake and learns it back.
 *
 * Returns what it had to fix, per call. The loop emits that as telemetry: the
 * repair tables in normalize.ts are guesswork until something counts which
 * repairs actually fire, for which model, on which tool.
 */
function repairToolUses(tool_uses: ToolUse[], toolNames: string[]): ToolRepair[] {
  const out: ToolRepair[] = []
  for (const use of tool_uses) {
    const repairs: string[] = []
    const resolved = resolveToolName(use.name, toolNames)
    if (resolved && resolved !== use.name) repairs.push(`name: ${use.name} → ${resolved}`)
    if (resolved) use.name = resolved
    const tool = getTool(use.name)
    if (tool) {
      const normalized = normalizeToolInput(tool.input_schema, use.input)
      use.input = normalized.input
      repairs.push(...normalized.repairs)
    }
    if (repairs.length > 0) out.push({ tool_use_id: use.id, name: use.name, repairs })
  }
  return out
}

/**
 * Stable, bounded identity for "this exact call" — the tool plus its arguments,
 * hashed so a call carrying a whole file body doesn't sit in a Map key.
 */
function callKey(name: string, input: unknown): string {
  const s = `${name}:${JSON.stringify(input ?? {})}`
  let hash = 2166136261
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${name}#${(hash >>> 0).toString(36)}`
}

/**
 * Appended to the SECOND identical failure of a call.
 *
 * The stream-repetition and identical-turn guards only catch a model repeating
 * itself back to back. The failure that actually eats a run alternates:
 * edit_file fails → read_file → the same edit_file fails → read_file, forever,
 * with no two consecutive turns alike. Handing back the same error string each
 * time is what sustains it — the model has already demonstrated it doesn't know
 * what to do with those words. So the wording changes and names a different
 * action.
 */
function escalation(name: string): string {
  return (
    `\n\nThis is the second time this exact ${name} call has failed with this same error. ` +
    `Sending it again will fail the same way. Change something: re-read the file to see what ` +
    `is actually there now, match on different text, use a different tool, or tell the user ` +
    `what is blocking you.`
  )
}

/** Handed back instead of running a call that has already failed twice. */
function refusal(name: string): string {
  return (
    `This exact ${name} call has already failed twice, so I did not run it a third time — ` +
    `nothing happened. Repeating it will not start working. Do something different: gather ` +
    `the information you're missing with read_file or grep, take another approach, or stop ` +
    `and tell the user what you're stuck on.`
  )
}

// Tools whose payload carries a large free-text field (file body / edit text).
// These are the ones a weak local model mangles or gets cut off mid-write.
const BIG_WRITE_TOOLS = new Set(['write_file', 'edit_file'])

/**
 * Guidance handed back when a big-write call can't run because its response was
 * cut off (token cap) or mangled mid-write. Steers the model to split the work
 * instead of re-emitting the same oversized call — which it otherwise loops on.
 */
function splitWriteHint(name: string, cause: 'truncated' | 'garbled'): string {
  const lead =
    cause === 'truncated'
      ? `Your response was cut off at the output token limit, so this ${name} call is incomplete and was NOT run.`
      : `Your ${name} call arrived with missing or garbled arguments — usually the response was cut off or mangled while writing a large value. It was NOT run.`
  return (
    `${lead} Do not resend the whole file in one call. Instead create the file ` +
    `with write_file containing only the first portion, then append the rest ` +
    `with successive edit_file calls. Keep each call small.`
  )
}

/**
 * After envelope-unwrapping, a big-write call that is still missing its key
 * fields (no `path`, or write_file with no string `content`) is almost never a
 * genuine shape mistake — it's a truncated/mangled write. Detect it so we can
 * steer the model to split the work rather than emit a bare "path Required",
 * which just makes it retry the same oversized call.
 */
function looksTruncatedWrite(name: string, input: Record<string, unknown>): boolean {
  if (!BIG_WRITE_TOOLS.has(name)) return false
  if (typeof input.path !== 'string' || !input.path) return true
  if (name === 'write_file' && typeof input.content !== 'string') return true
  return false
}

/**
 * Record a path the model now knows the current state of (read or wrote), along
 * with the stamp it had at that moment — which is what later makes a stale edit
 * detectable. Called only after a successful call, so a failed read never counts
 * as having seen the file.
 */
function markSeen(name: string, input: unknown, seen: Map<string, string>): void {
  // A shell write the guard let through leaves the model knowing that file's
  // contents, and moves its stamp — without recording it, the next write to the
  // same file reads as stale and blocks on work the model itself just did.
  if (name === 'run_bash') {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd !== 'string' || !cmd) return
    for (const raw of bashWriteTargets(cmd)) {
      try {
        const abs = confinePath(raw)
        const stamp = fileStamp(abs)
        if (stamp !== null) seen.set(abs, stamp)
      } catch { /* not a path we can resolve; nothing to record */ }
    }
    return
  }
  if (name !== 'read_file' && name !== 'edit_file' && name !== 'write_file') return
  const p = (input as { path?: unknown }).path
  if (typeof p !== 'string' || !p) return
  try {
    const abs = confinePath(p)
    const stamp = fileStamp(abs)
    if (stamp !== null) seen.set(abs, stamp)
  } catch { /* confinement error surfaced by tool */ }
}

export interface RunAgentOpts {
  model: string
  cwd: string
  history: MiiMessage[]
  userText: string
  /** Base64-encoded images attached to this turn's user message. */
  images?: string[]
  permissions: PermissionContext
  /** Permission mode at the start of the run; approving a plan changes it. */
  mode?: PermissionMode
  hooks?: HookBus
  signal?: AbortSignal
  num_ctx?: number
  /**
   * Narrow the advertised tools further than the mode already does. Used by
   * subagents, which get a task-shaped subset rather than everything.
   */
  toolFilter?: (name: string) => boolean
  /**
   * Replace the system prompt. The tools for the turn are passed in because the
   * prompt lists them and the set can change mid-run (approving a plan).
   */
  buildSystem?: (tools: Tool[], mode: PermissionMode) => string
  /** Tool-use turns before the run is cut off. Defaults to MAX_TURNS. */
  maxTurns?: number
}

/**
 * Canonical agent loop. Keyed on Ollama's analogue of stop_reason=="tool_use":
 * presence of tool_calls on the assistant message. Each iteration:
 *   1. assistant message accumulated (text + tool_use blocks)
 *   2. if zero tool_use → end_turn, break
 *   3. else run each tool (perm + hooks), emit ONE user message with
 *      tool_result blocks in same order, immediately following the assistant
 *      message. No other messages may interleave.
 *
 * Returns the updated history (caller persists).
 */
export async function* runAgent(opts: RunAgentOpts): AsyncGenerator<AgentEvent, MiiMessage[]> {
  const { model, cwd, permissions, hooks, signal, num_ctx } = opts
  const maxTurns = opts.maxTurns ?? MAX_TURNS
  const startTime = Date.now()
  const cfg = loadConfig()
  /**
   * Live for the whole run: approving a plan flips it mid-run, and everything
   * derived from it — the advertised tools, the system prompt, what the
   * permission gate allows — is rebuilt per turn so nothing trails a turn behind.
   */
  let mode: PermissionMode = opts.mode ?? 'default'
  // Effort drives temperature + output cap. high → num_predict -1 (unlimited),
  // which ollama.chat omits so the model runs to its own stop.
  const effort = EFFORT_OPTIONS[cfg.effort ?? 'medium']
  // Cap the requested context window so a model advertising a huge training
  // window (e.g. 131072) doesn't make Ollama allocate a KV cache that OOMs the
  // machine. Override with numCtxCap in config.json. Never raises a small window.
  const ctxCap = cfg.numCtxCap && cfg.numCtxCap > 0 ? cfg.numCtxCap : DEFAULT_NUM_CTX_CAP
  const cappedCtx =
    typeof num_ctx === 'number' && num_ctx > 0 ? Math.min(num_ctx, ctxCap) : undefined
  // Read once: MIII.md is the same file all run, and re-reading it per turn
  // would let an edit land mid-task and silently change the rules underfoot.
  const projectContext = loadProjectContext(cwd)

  // UserPromptSubmit sees the message before the model does. A block drops the
  // turn entirely — nothing is appended to history, so a refused prompt leaves
  // no trace for the next turn to be confused by. stdout from a hook that
  // allowed it rides along as extra context, which is how a project injects
  // "current sprint is X" or a ticket number without the user retyping it.
  let promptContext = ''
  if (hooks) {
    try {
      const gate = await hooks.firePrompt(opts.userText)
      for (const w of gate.warnings) yield { type: 'hook-notice', message: w }
      if (gate.blocked) {
        yield { type: 'error', message: `Prompt blocked by a UserPromptSubmit hook: ${gate.reason}` }
        yield { type: 'done', prompt_tokens: 0, eval_tokens: 0 }
        return opts.history
      }
      if (gate.context) promptContext = gate.context
    } catch { /* hook machinery failure never blocks a turn */ }
  }

  const history: MiiMessage[] = [
    ...opts.history,
    {
      role: 'user',
      content: promptContext ? `${opts.userText}\n\n<hook-context>\n${promptContext}\n</hook-context>` : opts.userText,
      ...(opts.images && opts.images.length > 0 ? { images: opts.images } : {}),
    },
  ]

  let promptTokens = 0
  let evalTokens = 0
  let lastAssistantSig = ''
  let repeatCount = 0
  // How many times we've asked the model to re-emit a leaked text tool call via
  // the native interface this run. Bounded so a model that can't comply ends the
  // turn instead of looping forever.
  let leakNudges = 0
  // How many times a Stop hook has sent the model back to work this run.
  let stopNudges = 0
  // Canonical path -> file stamp when the model last saw it. Gates edit/write,
  // and catches a file that moved underneath the model between read and edit.
  const seenPaths = new Map<string, string>()
  // callKey -> how many times that identical call has failed this run. Cleared
  // when the same call finally succeeds, so a transient failure costs nothing.
  const failures = new Map<string, number>()

  // Set when the model finishes on its own (end_turn). If we fall out of the
  // loop with this still false, we hit MAX_TURNS mid-task — surface it instead
  // of yielding a bare `done`, which reads as "completed successfully".
  let endedCleanly = false

  for (let turn = 0; turn < maxTurns; turn++) {
    // Derived from `mode`, which the user can change mid-run by approving a
    // plan. The model must see the tools it actually has this turn, and a
    // near-miss name must only ever resolve to one of them.
    const activeTools = opts.toolFilter
      ? toolsForMode(mode).filter((t) => opts.toolFilter!(t.name))
      : toolsForMode(mode)
    const ollamaTools = toOllamaTools(activeTools)
    const toolNames = activeTools.map((t) => t.name)
    // Built after cappedCtx: the prompt sizes itself to the window we actually
    // negotiated, dropping its optional layer when there is no room to spare.
    const system = opts.buildSystem
      ? opts.buildSystem(activeTools, mode)
      : buildSystemPrompt(activeTools, cwd, projectContext, cappedCtx, mode)

    let text = ''
    let tool_calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> | undefined
    // Reasoning models think THEN answer. Some providers still trickle a few
    // thinking tokens after visible text has begun; surfacing them flips the UI
    // back into "thinking" and wedges the spinner above the streaming answer
    // (between the prior tool result and this turn's text). Once we emit visible
    // text, drop the rest of this turn's thinking.
    let emittedText = false

    let lastTail = ''
    let tailRepeats = 0
    let streamLooped = false
    let truncated = false
    const ac = new AbortController()
    const composedSignal = signal
      ? (AbortSignal.any ? AbortSignal.any([signal, ac.signal]) : ac.signal)
      : ac.signal
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true })

    try {
      for await (const chunk of chat(model, toOllamaMessages(history, system), ollamaTools, { signal: composedSignal, num_ctx: cappedCtx, num_predict: effort.num_predict, temperature: effort.temperature })) {
        if (signal?.aborted) break
        if (chunk.content) {
          text += chunk.content
          emittedText = true
          yield { type: 'text-delta', text: chunk.content }
          if (text.length >= REPEAT_TAIL) {
            const tail = text.slice(-REPEAT_TAIL)
            if (tail === lastTail) {
              tailRepeats++
              if (tailRepeats >= REPEAT_KILL) {
                streamLooped = true
                ac.abort()
                break
              }
            } else {
              tailRepeats = 0
              lastTail = tail
            }
          }
        }
        if (chunk.thinking && !emittedText) {
          yield { type: 'thinking-delta', text: chunk.thinking }
        }
        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          tool_calls = chunk.tool_calls
        }
        if (chunk.done) {
          promptTokens += chunk.prompt_eval_count ?? 0
          evalTokens += chunk.eval_count ?? 0
          if (chunk.done_reason === 'length') truncated = true
        }
      }
    } catch (err) {
      if (streamLooped) {
        yield { type: 'error', message: 'Model stuck in repetition. Aborted stream. Try a different model or shorten context.' }
        return history
      }
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      return history
    }

    if (streamLooped) {
      yield { type: 'error', message: 'Model stuck in repetition. Aborted stream. Try a different model or shorten context.' }
      return history
    }

    if (signal?.aborted) {
      yield {
        type: 'aborted',
        prompt_tokens: promptTokens,
        eval_tokens: evalTokens,
        duration_ms: Date.now() - startTime,
      }
      return history
    }

    const blocks: ContentBlock[] = blocksFromOllama(text, tool_calls, toolNames)
    const tool_uses = blocks.filter((b): b is ToolUse => b.type === 'tool_use')

    // Repair names/arguments before anything downstream reads them — the blocks
    // are mutated in place, so history, the UI and loop-detection all see the
    // corrected call rather than the model's near-miss.
    for (const repair of repairToolUses(tool_uses, toolNames)) {
      yield { type: 'tool-repair', ...repair }
    }

    // Loop detection runs BEFORE the assistant message is committed to history.
    // If we push first and then bail on a detected repeat, the persisted history
    // ends on an assistant tool_use with no matching tool_result — which breaks
    // the next request when the session resumes. Only genuine tool-use turns can
    // loop here: a truncated call is handled below, and a no-tool turn produces no
    // tool_use to leave dangling.
    if (tool_uses.length > 0 && !truncated) {
      const sig = JSON.stringify(
        blocks.map((b) =>
          b.type === 'tool_use'
            ? { t: 'u', n: b.name, i: b.input }
            : b.type === 'text'
              ? { t: 't', x: b.text.trim() }
              : b,
        ),
      )
      if (sig === lastAssistantSig) {
        repeatCount++
        if (repeatCount >= 2) {
          yield { type: 'error', message: 'Agent loop detected: assistant produced identical output 3 turns in a row' }
          return history
        }
      } else {
        repeatCount = 0
        lastAssistantSig = sig
      }
    }

    history.push({ role: 'assistant', content: blocks })

    // Output hit the token cap mid-stream. Any tool call here has truncated
    // arguments (e.g. a half-written file `content`); executing it would write a
    // corrupt file, and the partial args usually fail validation so the model
    // just re-emits the same oversized call forever. Refuse to run it and tell
    // the model to split the work into smaller writes instead of looping.
    if (truncated && tool_uses.length > 0) {
      const results: ToolResultBlock[] = tool_uses.map((use) => ({
        type: 'tool_result' as const,
        tool_use_id: use.id,
        content: splitWriteHint(use.name, 'truncated'),
        is_error: true,
      }))
      for (const u of tool_uses) yield { type: 'tool-use', block: u }
      for (const r of results) yield { type: 'tool-result', block: r }
      history.push({ role: 'user', content: results as ContentBlock[] })
      yield { type: 'turn-end', stop_reason: 'tool_use' }
      continue
    }

    if (tool_uses.length === 0) {
      // The model produced no structured tool call, but its text looks like it
      // tried to call a tool in some prose syntax we couldn't parse (so it leaked
      // verbatim to the user and no file was actually written). Nudge it to
      // re-emit via the native function-calling interface rather than ending the
      // turn on a silent no-op. Bounded so a model that can't comply still exits.
      const assistantText = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (leakNudges < MAX_LEAK_NUDGES && looksLikeLeakedToolCall(assistantText, toolNames)) {
        leakNudges++
        history.push({
          role: 'user',
          content:
            'That tool call was written as plain text, so it did not run and nothing happened. ' +
            'Re-issue it using the function-calling interface only — do not print the call as ' +
            'text, JSON, or any custom syntax. If you did not mean to call a tool, answer in prose.',
        })
        yield { type: 'turn-end', stop_reason: 'tool_use' }
        continue
      }
      // Turn produced literally nothing — no visible text and no tool call. This
      // is not a clean end: it usually means the model returned an empty response
      // (stream dropped mid-request, or the output cap was spent entirely on
      // hidden thinking tokens). Ending silently here looks to the user like the
      // run just aborted with no reason. Surface it instead of a bare end_turn.
      if (assistantText.trim() === '') {
        yield {
          type: 'error',
          message:
            'The model returned an empty response — likely unloaded/OOM mid-stream or the ' +
            'output cap was consumed by thinking before any answer. Retry, switch models, or ' +
            'lower the context/effort.',
        }
        yield { type: 'done', prompt_tokens: promptTokens, eval_tokens: evalTokens }
        return history
      }
      // A Stop hook gets a veto on "I'm done". The use is a completion gate —
      // "the tests have to pass before you stop" — so a block sends the model
      // back to work with the reason. Bounded: a gate the model cannot satisfy
      // must end the turn rather than loop until MAX_TURNS.
      if (hooks && stopNudges < MAX_STOP_NUDGES) {
        let stopReason: string | null = null
        try {
          const gate = await hooks.fireStop()
          for (const w of gate.warnings) yield { type: 'hook-notice', message: w }
          if (gate.blocked) stopReason = gate.reason ?? 'A Stop hook is not satisfied yet.'
        } catch { /* see firePre */ }
        if (stopReason) {
          stopNudges++
          history.push({
            role: 'user',
            content:
              `You're not done yet — this project's Stop hook refused the turn: ${stopReason}\n\n` +
              `Address that and continue. If you genuinely cannot, say so plainly and stop.`,
          })
          yield { type: 'turn-end', stop_reason: 'tool_use' }
          continue
        }
      }
      endedCleanly = true
      yield { type: 'turn-end', stop_reason: 'end_turn' }
      break
    }

    for (const u of tool_uses) yield { type: 'tool-use', block: u }

    const results: ToolResultBlock[] = []
    for (const use of tool_uses) {
      // Identity of this exact call — tool plus arguments — for the repeat gate.
      const key = callKey(use.name, use.input)
      /**
       * Every result for this call funnels through here so the repeat gate sees
       * it: success clears the counter (a transient failure costs nothing),
       * failure increments it, and the second identical failure gets wording
       * that differs from the first and names another way out.
       */
      const note = (r: ToolResultBlock): ToolResultBlock => {
        if (!r.is_error) {
          failures.delete(key)
          return r
        }
        const n = (failures.get(key) ?? 0) + 1
        failures.set(key, n)
        if (n === MAX_IDENTICAL_FAILURES) r.content += escalation(use.name)
        return r
      }

      // Already failed its budget of identical attempts — refuse without
      // running it, and without spending a permission prompt on it either.
      if ((failures.get(key) ?? 0) >= MAX_IDENTICAL_FAILURES) {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: refusal(use.name),
          is_error: true,
        }
        results.push(r)
        yield { type: 'tool-result', block: r }
        continue
      }

      const tool = getTool(use.name)
      if (!tool) {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Unknown tool: ${use.name}. There's no tool by that name. Available tools: ${toolNames.join(', ')}. Pick the one that does what you meant and call it by its exact name.`,
          is_error: true,
        }
        results.push(note(r))
        yield { type: 'tool-result', block: r }
        continue
      }

      // Cancelled mid-turn (Esc). Don't prompt for or run what's left — but do
      // emit a tool_result for every tool_use, or the persisted history ends on
      // an unmatched tool_use and breaks the next request when the session
      // resumes. Same invariant the truncation path above protects.
      if (signal?.aborted) {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Cancelled — the user stopped the turn before ${use.name} ran.`,
          is_error: true,
        }
        results.push(r)
        yield { type: 'tool-result', block: r }
        continue
      }

      const invalid = validateInput(tool.input_schema, use.input)
      if (invalid) {
        // Empty/garbled args on a big-write tool almost always means a
        // truncated or mangled write, not a shape mistake — steer to splitting
        // the work rather than retrying the same oversized call.
        const content = looksTruncatedWrite(use.name, use.input)
          ? splitWriteHint(use.name, 'garbled')
          : `${invalid} for ${use.name}. Pass the arguments directly as the tool input — do NOT wrap them in {"name":...,"arguments":...}. Correct shape: ${exampleInput(tool.input_schema)}. Retry with all required fields.`
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content,
          is_error: true,
        }
        results.push(note(r))
        yield { type: 'tool-result', block: r }
        continue
      }

      const blocked = planGuard(use.name, use.input, mode)
      if (blocked) {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: blocked,
          is_error: true,
        }
        results.push(note(r))
        yield { type: 'tool-result', block: r }
        continue
      }

      // The one call that changes the rules rather than the project. It is put
      // to the user directly instead of through check(): the answer decides how
      // the rest of the run behaves, and an "always" here must never be
      // persisted as a permission rule — a saved "stop asking me to approve
      // plans" would make plan mode a no-op forever after.
      if (use.name === 'exit_plan_mode' && mode === 'plan') {
        const answer = await permissions.ask('exit_plan_mode', use.input)
        if (answer === 'no') {
          const r: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: use.id,
            content:
              'The user did not approve this plan, so you are still in plan mode and nothing ' +
              'has changed. Ask what they want different, or go read more, then propose a ' +
              'revised plan with exit_plan_mode. Do not try to make changes.',
            is_error: true,
          }
          results.push(note(r))
          yield { type: 'tool-result', block: r }
          continue
        }
        // "Always" is the second yes: approve the plan AND stop prompting for
        // the edits carrying it out, which is what a user who just read the
        // whole plan is actually agreeing to.
        mode = answer === 'always' ? 'acceptEdits' : 'default'
        yield { type: 'mode-change', mode }
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content:
            'The user approved the plan. You are out of plan mode and the write tools are ' +
            'available again' +
            (mode === 'acceptEdits' ? ', and file edits will no longer be prompted' : '') +
            '. Carry it out now, starting with the first step. Do not restate the plan — the ' +
            'user has read it. Track progress with write_todos if it runs to several steps.',
        }
        results.push(note(r))
        yield { type: 'tool-result', block: r }
        continue
      }

      const decision = await check(use.name, use.input, { ...permissions, mode })
      if (decision === 'deny') {
        // A standing deny rule and a user pressing "no" are both refusals, but
        // they call for different next moves: one is a rule that will refuse
        // every identical call forever, the other is a person who might say yes
        // to something else. Saying which is which saves a wasted retry.
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: deniedBySettings(use.name, use.input)
            ? `This project's permission settings forbid ${use.name} here, so it did not run. That rule is not going to change mid-run — find another way, or tell the user what it's blocking.`
            : `Permission denied — the user chose not to run ${use.name}. Try a different approach, or ask them what they'd prefer.`,
          is_error: true,
        }
        results.push(note(r))
        yield { type: 'permission-denied', toolName: use.name, tool_use_id: use.id }
        yield { type: 'tool-result', block: r }
        continue
      }

      const guard = readGuard(use.name, use.input, seenPaths)
      if (guard) {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: guard,
          is_error: true,
        }
        results.push(note(r))
        yield { type: 'tool-result', block: r }
        continue
      }

      // A PreToolUse hook that exits 2 refuses the call. That refusal reaches
      // the model as an ordinary failed tool_result, so it can adapt, and the
      // block invariant (one result per use) is preserved either way — an
      // exception in the hook machinery is swallowed rather than allowed to
      // strand a tool_use.
      let preBlocked: string | null = null
      try {
        const pre = await hooks?.firePre(use)
        for (const w of pre?.warnings ?? []) yield { type: 'hook-notice', message: w }
        if (pre?.blocked) preBlocked = pre.reason ?? 'A PreToolUse hook refused this call.'
      } catch { /* hook machinery failure is never the turn's problem */ }
      if (preBlocked) {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content:
            `Blocked by this project's ${use.name} hook, so it did not run and nothing changed: ` +
            `${preBlocked}\n\nThis is a rule the project enforces, not a transient failure — ` +
            `retrying the same call will be refused again. Work within it, or tell the user why you can't.`,
          is_error: true,
        }
        results.push(note(r))
        yield { type: 'tool-result', block: r }
        continue
      }

      let r: ToolResultBlock
      try {
        const out = await tool.handler(use.input, {
          ...(signal ? { signal } : {}),
          // The run environment, for the one tool that starts another agent.
          run: {
            model,
            cwd,
            permissions: { ...permissions, mode },
            mode,
            ...(hooks ? { hooks } : {}),
            ...(cappedCtx !== undefined ? { num_ctx: cappedCtx } : {}),
          },
        })
        r = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: out.content,
          is_error: out.is_error,
          ...(out.images && out.images.length > 0 ? { images: out.images } : {}),
          ...(out.diff ? { diff: out.diff } : {}),
        }
      } catch (err) {
        r = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        }
      }
      if (!r.is_error) markSeen(use.name, use.input, seenPaths)
      // PostToolUse runs after the call has already landed, so a block here
      // cannot undo it — what it can do is tell the model the result is not
      // acceptable (a formatter rewrote the file, a test gate failed) before it
      // moves on believing the step is done.
      try {
        const post = await hooks?.firePost(use, r)
        for (const w of post?.warnings ?? []) yield { type: 'hook-notice', message: w }
        if (post?.blocked) {
          r.content += `\n\n[This project's post-${use.name} hook rejected the result: ${post.reason}]`
          r.is_error = true
        } else if (post?.context) {
          r.content += `\n\n[post-${use.name} hook: ${post.context}]`
        }
      } catch { /* see firePre */ }
      results.push(note(r))
      yield { type: 'tool-result', block: r }
    }

    history.push({ role: 'user', content: results as ContentBlock[] })
    yield { type: 'turn-end', stop_reason: 'tool_use' }
  }

  if (!endedCleanly) {
    yield {
      type: 'error',
      message: `Stopped after ${maxTurns} tool-use turns — the task may be incomplete. Send another message to continue where it left off.`,
    }
  }
  yield { type: 'done', prompt_tokens: promptTokens, eval_tokens: evalTokens }
  return history
}
