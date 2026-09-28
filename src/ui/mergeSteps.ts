import type { ChatMessage } from './types.js'

/**
 * Tools whose calls never reach the transcript. The task list is the agent's
 * own bookkeeping — it plans better with one — but redrawn on every update it's
 * noise between the steps the user actually cares about.
 */
const HIDDEN_TOOLS = new Set(['write_todos'])

export function isHiddenTool(name: string): boolean {
  return HIDDEN_TOOLS.has(name)
}

function stripHidden(m: ChatMessage): ChatMessage {
  if (!m.tool_uses?.some((u) => HIDDEN_TOOLS.has(u.name))) return m
  const uses = m.tool_uses.filter((u) => !HIDDEN_TOOLS.has(u.name))
  const ids = new Set(uses.map((u) => u.id))
  return {
    ...m,
    tool_uses: uses.length ? uses : undefined,
    tool_results: m.tool_results?.filter((r) => ids.has(r.tool_use_id)),
  }
}

/** A message with nothing left to draw — say, a step that only updated the task list. */
function isEmpty(m: ChatMessage): boolean {
  return m.role === 'assistant' && !m.content.trim() && !m.tool_uses?.length && !m.tokens && !m.thinking?.trim()
}

/**
 * Fold a turn's tool-only steps into the step before them, so calls the agent
 * made across several steps read as one run: three reads in a row become one
 * "Read 3 files" block instead of three separate ones. Only a step with no text
 * of its own is folded in — anything the agent said, and anything the user
 * sent, stays where it happened and starts a new block.
 */
export function mergeToolSteps(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const raw of messages) {
    const m = stripHidden(raw)
    const prev = out[out.length - 1]
    const foldable =
      prev?.role === 'assistant' &&
      m.role === 'assistant' &&
      !prev.tokens && // the previous turn ended there
      !!prev.tool_uses?.length &&
      !m.content.trim()
    if (foldable) {
      out[out.length - 1] = {
        ...prev,
        thinking: [prev.thinking, m.thinking].filter((t) => t?.trim()).join('\n\n') || undefined,
        tool_uses: [...prev.tool_uses!, ...(m.tool_uses ?? [])],
        tool_results: [...(prev.tool_results ?? []), ...(m.tool_results ?? [])],
        tokens: m.tokens,
        duration: m.duration,
        summary: m.summary,
      }
    } else if (!isEmpty(m)) {
      out.push(m)
    }
  }
  return out
}

/**
 * Give each step's text and its tool calls separate blocks, before folding.
 *
 * Committed blocks print once into the terminal's scrollback and can't change
 * after that, but a tool block keeps growing for as long as the turn folds more
 * calls into it. Splitting means the only block ever still growing is a run of
 * tool calls: what the agent said above it is final the moment its step lands,
 * so it can print straight away instead of waiting on every tool after it. The
 * two draw exactly as the combined block did — one blank row apart either way.
 */
export function splitTextFromTools(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role !== 'assistant' || !m.content.trim() || !m.tool_uses?.length) return [m]
    const { tool_uses, tool_results, tokens, duration, summary, ...text } = m
    return [text, { role: 'assistant', content: '', tool_uses, tool_results, tokens, duration, summary }]
  })
}

/**
 * How many of `blocks` are final. A turn in flight can still fold calls into
 * its last block when that block is a run of tools the turn hasn't ended on;
 * everything before it — and everything, once the turn is over — is settled.
 */
export function settledCount(blocks: ChatMessage[], busy: boolean): number {
  const last = blocks[blocks.length - 1]
  const open = busy && last?.role === 'assistant' && !!last.tool_uses?.length && !last.tokens
  return open ? blocks.length - 1 : blocks.length
}
