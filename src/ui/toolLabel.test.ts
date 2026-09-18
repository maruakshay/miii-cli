import { describe, it, expect } from 'vitest'
import { describeTool, groupHeadline, groupToolUses } from './toolLabel.js'
import type { ToolUseDisplay } from './types.js'

describe('describeTool', () => {
  it('reads a file in English, keeping the call in the technical line', () => {
    const { text, technical } = describeTool('read_file', { path: './src/app.ts' })
    expect(text).toBe('Reading src/app.ts')
    expect(technical).toBe('Read(src/app.ts)')
  })

  it('prefers a description the model wrote over the raw command', () => {
    const { text, technical } = describeTool('run_bash', {
      command: 'npm run build -- --silent',
      description: 'Rebuilding the CLI',
    })
    expect(text).toBe('Rebuilding the CLI')
    expect(technical).toBe('Bash(npm run build -- --silent)')
  })

  it('recognises common commands when no description was given', () => {
    expect(describeTool('run_bash', { command: 'npm test -- --run' }).text).toBe('Running the tests')
    expect(describeTool('run_bash', { command: 'git status --short' }).text).toBe('Checking the working tree')
    expect(describeTool('run_bash', { command: 'git  diff HEAD' }).text).toBe('Reviewing the changes')
    expect(describeTool('run_bash', { command: 'cat src/x.ts | head -5' }).text).toBe('Reading src/x.ts')
    expect(describeTool('run_bash', { command: 'pnpm install' }).text).toBe('Installing dependencies')
  })

  it('falls back to the command itself for anything unrecognised', () => {
    expect(describeTool('run_bash', { command: 'weirdbin --go' }).text).toBe('Running weirdbin --go')
  })

  it('describes searches by what is being looked for', () => {
    expect(describeTool('grep', { pattern: 'TODO', glob: '*.ts' }).text).toBe(
      'Searching for “TODO” in *.ts files',
    )
    expect(describeTool('glob', { pattern: '**/*.tsx' }).text).toBe('Finding files matching “**/*.tsx”')
  })

  it('counts batched edits', () => {
    expect(describeTool('edit_file', { path: 'a.ts', edits: [{}, {}] }).text).toBe('Editing a.ts (2 changes)')
    expect(describeTool('edit_file', { path: 'a.ts', old_str: 'x', new_str: 'y' }).text).toBe('Editing a.ts')
  })

  it('names an unknown tool rather than dumping its input', () => {
    expect(describeTool('web_fetch', { url: 'https://x.dev' }).text).toBe('Running web_fetch')
  })
})

const use = (id: string, name: string, input: Record<string, unknown> = {}): ToolUseDisplay => ({ id, name, input })

describe('groupHeadline', () => {
  it('counts what is still in flight in the present tense', () => {
    expect(groupHeadline('run_bash', 1, true)).toBe('Running 1 shell command…')
    expect(groupHeadline('run_bash', 3, true)).toBe('Running 3 shell commands…')
    expect(groupHeadline('read_file', 1, true)).toBe('Reading 1 file…')
  })

  it('counts what is done in the past tense', () => {
    expect(groupHeadline('run_bash', 1, false)).toBe('Ran 1 shell command')
    expect(groupHeadline('read_file', 1, false)).toBe('Read 1 file')
    expect(groupHeadline('read_file', 6, false)).toBe('Read 6 files')
    expect(groupHeadline('grep', 2, false)).toBe('Ran 2 searches')
  })
})

describe('groupToolUses', () => {
  it('folds consecutive calls to the same tool into one block', () => {
    const groups = groupToolUses([
      use('a', 'read_file'),
      use('b', 'read_file'),
      use('c', 'read_file'),
    ])
    expect(groups.map((g) => g.length)).toEqual([3])
  })

  it('keeps every edit its own block, even back to back', () => {
    const groups = groupToolUses([use('a', 'edit_file'), use('b', 'edit_file')])
    expect(groups.map((g) => g.length)).toEqual([1, 1])
  })

  it('breaks a run when another tool interrupts it, preserving order', () => {
    const groups = groupToolUses([
      use('a', 'read_file'),
      use('b', 'edit_file'),
      use('c', 'read_file'),
      use('d', 'read_file'),
    ])
    expect(groups.map((g) => g.map((u) => u.id))).toEqual([['a'], ['b'], ['c', 'd']])
  })
})
