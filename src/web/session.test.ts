import { describe, expect, it } from 'vitest'
import { historyToWeb } from './session.js'
import type { MiiMessage } from '../agent/types.js'

describe('historyToWeb', () => {
  it('tags each user message with the history index a rewind drops back to', () => {
    const history: MiiMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'assistant', content: 'ok' },
    ]
    let id = 0
    const users = historyToWeb(history, () => ++id).filter((m) => m.role === 'user')
    expect(users.map((m) => [m.content, m.turn])).toEqual([['first', 0], ['second', 4]])
  })
})
