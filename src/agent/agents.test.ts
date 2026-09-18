import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadAgents, findAgent, READ_ONLY_SUBAGENT_TOOLS } from './agents.js'

let root: string
let home: string
let realHome: string | undefined

function agent(name: string, body: string, scope: 'project' | 'user' = 'project') {
  const dir = join(scope === 'user' ? home : root, '.miii', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'miii-agents-'))
  home = mkdtempSync(join(tmpdir(), 'miii-home-'))
  realHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
})

describe('built-ins', () => {
  it('ship so task works with no files at all', () => {
    const names = loadAgents(root).map((a) => a.name)
    expect(names).toContain('explore')
    expect(names).toContain('general')
  })
  it('explore is read-only', () => {
    expect(findAgent('explore', root)?.tools).toEqual(READ_ONLY_SUBAGENT_TOOLS)
  })
})

describe('definitions on disk', () => {
  it('reads frontmatter and body', () => {
    agent('reviewer', `---
name: reviewer
description: Reviews a diff for bugs.
tools: read_file, grep
model: qwen2.5-coder:7b
---
You are a reviewer.`)
    const found = findAgent('reviewer', root)
    expect(found?.description).toBe('Reviews a diff for bugs.')
    expect(found?.tools).toEqual(['read_file', 'grep'])
    expect(found?.model).toBe('qwen2.5-coder:7b')
    expect(found?.prompt).toBe('You are a reviewer.')
    expect(found?.source).toBe('project')
  })

  it('falls back to the filename when frontmatter has no name', () => {
    agent('auditor', 'Audit things.')
    expect(findAgent('auditor', root)?.name).toBe('auditor')
  })

  it('a project agent shadows a user one', () => {
    agent('helper', '---\ndescription: theirs\n---\nproject body', 'project')
    agent('helper', '---\ndescription: mine\n---\nuser body', 'user')
    const all = loadAgents(root).filter((a) => a.name === 'helper')
    expect(all).toHaveLength(1)
    expect(all[0].description).toBe('theirs')
  })

  it('a definition can replace a built-in', () => {
    agent('explore', '---\ndescription: our own search agent\n---\nSearch differently.')
    const found = findAgent('explore', root)
    expect(found?.source).toBe('project')
    expect(found?.description).toBe('our own search agent')
  })

  it('skips a file with no body — an empty prompt is not an agent', () => {
    agent('hollow', '---\ndescription: nothing here\n---\n')
    expect(findAgent('hollow', root)).toBeUndefined()
  })

  it('leaves tools empty when unspecified, meaning the default set', () => {
    agent('plain', 'Do the thing.')
    expect(findAgent('plain', root)?.tools).toEqual([])
  })
})
