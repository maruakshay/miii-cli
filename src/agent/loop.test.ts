import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  // config.decider for the run. Unset = the stop gate is off, which is the
  // default every other test in this file relies on.
  decider: undefined as undefined | { model?: string },
  // What stopGate returns each time it is consulted; shift()ed, and a missing
  // entry means "no opinion". Calls are recorded for the tests that pin what
  // the gate is shown.
  gateAnswers: [] as Array<string | null>,
  gateCalls: [] as Array<{ userText: string; finalText: string }>,
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

const KNOWN = ['echo', 'run_bash', 'read_file', 'edit_file', 'write_file', 'exit_plan_mode']
// What the real registry advertises while planning — mirrored here so the
// loop's plan enforcement is exercised against the same set it ships with.
const PLAN_TOOLS = ['read_file', 'run_bash', 'exit_plan_mode']
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
  toolsForMode: (mode: string) =>
    (mode === 'plan' ? PLAN_TOOLS : ['echo', 'run_bash']).map(makeTool),
}))

vi.mock('../tools/validate.js', () => ({
  validateInput: () => h.validateResult,
  exampleInput: () => '{}',
}))

vi.mock('../prompt/system.js', () => ({ buildSystemPrompt: () => 'SYS' }))
vi.mock('../prompt/context.js', () => ({ loadProjectContext: () => '' }))
// Only check() is faked. isReadOnlyCommand is a pure classifier with no I/O,
// and plan mode's whole boundary rests on it — a stub here would test the stub.
vi.mock('../permissions/policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions/policy.js')>()),
  check: async () => {
    h.checkCalls++
    h.onCheck?.()
    return h.decision
  },
}))
vi.mock('./decide.js', () => ({
  deciderEnabled: (cfg: { model?: string } | undefined) => !!cfg?.model,
  stopGate: async (input: { userText: string; finalText: string }) => {
    h.gateCalls.push({ userText: input.userText, finalText: input.finalText })
    return h.gateAnswers.shift() ?? null
  },
}))
vi.mock('../config.js', () => ({
  loadConfig: () => ({ effort: 'medium', ...(h.decider ? { decider: h.decider } : {}) }),
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
/**
 * Same tool call, different surrounding text — so the turn signature differs and
 * the identical-turn guard stays out of the way. That is what lets a test
 * exercise a call repeating across NON-consecutive turns, which is the shape the
 * repeat-failure gate exists for.
 */
function sayThenToolThenDone(
  text: string,
  calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }>,
): Array<Record<string, unknown>> {
  return [
    { content: text, done: false },
    { content: '', done: false, tool_calls: calls },
    { content: '', done: true, prompt_eval_count: 3, eval_count: 5 },
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
  h.decider = undefined
  h.gateAnswers = []
  h.gateCalls = []
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

// ---- plan mode -----------------------------------------------------------

/**
 * A permissions context whose `ask` always answers the same way, recording how
 * many times it was consulted. Plan approval goes through `ask` directly rather
 * than through check(), so these two counters distinguish the paths.
 */
function asker(answer: 'yes' | 'no' | 'always') {
  const calls: string[] = []
  return {
    calls,
    permissions: {
      ask: async (toolName: string) => {
        calls.push(toolName)
        return answer
      },
    } as never,
  }
}

/** Did the run execute this tool's handler? */
function ranTool(name: string, ran: string[]): boolean {
  return ran.includes(name)
}

describe('plan mode', () => {
  it('refuses a tool it never advertised, and points at exit_plan_mode', async () => {
    const ran: string[] = []
    h.toolHandlers.echo = () => { ran.push('echo'); return { content: 'ok' } }
    h.script = [toolThenDone([call('echo', { a: 1 })]), textThenDone('ok')]

    const { history } = await drive({ mode: 'plan', ...asker('yes') })
    const r = firstResults(history)[0]

    expect(r.is_error).toBe(true)
    expect(r.content).toContain('read-only')
    expect(r.content).toContain('exit_plan_mode')
    // The point of the guard: the handler must not have run.
    expect(ranTool('echo', ran)).toBe(false)
    assertBlockOrdering(history)
  })

  it('runs a command that only reports', async () => {
    const ran: string[] = []
    h.toolHandlers.run_bash = () => { ran.push('run_bash'); return { content: 'a.ts' } }
    h.script = [toolThenDone([call('run_bash', { command: 'ls src' })]), textThenDone('ok')]

    const { history } = await drive({ mode: 'plan', ...asker('yes') })
    expect(firstResults(history)[0].is_error).toBeFalsy()
    expect(ranTool('run_bash', ran)).toBe(true)
  })

  it('refuses a command that writes, and one that smuggles a write past a &&', async () => {
    for (const command of ['rm -rf build', 'ls && rm -rf build', 'cat a > b']) {
      h.callIndex = 0
      const ran: string[] = []
      h.toolHandlers.run_bash = () => { ran.push('run_bash'); return { content: 'ok' } }
      h.script = [toolThenDone([call('run_bash', { command })]), textThenDone('ok')]

      const { history } = await drive({ mode: 'plan', ...asker('yes') })
      const r = firstResults(history)[0]
      expect(r.is_error, command).toBe(true)
      expect(r.content, command).toContain('only commands that report')
      expect(ranTool('run_bash', ran), command).toBe(false)
    }
  })

  it('approving a plan leaves plan mode and unblocks the rest of the run', async () => {
    const ran: string[] = []
    h.toolHandlers.run_bash = () => { ran.push('run_bash'); return { content: 'ok' } }
    h.script = [
      toolThenDone([call('exit_plan_mode', { plan: '1. delete build/' })]),
      // Refused a turn ago; allowed now, which is the whole assertion.
      toolThenDone([call('run_bash', { command: 'rm -rf build' })]),
      textThenDone('done'),
    ]

    const { events, history } = await drive({ mode: 'plan', ...asker('yes') })

    expect(events).toContainEqual({ type: 'mode-change', mode: 'default' })
    const approval = firstResults(history)[0]
    expect(approval.is_error).toBeFalsy()
    expect(approval.content).toContain('approved')
    expect(ranTool('run_bash', ran)).toBe(true)
  })

  it('"always" approves the plan and stops asking about edits', async () => {
    h.script = [toolThenDone([call('exit_plan_mode', { plan: 'do it' })]), textThenDone('done')]
    const { events } = await drive({ mode: 'plan', ...asker('always') })
    expect(events).toContainEqual({ type: 'mode-change', mode: 'acceptEdits' })
  })

  it('rejecting a plan keeps the session read-only', async () => {
    const ran: string[] = []
    h.toolHandlers.run_bash = () => { ran.push('run_bash'); return { content: 'ok' } }
    h.script = [
      toolThenDone([call('exit_plan_mode', { plan: 'delete everything' })]),
      toolThenDone([call('run_bash', { command: 'rm -rf build' })]),
      textThenDone('done'),
    ]

    const { events, history } = await drive({ mode: 'plan', ...asker('no') })

    expect(types(events)).not.toContain('mode-change')
    const rejection = firstResults(history)[0]
    expect(rejection.is_error).toBe(true)
    expect(rejection.content).toContain('still in plan mode')
    expect(ranTool('run_bash', ran)).toBe(false)
  })

  it('never routes plan approval through the rule store', async () => {
    // An "always" that persisted as a permission rule would auto-approve every
    // future plan — plan mode would silently stop being a gate at all.
    h.script = [toolThenDone([call('exit_plan_mode', { plan: 'do it' })]), textThenDone('done')]
    const a = asker('always')
    await drive({ mode: 'plan', ...a })
    expect(a.calls).toEqual(['exit_plan_mode'])
    expect(h.checkCalls).toBe(0)
  })

  it('leaves an ordinary run untouched', async () => {
    const ran: string[] = []
    h.toolHandlers.run_bash = () => { ran.push('run_bash'); return { content: 'ok' } }
    h.script = [toolThenDone([call('run_bash', { command: 'rm -rf build' })]), textThenDone('done')]
    const { history } = await drive({ ...asker('yes') })
    expect(firstResults(history)[0].is_error).toBeFalsy()
    expect(ranTool('run_bash', ran)).toBe(true)
  })
})

// ---- repair telemetry ----------------------------------------------------

describe('repair telemetry', () => {
  it('reports the tool name it had to resolve', async () => {
    h.script = [toolThenDone([call('runBash', { command: 'ls' })]), textThenDone('done')]
    const { events } = await drive()
    const repairs = events.filter((e) => e.type === 'tool-repair')
    expect(repairs).toHaveLength(1)
    expect((repairs[0] as { name: string }).name).toBe('run_bash')
    expect((repairs[0] as { repairs: string[] }).repairs).toContain('name: runBash → run_bash')
  })

  it('reports an unwrapped envelope, keyed to the call it repaired', async () => {
    h.script = [
      toolThenDone([call('run_bash', { name: 'run_bash', arguments: { command: 'ls' } })]),
      textThenDone('done'),
    ]
    const { events } = await drive()
    const repair = events.find((e) => e.type === 'tool-repair') as
      | { tool_use_id: string; repairs: string[] }
      | undefined
    const use = events.find((e) => e.type === 'tool-use') as { block: ToolUse }
    expect(repair?.repairs).toContain('unwrapped call envelope')
    expect(repair?.tool_use_id).toBe(use.block.id)
  })

  it('stays silent on a call that arrived clean', async () => {
    h.script = [toolThenDone([call('run_bash', { command: 'ls' })]), textThenDone('done')]
    const { events } = await drive()
    expect(types(events)).not.toContain('tool-repair')
  })
})

// ---- repeat-failure gate -------------------------------------------------

/**
 * The failure the other guards miss. Stream repetition and the identical-turn
 * check both need consecutive repeats; the run-killing shape alternates —
 * edit fails, read, the SAME edit fails, read — so no two turns in a row match
 * and the model happily burns every remaining turn on it.
 */
describe('repeat-failure gate', () => {
  it('escalates the second identical failure and refuses the third without running it', async () => {
    let echoRuns = 0
    h.toolHandlers.echo = () => {
      echoRuns++
      throw new Error('boom')
    }
    h.toolHandlers.run_bash = () => ({ content: 'ok' })
    const failing = toolThenDone([call('echo', { path: 'a.ts' })])
    const filler = toolThenDone([call('run_bash', { command: 'ls' })])
    h.script = [failing, filler, failing, filler, failing, textThenDone('giving up')]

    const { events, history } = await drive()
    assertBlockOrdering(history)

    // Ran twice; the third identical attempt never reached the handler.
    expect(echoRuns).toBe(2)

    const errors = events
      .filter((e): e is { type: 'tool-result'; block: ToolResultBlock } => e.type === 'tool-result')
      .map((e) => e.block)
      .filter((b) => b.is_error)
    expect(errors).toHaveLength(3)
    expect(errors[0].content).toContain('boom')
    expect(errors[0].content).not.toMatch(/second time/)
    expect(errors[1].content).toContain('boom')
    expect(errors[1].content).toMatch(/second time/)
    expect(errors[2].content).toMatch(/did not run it a third time/)
    // The run still ends cleanly — the gate redirects the model, it doesn't kill it.
    expect(types(events)).toContain('done')
  })

  it('never spends a permission prompt on a call it has already gated', async () => {
    h.decision = 'deny'
    const denied = toolThenDone([call('echo', { path: 'a.ts' })])
    const filler = toolThenDone([call('run_bash', { command: 'ls' })])
    h.script = [denied, filler, denied, filler, denied, textThenDone('ok')]

    const { history } = await drive()
    assertBlockOrdering(history)
    // Two denials asked; the third was refused by the gate, so check() saw 4
    // calls total (2 denied echoes + 2 fillers), not 5.
    expect(h.checkCalls).toBe(4)
  })

  it('forgets a failure once the same call succeeds', async () => {
    let runs = 0
    h.toolHandlers.echo = () => {
      runs++
      if (runs === 2) return { content: 'worked' }
      throw new Error('boom')
    }
    const c = [call('echo', { path: 'a.ts' })]
    h.script = [
      sayThenToolThenDone('first try', c),
      sayThenToolThenDone('second try', c),
      sayThenToolThenDone('third try', c),
      textThenDone('done'),
    ]

    const { events } = await drive()
    const contents = events
      .filter((e): e is { type: 'tool-result'; block: ToolResultBlock } => e.type === 'tool-result')
      .map((e) => e.block.content)

    expect(runs).toBe(3)
    // fail, succeed, fail — the success cleared the counter, so the last
    // failure is a first failure again and gets no escalation.
    expect(contents[1]).toBe('worked')
    expect(contents[2]).not.toMatch(/second time/)
  })

  it('does not count a user cancellation as the model failing', async () => {
    const ac = new AbortController()
    h.toolHandlers.run_bash = () => {
      ac.abort()
      return { content: 'ran' }
    }
    h.script = [toolThenDone([call('run_bash', { command: 'a' }), call('run_bash', { command: 'b' })])]
    const { history } = await drive({ signal: ac.signal })
    const results = firstResults(history)
    expect(results[1].content).toMatch(/[Cc]ancelled/)
    expect(results[1].content).not.toMatch(/second time/)
  })
})

// ---- read-before-write guard ---------------------------------------------

/**
 * The guard tracks paths the model has actually seen, and what they looked like
 * when it saw them. Real files on a real temp cwd: confinePath resolves against
 * process.cwd(), and the stale check reads mtime/size off disk, so a fake fs
 * would be testing the fake.
 */
describe('read-before-write guard', () => {
  let dir = ''
  let prevCwd = ''
  const file = 'notes.txt'
  const ran: string[] = []

  beforeEach(() => {
    prevCwd = process.cwd()
    dir = mkdtempSync(join(tmpdir(), 'miii-guard-'))
    process.chdir(dir)
    writeFileSync(join(dir, file), 'alpha\nbeta\n', 'utf-8')
    ran.length = 0
    h.toolHandlers.read_file = () => { ran.push('read_file'); return { content: 'alpha\nbeta\n' } }
    h.toolHandlers.edit_file = () => { ran.push('edit_file'); return { content: 'edited' } }
    h.toolHandlers.write_file = (input) => {
      ran.push('write_file')
      const { path, content } = input as { path: string; content: string }
      writeFileSync(join(dir, path), content, 'utf-8')
      return { content: 'written' }
    }
    h.toolHandlers.run_bash = () => {
      ran.push('run_bash')
      appendFileSync(join(dir, file), 'gamma\n', 'utf-8')
      return { content: '' }
    }
  })

  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  const editCall = () => call('edit_file', { path: file, old_str: 'alpha', new_str: 'ALPHA' })

  it('refuses an edit to a file the model has never read', async () => {
    h.script = [toolThenDone([editCall()]), textThenDone('ok')]
    const { history } = await drive()
    const r = firstResults(history)[0]
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('without seeing it first')
    expect(ran).not.toContain('edit_file')
  })

  it('allows the edit once the file has been read', async () => {
    h.script = [
      toolThenDone([call('read_file', { path: file })]),
      toolThenDone([editCall()]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(ran).toEqual(['read_file', 'edit_file'])
  })

  it('refuses an edit against a copy that went stale after something else wrote the file', async () => {
    h.script = [
      toolThenDone([call('read_file', { path: file })]),
      toolThenDone([call('run_bash', { command: `echo gamma >> ${file}` })]),
      toolThenDone([editCall()]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)

    const results = history[history.length - 2].content as ToolResultBlock[]
    expect(results[0].is_error).toBe(true)
    expect(results[0].content).toMatch(/changed on disk/)
    // The whole point: the stale edit never reached the tool, so the appended
    // line is still there.
    expect(ran).not.toContain('edit_file')
  })

  it('lets the edit through again after the model re-reads the changed file', async () => {
    h.script = [
      toolThenDone([call('read_file', { path: file })]),
      toolThenDone([call('run_bash', { command: `echo gamma >> ${file}` })]),
      toolThenDone([editCall()]),
      toolThenDone([call('read_file', { path: file })]),
      // Same edit as before — allowed now only because the re-read re-stamped it.
      toolThenDone([editCall()]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(ran).toEqual(['read_file', 'run_bash', 'read_file', 'edit_file'])
  })

  it('treats a file the model wrote itself as seen', async () => {
    h.script = [
      toolThenDone([call('write_file', { path: 'fresh.txt', content: 'alpha\n' })]),
      toolThenDone([call('edit_file', { path: 'fresh.txt', old_str: 'alpha', new_str: 'ALPHA' })]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(ran).toEqual(['write_file', 'edit_file'])
  })

  // The same guard has to cover run_bash, or the model routes around it with a
  // heredoc and clobbers a file it never read.
  it('refuses a shell redirect over a file the model has never read', async () => {
    h.script = [
      toolThenDone([call('run_bash', { command: `cat > ${file} <<'EOF'\nrewritten\nEOF` })]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    const r = firstResults(history)[0]
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('would overwrite')
    expect(ran).not.toContain('run_bash')
    expect(readFileSync(join(dir, file), 'utf-8')).toBe('alpha\nbeta\n')
  })

  it('refuses an in-place sed over an unread file', async () => {
    h.script = [
      toolThenDone([call('run_bash', { command: `sed -i '' 's/alpha/ALPHA/' ${file}` })]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    expect(firstResults(history)[0].is_error).toBe(true)
    expect(ran).not.toContain('run_bash')
  })

  it('allows the shell write once the file has been read', async () => {
    h.script = [
      toolThenDone([call('read_file', { path: file })]),
      toolThenDone([call('run_bash', { command: `cat > ${file} <<'EOF'\nrewritten\nEOF` })]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(ran).toEqual(['read_file', 'run_bash'])
  })

  it('allows a shell write that creates a new file', async () => {
    h.script = [
      toolThenDone([call('run_bash', { command: `cat > brand-new.txt <<'EOF'\nhi\nEOF` })]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(ran).toEqual(['run_bash'])
  })

  it('leaves ordinary read-only commands alone', async () => {
    h.script = [
      toolThenDone([call('run_bash', { command: `grep -n "a > b" ${file} || true` })]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(ran).toEqual(['run_bash'])
  })

  it('refuses an edit built on a copy that a shell write made stale', async () => {
    h.script = [
      toolThenDone([call('read_file', { path: file })]),
      // Allowed: the file has been read. It also re-stamps, so the model is not
      // blocked on its own write...
      toolThenDone([call('run_bash', { command: `cat > ${file} <<'EOF'\nrewritten\nEOF` })]),
      toolThenDone([call('run_bash', { command: `cat > ${file} <<'EOF'\nagain\nEOF` })]),
      textThenDone('ok'),
    ]
    const { history } = await drive()
    assertBlockOrdering(history)
    expect(ran).toEqual(['read_file', 'run_bash', 'run_bash'])
  })
})

// ---- the stop gate -------------------------------------------------------

describe('stop gate (decision box)', () => {
  const ON = { model: 'judge:1.5b' }

  /** A run that does one tool call and then declares itself finished. */
  function toolThenClaim(text = 'All done.') {
    return [toolThenDone([call('echo', { x: 1 })]), textThenDone(text)]
  }

  it('is never consulted unless a judge model is configured', async () => {
    h.script = toolThenClaim()
    h.gateAnswers = ['you forgot the tests']
    const { events } = await drive()
    expect(h.gateCalls).toHaveLength(0)
    expect(events.filter((e) => e.type === 'turn-end').at(-1)).toMatchObject({ stop_reason: 'end_turn' })
  })

  it('sends the model back to work, telling it what is missing', async () => {
    h.decider = ON
    h.script = [...toolThenClaim(), textThenDone('now really done')]
    h.gateAnswers = ['the tests were never run']
    const { events, history } = await drive()

    assertBlockOrdering(history)
    expect(events.some((e) => e.type === 'judge-notice' && e.message.includes('the tests were never run'))).toBe(true)
    const nudge = history.filter((m) => m.role === 'user').at(-1)
    expect(String(nudge?.content)).toContain('the tests were never run')
    // And the run went on to produce a real second turn rather than stopping.
    expect(events.filter((e) => e.type === 'turn-end').at(-1)).toMatchObject({ stop_reason: 'end_turn' })
  })

  it('lets the turn end when the judge has no opinion', async () => {
    h.decider = ON
    h.script = toolThenClaim()
    h.gateAnswers = [null]
    const { events, history } = await drive()
    expect(h.gateCalls).toHaveLength(1)
    expect(events.some((e) => e.type === 'judge-notice')).toBe(false)
    expect(history.filter((m) => m.role === 'user')).toHaveLength(2) // prompt + tool results
  })

  it('pushes back at most once, however unconvinced the judge stays', async () => {
    h.decider = ON
    h.script = [...toolThenClaim(), textThenDone('second'), textThenDone('third')]
    h.gateAnswers = ['still missing', 'STILL missing']
    const { events } = await drive()
    expect(h.gateCalls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'judge-notice')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn-end').at(-1)).toMatchObject({ stop_reason: 'end_turn' })
  })

  it('stays out of a turn that ran no tools — a question is not unfinished work', async () => {
    h.decider = ON
    h.script = [textThenDone('Your tests fail because the mock is stale.')]
    h.gateAnswers = ['you did not fix it']
    await drive()
    expect(h.gateCalls).toHaveLength(0)
  })

  it('stays out of plan mode, where ending the turn is the point', async () => {
    h.decider = ON
    h.script = [toolThenDone([call('read_file', { path: 'a.ts' })]), textThenDone("Here's the plan.")]
    h.gateAnswers = ['the plan was never carried out']
    await drive({ mode: 'plan' })
    expect(h.gateCalls).toHaveLength(0)
  })

  it('stays out of a subagent run', async () => {
    h.decider = ON
    h.script = toolThenClaim()
    h.gateAnswers = ['incomplete report']
    await drive({ judge: false })
    expect(h.gateCalls).toHaveLength(0)
  })

  it('judges the request and the closing message, not the whole transcript', async () => {
    h.decider = ON
    h.script = toolThenClaim('Renamed it.')
    h.gateAnswers = [null]
    await drive({ userText: 'rename foo to bar' })
    expect(h.gateCalls[0]).toEqual({ userText: 'rename foo to bar', finalText: 'Renamed it.' })
  })

  it('does not fire after MAX_TURNS cuts the run off mid-task', async () => {
    h.decider = ON
    h.alwaysTool = true
    h.gateAnswers = ['unfinished']
    const { events } = await drive({ maxTurns: 3 })
    expect(h.gateCalls).toHaveLength(0)
    expect(events.some((e) => e.type === 'error' && e.message.includes('Stopped after 3'))).toBe(true)
  })
})
