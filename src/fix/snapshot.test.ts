import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { RoundSnapshot, fingerprint, fingerprintDiff } from './snapshot.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'miii-fix-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/a.ts'), 'original a')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: '1', name, input })

describe('RoundSnapshot', () => {
  it('restores an edited file and removes a created one', () => {
    const snap = new RoundSnapshot(root)
    snap.onPreTool(use('edit_file', { path: 'src/a.ts' }))
    snap.onPreTool(use('write_file', { path: 'src/new.ts' }))
    writeFileSync(join(root, 'src/a.ts'), 'broken a')
    writeFileSync(join(root, 'src/new.ts'), 'new')

    expect(snap.changed()).toEqual(['src/a.ts', 'src/new.ts'])
    const rb = snap.rollback()
    expect(rb.restored).toEqual(['src/a.ts'])
    expect(rb.removed).toEqual(['src/new.ts'])
    expect(readFileSync(join(root, 'src/a.ts'), 'utf-8')).toBe('original a')
    expect(existsSync(join(root, 'src/new.ts'))).toBe(false)
  })

  it('keeps the first state when a file is touched twice', () => {
    const snap = new RoundSnapshot(root)
    snap.onPreTool(use('edit_file', { path: 'src/a.ts' }))
    writeFileSync(join(root, 'src/a.ts'), 'step 1')
    snap.onPreTool(use('edit_file', { path: 'src/a.ts' }))
    writeFileSync(join(root, 'src/a.ts'), 'step 2')
    snap.rollback()
    expect(readFileSync(join(root, 'src/a.ts'), 'utf-8')).toBe('original a')
  })

  it('covers files a shell command overwrites', () => {
    const snap = new RoundSnapshot(root)
    snap.onPreTool(use('run_bash', { command: 'echo hi > src/a.ts' }))
    writeFileSync(join(root, 'src/a.ts'), 'hi')
    snap.rollback()
    expect(readFileSync(join(root, 'src/a.ts'), 'utf-8')).toBe('original a')
  })

  it('ignores paths outside the project', () => {
    const snap = new RoundSnapshot(root)
    snap.onPreTool(use('write_file', { path: '../escape.ts' }))
    expect(snap.changed()).toEqual([])
  })

  it('reports changes it never saw as unrestorable', () => {
    const snap = new RoundSnapshot(root)
    expect(snap.rollback(['src/sed-edited.ts']).unrestorable).toEqual(['src/sed-edited.ts'])
  })

  it('leaves untouched files alone', () => {
    const snap = new RoundSnapshot(root)
    snap.onPreTool(use('edit_file', { path: 'src/a.ts' }))
    expect(snap.rollback().restored).toEqual([])
  })
})

describe('fingerprint', () => {
  it('is null outside git', () => {
    expect(fingerprint(root)).toBeNull()
  })

  it('sees modified and new files in a repo', () => {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const before = fingerprint(root)
    writeFileSync(join(root, 'src/a.ts'), 'changed through the shell, longer')
    writeFileSync(join(root, 'src/b.ts'), 'new')
    const after = fingerprint(root)
    expect(fingerprintDiff(before, after)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})
