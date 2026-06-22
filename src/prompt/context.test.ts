import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  findContextFile,
  loadProjectContext,
  CONTEXT_FILENAME,
  MAX_CONTEXT_BYTES,
} from './context.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'miii-ctx-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('findContextFile', () => {
  it('finds MIII.md in cwd', () => {
    const f = join(root, CONTEXT_FILENAME)
    writeFileSync(f, 'hi')
    expect(findContextFile(root)).toBe(f)
  })

  it('walks up to a parent dir', () => {
    const sub = join(root, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    const f = join(root, CONTEXT_FILENAME)
    writeFileSync(f, 'hi')
    expect(findContextFile(sub)).toBe(f)
  })

  it('nearest file wins over an ancestor', () => {
    const sub = join(root, 'a')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(root, CONTEXT_FILENAME), 'far')
    const near = join(sub, CONTEXT_FILENAME)
    writeFileSync(near, 'near')
    expect(findContextFile(sub)).toBe(near)
  })

  it('stops at the repo root (.git) without ascending past it', () => {
    const repo = join(root, 'repo')
    const sub = join(repo, 'pkg')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
    // File lives ABOVE the repo root — must not be found.
    writeFileSync(join(root, CONTEXT_FILENAME), 'outside')
    expect(findContextFile(sub)).toBeNull()
  })

  it('returns null when no file exists', () => {
    expect(findContextFile(root)).toBeNull()
  })
})

describe('loadProjectContext', () => {
  it('returns empty when no file', () => {
    expect(loadProjectContext(root)).toEqual({ content: '', source: null, truncated: false })
  })

  it('loads file content', () => {
    const f = join(root, CONTEXT_FILENAME)
    writeFileSync(f, 'use tabs')
    const c = loadProjectContext(root)
    expect(c.content).toBe('use tabs')
    expect(c.source).toBe(f)
    expect(c.truncated).toBe(false)
  })

  it('treats an empty file as no content but records source', () => {
    const f = join(root, CONTEXT_FILENAME)
    writeFileSync(f, '')
    const c = loadProjectContext(root)
    expect(c.content).toBe('')
    expect(c.source).toBe(f)
  })

  it('truncates oversized files', () => {
    const f = join(root, CONTEXT_FILENAME)
    writeFileSync(f, 'x'.repeat(MAX_CONTEXT_BYTES + 1000))
    const c = loadProjectContext(root)
    expect(c.truncated).toBe(true)
    expect(Buffer.byteLength(c.content, 'utf8')).toBeLessThanOrEqual(MAX_CONTEXT_BYTES)
  })
})
