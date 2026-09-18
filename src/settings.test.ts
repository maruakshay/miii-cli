import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  loadSettings, invalidateSettings, mergeSettings, parseRuleSpec, settingsProblems,
  settingsAllowRules, settingsDenyRules, defaultPermissionMode, type Settings,
} from './settings.js'

let root: string
let home: string
let realHome: string | undefined

function write(name: string, body: unknown) {
  mkdirSync(join(root, '.miii'), { recursive: true })
  writeFileSync(join(root, '.miii', name), typeof body === 'string' ? body : JSON.stringify(body))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'miii-settings-'))
  // The user scope resolves through homedir(), so point HOME at a temp dir —
  // otherwise these assertions depend on whether the machine running them
  // happens to have a ~/.miii/settings.json.
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

describe('parseRuleSpec', () => {
  it('reads Tool(pattern)', () => {
    expect(parseRuleSpec('run_bash(npm test *)')).toEqual({ tool: 'run_bash', pattern: 'npm test *' })
  })
  it('treats a bare tool name as any arguments', () => {
    expect(parseRuleSpec('mcp__github__create_issue')).toEqual({
      tool: 'mcp__github__create_issue',
      pattern: '*',
    })
  })
  it('reads an empty pattern as any arguments', () => {
    expect(parseRuleSpec('write_todos()')).toEqual({ tool: 'write_todos', pattern: '*' })
  })
  it('rejects nonsense rather than inventing a rule', () => {
    expect(parseRuleSpec('')).toBeNull()
    expect(parseRuleSpec('not a rule at all')).toBeNull()
  })
})

describe('mergeSettings', () => {
  it('appends hooks instead of replacing them', () => {
    const base: Settings = { hooks: { PreToolUse: [{ hooks: [{ command: 'a' }] }] } }
    const next: Settings = { hooks: { PreToolUse: [{ hooks: [{ command: 'b' }] }] } }
    const merged = mergeSettings(base, next)
    expect(merged.hooks?.PreToolUse).toHaveLength(2)
  })
  it('concatenates permission rules from both scopes', () => {
    const merged = mergeSettings(
      { permissions: { allow: ['run_bash(ls)'] } },
      { permissions: { deny: ['run_bash(rm *)'] } },
    )
    expect(merged.permissions?.allow).toEqual(['run_bash(ls)'])
    expect(merged.permissions?.deny).toEqual(['run_bash(rm *)'])
  })
  it('lets the later scope win a scalar', () => {
    const merged = mergeSettings({ vimMode: false }, { vimMode: true })
    expect(merged.vimMode).toBe(true)
  })
  it('merges env shallowly, later wins', () => {
    const merged = mergeSettings({ env: { A: '1', B: '2' } }, { env: { B: '3' } })
    expect(merged.env).toEqual({ A: '1', B: '3' })
  })
})

describe('loadSettings', () => {
  it('is empty when nothing is configured', () => {
    expect(loadSettings(root)).toEqual({})
  })
  it('lets a project file override the user one', () => {
    mkdirSync(join(home, '.miii'), { recursive: true })
    writeFileSync(join(home, '.miii', 'settings.json'), JSON.stringify({ vimMode: true }))
    write('settings.json', { vimMode: false })
    expect(loadSettings(root).vimMode).toBe(false)
  })
  it('keeps a user hook when the project adds its own', () => {
    mkdirSync(join(home, '.miii'), { recursive: true })
    writeFileSync(
      join(home, '.miii', 'settings.json'),
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'mine' }] }] } }),
    )
    write('settings.json', { hooks: { PostToolUse: [{ hooks: [{ command: 'theirs' }] }] } })
    const commands = (loadSettings(root).hooks?.PostToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command))
    expect(commands).toEqual(['mine', 'theirs'])
  })
  it('lets settings.local.json override settings.json', () => {
    write('settings.json', { permissions: { defaultMode: 'plan' } })
    write('settings.local.json', { permissions: { defaultMode: 'acceptEdits' } })
    expect(defaultPermissionMode(root)).toBe('acceptEdits')
  })
  it('reads allow and deny rules into rule shape', () => {
    write('settings.json', { permissions: { allow: ['run_bash(npm test *)'], deny: ['run_bash(git push *)'] } })
    expect(settingsAllowRules(root)).toEqual([{ tool: 'run_bash', pattern: 'npm test *' }])
    expect(settingsDenyRules(root)).toEqual([{ tool: 'run_bash', pattern: 'git push *' }])
  })
  it('reports a malformed file instead of silently using defaults', () => {
    write('settings.json', '{ not json')
    loadSettings(root)
    expect(settingsProblems()).toHaveLength(1)
    expect(settingsProblems()[0].path).toContain('settings.json')
  })
  it('ignores a file that is a JSON array rather than an object', () => {
    write('settings.json', [1, 2, 3])
    loadSettings(root)
    expect(settingsProblems()[0].message).toMatch(/object/)
  })
})
