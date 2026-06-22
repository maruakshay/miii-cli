import { describe, it, expect } from 'vitest'
import { parseTextToolCalls, blocksFromOllama, toOllamaMessages } from './adapter.js'
import type { MiiMessage, ToolUse } from './types.js'

const KNOWN = ['read_file', 'edit_file', 'run_bash']

describe('parseTextToolCalls', () => {
  it('parses a <tool_call>-wrapped JSON object', () => {
    const { calls, cleanedText } = parseTextToolCalls(
      'sure\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
      KNOWN,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].function).toEqual({ name: 'read_file', arguments: { path: 'a.ts' } })
    expect(cleanedText).toBe('sure')
  })

  it('parses a fenced json block and strips it', () => {
    const { calls, cleanedText } = parseTextToolCalls(
      '```json\n{"name":"run_bash","arguments":{"command":"ls"}}\n```',
      KNOWN,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('run_bash')
    expect(cleanedText).toBe('')
  })

  it('accepts the "parameters" alias for arguments', () => {
    const { calls } = parseTextToolCalls('{"name":"read_file","parameters":{"path":"x"}}', KNOWN)
    expect(calls[0].function.arguments).toEqual({ path: 'x' })
  })

  it('rejects an object whose name is not a known tool', () => {
    const { calls, cleanedText } = parseTextToolCalls('{"name":"frobnicate","arguments":{}}', KNOWN)
    expect(calls).toHaveLength(0)
    // unknown object left in place, not silently eaten
    expect(cleanedText).toContain('frobnicate')
  })

  it('does not treat prose mentioning a tool as a call', () => {
    const { calls } = parseTextToolCalls('I will use read_file on the config.', KNOWN)
    expect(calls).toHaveLength(0)
  })

  it('returns nothing for empty input', () => {
    expect(parseTextToolCalls('', KNOWN).calls).toHaveLength(0)
  })
})

describe('blocksFromOllama', () => {
  it('prefers native structured tool_calls over text parsing', () => {
    const blocks = blocksFromOllama(
      'ignored body',
      [{ function: { name: 'read_file', arguments: { path: 'a' } } }],
      KNOWN,
    )
    const uses = blocks.filter((b) => b.type === 'tool_use') as ToolUse[]
    expect(uses).toHaveLength(1)
    expect(uses[0].name).toBe('read_file')
    expect(uses[0].id).toMatch(/^toolu_/)
  })

  it('falls back to text-extracted calls when no native calls', () => {
    const blocks = blocksFromOllama(
      'doing it\n<tool_call>{"name":"run_bash","arguments":{"command":"ls"}}</tool_call>',
      undefined,
      KNOWN,
    )
    const texts = blocks.filter((b) => b.type === 'text')
    const uses = blocks.filter((b) => b.type === 'tool_use') as ToolUse[]
    expect((texts[0] as { text: string }).text).toBe('doing it')
    expect(uses[0].name).toBe('run_bash')
  })

  it('emits a lone text block when there are no calls', () => {
    const blocks = blocksFromOllama('just an answer', undefined, KNOWN)
    expect(blocks).toEqual([{ type: 'text', text: 'just an answer' }])
  })
})

describe('toOllamaMessages', () => {
  it('prepends the system message', () => {
    const out = toOllamaMessages([], 'SYS')
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' })
  })

  it('maps assistant tool_use blocks to tool_calls', () => {
    const history: MiiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
        ],
      },
    ]
    const out = toOllamaMessages(history, 'SYS')
    const asst = out[1]
    expect(asst.role).toBe('assistant')
    expect(asst.content).toBe('hi')
    expect(asst.tool_calls).toEqual([
      { id: 'toolu_1', function: { name: 'read_file', arguments: { path: 'a' } } },
    ])
  })

  it('emits one role:tool message per tool_result, in order, after the assistant', () => {
    const history: MiiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'run_bash', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'A' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'B' },
        ],
      },
    ]
    const out = toOllamaMessages(history, 'SYS')
    // [system, assistant, tool(A), tool(B)]
    expect(out.map((m) => m.role)).toEqual(['system', 'assistant', 'tool', 'tool'])
    expect(out[2]).toMatchObject({ content: 'A', tool_call_id: 'toolu_1' })
    expect(out[3]).toMatchObject({ content: 'B', tool_call_id: 'toolu_2' })
  })
})
