import { describe, it, expect } from 'vitest'
import { countFailures, digest, excerpt, improved, snippet, sourceRefs, stripAnsi, type CheckResult } from './digest.js'

const fail = (output: string, exitCode = 1): CheckResult => ({ exitCode, output, timedOut: false, durationMs: 10 })

const VITEST = `
 ✓ src/a.test.ts (3 tests) 4ms
 ✓ src/c.test.ts (1 test) 2ms
 ✓ src/d.test.ts (1 test) 2ms
 ✓ src/e.test.ts (1 test) 2ms
 ❯ src/b.test.ts (2 tests | 1 failed) 7ms
   × adds numbers 5ms
     → expected 3 to be 4

 FAIL  src/b.test.ts > adds numbers
AssertionError: expected 3 to be 4
 ❯ src/b.test.ts:5:17
 ❯ node_modules/vitest/dist/chunk.js:10:3

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 4 passed (5)
`

describe('countFailures', () => {
  it('reads vitest and jest summaries', () => {
    expect(countFailures(VITEST)).toBe(1)
    expect(countFailures('Tests:       2 failed, 8 passed, 10 total')).toBe(2)
  })

  it('reads pytest, tsc, mocha and cargo', () => {
    expect(countFailures('=== 3 failed, 12 passed in 0.4s ===')).toBe(3)
    expect(countFailures('Found 4 errors in 2 files.')).toBe(4)
    expect(countFailures('  2 passing\n  5 failing')).toBe(5)
    expect(countFailures('test result: FAILED. 7 passed; 2 failed; 0 ignored')).toBe(2)
    expect(countFailures('# pass 3\n# fail 2')).toBe(2)
    expect(countFailures('ℹ pass 3\nℹ fail 1')).toBe(1)
  })

  it('counts go and bare tsc lines when there is no summary', () => {
    expect(countFailures('--- FAIL: TestA\n--- FAIL: TestB\nFAIL')).toBe(2)
    expect(countFailures('a.ts(1,1): error TS2322: x\nb.ts(2,2): error TS2345: y')).toBe(2)
  })

  it('returns null when it cannot tell', () => {
    expect(countFailures('something went wrong')).toBeNull()
  })
})

describe('excerpt', () => {
  it('starts near the first failure and drops dependency frames', () => {
    const out = excerpt(VITEST)
    expect(out).toContain('× adds numbers')
    expect(out).toContain('src/b.test.ts:5:17')
    expect(out).not.toContain('node_modules')
    expect(out).not.toContain('src/a.test.ts (3 tests)')
  })

  it('falls back to the tail when nothing looks like a failure', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out = excerpt(lines, 10)
    expect(out).toContain('line 99')
    expect(out).not.toContain('line 50')
  })

  it('cuts long output and says so', () => {
    const lines = ['FAIL x', ...Array.from({ length: 200 }, (_, i) => `detail ${i}`)].join('\n')
    expect(excerpt(lines, 20)).toMatch(/more lines cut/)
  })
})

describe('sourceRefs / snippet', () => {
  it('finds project paths and skips ones outside it', () => {
    const refs = sourceRefs('at src/b.ts:5:17\n at /elsewhere/x.ts:3\n at src/b.ts:5:17', '/proj')
    expect(refs).toEqual([{ path: 'src/b.ts', line: 5 }])
  })

  it('resolves absolute paths inside the project', () => {
    expect(sourceRefs('/proj/src/c.py:12', '/proj')).toEqual([{ path: 'src/c.py', line: 12 }])
  })

  it('marks the target line', () => {
    const s = snippet('a\nb\nc\nd', 2, 1)
    expect(s).toBe('  1 | a\n> 2 | b\n  3 | c')
  })
})

describe('digest', () => {
  it('is empty for a pass', () => {
    expect(digest(fail('ok', 0), { cwd: '/p' })).toEqual({ passed: true, failures: 0, signature: '', text: '' })
  })

  it('includes the failing source when it can read it', () => {
    const d = digest(fail(VITEST), {
      cwd: '/p',
      readFile: (p) => (p === '/p/src/b.test.ts' ? 'l1\nl2\nl3\nl4\nexpect(add(1,2)).toBe(4)\n' : null),
    })
    expect(d.passed).toBe(false)
    expect(d.failures).toBe(1)
    expect(d.text).toContain('src/b.test.ts around line 5')
    expect(d.text).toContain('> 5 | expect(add(1,2)).toBe(4)')
  })

  it('treats a timeout as a failure even with exit 0', () => {
    const d = digest({ exitCode: 0, output: '', timedOut: true, durationMs: 5000 }, { cwd: '/p' })
    expect(d.passed).toBe(false)
    expect(d.text).toContain('timed out after 5s')
  })

  it('gives identical failures the same signature despite timings', () => {
    const a = digest(fail('FAIL src/x.test.ts (12 ms)'), { cwd: '/p' })
    const b = digest(fail('FAIL src/x.test.ts (48 ms)'), { cwd: '/p' })
    expect(a.signature).toBe(b.signature)
  })

  it('strips colour codes', () => {
    expect(stripAnsi('\x1b[31mFAIL\x1b[0m x')).toBe('FAIL x')
  })
})

describe('improved', () => {
  const d = (failures: number | null, signature = 'e', passed = false) => ({ passed, failures, signature, text: '' })

  it('accepts a pass and fewer failures', () => {
    expect(improved(d(3), d(0, '', true), 10, 10)).toBe(true)
    expect(improved(d(3), d(2), 10, 10)).toBe(true)
  })

  it('rejects the same or more failures, even with a different first error', () => {
    expect(improved(d(3), d(3, 'other'), 10, 10)).toBe(false)
    expect(improved(d(3), d(4, 'other'), 10, 10)).toBe(false)
  })

  it('without counts, a new first error is progress unless the output ballooned', () => {
    expect(improved(d(null, 'a'), d(null, 'a'), 10, 10)).toBe(false)
    expect(improved(d(null, 'a'), d(null, 'b'), 100, 120)).toBe(true)
    expect(improved(d(null, 'a'), d(null, 'b'), 100, 400)).toBe(false)
  })
})
