import { chat } from '../llm/client.js'
import { TOOLS, getTool, toOllamaTools } from '../tools/registry.js'
import { validateInput } from '../tools/validate.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { check, type PermissionContext } from '../permissions/policy.js'
import { HookBus } from '../hooks/bus.js'
import { toOllamaMessages, blocksFromOllama } from './adapter.js'
import type {
  MiiMessage,
  AgentEvent,
  ToolUse,
  ToolResultBlock,
  ContentBlock,
} from './types.js'

const MAX_TURNS = 25
const NUM_PREDICT = 8192
const REPEAT_TAIL = 120
const REPEAT_KILL = 4

export interface RunAgentOpts {
  model: string
  cwd: string
  history: MiiMessage[]
  userText: string
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
  const system = buildSystemPrompt(TOOLS, cwd)
  const ollamaTools = toOllamaTools(TOOLS)

  const history: MiiMessage[] = [
    ...opts.history,
    { role: 'user', content: opts.userText },
  ]

  let promptTokens = 0
  let evalTokens = 0
  let lastAssistantSig = ''
  let repeatCount = 0

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let text = ''
    let tool_calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> | undefined

    let lastTail = ''
    let tailRepeats = 0
    let streamLooped = false
    const ac = new AbortController()
    const composedSignal = signal
      ? (AbortSignal.any ? AbortSignal.any([signal, ac.signal]) : ac.signal)
      : ac.signal
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true })

    try {
      for await (const chunk of chat(model, toOllamaMessages(history, system), ollamaTools, { signal: composedSignal, num_ctx, num_predict: NUM_PREDICT })) {
        if (signal?.aborted) break
        if (chunk.content) {
          text += chunk.content
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
        if (chunk.thinking) {
          yield { type: 'thinking-delta', text: chunk.thinking }
        }
        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          tool_calls = chunk.tool_calls
        }
        if (chunk.done) {
          promptTokens += chunk.prompt_eval_count ?? 0
          evalTokens += chunk.eval_count ?? 0
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

    const blocks = blocksFromOllama(text, tool_calls, TOOLS.map((t) => t.name))
    const tool_uses = blocks.filter((b): b is ToolUse => b.type === 'tool_use')

    history.push({ role: 'assistant', content: blocks })

    if (tool_uses.length === 0) {
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

      const invalid = validateInput(tool.input_schema, use.input)
      if (invalid) {
        const r: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `${invalid} for ${use.name}.`,
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
      try { await hooks?.firePost(use, r) } catch { /* hook error ignored */ }
      results.push(r)
      yield { type: 'tool-result', block: r }
    }

    history.push({ role: 'user', content: results as ContentBlock[] })
    yield { type: 'turn-end', stop_reason: 'tool_use' }
  }

  yield { type: 'done', prompt_tokens: promptTokens, eval_tokens: evalTokens }
  return history
}
