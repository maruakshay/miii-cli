import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentEvent, MiiMessage, ToolResultBlock, ToolUse } from './types.js'

// Shared mutable state for the mocked modules. Declared via vi.hoisted so the
// vi.mock factories (which are hoisted above imports) can reference it.
const h = vi.hoisted(() => ({
  // script[i] = the chunk sequence chat() yields on its i-th call this test.
  script: [] as Array<Array<Record<string, unknown>>>,
  callIndex: 0,
  // When a script slot is missing, emit a tool call (unique input per turn so
  // the identical-output guard never fires) instead of ending. Drives MAX_TURNS.
  alwaysTool: false,
  // name -> handler; falls back to `${name} ok`.
  toolHandlers: {} as Record<string, (input: unknown) => unknown>,
  // permission decision for every call.
  decision: 'allow' as 'allow' | 'deny',
  // How many times check() was consulted — proves we stop asking after a cancel.
  checkCalls: 0,
  // Runs inside check(); lets a test cancel the turn mid-permission-prompt.
  onCheck: undefined as undefined | (() => void),
  // validateInput result: null = valid.
  validateResult: null as string | null,
}))

vi.mock('../llm/client.js', () => ({
  chat: async function* (
    _model: string,
    _messages: unknown,
    _tools: unknown,
    opts?: { signal?: AbortSignal },
  ) {
    const i = h.callIndex++
    if (opts?.signal?.aborted) return
    let chunks = h.script[i]
    if (!chunks) {
      chunks = h.alwaysTool
        ? [
            { content: '', done: false, tool_calls: [{ function: { name: 'echo', arguments: { n: i } } }] },
            { content: '', done: true, prompt_eval_count: 1, eval_count: 1 },
          ]
        : [{ content: '', done: true, prompt_eval_count: 1, eval_count: 1 }]
    }
    for (const c of chunks) {
      if (opts?.signal?.aborted) return
      yield c
    }
  },
}))

const KNOWN = ['echo', 'run_bash']
function makeTool(name: string) {
  return {
    name,
    description: '',
    input_schema: { type: 'object', properties: {} },
    handler: async (input: unknown) => {
      const fn = h.toolHandlers[name]
      return fn ? fn(input) : { content: `${name} ok` }
    },
  }
}
vi.mock('../tools/registry.js', () => ({
  TOOLS: [makeTool('echo'), makeTool('run_bash')],
  getTool: (name: string) => (KNOWN.includes(name) ? makeTool(name) : undefined),
  toOllamaTools: () => [],
}))

vi.mock('../tools/validate.js', () => ({
  validateInput: () => h.validateResult,
  exampleInput: () => '{}',
}))

vi.mock('../prompt/system.js', () => ({ buildSystemPrompt: () => 'SYS' }))
vi.mock('../prompt/context.js', () => ({ loadProjectContext: () => '' }))
vi.mock('../permissions/policy.js', () => ({
  check: async () => {
    h.checkCalls++
    h.onCheck?.()
    return h.decision
  },
}))
vi.mock('../config.js', () => ({
  loadConfig: () => ({ effort: 'medium' }),
  EFFORT_OPTIONS: { medium: { num_predict: -1, temperature: 0.5 } },
  DEFAULT_NUM_CTX_CAP: 8192,
}))

// Imported after the mocks are registered. adapter.js is intentionally NOT
// mocked — the real block assembly is part of what we're pinning.
const { runAgent } = await import('./loop.js')

// ---- helpers -------------------------------------------------------------

function textThenDone(text: string): Array<Record<string, unknown>> {
  return [
    { content: text, done: false },
    { content: '', done: true, prompt_eval_count: 3, eval_count: 5 },
  ]
}
function toolThenDone(
  calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }>,
  doneExtra: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  return [
    { content: '', done: false, tool_calls: calls },
    { content: '', done: true, prompt_eval_count: 3, eval_count: 5, ...doneExtra },
  ]
}
function call(name: string, args: Record<string, unknown> = {}) {
  return { function: { name, arguments: args } }
}

