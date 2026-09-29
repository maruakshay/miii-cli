import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildPrompt, detectCheck, fixLoop, parseFixArgs, type FixDeps, type FixOptions } from './run.js'
import type { CheckResult } from './digest.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'miii-fixrun-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('detectCheck', () => {
  it('uses npm test when package.json has a real one', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    expect(detectCheck(root)).toBe('npm test')
  })

  it('skips the npm init placeholder', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
    expect(detectCheck(root)).toBeNull()
  })

  it('knows cargo, go and pytest', () => {
    writeFileSync(join(root, 'Cargo.toml'), '')
    expect(detectCheck(root)).toBe('cargo test')
    rmSync(join(root, 'Cargo.toml'))
    writeFileSync(join(root, 'go.mod'), '')
    expect(detectCheck(root)).toBe('go test ./...')
    rmSync(join(root, 'go.mod'))
    writeFileSync(join(root, 'pyproject.toml'), '')
    expect(detectCheck(root)).toBe('python -m pytest -q')
  })
})

describe('parseFixArgs', () => {
  it('takes --check and defaults the rest', () => {
    const o = parseFixArgs(['--check', 'npx tsc --noEmit'], root).options!
    expect(o.check).toBe('npx tsc --noEmit')
    expect(o.mode).toBe('acceptEdits')
    expect(o.maxRounds).toBe(5)
    expect(o.outputFormat).toBe('text')
  })

  it('joins bare words into a direction', () => {
    expect(parseFixArgs(['--check', 't', 'only', 'the', 'parser'], root).options?.instruction).toBe('only the parser')
  })

  it('rejects plan mode, bad numbers and unknown flags', () => {
    expect(parseFixArgs(['--check', 't', '--permission-mode', 'plan'], root).error).toContain('plan')
    expect(parseFixArgs(['--check', 't', '--max-rounds', '0'], root).error).toContain('positive')
    expect(parseFixArgs(['--check', 't', '--wat'], root).error).toContain('--wat')
  })

  it('explains when it cannot infer a check', () => {
    expect(parseFixArgs([], root).error).toContain('--check')
  })
})

describe('buildPrompt', () => {
  it('carries the failure, the rules and earlier attempts', () => {
    const p = buildPrompt({ check: 'npm test', failure: 'boom', notes: ['tried X'], instruction: 'be brief', canRunCheck: false })
    expect(p).toContain('<failure>\nboom\n</failure>')
    expect(p).toContain('Do not edit, delete, skip or loosen tests')
    expect(p).toContain('1. tried X')
    expect(p).toContain('be brief')
    expect(p).toContain('You cannot run commands')
  })
})

// A fake project: one file whose content decides the check's result.
function harness(opts: {
  /** Maps file content to the check output. */
  check: (content: string) => CheckResult
  /** What each round's "agent" writes, in order. null = changes nothing. */
  writes: (string | null)[]
}) {
  const file = join(root, 'src.ts')
  writeFileSync(file, 'v0')
  const prompts: string[] = []
  let round = 0
  const log: string[] = []
  const deps: FixDeps = {
    runCheck: async () => opts.check(readFileSync(file, 'utf-8')),
    attempt: async (prompt, onPreTool) => {
      prompts.push(prompt)
      const w = opts.writes[round++]
      if (w !== null && w !== undefined) {
        onPreTool({ type: 'tool_use', id: String(round), name: 'edit_file', input: { path: 'src.ts' } })
        writeFileSync(file, w)
      }
      return { summary: `set ${w}`, denied: [], history: [] }
    },
    readFile: () => null,
    fingerprint: () => null,
    log: (l) => log.push(l),
  }
  const options: FixOptions = {
    check: 'check', cwd: root, outputFormat: 'json', mode: 'acceptEdits',
    maxRounds: 5, maxTurns: 5, maxStalls: 3, checkTimeout: 10,
  }
  return { deps, options, prompts, log, content: () => readFileSync(file, 'utf-8') }
}

/** "vN" fails with (3 - N) failures; v3 passes. */
const countdown = (content: string): CheckResult => {
  const n = 3 - Number(content.slice(1))
  return n <= 0
    ? { exitCode: 0, output: 'ok', timedOut: false, durationMs: 1 }
    : { exitCode: 1, output: `FAIL case\nTests  ${n} failed`, timedOut: false, durationMs: 1 }
}

describe('fixLoop', () => {
  it('stops at once when the check already passes', async () => {
    const h = harness({ check: countdown, writes: [] })
    writeFileSync(join(root, 'src.ts'), 'v3')
    const r = await fixLoop(h.options, h.deps)
    expect(r.stoppedBecause).toBe('already_passing')
    expect(h.prompts).toHaveLength(0)
  })

  it('keeps rounds that reduce failures until green', async () => {
    const h = harness({ check: countdown, writes: ['v1', 'v3'] })
    const r = await fixLoop(h.options, h.deps)
    expect(r.passed).toBe(true)
    expect(r.stoppedBecause).toBe('passed')
    expect(r.attempts.map((a) => a.outcome)).toEqual(['kept', 'kept'])
    expect(r.initialFailures).toBe(3)
    expect(r.changedFiles).toEqual(['src.ts'])
    expect(h.content()).toBe('v3')
  })

  it('rolls back a round that makes things worse and tells the next round', async () => {
    const worse = (c: string): CheckResult =>
      c === 'bad'
        ? { exitCode: 1, output: 'FAIL other\nTests  9 failed', timedOut: false, durationMs: 1 }
        : countdown(c)
    const h = harness({ check: worse, writes: ['bad', 'v3'] })
    const r = await fixLoop(h.options, h.deps)
    expect(r.attempts.map((a) => a.outcome)).toEqual(['rolled_back', 'kept'])
    expect(r.passed).toBe(true)
    expect(h.prompts[1]).toContain('Earlier attempts')
    expect(h.prompts[1]).toContain('set bad')
  })

  it('restores the file after a rolled-back round', async () => {
    const h = harness({ check: (c) => (c === 'v0' ? countdown(c) : countdown('v0')), writes: ['junk', null, null] })
    await fixLoop(h.options, h.deps)
    expect(h.content()).toBe('v0')
  })

  it('stops after too many rounds without progress', async () => {
    const h = harness({ check: countdown, writes: [null, null, null, null, null] })
    const r = await fixLoop(h.options, h.deps)
    expect(r.stoppedBecause).toBe('stalled')
    expect(r.rounds).toBe(3)
    expect(r.attempts.every((a) => a.outcome === 'no_change')).toBe(true)
  })

  it('stops at max rounds while still making progress', async () => {
    const slow = (c: string): CheckResult => {
      const n = 10 - Number(c.slice(1))
      return { exitCode: 1, output: `FAIL x\nTests  ${n} failed`, timedOut: false, durationMs: 1 }
    }
    const h = harness({ check: slow, writes: ['v1', 'v2', 'v3', 'v4', 'v5'] })
    const r = await fixLoop(h.options, h.deps)
    expect(r.stoppedBecause).toBe('max_rounds')
    expect(r.finalFailures).toBe(5)
  })

  it('undoes the in-flight round when aborted', async () => {
    let aborted = false
    const h = harness({ check: countdown, writes: ['v1'] })
    const attempt = h.deps.attempt
    h.deps.attempt = async (p, pre) => {
      const res = await attempt(p, pre)
      aborted = true
      return res
    }
    h.deps.aborted = () => aborted
    const r = await fixLoop(h.options, h.deps)
    expect(r.stoppedBecause).toBe('aborted')
    expect(h.content()).toBe('v0')
  })
})
