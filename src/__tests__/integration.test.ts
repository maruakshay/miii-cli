import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { looksCodeRelated } from '../tui/git-context.js'
import { tools } from '../tools/index.js'

// patch_file uses guardPath which restricts to CWD — use a local scratch file
const SCRATCH = join(process.cwd(), '.miii-test-scratch.txt')

// ─── looksCodeRelated ─────────────────────────────────────────────────────────

describe('looksCodeRelated', () => {
  it('true: file extension in message', () => {
    expect(looksCodeRelated('fix the bug in auth.ts')).toBe(true)
  })

  it('true: code keyword present', () => {
    expect(looksCodeRelated('refactor the user login function')).toBe(true)
  })

  it('true: backtick token', () => {
    expect(looksCodeRelated('what does `useEffect` do')).toBe(true)
  })

  it('false: too short', () => {
    expect(looksCodeRelated('hi')).toBe(false)
  })

  it('false: plain prose, no code signal', () => {
    expect(looksCodeRelated('what is the weather like in london today')).toBe(false)
  })
})

// ─── patch_file ───────────────────────────────────────────────────────────────

describe('patch_file', () => {
  const patchTool = tools.find(t => t.name === 'patch_file')!

  afterEach(() => {
    try { unlinkSync(SCRATCH) } catch {}
  })

  it('applies a unique patch correctly', async () => {
    writeFileSync(SCRATCH, 'hello world\ngoodbye world\n')
    await patchTool.execute({ path: SCRATCH, old: 'hello world', new: 'hello earth' })
    expect(readFileSync(SCRATCH, 'utf-8')).toBe('hello earth\ngoodbye world\n')
  })

  it('throws when old text not found', async () => {
    writeFileSync(SCRATCH, 'hello world\n')
    await expect(patchTool.execute({ path: SCRATCH, old: 'no such text', new: 'x' }))
      .rejects.toThrow('old text not found')
  })

  it('throws on ambiguous match (2+ occurrences)', async () => {
    writeFileSync(SCRATCH, 'hello world\nhello world\n')
    await expect(patchTool.execute({ path: SCRATCH, old: 'hello world', new: 'hi' }))
      .rejects.toThrow('ambiguous')
  })
})