interface DriveResult {
  events: AgentEvent[]
  history: MiiMessage[]
}
async function drive(overrides: Partial<Parameters<typeof runAgent>[0]> = {}): Promise<DriveResult> {
  const gen = runAgent({
    model: 'm',
    cwd: '/tmp',
    history: [],
    userText: 'hi',
    permissions: {} as never,
    ...overrides,
  })
  const events: AgentEvent[] = []
  let res = await gen.next()
  while (!res.done) {
    events.push(res.value)
    res = await gen.next()
  }
  return { events, history: res.value }
}

function types(events: AgentEvent[]): string[] {
  return events.map((e) => e.type)
}

/** tool_result blocks of the message following the first assistant tool_use. */
function firstResults(history: MiiMessage[]): ToolResultBlock[] {
  const i = history.findIndex(
    (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'),
  )
  return history[i + 1].content as ToolResultBlock[]
}

/**
 * Core block-ordering invariant the model contract depends on: every assistant
 * message carrying tool_use blocks is immediately followed by a user message
 * whose tool_result blocks are one-per-use, in the same order, with matching ids.
 */
function assertBlockOrdering(history: MiiMessage[]): void {
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const uses = m.content.filter((b): b is ToolUse => b.type === 'tool_use')
    if (uses.length === 0) continue
    const next = history[i + 1]
    expect(next, 'assistant tool_use must be followed by a message').toBeDefined()
    expect(next.role).toBe('user')
    expect(Array.isArray(next.content)).toBe(true)
    const results = (next.content as ToolResultBlock[]).filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(uses.length)
    results.forEach((r, idx) => expect(r.tool_use_id).toBe(uses[idx].id))
  }
}

beforeEach(() => {
  h.script = []
  h.callIndex = 0
  h.alwaysTool = false
  h.toolHandlers = {}
  h.decision = 'allow'
  h.checkCalls = 0
  h.onCheck = undefined
  h.validateResult = null
})

// ---- invariants ----------------------------------------------------------

describe('runAgent block-ordering invariant', () => {
  it('emits exactly one tool_result per tool_use, in order, right after the assistant', async () => {
    h.toolHandlers.echo = () => ({ content: 'A' })
    h.toolHandlers.run_bash = () => ({ content: 'B' })
    h.script = [toolThenDone([call('echo', { x: 1 }), call('run_bash', { cmd: 'ls' })]), textThenDone('done')]

    const { events, history } = await drive()
    assertBlockOrdering(history)

    const asst = history.find(
      (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'),
    )!
    const uses = (asst.content as ToolUse[]).filter((b) => b.type === 'tool_use')
    expect(uses.map((u) => u.name)).toEqual(['echo', 'run_bash'])

    const resultMsg = history[history.indexOf(asst) + 1]
    const results = resultMsg.content as ToolResultBlock[]
    expect(results.map((r) => r.content)).toEqual(['A', 'B'])
    expect(results.every((r) => !r.is_error)).toBe(true)

    // one tool-use event and one tool-result event per call, uses before results
    expect(types(events).filter((t) => t === 'tool-use')).toHaveLength(2)
    expect(types(events).filter((t) => t === 'tool-result')).toHaveLength(2)
  })

  it('keeps ordering when a tool handler throws (result is an error, loop continues)', async () => {
    h.toolHandlers.echo = () => {
      throw new Error('boom')
    }
    h.script = [toolThenDone([call('echo')]), textThenDone('recovered')]

    const { events, history } = await drive()
    assertBlockOrdering(history)
    const result = firstResults(history)[0]
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('boom')
    expect(types(events)).toContain('done')
  })

  it('a throwing hook never breaks the tool_use -> tool_result pairing', async () => {
    h.toolHandlers.echo = () => ({ content: 'ok' })
    h.script = [toolThenDone([call('echo')]), textThenDone('bye')]
    const hooks = {
      firePre: async () => {
        throw new Error('pre hook died')
      },
      firePost: async () => {
        throw new Error('post hook died')
      },
    }
    const { history } = await drive({ hooks: hooks as never })
    assertBlockOrdering(history)
    const result = firstResults(history)[0]
    expect(result.is_error).toBeFalsy()
    expect(result.content).toBe('ok')
  })
})

describe('runAgent stop_reason / termination', () => {
  it('flips endedCleanly on a natural finish: end_turn then done, no error', async () => {
    h.script = [textThenDone('here is the answer')]
    const { events } = await drive()
    const t = types(events)
    expect(events).toContainEqual({ type: 'turn-end', stop_reason: 'end_turn' })
    expect(t).toContain('done')
    expect(t).not.toContain('error')
    expect(t[t.length - 1]).toBe('done')
  })

  it('surfaces a MAX_TURNS error (never a bare success) when the model never stops', async () => {
    h.alwaysTool = true // 25 tool turns, unique input each → no repeat-kill
    h.toolHandlers.echo = () => ({ content: 'again' })
    const { events } = await drive()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0] as { message: string }).message).toContain('Stopped after')
    // MAX_TURNS is NOT a clean end_turn, but a done event still closes the stream
    expect(events).not.toContainEqual({ type: 'turn-end', stop_reason: 'end_turn' })
    expect(types(events)[types(events).length - 1]).toBe('done')
  })
})

