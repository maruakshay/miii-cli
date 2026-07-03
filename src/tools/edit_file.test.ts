import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { edit_file, fuzzyRange, similarity, applyBatch } from './edit_file.js'

describe('similarity', () => {
  it('is 1 for identical (ws-trimmed) strings', () => {
    expect(similarity('  foo ', 'foo')).toBe(1)
  })
  it('is 1 when both are empty', () => {
    expect(similarity('   ', '')).toBe(1)
  })
  it('is low for disjoint strings', () => {
    expect(similarity('abcd', 'wxyz')).toBe(0)
  })
})

describe('fuzzyRange', () => {
  it('finds a unique whitespace-tolerant match and returns its char range', () => {
    const src = 'line one\n    const x = 1\nline three\n'
    const r = fuzzyRange(src, 'const x = 1')
    expect(r).not.toBeNull()
    const [s, e] = r!
    expect(src.slice(s, e)).toBe('    const x = 1')
  })

  it('returns null when the normalized block matches more than once', () => {
    const src = 'a\n  dup\nb\n    dup\nc\n'
    expect(fuzzyRange(src, 'dup')).toBeNull()
  })

  it('returns null when there is no match', () => {
    expect(fuzzyRange('a\nb\nc\n', 'zzz')).toBeNull()
  })
})

describe('applyBatch', () => {
  it('applies multiple non-overlapping edits atomically', () => {
    const src = 'const a = 1\nconst b = 2\nconst c = 3\n'
    const r = applyBatch(src, [
      { old_str: 'a = 1', new_str: 'a = 10' },
      { old_str: 'c = 3', new_str: 'c = 30' },
    ])
    expect('out' in r).toBe(true)
    if ('out' in r) {
      expect(r.count).toBe(2)
      expect(r.out).toBe('const a = 10\nconst b = 2\nconst c = 30\n')
    }
  })

  it('errors and applies nothing when one edit does not match', () => {
    const src = 'x = 1\ny = 2\n'
    const r = applyBatch(src, [
      { old_str: 'x = 1', new_str: 'x = 9' },
      { old_str: 'z = 3', new_str: 'z = 9' },
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/edits\[1\].*not found/)
  })

  it('rejects a non-unique old_str', () => {
    const r = applyBatch('dup\ndup\n', [{ old_str: 'dup', new_str: 'x' }])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/not unique/)
  })

  it('rejects overlapping edits', () => {
    const src = 'abcdef'
    const r = applyBatch(src, [
      { old_str: 'abcd', new_str: 'X' },
      { old_str: 'cdef', new_str: 'Y' },
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/overlap/)
  })
})

describe('edit_file handler', () => {
  let dir: string
  const rel = (abs: string) => relative(process.cwd(), abs)

  beforeEach(() => {
    dir = mkdtempSync(join(process.cwd(), '.vitest-edit-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const seed = (name: string, content: string) => {
    const abs = join(dir, name)
    writeFileSync(abs, content, 'utf-8')
    return rel(abs)
  }

  it('replaces a unique exact string', async () => {
    const p = seed('a.txt', 'hello world\n')
    const out = await edit_file.handler({ path: p, old_str: 'world', new_str: 'there' })
    expect(out.is_error).toBeFalsy()
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('hello there\n')
  })

  it('errors when old_str is not unique and replace_all is unset', async () => {
    const p = seed('a.txt', 'x x x')
    const out = await edit_file.handler({ path: p, old_str: 'x', new_str: 'y' })
    expect(out.is_error).toBe(true)
    expect(out.content).toMatch(/not unique/)
  })

  it('replaces every occurrence with replace_all', async () => {
    const p = seed('a.txt', 'x x x')
    const out = await edit_file.handler({ path: p, old_str: 'x', new_str: 'y', replace_all: true })
    expect(out.is_error).toBeFalsy()
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('y y y')
    expect(out.content).toMatch(/3 occurrences/)
  })

  it('rejects an identical old_str/new_str no-op', async () => {
    const p = seed('a.txt', 'abc')
    const out = await edit_file.handler({ path: p, old_str: 'abc', new_str: 'abc' })
    expect(out.is_error).toBe(true)
    expect(out.content).toMatch(/identical/)
  })

  it('falls back to a unique whitespace-tolerant match', async () => {
    // File is tab-indented; the model's old_str uses spaces, so the exact
    // indexOf misses and the whitespace-tolerant path takes over.
    const p = seed('a.py', 'def f():\n\tfoo = 1\n')
    const out = await edit_file.handler({ path: p, old_str: '    foo = 1', new_str: '\tfoo = 2' })
    expect(out.is_error).toBeFalsy()
    expect(out.content).toMatch(/whitespace-tolerant/)
    expect(readFileSync(join(dir, 'a.py'), 'utf-8')).toBe('def f():\n\tfoo = 2\n')
  })

  it('applies a batch of edits via the edits[] param', async () => {
    const p = seed('a.txt', 'one\ntwo\nthree\n')
    const out = await edit_file.handler({
      path: p,
      edits: [
        { old_str: 'one', new_str: '1' },
        { old_str: 'three', new_str: '3' },
      ],
    })
    expect(out.is_error).toBeFalsy()
    expect(out.content).toMatch(/2 edits/)
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('1\ntwo\n3\n')
  })

  it('writes nothing when a batch edit fails to match', async () => {
    const p = seed('a.txt', 'alpha\nbeta\n')
    const out = await edit_file.handler({
      path: p,
      edits: [
        { old_str: 'alpha', new_str: 'A' },
        { old_str: 'gamma', new_str: 'G' },
      ],
    })
    expect(out.is_error).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('alpha\nbeta\n')
  })

  it('on no match, returns the closest text in the file', async () => {
    const p = seed('a.txt', 'const alpha = 1\nconst beta = 2\n')
    const out = await edit_file.handler({ path: p, old_str: 'const alph = 1', new_str: 'x' })
    expect(out.is_error).toBe(true)
    expect(out.content).toMatch(/not found/)
    expect(out.content).toMatch(/Closest text/)
    expect(out.content).toMatch(/const alpha = 1/)
  })
})
