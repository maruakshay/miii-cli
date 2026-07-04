import type { Tool } from './types.js'

// A task-list item. The model owns the whole list and resends it in full on
// every call — this tool is stateless, like a kanban board the model redraws
// each move. Status is the "column": pending → in_progress → completed.
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

interface TodoItem {
  content: string
  status: TodoStatus
}

interface Input {
  todos: TodoItem[]
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']

// Board glyphs mirror the three columns so the model's returned text reads like
// the UI: done, doing, todo.
const MARK: Record<TodoStatus, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
}

/** Render the list back to the model so it stays aware of what it has left. */
function render(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'completed').length
  const header = `Todos (${done}/${todos.length} done):`
  const lines = todos.map((t) => `${MARK[t.status]} ${t.content}`)
  return [header, ...lines].join('\n')
}

export const write_todos: Tool<Input> = {
  name: 'write_todos',
  description:
    'Create and maintain a task list for the current session, shown to the user as a live checklist. Pass the FULL list every call — it replaces the previous one (all or nothing), so include finished items too. Each todo is {content, status} where status is pending | in_progress | completed. Keep exactly one item in_progress at a time and mark it completed before starting the next. Use for multi-step work (features, refactors, multi-file changes) so the user can see what is done, in progress, and left. Skip it for single trivial actions.',
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full, ordered task list. Replaces the prior list entirely.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short task description (imperative, e.g. "Add webfetch tool").' },
            status: { type: 'string', enum: STATUSES, description: 'pending | in_progress | completed' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  handler: ({ todos }) => {
    if (!Array.isArray(todos)) {
      return { content: 'I need a todos array here — pass the full list of tasks.', is_error: true }
    }
    if (todos.length === 0) {
      return { content: 'The todo list is empty — give me at least one task.', is_error: true }
    }
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i]
      if (!t || typeof t.content !== 'string' || t.content.trim() === '') {
        return { content: `Task #${i + 1} needs some text — its content can't be empty.`, is_error: true }
      }
      if (!STATUSES.includes(t.status)) {
        return { content: `Task #${i + 1} has an unknown status. Use one of: ${STATUSES.join(', ')}.`, is_error: true }
      }
    }
    // Kanban WIP rule: at most one task in flight so "current" is unambiguous.
    const active = todos.filter((t) => t.status === 'in_progress').length
    if (active > 1) {
      return { content: `Keep just one task in progress at a time — I see ${active}. Finish one before starting the next.`, is_error: true }
    }
    return { content: render(todos) }
  },
}
