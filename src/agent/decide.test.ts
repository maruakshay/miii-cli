import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MiiMessage } from './types.js'

const h = vi.hoisted(() => ({
  // What the judge model "says". A string is streamed as one content chunk;
  // an Error is thrown from the generator.
  reply: '' as string | Error,
  // Captured so the tests can pin what we actually send the judge.
  lastCall: null as null | { model: string; messages: unknown; opts: Record<string, unknown> },
  // Set to hang the stream until the passed signal aborts — the timeout path.
  hang: false,
}))

vi.mock('../llm/client.js', () => ({
  chat: async function* (
    model: string,
    messages: unknown,
    _tools: unknown,
    opts: Record<string, unknown>,
  ) {
    h.lastCall = { model, messages, opts }
    if (h.hang) {
      const signal = opts.signal as AbortSignal
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return
    }
    if (h.reply instanceof Error) throw h.reply
    yield { content: h.reply, done: false }
    yield { content: '', done: true }
  },
}))

const { askBool, parseJudgment, stopGate, toolTrail, deciderEnabled, threshold } = await import('./decide.js')

const CFG = { model: 'judge:1.5b' }

beforeEach(() => {
  h.reply = ''
  h.lastCall = null
  h.hang = false
})

describe('parseJudgment', () => {
  it('reads a clean object', () => {
    expect(parseJudgment('{"value":false,"confidence":0.9,"reason":"tests never ran"}')).toEqual({
      value: false,
      confidence: 0.9,
      reason: 'tests never ran',
    })
  })

  it('digs the object out of fences and prose', () => {
    const text = 'Sure!\n```json\n{"value": true, "confidence": 0.8, "reason": "done"}\n```\nHope that helps.'
    expect(parseJudgment(text)?.value).toBe(true)
  })

  it('accepts a stringified verdict and confidence', () => {
    const j = parseJudgment('{"value":"yes","confidence":"0.55","reason":"ok"}')
    expect(j).toEqual({ value: true, confidence: 0.55, reason: 'ok' })
  })

  it('rescales a percentage confidence', () => {
    expect(parseJudgment('{"value":false,"confidence":85,"reason":"x"}')?.confidence).toBe(0.85)
  })

  it('clamps out-of-range confidence', () => {
    expect(parseJudgment('{"value":false,"confidence":-3,"reason":"x"}')?.confidence).toBe(0)
  })

  it('returns null rather than guessing at junk', () => {
    expect(parseJudgment('probably not')).toBeNull()
    expect(parseJudgment('{"value":"maybe","confidence":0.9,"reason":"x"}')).toBeNull()
    expect(parseJudgment('{"value":false,"reason":"x"}')).toBeNull()
    expect(parseJudgment('{"value":false,"confidence":0.5,')).toBeNull()
  })
})

describe('deciderEnabled / threshold', () => {
  it('is off without a model, and off when switched off', () => {
    expect(deciderEnabled(undefined)).toBe(false)
    expect(deciderEnabled({})).toBe(false)
    expect(deciderEnabled({ model: '  ' })).toBe(false)
    expect(deciderEnabled({ model: 'm', enabled: false })).toBe(false)
    expect(deciderEnabled({ model: 'm' })).toBe(true)
  })

  it('falls back to the default threshold for a nonsense one', () => {
    expect(threshold({ model: 'm' })).toBe(0.7)
    expect(threshold({ model: 'm', threshold: 0.9 })).toBe(0.9)
    expect(threshold({ model: 'm', threshold: 5 })).toBe(0.7)
  })
})

