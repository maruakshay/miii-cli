import type { Tool } from './types.js'

// A task-list item. The model either draws the whole board (`todos`) or moves
// cards on the board it already drew (`updates`, by item number). The tool
// keeps no state of its own: the harness replays the accepted calls to hand it
// the current board. Status is the "column": pending → in_progress → completed.
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

interface TodoUpdate {
  id: number
  status: TodoStatus
}

interface Input {
  todos?: TodoItem[]
  updates?: TodoUpdate[]
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']

// Words models reach for instead of the three real statuses, keyed with case,
// spaces, dashes and underscores stripped.
const STATUS_WORDS: Record<string, TodoStatus> = {
  pending: 'pending', todo: 'pending', notstarted: 'pending', open: 'pending',
  inprogress: 'in_progress', active: 'in_progress', doing: 'in_progress', started: 'in_progress', wip: 'in_progress',
  completed: 'completed', complete: 'completed', done: 'completed', finished: 'completed',
}

/** The status a model meant, or null if the word isn't one we recognise. */
export function toStatus(value: unknown): TodoStatus | null {
  if (typeof value !== 'string') return null
  return STATUS_WORDS[value.trim().toLowerCase().replace(/[\s_-]/g, '')] ?? null
}

// Board glyphs mirror the three columns so the model's returned text reads like
// the UI: done, doing, todo.
const MARK: Record<TodoStatus, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
}

/** Render the list back to the model, numbered so it can target items by id. */
function render(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'completed').length
  const header = `Todos (${done}/${todos.length} done):`
  const lines = todos.map((t, i) => `${i + 1}. ${MARK[t.status]} ${t.content}`)
  return [header, ...lines].join('\n')
}

export type TodoOutcome = { todos: TodoItem[]; notes: string[] } | { error: string }

/**
 * Apply one write_todos call to the current board. Pure, so the tool, the agent
 * loop and the UI all arrive at the same list from the same calls.
 */
export function applyTodos(prev: TodoItem[] | null, input: Input): TodoOutcome {
  const { todos, updates } = input
  const hasUpdates = Array.isArray(updates) && updates.length > 0
  const notes: string[] = []
  let board: TodoItem[]

  if (todos !== undefined && !(Array.isArray(todos) && todos.length === 0 && hasUpdates)) {
    if (!Array.isArray(todos)) return { error: 'I need a todos array here — pass the full list of tasks.' }
    if (todos.length === 0) {
      return {
        error:
          'The todo list is empty — give me at least one task. To change a status, send ' +
          'updates: [{id, status}] instead; to start a new list, send it in full.',
      }
    }
    board = []
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i]
      if (!t || typeof t.content !== 'string' || t.content.trim() === '') {
        return { error: `Task #${i + 1} needs some text — its content can't be empty.` }
      }
      const status = toStatus(t.status)
      if (!status) return { error: `Task #${i + 1} has an unknown status. Use one of: ${STATUSES.join(', ')}.` }
      board.push({ content: t.content.trim(), status })
    }
    // A rewrite that silently loses open work is the usual way the board goes
    // wrong; say so, so the model can put them back.
    const kept = new Set(board.map((t) => t.content))
    const dropped = (prev ?? []).filter((t) => t.status !== 'completed' && !kept.has(t.content))
    if (dropped.length) {
      notes.push(
        `This replaced the previous list and dropped ${dropped.length} unfinished task(s): ` +
          `${dropped.map((t) => `"${t.content}"`).join(', ')}. If that wasn't intended, resend ` +
          'them — or use updates: [{id, status}] to change statuses without rewriting the list.',
      )
    }
  } else if (hasUpdates) {
    if (!prev?.length) return { error: 'There is no task list yet — create one by sending todos with the full list.' }
    board = prev.map((t) => ({ ...t }))
  } else {
    return { error: 'Send todos (the full list) to create or replace the board, or updates: [{id, status}] to change items on it.' }
  }

  if (hasUpdates) {
    const started = new Set<number>()
    const touched = new Set<number>()
    for (const u of updates!) {
      const id = Number(u?.id)
      if (!Number.isInteger(id) || id < 1 || id > board.length) {
        return { error: `Update id ${String(u?.id)} doesn't match a task — ids run 1 to ${board.length}, as numbered in the list.` }
      }
      const status = toStatus(u.status)
      if (!status) return { error: `Update for task ${id} has an unknown status. Use one of: ${STATUSES.join(', ')}.` }
      board[id - 1].status = status
      touched.add(id - 1)
      if (status === 'in_progress') started.add(id - 1)
    }
    // Starting the next task means the one in flight is done — that's the order
    // the model is told to work in, so finish it rather than refuse the call.
    if (started.size === 1) {
      board.forEach((t, i) => {
        if (t.status === 'in_progress' && !touched.has(i)) {
          t.status = 'completed'
          notes.push(`Marked "${t.content}" completed, since you started the next task.`)
        }
      })
    }
  }

  // Kanban WIP rule: at most one task in flight so "current" is unambiguous.
  const active = board.filter((t) => t.status === 'in_progress').length
  if (active > 1) {
    return { error: `Keep just one task in progress at a time — I see ${active}. Finish one before starting the next.` }
  }
  return { todos: board, notes }
}

/** The board after a run of calls, oldest first; calls the tool refused are skipped. */
export function replayTodos(calls: Iterable<Record<string, unknown>>): TodoItem[] | null {
  let board: TodoItem[] | null = null
  for (const input of calls) {
    const out = applyTodos(board, input as Input)
    if ('todos' in out) board = out.todos
  }
  return board
}

export const write_todos: Tool<Input> = {
  name: 'write_todos',
  description:
    'Task list for multi-step work; miii shows it to the user, so never write it into your reply. ' +
    'Create or replace it with todos (the FULL ordered list). Then move work along with updates: [{id, status}] using the item numbers in the last result; starting the next item completes the current one. ' +
    'Status: pending | in_progress | completed, one in_progress at a time. Skip it for trivial actions.',
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full ordered list; replaces the old one.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short task description (imperative, e.g. "Add webfetch tool").' },
            status: { type: 'string', enum: STATUSES, description: 'pending | in_progress | completed' },
          },
          required: ['content', 'status'],
        },
      },
      updates: {
        type: 'array',
        description: 'Status changes by item number.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Item number, from 1.' },
            status: { type: 'string', enum: STATUSES },
          },
          required: ['id', 'status'],
        },
      },
    },
  },
  handler: (input, ctx) => {
    const out = applyTodos(ctx?.todos ?? null, input)
    if ('error' in out) return { content: out.error, is_error: true }
    return { content: [render(out.todos), ...out.notes].join('\n\n') }
  },
}
