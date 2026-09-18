import { describe, it, expect } from 'vitest'
import { parseHeadlessArgs } from './headless.js'

describe('parseHeadlessArgs', () => {
  it('returns nothing without -p, so the TUI still launches', () => {
    expect(parseHeadlessArgs([]).options).toBeNull()
    expect(parseHeadlessArgs(['--continue']).options).toBeNull()
  })

  it('takes the prompt after -p', () => {
    expect(parseHeadlessArgs(['-p', 'fix the build']).options?.prompt).toBe('fix the build')
    expect(parseHeadlessArgs(['--print', 'fix the build']).options?.prompt).toBe('fix the build')
  })

  it('accepts -p with no prompt, for the piped case', () => {
    const opts = parseHeadlessArgs(['-p', '--output-format', 'json']).options
    expect(opts?.prompt).toBe('')
    expect(opts?.outputFormat).toBe('json')
  })

  it('does not swallow the next flag as the prompt', () => {
    const opts = parseHeadlessArgs(['-p', '--max-turns', '3']).options
    expect(opts?.prompt).toBe('')
    expect(opts?.maxTurns).toBe(3)
  })

  it('defaults to text output', () => {
    expect(parseHeadlessArgs(['-p', 'hi']).options?.outputFormat).toBe('text')
  })

  it('rejects an unknown output format instead of guessing', () => {
    const parsed = parseHeadlessArgs(['-p', 'hi', '--output-format', 'yaml'])
    expect(parsed.options).toBeNull()
    expect(parsed.error).toContain('yaml')
  })

  it('rejects an unknown permission mode', () => {
    const parsed = parseHeadlessArgs(['-p', 'hi', '--permission-mode', 'yolo'])
    expect(parsed.options).toBeNull()
    expect(parsed.error).toContain('yolo')
  })

  it('reads every permission mode the policy defines', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'bypass']) {
      expect(parseHeadlessArgs(['-p', 'hi', '--permission-mode', mode]).options?.mode).toBe(mode)
    }
  })

  it('maps --dangerously-skip-permissions onto bypass', () => {
    expect(parseHeadlessArgs(['-p', 'hi', '--dangerously-skip-permissions']).options?.mode).toBe('bypass')
  })

  it('splits --allowed-tools on commas', () => {
    const opts = parseHeadlessArgs(['-p', 'hi', '--allowed-tools', 'read_file, grep ,glob']).options
    expect(opts?.allowedTools).toEqual(['read_file', 'grep', 'glob'])
  })

  it('rejects a non-positive --max-turns', () => {
    expect(parseHeadlessArgs(['-p', 'hi', '--max-turns', '0']).error).toBeTruthy()
    expect(parseHeadlessArgs(['-p', 'hi', '--max-turns', 'lots']).error).toBeTruthy()
  })

  it('carries session flags through', () => {
    expect(parseHeadlessArgs(['-p', 'hi', '--resume', 'abc']).options?.resume).toBe('abc')
    expect(parseHeadlessArgs(['-p', 'hi', '-c']).options?.continueLast).toBe(true)
  })

  it('takes a bare word as the prompt when -p came earlier in the list', () => {
    expect(parseHeadlessArgs(['--model', 'x', '-p', 'do the thing']).options?.prompt).toBe('do the thing')
    expect(parseHeadlessArgs(['--model', 'x', '-p', 'do the thing']).options?.model).toBe('x')
  })
})