describe('askBool', () => {
  it('asks the judge model with deterministic, non-thinking, schema-bound options', async () => {
    h.reply = '{"value":true,"confidence":0.9,"reason":"yes"}'
    await askBool('Q?', 'S', CFG)
    expect(h.lastCall?.model).toBe('judge:1.5b')
    expect(h.lastCall?.opts.temperature).toBe(0)
    expect(h.lastCall?.opts.think).toBe(false)
    expect(h.lastCall?.opts.format).toMatchObject({ type: 'object' })
    // No tools: a decision box that could call a tool is just another agent.
    expect((h.lastCall as { messages: Array<{ content: string }> }).messages[1].content).toContain('Q?')
  })

  it('has no opinion when the decider is unconfigured', async () => {
    expect(await askBool('Q?', 'S', {})).toBeNull()
  })

  it('has no opinion when the provider throws', async () => {
    h.reply = new Error('model not found')
    expect(await askBool('Q?', 'S', CFG)).toBeNull()
  })

  it('has no opinion when the judge blows its deadline', async () => {
    h.hang = true
    expect(await askBool('Q?', 'S', { ...CFG, timeoutMs: 20 })).toBeNull()
  })

  it('has no opinion once the run is aborted', async () => {
    h.reply = '{"value":false,"confidence":1,"reason":"nope"}'
    const ctl = new AbortController()
    ctl.abort()
    expect(await askBool('Q?', 'S', CFG, ctl.signal)).toBeNull()
  })
})

describe('toolTrail', () => {
  const history: MiiMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: '1', name: 'read_file', input: { path: 'src/a.ts' } },
        { type: 'tool_use', id: '2', name: 'run_bash', input: { command: 'npm  test' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: '1', content: 'ok' },
        { type: 'tool_result', tool_use_id: '2', content: 'boom', is_error: true },
      ],
    },
  ]

  it('pairs each call with its outcome', () => {
    expect(toolTrail(history)).toEqual(['read_file(src/a.ts) ok', 'run_bash(npm test) failed'])
  })

  it('is empty for a conversation that ran nothing', () => {
    expect(toolTrail([{ role: 'user', content: 'hi' }])).toEqual([])
  })

  it('keeps only the most recent calls', () => {
    const many: MiiMessage[] = []
    for (let i = 0; i < 50; i++) {
      many.push({ role: 'assistant', content: [{ type: 'tool_use', id: `${i}`, name: 'echo', input: {} }] })
      many.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `${i}`, content: 'ok' }] })
    }
    expect(toolTrail(many)).toHaveLength(30)
  })
})

describe('stopGate', () => {
  const base = {
    userText: 'rename foo to bar everywhere',
    finalText: 'Done!',
    history: [
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: '1', name: 'edit_file', input: { path: 'a.ts' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: '1', content: 'ok' }] },
    ],
    cfg: CFG,
  }

  it('returns the missing work when the judge is confidently unconvinced', async () => {
    h.reply = '{"value":false,"confidence":0.95,"reason":"only one of three call sites was renamed"}'
    expect(await stopGate(base)).toBe('only one of three call sites was renamed')
  })

  it('shows the judge the request, the trail and the closing message — not the conversation', async () => {
    h.reply = '{"value":true,"confidence":0.9,"reason":"done"}'
    await stopGate(base)
    const state = (h.lastCall as { messages: Array<{ content: string }> }).messages[1].content
    expect(state).toContain('rename foo to bar everywhere')
    expect(state).toContain('edit_file(a.ts) ok')
    expect(state).toContain('Done!')
  })

  it('stays quiet when the judge agrees the work is finished', async () => {
    h.reply = '{"value":true,"confidence":0.99,"reason":"all sites renamed"}'
    expect(await stopGate(base)).toBeNull()
  })

  it('stays quiet on a coin flip', async () => {
    h.reply = '{"value":false,"confidence":0.4,"reason":"maybe missed something"}'
    expect(await stopGate(base)).toBeNull()
  })

  it('respects a stricter configured threshold', async () => {
    h.reply = '{"value":false,"confidence":0.8,"reason":"tests not run"}'
    expect(await stopGate({ ...base, cfg: { ...CFG, threshold: 0.9 } })).toBeNull()
    expect(await stopGate({ ...base, cfg: { ...CFG, threshold: 0.75 } })).toBe('tests not run')
  })

  it('stays quiet when unconfigured, without calling any model', async () => {
    expect(await stopGate({ ...base, cfg: {} })).toBeNull()
    expect(h.lastCall).toBeNull()
  })

  it('substitutes wording when the judge refuses but says nothing useful', async () => {
    h.reply = '{"value":false,"confidence":0.9,"reason":"  "}'
    expect(await stopGate(base)).toBe('part of the request has not been carried out yet')
  })
})