describe('runAgent abort', () => {
  it('yields {type:aborted} and never {type:done} when the signal is aborted', async () => {
    const { events } = await drive({ signal: AbortSignal.abort() })
    const t = types(events)
    expect(t).toContain('aborted')
    expect(t).not.toContain('done')
    const aborted = events.find((e) => e.type === 'aborted')!
    expect(aborted).toMatchObject({ type: 'aborted' })
    expect(typeof (aborted as { duration_ms: number }).duration_ms).toBe('number')
  })

  // Esc at a permission prompt cancels the turn. The remaining tools in that
  // turn must not be prompted for or run — but each still needs a tool_result,
  // or the persisted history ends on an unmatched tool_use and the next request
  // breaks when the session resumes.
  describe('cancelled at a permission prompt', () => {
    const ac = { current: null as AbortController | null }

    async function driveCancelledMidTurn() {
      ac.current = new AbortController()
      h.script = [toolThenDone([call('run_bash', { command: 'a' }), call('run_bash', { command: 'b' })])]
      // The user hits Esc while the first prompt is up: the pending prompt
      // resolves 'no' and the run is aborted.
      h.decision = 'deny'
      h.onCheck = () => ac.current!.abort()
      return drive({ signal: ac.current.signal })
    }

    it('stops asking for permission once the turn is cancelled', async () => {
      await driveCancelledMidTurn()
      expect(h.checkCalls).toBe(1)
    })

    it('still emits one tool_result per tool_use', async () => {
      const { history } = await driveCancelledMidTurn()
      assertBlockOrdering(history)
      const results = firstResults(history)
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.is_error)).toBe(true)
      expect(results[1].content).toMatch(/[Cc]ancelled/)
    })

    it('ends the run as aborted, not as a completed turn', async () => {
      const { events } = await driveCancelledMidTurn()
      const t = types(events)
      expect(t).toContain('aborted')
      expect(t).not.toContain('done')
    })

    // The other order: the cancel lands after the first tool was already
    // approved and run. That one keeps its real result; the rest are skipped.
    it('does not run the tools left after the cancel', async () => {
      let ran = 0
      ac.current = new AbortController()
      h.script = [
        toolThenDone([
          call('run_bash', { command: 'a' }),
          call('run_bash', { command: 'b' }),
          call('run_bash', { command: 'c' }),
        ]),
      ]
      h.decision = 'allow'
      h.toolHandlers = { run_bash: () => { ran++; ac.current!.abort(); return { content: 'ran' } } }
      const { history } = await drive({ signal: ac.current.signal })

      expect(ran).toBe(1)
      assertBlockOrdering(history)
      const results = firstResults(history)
      expect(results).toHaveLength(3)
      expect(results[0]).toMatchObject({ content: 'ran' })
      expect(results[0].is_error).toBeFalsy()
      expect(results[1].content).toMatch(/[Cc]ancelled/)
      expect(results[2].content).toMatch(/[Cc]ancelled/)
    })
  })
})

