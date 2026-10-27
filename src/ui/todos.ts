import { applyTodos, type TodoItem as Todo } from '../tools/write_todos.js'
import type { ChatMessage } from './types.js'

export type { TodoStatus, TodoItem as Todo } from '../tools/write_todos.js'

/**
 * The agent's current task list, rebuilt the way the tool sees it: every
 * write_todos call replayed in order, each either redrawing the board or moving
 * items on it. A call the tool rejected is skipped — the model will resend a
 * fixed one. A turn that finishes on its own closes the task it left in
 * flight — the model has stopped working, and often forgets that last update.
 * A list finished before the user's latest message is spent: it belongs to an
 * earlier turn and isn't brought back.
 */
export function latestTodos(
  messages: Array<Partial<Pick<ChatMessage, 'role' | 'summary'>> & Pick<ChatMessage, 'tool_uses' | 'tool_results'>>,
): Todo[] | null {
  const rejected = new Set<string>()
  for (const m of messages) for (const r of m.tool_results ?? []) if (r.is_error) rejected.add(r.tool_use_id)
  let board: Todo[] | null = null
  let earlierTurn = false
  for (const m of messages) {
    if (m.role === 'user') earlierTurn = true
    for (const u of m.tool_uses ?? []) {
      if (u.name !== 'write_todos' || rejected.has(u.id)) continue
      const out = applyTodos(board, u.input)
      if ('todos' in out) { board = out.todos; earlierTurn = false }
    }
    if (board && m.summary && !m.summary.stopped) {
      board = board.map((t) => (t.status === 'in_progress' ? { ...t, status: 'completed' } : t))
    }
  }
  return board && earlierTurn && board.every((t) => t.status === 'completed') ? null : board
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
