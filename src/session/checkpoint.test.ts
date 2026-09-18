import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { invalidateSettings } from '../settings.js'
import {
  snapshotForTurn, snapshotFile, listCheckpoints, restoreTo, clearCheckpoints,
  checkpointPreToolHook,
} from './checkpoint.js'

let root: string
let home: string
let realHome: string | undefined
const SESSION = 'test-session'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'miii-cp-'))
  home = mkdtempSync(join(tmpdir(), 'miii-home-'))
  realHome = process.env.HOME
  process.env.HOME = home
  invalidateSettings()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  invalidateSettings()
})

describe('checkpoints', () => {
  it('restores a file to what it was before the turn', () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'original')
    snapshotForTurn(SESSION, 0)
    snapshotFile(file, root)
    writeFileSync(file, 'agent wrote this')

    restoreTo(SESSION, 0, root)
    expect(readFileSync(file, 'utf-8')).toBe('original')
  })

  it('deletes a file the agent created, since it did not exist before', () => {
    const file = join(root, 'new.txt')
    snapshotForTurn(SESSION, 0)
    snapshotFile(file, root)
    writeFileSync(file, 'created by the agent')

    const result = restoreTo(SESSION, 0, root)
    expect(existsSync(file)).toBe(false)
    expect(result.removed).toEqual(['new.txt'])
  })

  it('keeps only the first snapshot of a path within a turn', () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'v1')
    snapshotForTurn(SESSION, 0)
    snapshotFile(file, root)
    writeFileSync(file, 'v2')
    snapshotFile(file, root)
    writeFileSync(file, 'v3')

    restoreTo(SESSION, 0, root)
    expect(readFileSync(file, 'utf-8')).toBe('v1')
  })

  it('rewinding to an early turn undoes every later turn too', () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'turn0')
    snapshotForTurn(SESSION, 0)
    snapshotFile(file, root)
    writeFileSync(file, 'turn1')
    snapshotForTurn(SESSION, 2)
    snapshotFile(file, root)
    writeFileSync(file, 'turn2')

    restoreTo(SESSION, 0, root)
    expect(readFileSync(file, 'utf-8')).toBe('turn0')
  })

  it('rewinding to a later turn leaves the earlier one alone', () => {
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    writeFileSync(a, 'a0')
    writeFileSync(b, 'b0')
    snapshotForTurn(SESSION, 0)
    snapshotFile(a, root)
    writeFileSync(a, 'a1')
    snapshotForTurn(SESSION, 2)
    snapshotFile(b, root)
    writeFileSync(b, 'b1')

    restoreTo(SESSION, 2, root)
    expect(readFileSync(a, 'utf-8')).toBe('a1')
    expect(readFileSync(b, 'utf-8')).toBe('b0')
  })

  it('lists turns with the files each was about to change', () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    snapshotForTurn(SESSION, 0)
    snapshotFile(join(root, 'a.txt'), root)
    snapshotFile(join(root, 'b.txt'), root)
    snapshotForTurn(SESSION, 3)
    snapshotFile(join(root, 'c.txt'), root)

    const points = listCheckpoints(SESSION, root)
    expect(points.map((p) => p.turn)).toEqual([0, 3])
    expect(points[0].files.sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('drops the rewound turns so a second rewind cannot re-apply them', () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'original')
    snapshotForTurn(SESSION, 0)
    snapshotFile(file, root)
    writeFileSync(file, 'changed')

    restoreTo(SESSION, 0, root)
    writeFileSync(file, 'newer work')
    restoreTo(SESSION, 0, root)
    expect(readFileSync(file, 'utf-8')).toBe('newer work')
  })

  it('ignores a path outside the project', () => {
    const outside = join(home, 'elsewhere.txt')
    writeFileSync(outside, 'not ours')
    snapshotForTurn(SESSION, 0)
    snapshotFile(outside, root)
    expect(listCheckpoints(SESSION, root)).toEqual([])
  })

  it('snapshots only the tools that write', () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'x')
    snapshotForTurn(SESSION, 0)
    checkpointPreToolHook({ type: 'tool_use', id: '1', name: 'read_file', input: { path: 'src/a.ts' } }, root)
    expect(listCheckpoints(SESSION, root)).toEqual([])
    checkpointPreToolHook({ type: 'tool_use', id: '2', name: 'edit_file', input: { path: 'src/a.ts' } }, root)
    expect(listCheckpoints(SESSION, root)[0].files).toEqual(['src/a.ts'])
  })

  it('clearCheckpoints forgets the session', () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    snapshotForTurn(SESSION, 0)
    snapshotFile(join(root, 'a.txt'), root)
    clearCheckpoints(SESSION, root)
    expect(listCheckpoints(SESSION, root)).toEqual([])
  })
})
