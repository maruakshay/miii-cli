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
