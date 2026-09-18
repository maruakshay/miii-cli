import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { invalidateSettings } from '../settings.js'
import { matches, hooksFor, runHooks, hasHooks } from './run.js'

let root: string
let home: string
let realHome: string | undefined

function settings(body: unknown) {
  mkdirSync(join(root, '.miii'), { recursive: true })
  writeFileSync(join(root, '.miii', 'settings.json'), JSON.stringify(body))
  invalidateSettings()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'miii-hooks-'))
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

describe('matcher', () => {
  it('is anchored, so one tool name does not match a longer one', () => {
    expect(matches('edit_file', 'edit_file')).toBe(true)
    expect(matches('edit_file', 'edit_file_bulk')).toBe(false)
  })
  it('accepts alternation', () => {
    expect(matches('edit_file|write_file', 'write_file')).toBe(true)
    expect(matches('edit_file|write_file', 'read_file')).toBe(false)
  })
  it('treats absent and * as every tool', () => {
    expect(matches(undefined, 'anything')).toBe(true)
    expect(matches('*', 'anything')).toBe(true)
  })
  it('matches nothing when the pattern will not compile', () => {
    expect(matches('[unclosed', 'read_file')).toBe(false)
  })
})

describe('hooksFor', () => {
  it('collects only the groups whose matcher applies', () => {
    settings({
      hooks: {
        PreToolUse: [
          { matcher: 'run_bash', hooks: [{ command: 'bash-only' }] },
          { matcher: 'edit_file', hooks: [{ command: 'edit-only' }] },
          { hooks: [{ command: 'always' }] },
        ],
      },
    })
    expect(hooksFor('PreToolUse', 'run_bash', root).map((h) => h.command)).toEqual(['bash-only', 'always'])
    expect(hasHooks('PostToolUse', 'run_bash', root)).toBe(false)
  })
  it('skips a group with no usable command', () => {
    settings({ hooks: { Stop: [{ hooks: [{ command: '   ' }] }] } })
    expect(hooksFor('Stop', undefined, root)).toEqual([])
  })
})

describe('runHooks', () => {
  it('does nothing when no hook is configured', async () => {
    const out = await runHooks({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'read_file' })
    expect(out.blocked).toBe(false)
    expect(out.warnings).toEqual([])
  })

  it('blocks on exit 2 and hands stderr back as the reason', async () => {
    settings({
      hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ command: 'echo "migrations are off limits" >&2; exit 2' }] }] },
    })
    const out = await runHooks({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'write_file' })
    expect(out.blocked).toBe(true)
    expect(out.reason).toContain('migrations are off limits')
  })

  it('collects stdout as context on success', async () => {
    settings({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'echo sprint-42' }] }] } })
    const out = await runHooks({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'hi' })
    expect(out.blocked).toBe(false)
    expect(out.context).toBe('sprint-42')
  })

  it('reports a broken hook as a warning without blocking the turn', async () => {
    settings({ hooks: { PostToolUse: [{ hooks: [{ command: 'exit 7' }] }] } })
    const out = await runHooks({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'read_file' })
    expect(out.blocked).toBe(false)
    expect(out.warnings[0]).toContain('exit 7')
  })

  it('passes the event to the hook as JSON on stdin', async () => {
    const sink = join(root, 'payload.json')
    settings({ hooks: { PreToolUse: [{ hooks: [{ command: `cat > ${sink}` }] }] } })
    await runHooks({
      hook_event_name: 'PreToolUse',
      cwd: root,
      tool_name: 'edit_file',
      tool_input: { path: 'src/a.ts' },
    })
    const payload = JSON.parse(readFileSync(sink, 'utf-8'))
    expect(payload.hook_event_name).toBe('PreToolUse')
    expect(payload.tool_input.path).toBe('src/a.ts')
  })

  it('exposes the touched path in the environment for one-liners', async () => {
    const sink = join(root, 'path.txt')
    settings({ hooks: { PostToolUse: [{ hooks: [{ command: `printf '%s' "$MIII_TOOL_PATH" > ${sink}` }] }] } })
    await runHooks({
      hook_event_name: 'PostToolUse',
      cwd: root,
      tool_name: 'edit_file',
      tool_input: { path: 'src/b.ts' },
    })
    expect(readFileSync(sink, 'utf-8')).toBe('src/b.ts')
  })

  it('stops at the first block, so later hooks do not run', async () => {
    const sink = join(root, 'ran.txt')
    settings({
      hooks: {
        PreToolUse: [
          { hooks: [{ command: 'exit 2' }, { command: `touch ${sink}` }] },
        ],
      },
    })
    const out = await runHooks({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'run_bash' })
    expect(out.blocked).toBe(true)
    expect(existsSync(sink)).toBe(false)
  })
})
