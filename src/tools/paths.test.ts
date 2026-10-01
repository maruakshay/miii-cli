import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { confinePath } from './paths.js'

const root = mkdtempSync(join(tmpdir(), 'miii-paths-'))
const project = join(root, 'project')
const outside = join(root, 'outside')
const originalCwd = process.cwd()

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret'), 'key')
  process.chdir(project)
})
afterAll(() => {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
})

describe('confinePath', () => {
  it('allows paths inside the project, existing or not', () => {
    expect(confinePath('src/a.ts')).toBe(join(process.cwd(), 'src', 'a.ts'))
    expect(confinePath('new/dir/b.ts')).toBe(join(process.cwd(), 'new', 'dir', 'b.ts'))
  })

  it('refuses traversal and absolute paths outside', () => {
    expect(() => confinePath('../outside/secret')).toThrow(/outside the working directory/)
    expect(() => confinePath(join(outside, 'secret'))).toThrow(/outside the working directory/)
  })

  it('refuses a symlinked directory that points outside the project', () => {
    symlinkSync(outside, join(project, 'notes'))
    expect(() => confinePath('notes/secret')).toThrow(/outside the working directory/)
    // Creating a file through the link would land outside just the same.
    expect(() => confinePath('notes/new.txt')).toThrow(/outside the working directory/)
  })

  it('refuses a symlinked file that points outside the project', () => {
    symlinkSync(join(outside, 'secret'), join(project, 'secret'))
    expect(() => confinePath('secret')).toThrow(/outside the working directory/)
  })

  it('refuses a dangling symlink, whose target a write would create', () => {
    symlinkSync(join(outside, 'not-yet'), join(project, 'later'))
    expect(() => confinePath('later')).toThrow(/does not exist/)
  })

  it('allows a symlink that stays inside the project', () => {
    symlinkSync(join(project, 'src'), join(project, 'source'))
    expect(confinePath('source/a.ts')).toBe(join(process.cwd(), 'source', 'a.ts'))
  })
})
