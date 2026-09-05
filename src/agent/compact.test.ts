import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MiiMessage } from './types.js'

const h = vi.hoisted(() => ({
  reply: 'summary',
  lastPrompt: '',
  lastOpts: undefined as Record<string, unknown> | undefined,
}))

vi.mock('../llm/client.js', () => ({
  chat: async function* (
    _model: string,
    messages: Array<{ content: string }>,
    _tools: unknown,
    opts?: Record<string, unknown>,
  ) {
    h.lastPrompt = messages[0].content
    h.lastOpts = opts
    yield { content: h.reply }
  },
}))

const { compactHistory, estimateHistoryTokens, COMPACT_PREAMBLE } = await import('./compact.js')

/** A summary long enough to clear the "model said nothing" guard. */
const SUMMARY = '## Goal\nShip the thing.\n## Next steps\nWrite the tests properly.'

function user(text: string): MiiMessage {
  return { role: 'user', content: text }
}
function assistant(text: string): MiiMessage {
  return { role: 'assistant', content: text }
}
/** An assistant turn calling a tool, plus the user message carrying its result. */
function toolExchange(id: string): MiiMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'file body' }] },
  ]
}

beforeEach(() => {
  h.reply = SUMMARY
  h.lastPrompt = ''
  h.lastOpts = undefined
})

describe('compactHistory', () => {
  it('replaces history with the summary plus an acknowledgement', async () => {
    const history = [user('build a parser'), assistant('done')]
    const res = await compactHistory('m', history)

    expect(res.summary).toBe(SUMMARY)
    expect(res.history).toHaveLength(2)
    expect(res.history[0].role).toBe('user')
    expect(res.history[0].content).toBe(COMPACT_PREAMBLE + SUMMARY)
    expect(res.history[1].role).toBe('assistant')
    expect(res.droppedMessages).toBe(2)
    expect(res.keptMessages).toBe(0)
  })

  it('keeps a recent tail verbatim when a context window is given', async () => {
    const history = [
      user('old task'),
      assistant('old answer'),
      user('new task'),
      assistant('new answer'),
    ]
    const res = await compactHistory('m', history, { num_ctx: 8000 })

    expect(res.keptMessages).toBeGreaterThan(0)
    // At least half the history is always folded, so the recap has something to
    // say; the tail begins at a real user turn, never mid-exchange.
    expect(res.droppedMessages).toBeGreaterThan(0)
    expect(res.history[2]).toEqual(user('new task'))
    expect(res.history.at(-1)).toEqual(assistant('new answer'))
  })

  it('never cuts between a tool_use and its tool_result', async () => {
    const history = [user('read it'), ...toolExchange('t1'), assistant('here it is')]
    const res = await compactHistory('m', history, { num_ctx: 8000 })

    const tail = res.history.slice(2)
    // The only safe cut point is the leading user turn, so either the whole
    // exchange survives or none of it does — a lone tool_result is a bug.
    const orphan = tail.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    )
    if (orphan) expect(tail[0]).toEqual(user('read it'))
  })

  it('drops the tail when it cannot fit the budget', async () => {
    const history = [user('x'.repeat(40000)), assistant('y'.repeat(40000))]
    const res = await compactHistory('m', history, { num_ctx: 4096 })

    expect(res.keptMessages).toBe(0)
    expect(res.afterTokens).toBeLessThan(res.beforeTokens)
  })

  it('summarises tool calls and results rather than dropping them', async () => {
    await compactHistory('m', [user('read it'), ...toolExchange('t1')])

    expect(h.lastPrompt).toContain('read_file')
    expect(h.lastPrompt).toContain('file body')
  })

  it('passes the focus instructions through to the model', async () => {
    await compactHistory('m', [user('hi')], { instructions: 'the auth bug only' })
    expect(h.lastPrompt).toContain('the auth bug only')
  })

  it('disables thinking so reasoning models emit a summary', async () => {
    await compactHistory('m', [user('hi')])
    expect(h.lastOpts?.think).toBe(false)
  })

  it('throws rather than returning an empty summary', async () => {
    h.reply = '  '
    await expect(compactHistory('m', [user('hi')])).rejects.toThrow(/empty summary/)
  })

  it('throws on empty history', async () => {
    await expect(compactHistory('m', [])).rejects.toThrow(/nothing to compact/)
  })
})

describe('estimateHistoryTokens', () => {
  it('grows with the transcript and counts tool blocks', () => {
    const small = estimateHistoryTokens([user('hi')])
    const big = estimateHistoryTokens([user('hi'), ...toolExchange('t1')])
    expect(big).toBeGreaterThan(small)
  })
})
