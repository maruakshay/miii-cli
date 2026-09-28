import { describe, it, expect } from 'vitest'
import { mergeToolSteps } from './mergeSteps.js'
import type { ChatMessage } from './types.js'

const step = (content: string, ...tools: Array<[id: string, name: string]>): ChatMessage => ({
  role: 'assistant',
  content,
  tool_uses: tools.length ? tools.map(([id, name]) => ({ id, name, input: {} })) : undefined,
  tool_results: tools.length ? tools.map(([id]) => ({ tool_use_id: id, content: 'ok' })) : undefined,
})
const names = (m: ChatMessage) => (m.tool_uses ?? []).map((u) => u.id)

describe('mergeToolSteps', () => {
  it('folds tool-only steps into the step before them', () => {
    const out = mergeToolSteps([
      { role: 'user', content: 'go' },
      step('Looking around.', ['a', 'read_file']),
      step('', ['b', 'read_file']),
      step('', ['c', 'read_file']),
    ])
    expect(out).toHaveLength(2)
    expect(out[1].content).toBe('Looking around.')
    expect(names(out[1])).toEqual(['a', 'b', 'c'])
    expect(out[1].tool_results?.map((r) => r.tool_use_id)).toEqual(['a', 'b', 'c'])
  })

  it('starts a new block when the agent says something, or the user does', () => {
    const out = mergeToolSteps([
      step('', ['a', 'read_file']),
      step('Now the tests.', ['b', 'run_bash']),
      { role: 'user', content: 'use tabs' },
      step('', ['c', 'read_file']),
    ])
    expect(out.map(names)).toEqual([['a'], ['b'], [], ['c']])
  })

  it('never folds across turns', () => {
    const done = { ...step('Done.', ['a', 'read_file']), tokens: { prompt_eval: 1, eval: 1 } }
    const out = mergeToolSteps([done, step('', ['b', 'read_file'])])
    expect(out).toHaveLength(2)
  })

  it('carries the final step\'s closing line onto the merged block', () => {
    const last = { ...step('', ['b', 'read_file']), tokens: { prompt_eval: 5, eval: 5 }, duration: 10 }
    const out = mergeToolSteps([step('Reading.', ['a', 'read_file']), last])
    expect(out).toHaveLength(1)
    expect(out[0].tokens).toEqual({ prompt_eval: 5, eval: 5 })
  })

  it('hides the task list, so it neither shows nor breaks a run of reads', () => {
    const out = mergeToolSteps([
      step('', ['a', 'read_file']),
      step('', ['t', 'write_todos']),
      step('', ['b', 'read_file']),
    ])
    expect(out).toHaveLength(1)
    expect(names(out[0])).toEqual(['a', 'b'])
  })

  it('drops a step that only updated the task list', () => {
    const out = mergeToolSteps([{ role: 'user', content: 'go' }, step('', ['t', 'write_todos'])])
    expect(out).toHaveLength(1)
  })
})
