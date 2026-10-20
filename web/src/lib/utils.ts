import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Todo, TurnSummary, WebMessage } from './types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 4.2s under a minute, then 1m 05s — matches the terminal UI. */
export function fmtDuration(ms: number, precise = false) {
  const sec = ms / 1000
  if (sec < 60) return precise ? `${sec.toFixed(1)}s` : `${Math.floor(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec - m * 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/**
 * What the whole session has changed so far: each file once, lines summed.
 * Same arithmetic as sessionTally in src/ui/turnSummary.ts.
 */
export function sessionTally(summaries: Array<TurnSummary | undefined>) {
  const files = new Set<string>()
  let added = 0
  let removed = 0
  for (const s of summaries) {
    for (const f of s?.files ?? []) {
      files.add(f.path)
      added += f.added
      removed += f.removed
    }
  }
  return { files: files.size, added, removed }
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/**
 * The agent's current task list: the newest write_todos call the tool accepted.
 * Same rule as latestTodos in src/ui/todos.ts.
 */
export function latestTodos(messages: WebMessage[]): Todo[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tools = messages[i].tools ?? []
    for (let j = tools.length - 1; j >= 0; j--) {
      const t = tools[j]
      if (t.name !== 'write_todos' || t.result?.is_error) continue
      const list = t.input.todos
      if (
        Array.isArray(list) && list.length &&
        list.every((x) => x && typeof x.content === 'string' && x.content.trim() && TODO_STATUSES.has(x.status))
      ) return list as Todo[]
    }
  }
  return null
}
