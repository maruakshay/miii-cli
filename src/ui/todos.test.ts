import { describe, expect, it } from 'vitest'
import { latestTodos, parseTodos, todoWindow, type Todo } from './todos.js'

const call = (id: string, todos: unknown) => ({ id, name: 'write_todos', input: { todos } })

describe('parseTodos', () => {
  it('accepts a well-formed list and rejects anything the tool would', () => {
    expect(parseTodos({ todos: [{ content: ' a ', status: 'pending' }] })).toEqual([{ content: 'a', status: 'pending' }])
    expect(parseTodos({ todos: [] })).toBeNull()
    expect(parseTodos({ todos: [{ content: 'a', status: 'done' }] })).toBeNull()
    expect(parseTodos({})).toBeNull()
  })
})

describe('latestTodos', () => {
  it('takes the newest accepted list, skipping one the tool rejected', () => {
    const msgs = [
      { tool_uses: [call('1', [{ content: 'old', status: 'pending' }])] },
      { tool_uses: [{ id: 'r', name: 'read_file', input: {} }, call('2', [{ content: 'new', status: 'in_progress' }])] },
      {
        tool_uses: [call('3', [{ content: 'bad', status: 'in_progress' }])],
        tool_results: [{ tool_use_id: '3', content: 'nope', is_error: true }],
      },
    ]
    expect(latestTodos(msgs)).toEqual([{ content: 'new', status: 'in_progress' }])
  })

  it('drops a list finished in an earlier turn, but keeps one left open', () => {
    const done = [{ content: 'a', status: 'completed' }]
    const open = [{ content: 'a', status: 'in_progress' }]
    expect(latestTodos([{ tool_uses: [call('1', done)] }, { role: 'user' as const }])).toBeNull()
    expect(latestTodos([{ tool_uses: [call('1', open)] }, { role: 'user' as const }])).toEqual(open)
    expect(latestTodos([{ role: 'user' as const }, { tool_uses: [call('1', done)] }])).toEqual(done)
  })

  it('is null when the agent kept no list', () => {
    expect(latestTodos([{ tool_uses: [{ id: 'r', name: 'read_file', input: {} }] }])).toBeNull()
  })
})

describe('todoWindow', () => {
  const list = (active: number): Todo[] =>
    Array.from({ length: 10 }, (_, i) => ({ content: `t${i}`, status: i < active ? 'completed' : i === active ? 'in_progress' : 'pending' }))

  it('shows everything when it fits', () => {
    expect(todoWindow(list(2), 10)).toMatchObject({ above: 0, below: 0 })
  })

  it('keeps the task in flight in view, one done task above it', () => {
    const w = todoWindow(list(6), 4)
    expect(w.items.map((t) => t.content)).toEqual(['t5', 't6', 't7', 't8'])
    expect(w).toMatchObject({ above: 5, below: 1 })
  })

  it('pins to the end when the active task is near it', () => {
    expect(todoWindow(list(9), 4)).toMatchObject({ above: 6, below: 0 })
  })
})
