import { existsSync } from 'fs'
import { chat } from '../llm/client.js'
import { confinePath } from '../tools/paths.js'
import { TOOLS, getTool, toOllamaTools } from '../tools/registry.js'
import { validateInput, exampleInput } from '../tools/validate.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { loadProjectContext } from '../prompt/context.js'
import { check, type PermissionContext } from '../permissions/policy.js'
import { loadConfig, EFFORT_OPTIONS, DEFAULT_NUM_CTX_CAP } from '../config.js'
import { HookBus } from '../hooks/bus.js'
import {
  toOllamaMessages,
  blocksFromOllama,
  looksLikeLeakedToolCall,
} from './adapter.js'
import type {
  MiiMessage,
  AgentEvent,
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

/**
 * Harness-enforced read-before-write. The system prompt asks the model to read
 * a file before editing it, but weak local models ignore prose invariants — so
 * we enforce it mechanically. `seen` holds canonical paths the model has read
 * (or already written) this run. Returns an actionable error string to block
 * the call, or null to allow it.
 *
 * - edit_file always targets an existing file → requires a prior read.
 * - write_file creating a NEW file is allowed (nothing to read); overwriting an
 *   existing file requires a prior read.
 * Path/confinement problems are left to the tool handler to report.
 */
function readGuard(name: string, input: unknown, seen: Set<string>): string | null {
  if (name !== 'edit_file' && name !== 'write_file') return null
  const p = (input as { path?: unknown }).path
  if (typeof p !== 'string' || !p) return null
  let abs: string
  try { abs = confinePath(p) } catch { return null }
  if (seen.has(abs)) return null
  if (name === 'write_file' && !existsSync(abs)) return null
  const verb = name === 'edit_file' ? 'edit' : 'overwrite'
  return `Refusing to ${verb} ${p}: you have not read it this turn. Call read_file on ${p} first, then retry the ${name}.`
}

/**
 * Some local models echo the full call envelope as the tool input, e.g.
 *   { name: "write_file", arguments: { path, content } }
 * instead of the bare { path, content }. Unwrap to the inner arguments so
 * validation/handlers see the real fields — otherwise the model loops,
 * re-emitting the same malformed call until the repeat-kill fires.
 */
function unwrapEnvelope(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!('arguments' in input)) return input
  if ('name' in input && input.name !== name) return input
  let args = input.arguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return input }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>
  return input
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

/** Record a path the model now knows the current state of (read or wrote). */
function markSeen(name: string, input: unknown, seen: Set<string>): void {
  if (name !== 'read_file' && name !== 'edit_file' && name !== 'write_file') return
  const p = (input as { path?: unknown }).path
  if (typeof p !== 'string' || !p) return
  try { seen.add(confinePath(p)) } catch { /* confinement error surfaced by tool */ }
}

export interface RunAgentOpts {
  model: string
  cwd: string
  history: MiiMessage[]
  userText: string
  /** Base64-encoded images attached to this turn's user message. */
  images?: string[]
  permissions: PermissionContext
  hooks?: HookBus
  signal?: AbortSignal
  num_ctx?: number
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
  const startTime = Date.now()
  const system = buildSystemPrompt(TOOLS, cwd, loadProjectContext(cwd))
  const ollamaTools = toOllamaTools(TOOLS)
  const toolNames = TOOLS.map((t) => t.name)
  const cfg = loadConfig()
  // Effort drives temperature + output cap. high → num_predict -1 (unlimited),
  // which ollama.chat omits so the model runs to its own stop.
  const effort = EFFORT_OPTIONS[cfg.effort ?? 'medium']
  // Cap the requested context window so a model advertising a huge training
  // window (e.g. 131072) doesn't make Ollama allocate a KV cache that OOMs the
  // machine. Override with numCtxCap in config.json. Never raises a small window.
  const ctxCap = cfg.numCtxCap && cfg.numCtxCap > 0 ? cfg.numCtxCap : DEFAULT_NUM_CTX_CAP
  const cappedCtx =
    typeof num_ctx === 'number' && num_ctx > 0 ? Math.min(num_ctx, ctxCap) : undefined

  const history: MiiMessage[] = [
    ...opts.history,
    {
      role: 'user',
      content: opts.userText,
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
  // Canonical paths the model has read (or written) this run — gates edit/write.
  const seenPaths = new Set<string>()

  // Set when the model finishes on its own (end_turn). If we fall out of the
  // loop with this still false, we hit MAX_TURNS mid-task — surface it instead
  // of yielding a bare `done`, which reads as "completed successfully".
  let endedCleanly = false

  for (let turn = 0; turn < MAX_TURNS; turn++) {
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
      endedCleanly = true
      yield { type: 'turn-end', stop_reason: 'end_turn' }
      break
    }

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

    for (const u of tool_uses) yield { type: 'tool-use', block: u }

    const results: ToolResultBlock[] = []
    for (const use of tool_uses) {
      const tool = getTool(use.name)
      if (!tool) {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Unknown tool: ${use.name}`,
          is_error: true,
        }
        results.push(r)
        yield { type: 'tool-result', block: r }
        continue
      }

      use.input = unwrapEnvelope(use.name, use.input)
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
        results.push(r)
        yield { type: 'tool-result', block: r }
        continue
      }

      const decision = await check(use.name, use.input, permissions)
      if (decision === 'deny') {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Permission denied for ${use.name}.`,
          is_error: true,
        }
        results.push(r)
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
        results.push(r)
        yield { type: 'tool-result', block: r }
        continue
      }

      // Hooks are best-effort: a throwing hook must never break the
      // tool_use → tool_result block invariant the model relies on.
      try { await hooks?.firePre(use) } catch { /* hook error ignored */ }
      let r: ToolResultBlock
      try {
        const out = await tool.handler(use.input)
        r = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: out.content,
          is_error: out.is_error,
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
      try { await hooks?.firePost(use, r) } catch { /* hook error ignored */ }
      results.push(r)
      yield { type: 'tool-result', block: r }
    }

    history.push({ role: 'user', content: results as ContentBlock[] })
    yield { type: 'turn-end', stop_reason: 'tool_use' }
  }

  if (!endedCleanly) {
    yield {
      type: 'error',
      message: `Stopped after ${MAX_TURNS} tool-use turns — the task may be incomplete. Send another message to continue where it left off.`,
    }
  }
  yield { type: 'done', prompt_tokens: promptTokens, eval_tokens: evalTokens }
  return history
}
