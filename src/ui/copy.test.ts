import { describe, it, expect } from 'vitest'
import { collectCopyText, codeBlocks, describeSize, parseCopyTarget } from './copy.js'
import type { ChatMessage } from './types.js'

const user = (content: string): ChatMessage => ({ role: 'user', content })
const reply = (content: string): ChatMessage => ({ role: 'assistant', content })

describe('parseCopyTarget', () => {
  it('defaults a bare /copy to the last reply', () => {
    expect(parseCopyTarget('')).toBe('last')
    expect(parseCopyTarget('  ')).toBe('last')
  })

  it('accepts aliases, case-insensitively', () => {
    expect(parseCopyTarget('Reply')).toBe('last')
    expect(parseCopyTarget('OUTPUT')).toBe('tool')
    expect(parseCopyTarget('chat')).toBe('all')
  })

  it('rejects anything else', () => {
    expect(parseCopyTarget('everything')).toBeNull()
  })
})

describe('codeBlocks', () => {
  it('extracts fenced blocks without the fences or info string', () => {
    const md = 'before\n```ts\nconst a = 1\n```\nafter\n```\nplain\n```'
    expect(codeBlocks(md)).toEqual(['const a = 1', 'plain'])
  })

  it('ignores empty fences', () => {
    expect(codeBlocks('```\n\n```')).toEqual([])
  })
})

describe('collectCopyText', () => {
  const messages: ChatMessage[] = [
    user('read the file'),
    {
      role: 'assistant',
      content: 'here it is',
      tool_uses: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
      tool_results: [{ tool_use_id: 't1', content: 'file body' }],
    },
    reply('done — try:\n```sh\nnpm test\n```'),
  ]

  it('copies the last reply', () => {
    expect(collectCopyText(messages, 'last')).toBe('done — try:\n```sh\nnpm test\n```')
  })

  it('copies the last code block, unfenced', () => {
    expect(collectCopyText(messages, 'code')).toBe('npm test')
  })

  it('copies the most recent tool output, skipping turns without one', () => {
    expect(collectCopyText(messages, 'tool')).toBe('file body')
  })

  it('copies the whole conversation with tool output inline', () => {
    const all = collectCopyText(messages, 'all')!
    expect(all).toContain('> read the file')
    expect(all).toContain('miii: here it is')
    expect(all).toContain('[tool output]\nfile body')
  })

  it('returns null when the target is not there', () => {
    expect(collectCopyText([], 'last')).toBeNull()
    expect(collectCopyText([], 'all')).toBeNull()
    expect(collectCopyText(messages.slice(0, 1), 'tool')).toBeNull()
    expect(collectCopyText([reply('no code here')], 'code')).toBeNull()
  })

  it('skips an empty streamed reply when picking the last one', () => {
    expect(collectCopyText([reply('real answer'), reply('   ')], 'last')).toBe('real answer')
  })
})

describe('describeSize', () => {
  it('singularises one line', () => {
    expect(describeSize('one')).toBe('1 line')
    expect(describeSize('one\ntwo')).toBe('2 lines')
  })
})