describe('runAgent guards', () => {
  it('aborts with a repetition error when the stream loops on the same tail', async () => {
    const tail = 'x'.repeat(120)
    h.script = [[
      { content: tail, done: false },
      { content: tail, done: false },
      { content: tail, done: false },
      { content: tail, done: false },
      { content: tail, done: false },
      { content: '', done: true },
    ]]
    const { events } = await drive()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0] as { message: string }).message).toMatch(/repetition/i)
    expect(types(events)).not.toContain('done')
  })

  it('aborts with a loop-detected error on 3 identical assistant turns', async () => {
    h.toolHandlers.echo = () => ({ content: 'same' })
    const one = toolThenDone([call('echo', { fixed: true })])
    h.script = [one, one, one]
    const { events, history } = await drive()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0] as { message: string }).message).toMatch(/loop detected/i)
    expect(types(events)).not.toContain('done')
    // returned history must not dangle: the repeat-detected assistant turn is
    // never committed, so every assistant tool_use still has matching results.
    assertBlockOrdering(history)
    const last = history[history.length - 1]
    const lastBlocks = Array.isArray(last.content) ? last.content : []
    expect(lastBlocks.some((b) => b.type === 'tool_use')).toBe(false)
  })

  it('refuses a truncated (done_reason=length) tool call and steers to splitting, without running it', async () => {
    const echo = vi.fn(() => ({ content: 'RAN' }))
    h.toolHandlers.echo = echo
    h.script = [
      toolThenDone([call('echo', { path: 'big.ts', content: 'half' })], { done_reason: 'length' }),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(echo).not.toHaveBeenCalled()
    const result = firstResults(history)[0]
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/cut off|split|smaller/i)
  })

  it('returns an error result for an unknown tool but keeps the pairing', async () => {
    h.script = [toolThenDone([call('nope')]), textThenDone('ok')]
    const { history } = await drive()
    assertBlockOrdering(history)
    const result = firstResults(history)[0]
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Unknown tool: nope')
  })

  it('denied permission emits permission-denied + one error result per use', async () => {
    h.decision = 'deny'
    h.script = [toolThenDone([call('echo'), call('run_bash')]), textThenDone('ok')]
    const { events, history } = await drive()
    assertBlockOrdering(history)
    expect(events.filter((e) => e.type === 'permission-denied')).toHaveLength(2)
    const results = firstResults(history)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.is_error && r.content.includes('Permission denied'))).toBe(true)
  })

  it('an invalid tool call yields an error result and does not run the tool', async () => {
    h.validateResult = 'path Required'
    const echo = vi.fn(() => ({ content: 'RAN' }))
    h.toolHandlers.echo = echo
    h.script = [toolThenDone([call('echo', {})]), textThenDone('ok')]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(echo).not.toHaveBeenCalled()
    expect(firstResults(history)[0].is_error).toBe(true)
  })
})

describe('runAgent leaked-tool-call nudge', () => {
  it('nudges a leaked text call, bounded by MAX_LEAK_NUDGES, then ends cleanly', async () => {
    // Every turn the model leaks a call in a syntax the parser can't extract
    // (the <|"|> sentinel, no call:NAME wrapper) → tool_uses stays empty, so the
    // leak-detector fires instead of a real tool call being run.
    const leak = textThenDone('content:<|"|>ls -la<|"|>')
    h.script = [leak, leak, leak]
    const { events, history } = await drive()

    // exactly two nudge messages pushed into history (bounded)
    const nudges = history.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('function-calling interface'),
    )
    expect(nudges).toHaveLength(2)

    const t = types(events)
    expect(events).toContainEqual({ type: 'turn-end', stop_reason: 'end_turn' })
    expect(t).toContain('done')
    expect(t).not.toContain('error')
  })
})

describe('near-miss tool calls', () => {
  it('runs a call whose tool name is mis-spelled, under the real name', async () => {
    h.script = [toolThenDone([call('runBash', { command: 'ls' })]), textThenDone('done')]
    const { events, history } = await drive()
    const use = events.find((e) => e.type === 'tool-use') as { block: ToolUse }
    expect(use.block.name).toBe('run_bash')
    expect(firstResults(history)[0].is_error).toBeFalsy()
  })

  it('unwraps a call envelope before the tool sees it', async () => {
    let seen: unknown
    h.toolHandlers.run_bash = (input) => { seen = input; return { content: 'ok' } }
    h.script = [
      toolThenDone([call('run_bash', { name: 'run_bash', arguments: { command: 'ls' } })]),
      textThenDone('done'),
    ]
    await drive()
    expect(seen).toEqual({ command: 'ls' })
  })

  it('still reports a name that resolves to nothing', async () => {
    h.script = [toolThenDone([call('frobnicate', {})]), textThenDone('done')]
    const { history } = await drive()
    const r = firstResults(history)[0]
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('Unknown tool')
  })
})
