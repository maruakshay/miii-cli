import { describe, it, expect } from 'vitest'
import { write_todos } from './write_todos.js'

const run = (input: unknown) => write_todos.handler(input as Parameters<typeof write_todos.handler>[0])

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
    expect(res.content).toContain('[x] Read edit_file.ts')
    expect(res.content).toContain('[~] Add webfetch tool')
    expect(res.content).toContain('[ ] Wire into registry')
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
})
