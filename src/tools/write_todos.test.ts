import { describe, it, expect } from 'vitest'
import { write_todos, replayTodos, type TodoItem } from './write_todos.js'
import type { ToolResult } from './types.js'

// write_todos.handler is synchronous; the Tool type widens its return to
// ToolResult | Promise<ToolResult>, so narrow it back here.
const run = (input: unknown, todos: TodoItem[] | null = null) =>
  write_todos.handler(input as Parameters<typeof write_todos.handler>[0], { todos }) as ToolResult

const board: TodoItem[] = [
  { content: 'a', status: 'completed' },
  { content: 'b', status: 'in_progress' },
  { content: 'c', status: 'pending' },
]

describe('write_todos', () => {
  it('renders a kanban-style list with a done count', () => {
    const res = run({
      todos: [
        { content: 'Read edit_file.ts', status: 'completed' },
        { content: 'Add webfetch tool', status: 'in_progress' },
        { content: 'Wire into registry', status: 'pending' },
      ],
    })
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('Todos (1/3 done):')
    expect(res.content).toContain('1. [x] Read edit_file.ts')
    expect(res.content).toContain('2. [~] Add webfetch tool')
    expect(res.content).toContain('3. [ ] Wire into registry')
  })

  it('rejects a non-array todos', () => {
    const res = run({ todos: 'nope' })
    expect(res.is_error).toBe(true)
  })

  it('rejects an empty list', () => {
    const res = run({ todos: [] })
    expect(res.is_error).toBe(true)
  })

  it('rejects an empty content string', () => {
    const res = run({ todos: [{ content: '  ', status: 'pending' }] })
    expect(res.is_error).toBe(true)
  })

  it('rejects an unknown status', () => {
    const res = run({ todos: [{ content: 'x', status: 'blocked' }] })
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('unknown status')
  })

  it('rejects more than one in_progress item', () => {
    const res = run({
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'in_progress' },
      ],
    })
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('one task in progress')
  })

  it('accepts the status words models reach for', () => {
    const res = run({ todos: [{ content: 'a', status: 'done' }, { content: 'b', status: 'In Progress' }] })
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('1. [x] a')
    expect(res.content).toContain('2. [~] b')
  })

  it('moves items by number without resending the list', () => {
    const res = run({ updates: [{ id: 2, status: 'completed' }] }, board)
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('Todos (2/3 done):')
    expect(res.content).toContain('3. [ ] c')
  })

  it('completes the task in flight when the next one starts', () => {
    const res = run({ updates: [{ id: 3, status: 'in_progress' }] }, board)
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('2. [x] b')
    expect(res.content).toContain('3. [~] c')
    expect(res.content).toContain('Marked "b" completed')
  })

  it('refuses updates with no list or an id off the end', () => {
    expect(run({ updates: [{ id: 1, status: 'completed' }] }).content).toContain('no task list yet')
    const off = run({ updates: [{ id: 9, status: 'completed' }] }, board)
    expect(off.is_error).toBe(true)
    expect(off.content).toContain('1 to 3')
  })

  it('warns when a rewrite drops unfinished work', () => {
    const res = run({ todos: [{ content: 'd', status: 'in_progress' }] }, board)
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('dropped 2 unfinished task(s): "b", "c"')
  })

  it('replays calls into the current board, skipping refused ones', () => {
    expect(replayTodos([
      { todos: board },
      { updates: [{ id: 7, status: 'completed' }] },
      { updates: [{ id: 3, status: 'in_progress' }] },
    ])).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
    ])
  })
})
