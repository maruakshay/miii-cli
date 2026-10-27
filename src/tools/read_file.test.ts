import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { read_file, readBudget } from './read_file.js'
import { shedOldToolResults } from '../agent/loop.js'
import type { MiiMessage } from '../agent/types.js'

describe('read_file on a large file', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(process.cwd(), '.vitest-read-'))
    file = relative(process.cwd(), join(dir, 'big.txt'))
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`)
    writeFileSync(file, lines.join('\n'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('stays inside the context window and says where to resume', async () => {
    const out = await read_file.handler({ path: file }, { run: { model: 'm', cwd: '.', permissions: {} as never, mode: 'default', num_ctx: 8192 } })
    expect(out.content.length).toBeLessThan(readBudget(8192) + 400)
    const m = out.content.match(/Showing lines 1-(\d+) of 20000.*offset=(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![2])).toBe(Number(m![1]) + 1)
  })

  it('reads a requested range whole when it fits', async () => {
    const out = await read_file.handler({ path: file, offset: 100, limit: 10 })
    expect(out.content).toContain('[showing lines 100-109 of 20000]')
  })
})

describe('shedOldToolResults', () => {
  const big = 'y'.repeat(40_000)
  const history = (): MiiMessage[] => [
    { role: 'user', content: 'read them' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: big }] },
  ]

  it('elides the oldest results first and never the newest message', () => {
    const h = history()
    expect(shedOldToolResults(h, 0, 12_000)).toBe(1)
    const [older, newest] = [h[2].content, h[4].content] as Array<Array<{ content: string }>>
    expect(older[0].content).toMatch(/removed to free up context/)
    expect(newest[0].content).toBe(big)
  })

  it('leaves history alone when it fits', () => {
    const h = history()
    expect(shedOldToolResults(h, 0, 100_000)).toBe(0)
  })
})
