import type { ChatMessage, ToolResultDisplay, ToolUseDisplay } from './types.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface Todo { content: string; status: TodoStatus }

const STATUSES = new Set<string>(['pending', 'in_progress', 'completed'])

/** The list a write_todos call carried, or null if it isn't one the tool would accept. */
export function parseTodos(input: Record<string, unknown>): Todo[] | null {
  const list = input.todos
  if (!Array.isArray(list) || !list.length) return null
  const todos: Todo[] = []
  for (const t of list) {
    if (!t || typeof t !== 'object') return null
    const { content, status } = t as Record<string, unknown>
    if (typeof content !== 'string' || !content.trim() || typeof status !== 'string' || !STATUSES.has(status)) return null
    todos.push({ content: content.trim(), status: status as TodoStatus })
  }
  return todos
}

/**
 * The agent's current task list: the last write_todos call it made, read from
 * the newest step backwards. Each call replaces the whole list, so the newest
 * one the tool accepted is the board. A call the tool rejected is skipped —
 * the model will resend a fixed one. A list finished before the user's latest
 * message is spent: it belongs to an earlier turn and isn't brought back.
 */
export function latestTodos(
  messages: Array<Partial<Pick<ChatMessage, 'role'>> & Pick<ChatMessage, 'tool_uses' | 'tool_results'>>,
): Todo[] | null {
  let earlierTurn = false
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') earlierTurn = true
    const uses: ToolUseDisplay[] = messages[i].tool_uses ?? []
    const results: ToolResultDisplay[] = messages[i].tool_results ?? []
    for (let j = uses.length - 1; j >= 0; j--) {
      const u = uses[j]
      if (u.name !== 'write_todos') continue
      if (results.find((r) => r.tool_use_id === u.id)?.is_error) continue
      const todos = parseTodos(u.input)
      if (todos) return earlierTurn && todos.every((t) => t.status === 'completed') ? null : todos
    }
  }
  return null
}

/**
 * The rows to draw when the list is longer than the room for it: a window that
 * keeps the task in flight in view, with one finished task above it for
 * context, and counts of what was cut either side.
 */
export function todoWindow(todos: Todo[], max: number): { items: Todo[]; above: number; below: number } {
  if (todos.length <= max) return { items: todos, above: 0, below: 0 }
  const active = todos.findIndex((t) => t.status === 'in_progress')
  const firstOpen = todos.findIndex((t) => t.status !== 'completed')
  const focus = active >= 0 ? active : firstOpen >= 0 ? firstOpen : todos.length - 1
  const start = Math.max(0, Math.min(focus - 1, todos.length - max))
  return { items: todos.slice(start, start + max), above: start, below: todos.length - start - max }
}
