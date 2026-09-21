import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

/** Fresh module each time — the bash/fs decision is cached for the process. */
async function load(noBash: boolean) {
  vi.resetModules()
  if (noBash) vi.stubEnv('PATH', '')
  return await import('./shellFs.js')
}

describe.each([
  ['bash', false],
  ['fs fallback', true],
])('shellFs via %s', (_label, noBash) => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(process.cwd(), 'tmp-shellfs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('round-trips a file, parent dirs and all', async () => {
    const { writeFileShell, readTextShell, bashAvailable } = await load(noBash)
    const file = join(dir, 'nested', 'a.txt')
    writeFileShell(file, 'alpha\nbeta\n')
    expect(readFileSync(file, 'utf-8')).toBe('alpha\nbeta\n')
    expect(readTextShell(file)).toBe('alpha\nbeta\n')
    expect(bashAvailable()).toBe(!noBash)
  })

  it('keeps bytes intact on binary content', async () => {
    const { readFileShell } = await load(noBash)
    const file = join(dir, 'b.bin')
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x0a, 0x0d, 0x1a])
    writeFileSync(file, bytes)
    expect(readFileShell(file).equals(bytes)).toBe(true)
  })

  it('handles a path the shell would otherwise mangle', async () => {
    const { writeFileShell, readTextShell } = await load(noBash)
    const file = join(dir, 'we ird$ ;"name".txt')
    writeFileShell(file, 'ok\n')
    expect(readTextShell(file)).toBe('ok\n')
  })

  it('throws on a missing file', async () => {
    const { readFileShell } = await load(noBash)
    expect(() => readFileShell(join(dir, 'gone.txt'))).toThrow()
  })

  it('reports existence', async () => {
    const { existsShell, mkdirpShell } = await load(noBash)
    expect(existsShell(join(dir, 'nope'))).toBe(false)
    mkdirpShell(join(dir, 'sub', 'deep'))
    expect(existsShell(join(dir, 'sub', 'deep'))).toBe(true)
  })
})
