import { describe, it, expect } from 'vitest'
import { TurnSummaryBuilder, isTestCommand, summaryParts } from './turnSummary.js'
import type { FileDiff } from '../diff.js'

const diff = (path: string, added: number, removed: number): FileDiff => ({ path, added, removed, hunks: [] })
const bash = (id: string, command: string) => ({ id, name: 'run_bash', input: { command } })

describe('isTestCommand', () => {
  it('recognises common test runners', () => {
    for (const c of ['npm test', 'npm run test -- --run', 'pnpm test:unit', 'npx vitest run', 'pytest -q', 'go test ./...', 'cargo test', 'python -m pytest'])
      expect(isTestCommand(c), c).toBe(true)
  })
  it('ignores commands that only mention tests', () => {
    for (const c of ['ls test/', 'cat src/latest.ts', 'npm install', 'git log --grep test-suite'])
      expect(isTestCommand(c), c).toBe(false)
  })
})

describe('TurnSummaryBuilder', () => {
  it('merges edits to the same file however the path was written', () => {
    const b = new TurnSummaryBuilder('/repo')
    b.add(undefined, { tool_use_id: '1', content: '', diff: diff('src/a.ts', 3, 1) })
    b.add(undefined, { tool_use_id: '2', content: '', diff: diff('./src/a.ts', 2, 0) })
    b.add(undefined, { tool_use_id: '3', content: '', diff: diff('/repo/src/a.ts', 1, 1) })
    expect(b.build().files).toEqual([{ path: 'src/a.ts', added: 6, removed: 2 }])
  })

  it('skips failed edits', () => {
    const b = new TurnSummaryBuilder('/repo')
    b.add(undefined, { tool_use_id: '1', content: 'no match', is_error: true, diff: diff('a.ts', 1, 0) })
    expect(b.build().files).toEqual([])
  })

  it('reports the outcome of the last test run', () => {
    const b = new TurnSummaryBuilder('/repo')
    b.add(bash('1', 'npm test'), { tool_use_id: '1', content: 'FAIL', is_error: true })
    expect(b.build().tests).toBe('failed')
    b.add(bash('2', 'npm test'), { tool_use_id: '2', content: 'ok' })
    b.add(bash('3', 'ls'), { tool_use_id: '3', content: 'x', is_error: true })
    expect(b.build().tests).toBe('passed')
  })
})

describe('summaryParts', () => {
  it('leads with what changed and offers the undo', () => {
    const parts = summaryParts(
      { files: [{ path: 'a.ts', added: 40, removed: 10 }, { path: 'b.ts', added: 2, removed: 0 }], tests: 'passed' },
      '1.5k',
      '4.2s',
    )
    expect(parts.map((p) => p.text)).toEqual(['Changed a.ts, b.ts (+42 −10)', 'tests passed', '1.5k tokens', '4.2s', '/rewind last to undo'])
    expect(parts[1].tone).toBe('good')
  })

  it('counts files past two, and says Completed when nothing changed', () => {
    const three = [1, 2, 3].map((n) => ({ path: `${n}.ts`, added: 1, removed: 0 }))
    expect(summaryParts({ files: three }, '10', undefined)[0].text).toBe('Changed 3 files (+3)')
    expect(summaryParts(undefined, '10', '1s').map((p) => p.text)).toEqual(['Completed', '10 tokens', '1s'])
  })

  it('drops the token count when the provider reported none', () => {
    expect(summaryParts(undefined, undefined, '1s').map((p) => p.text)).toEqual(['Completed', '1s'])
  })
})
