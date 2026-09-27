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

  it.each([
    ['a middle line', 'a\nb\nc\n', 'a\nB\nc\n'],
    ['the last line with no trailing newline', 'a\nb\nc', 'a\nb\nC'],
    ['adding a trailing newline', 'a\nb', 'a\nb\n'],
    ['an insertion between lines', 'a\nc\n', 'a\nb\nc\n'],
    ['an insertion at the top', 'b\n', 'a\nb\n'],
    ['deleting every line', 'a\nb\n', ''],
    ['text full of sed syntax', 'x\n', 'a/b\\1 & $d\n1,$d\n'],
    ['a line with no change around it', 'one line', 'another line'],
  ])('replaces content in place: %s', async (_name, before, after) => {
    const { replaceShell } = await load(noBash)
    const file = join(dir, 'r.txt')
    writeFileSync(file, before)
    replaceShell(file, before, after)
    expect(readFileSync(file, 'utf-8')).toBe(after)
  })

  it('writes the expected result even when the file changed under it', async () => {
    const { replaceShell } = await load(noBash)
    const file = join(dir, 'stale.txt')
    writeFileSync(file, 'someone else wrote this\n')
    replaceShell(file, 'a\nb\n', 'a\nB\n')
    expect(readFileSync(file, 'utf-8')).toBe('a\nB\n')
  })

  it('creates a file that does not exist yet', async () => {
    const { replaceShell } = await load(noBash)
    const file = join(dir, 'new', 'n.txt')
    replaceShell(file, '', 'hello\n')
    expect(readFileSync(file, 'utf-8')).toBe('hello\n')
  })

  it('reports existence', async () => {
    const { existsShell, mkdirpShell } = await load(noBash)
    expect(existsShell(join(dir, 'nope'))).toBe(false)
    mkdirpShell(join(dir, 'sub', 'deep'))
    expect(existsShell(join(dir, 'sub', 'deep'))).toBe(true)
  })
})

describe('changedBlock', () => {
  it('narrows to the lines that differ', async () => {
    const { changedBlock } = await load(false)
    expect(changedBlock('a\nb\nc\nd\n', 'a\nB\nC\nd\n')).toEqual({ from: 2, to: 3, text: 'B\nC\n' })
  })

  it('widens a pure insertion to one line of context', async () => {
    const { changedBlock } = await load(false)
    expect(changedBlock('a\nc\n', 'a\nb\nc\n')).toEqual({ from: 1, to: 1, text: 'a\nb\n' })
  })

  it('is null when nothing changed', async () => {
    const { changedBlock } = await load(false)
    expect(changedBlock('a\n', 'a\n')).toBeNull()
  })
})

describe('isNativeWindowsBash', () => {
  it.each([
    ['MINGW64_NT-10.0-19045\n', true],
    ['MSYS_NT-10.0-22631', true],
    ['CYGWIN_NT-10.0', true],
    ['Linux\n', false],
    ['', false],
  ])('%j -> %s', async (uname, want) => {
    const { isNativeWindowsBash } = await load(false)
    expect(isNativeWindowsBash(uname)).toBe(want)
  })
})

describe('on Windows', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.doUnmock('child_process')
  })

  /** shellFs with process.platform faked to win32 and bash answering `uname` with `uname`. */
  async function loadWindows(uname: string) {
    vi.resetModules()
    const calls: string[] = []
    vi.doMock('child_process', () => ({
      execFileSync: (_cmd: string, args: string[]) => {
        calls.push(args[1])
        if (args[1] === 'uname -s') return Buffer.from(uname)
        return Buffer.from('')
      },
    }))
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const mod = await import('./shellFs.js')
      return { mod, calls, restore: () => Object.defineProperty(process, 'platform', platform) }
    } catch (err) {
      Object.defineProperty(process, 'platform', platform)
      throw err
    }
  }

  it('skips WSL bash and uses fs', async () => {
    const { mod, calls, restore } = await loadWindows('Linux\n')
    try {
      const dir = mkdtempSync(join(process.cwd(), 'tmp-shellfs-'))
      try {
        const file = join(dir, 'w.txt')
        writeFileSync(file, 'hi\n')
        expect(mod.readTextShell(file)).toBe('hi\n')
        expect(mod.bashAvailable()).toBe(false)
        expect(calls).toEqual(['uname -s'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      restore()
    }
  })

  it('uses Git Bash', async () => {
    const { mod, calls, restore } = await loadWindows('MINGW64_NT-10.0-19045\n')
    try {
      mod.existsShell('C:\\anything')
      expect(mod.bashAvailable()).toBe(true)
      expect(calls[0]).toBe('uname -s')
      expect(calls).toHaveLength(2)
    } finally {
      restore()
    }
  })
})
