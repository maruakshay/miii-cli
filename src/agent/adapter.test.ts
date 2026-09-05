import { describe, it, expect } from 'vitest'
import {
  parseTextToolCalls,
  blocksFromOllama,
  toOllamaMessages,
  looksLikeLeakedToolCall,
} from './adapter.js'
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

  it('resolves a mis-spelled tool name to the real one', () => {
    const { calls } = parseTextToolCalls('{"name":"readFile","arguments":{"path":"a.ts"}}', KNOWN)
    expect(calls[0].function.name).toBe('read_file')
  })

  it('resolves an alias borrowed from another harness', () => {
    const { calls } = parseTextToolCalls('<tool_call>{"tool":"bash","args":{"command":"ls"}}</tool_call>', KNOWN)
    expect(calls[0].function).toEqual({ name: 'run_bash', arguments: { command: 'ls' } })
  })

  it('pulls every bare JSON call, not just the first', () => {
    const { calls, cleanedText } = parseTextToolCalls(
      'reading both:\n{"name":"read_file","arguments":{"path":"a.ts"}}\n{"name":"read_file","arguments":{"path":"b.ts"}}',
      KNOWN,
    )
    expect(calls.map((c) => c.function.arguments.path)).toEqual(['a.ts', 'b.ts'])
    expect(cleanedText).toBe('reading both:')
  })

  it('keeps scanning past a JSON object that is not a call', () => {
    const { calls, cleanedText } = parseTextToolCalls(
      'config is {"debug":true} — now {"name":"read_file","arguments":{"path":"a.ts"}}',
      KNOWN,
    )
    expect(calls).toHaveLength(1)
    expect(cleanedText).toContain('{"debug":true}')
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

  it('parses the call:NAME{...} delimiter-wrapped syntax', () => {
    const src = 'call:run_bash{command:<|"|>ls -la<|"|>}'
    const { calls, cleanedText } = parseTextToolCalls(src, KNOWN)
    expect(calls).toHaveLength(1)
    expect(calls[0].function).toEqual({ name: 'run_bash', arguments: { command: 'ls -la' } })
    expect(cleanedText).toBe('')
  })

  it('keeps delimited values that span newlines and braces intact', () => {
    const body = 'function f() {\n  return { a: 1 };\n}'
    const src = `call:edit_file{path:<|"|>a.js<|"|>,content:<|"|>${body}<|"|>}`
    const { calls } = parseTextToolCalls(src, KNOWN)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('edit_file')
    expect(calls[0].function.arguments).toEqual({ path: 'a.js', content: body })
  })

  it('ignores call:NAME for an unknown tool', () => {
    const { calls, cleanedText } = parseTextToolCalls('call:frobnicate{x:<|"|>1<|"|>}', KNOWN)
    expect(calls).toHaveLength(0)
    expect(cleanedText).toContain('frobnicate')
  })

  it('parses bare (undelimited) values in call syntax', () => {
    const { calls } = parseTextToolCalls('call:read_file{path:"a.ts"}', KNOWN)
    expect(calls[0].function.arguments).toEqual({ path: 'a.ts' })
  })

  it('does not extract a call embedded in an unknown call\'s value', () => {
    const src = 'call:frobnicate{x:<|"|>call:read_file{path:secret.ts}<|"|>}'
    const { calls } = parseTextToolCalls(src, KNOWN)
    expect(calls).toHaveLength(0)
  })
})

describe('looksLikeLeakedToolCall', () => {
  it('flags the <|"|> delimiter sentinel', () => {
    expect(looksLikeLeakedToolCall('content:<|"|>x<|"|>', KNOWN)).toBe(true)
  })
  it('flags call:NAME{ syntax', () => {
    expect(looksLikeLeakedToolCall('call:run_bash{cmd:1}', KNOWN)).toBe(true)
  })
  it('flags a <tool_call tag', () => {
    expect(looksLikeLeakedToolCall('<tool_call>{}', KNOWN)).toBe(true)
  })
  it('flags a JSON object naming a known tool with arguments', () => {
    expect(looksLikeLeakedToolCall('{"name":"read_file","arguments":{}}', KNOWN)).toBe(true)
  })
  it('does NOT flag prose that mentions a tool', () => {
    expect(looksLikeLeakedToolCall('I read the file with read_file earlier.', KNOWN)).toBe(false)
  })
  it('does NOT flag a JSON object naming an unknown tool', () => {
    expect(looksLikeLeakedToolCall('{"name":"frobnicate","arguments":{}}', KNOWN)).toBe(false)
  })
  it('does NOT flag prose "call:" for an unknown name', () => {
    expect(looksLikeLeakedToolCall("I'll call: someone {later} about it.", KNOWN)).toBe(false)
  })
  it('does NOT flag empty text', () => {
    expect(looksLikeLeakedToolCall('', KNOWN)).toBe(false)
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
