import { describe, it, expect } from 'vitest'
import { resolveToolName, unwrapEnvelope, repairJson, normalizeToolInput } from './normalize.js'
import { getTool, TOOLS } from '../tools/registry.js'

const NAMES = TOOLS.map((t) => t.name)
const schema = (name: string) => getTool(name)!.input_schema

describe('resolveToolName', () => {
  it('passes an exact name straight through', () => {
    expect(resolveToolName('read_file', NAMES)).toBe('read_file')
  })

  it('normalises casing and separators', () => {
    for (const raw of ['readFile', 'ReadFile', 'read-file', 'READ_FILE', 'read file']) {
      expect(resolveToolName(raw, NAMES)).toBe('read_file')
    }
  })

  it('strips a namespace prefix', () => {
    expect(resolveToolName('functions.run_bash', NAMES)).toBe('run_bash')
    expect(resolveToolName('tools/write_file', NAMES)).toBe('write_file')
  })

  it('maps names borrowed from other harnesses', () => {
    expect(resolveToolName('bash', NAMES)).toBe('run_bash')
    expect(resolveToolName('str_replace_editor', NAMES)).toBe('edit_file')
    expect(resolveToolName('ripgrep', NAMES)).toBe('grep')
    expect(resolveToolName('TodoWrite', NAMES)).toBe('write_todos')
    expect(resolveToolName('list_files', NAMES)).toBe('glob')
  })

  it('recovers a typo via edit distance', () => {
    expect(resolveToolName('read_fil', NAMES)).toBe('read_file')
    expect(resolveToolName('wrote_file', NAMES)).toBe('write_file')
  })

  it('refuses a name that is nothing like a tool', () => {
    expect(resolveToolName('frobnicate', NAMES)).toBeNull()
    expect(resolveToolName('', NAMES)).toBeNull()
  })

  it('does not guess when fuzzy matching is off', () => {
    expect(resolveToolName('read_fil', NAMES, false)).toBeNull()
    // Exact, canonical and alias tiers still apply.
    expect(resolveToolName('readFile', NAMES, false)).toBe('read_file')
    expect(resolveToolName('bash', NAMES, false)).toBe('run_bash')
  })

  it('stays silent on an ambiguous tie', () => {
    // Equidistant from both — better to report unknown than to pick one.
    expect(resolveToolName('ile', ['file_a', 'file_b'])).toBeNull()
  })
})

describe('repairJson', () => {
  it('returns valid JSON unchanged', () => {
    expect(repairJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('closes a string and braces cut off mid-write', () => {
    expect(repairJson('{"path":"a.ts","content":"const x = 1')).toEqual({
      path: 'a.ts',
      content: 'const x = 1',
    })
  })

  it('drops a key the model never got to fill', () => {
    expect(repairJson('{"path":"a.ts","content":')).toEqual({ path: 'a.ts' })
    expect(repairJson('{"path":"a.ts",')).toEqual({ path: 'a.ts' })
  })

  it('closes nested structures', () => {
    expect(repairJson('{"todos":[{"content":"do it","status":"pend')).toEqual({
      todos: [{ content: 'do it', status: 'pend' }],
    })
  })

  it('rejects something that is not an object', () => {
    expect(repairJson('just prose')).toBeNull()
    expect(repairJson('[1,2]')).toBeNull()
  })
})

describe('unwrapEnvelope', () => {
  it('unwraps {name, arguments}', () => {
    expect(unwrapEnvelope({ name: 'write_file', arguments: { path: 'a', content: 'b' } }))
      .toEqual({ path: 'a', content: 'b' })
  })

  it('unwraps the args/parameters/input spellings', () => {
    expect(unwrapEnvelope({ tool: 'grep', args: { pattern: 'x' } })).toEqual({ pattern: 'x' })
    expect(unwrapEnvelope({ name: 'grep', parameters: { pattern: 'x' } })).toEqual({ pattern: 'x' })
    expect(unwrapEnvelope({ name: 'grep', input: { pattern: 'x' } })).toEqual({ pattern: 'x' })
  })

  it('unwraps a nested function envelope', () => {
    expect(unwrapEnvelope({ function: { name: 'read_file', arguments: { path: 'a' } } }))
      .toEqual({ path: 'a' })
  })

  it('parses arguments handed over as a JSON string', () => {
    expect(unwrapEnvelope({ name: 'read_file', arguments: '{"path":"a.ts"}' }))
      .toEqual({ path: 'a.ts' })
  })

  it('recovers the _raw fallback the OpenAI adapter leaves behind', () => {
    expect(unwrapEnvelope({ _raw: '{"path":"a.ts","offset":2' }))
      .toEqual({ path: 'a.ts', offset: 2 })
  })

  it('leaves a real payload alone', () => {
    const real = { path: 'a.ts', content: 'x' }
    expect(unwrapEnvelope(real)).toBe(real)
  })

  it('leaves a payload that merely has extra fields beside arguments', () => {
    // `path` is not envelope machinery, so this is a real payload with a stray
    // key — descending would throw away the path the model actually gave.
    const input = { path: 'a.ts', arguments: { path: 'b.ts' } }
    expect(unwrapEnvelope(input)).toBe(input)
  })
})

describe('normalizeToolInput', () => {
  it('renames keys borrowed from other harnesses', () => {
    const { input, repairs } = normalizeToolInput(schema('read_file'), { file_path: 'a.ts' })
    expect(input).toEqual({ path: 'a.ts' })
    expect(repairs).toContain('file_path → path')
  })

  it('renames per tool, without cross-tool confusion', () => {
    // `limit` means max_results to grep, and is a declared field of read_file.
    expect(normalizeToolInput(schema('grep'), { pattern: 'x', limit: 5 }).input)
      .toEqual({ pattern: 'x', max_results: 5 })
    expect(normalizeToolInput(schema('read_file'), { path: 'a', limit: 5 }).input)
      .toEqual({ path: 'a', limit: 5 })
  })

  it('never remaps a spelling the tool itself declares', () => {
    // grep declares both `glob` and `pattern`; `glob` must stay put.
    expect(normalizeToolInput(schema('grep'), { pattern: 'x', glob: '*.ts' }).input)
      .toEqual({ pattern: 'x', glob: '*.ts' })
  })

  it('never overwrites a field the model already set', () => {
    const { input } = normalizeToolInput(schema('read_file'), { path: 'real.ts', filename: 'other.ts' })
    expect(input.path).toBe('real.ts')
    expect(input.filename).toBe('other.ts')
  })

  it('coerces stringified numbers and booleans', () => {
    const { input } = normalizeToolInput(schema('grep'), {
      pattern: 'x', max_results: '20', case_insensitive: 'true', files_only: 'no',
    })
    expect(input).toEqual({
      pattern: 'x', max_results: 20, case_insensitive: true, files_only: false,
    })
  })

  it('joins file content sent as an array of lines', () => {
    const { input } = normalizeToolInput(schema('write_file'), {
      path: 'a.ts', content: ['const a = 1', 'const b = 2'],
    })
    expect(input.content).toBe('const a = 1\nconst b = 2')
  })

  it('parses an array field sent as a JSON string', () => {
    const { input } = normalizeToolInput(schema('write_todos'), {
      todos: '[{"content":"ship it","status":"pending"}]',
    })
    expect(input.todos).toEqual([{ content: 'ship it', status: 'pending' }])
  })

  it('wraps a single item where a list is declared, and fixes its keys', () => {
    const { input } = normalizeToolInput(schema('write_todos'), {
      tasks: { task: 'ship it', state: 'pending' },
    })
    expect(input.todos).toEqual([{ content: 'ship it', status: 'pending' }])
  })

  it('fixes keys inside array items', () => {
    const { input } = normalizeToolInput(schema('edit_file'), {
      path: 'a.ts',
      edits: [{ old_string: 'a', new_string: 'b' }],
    })
    expect(input.edits).toEqual([{ old_str: 'a', new_str: 'b' }])
  })

  it('handles an envelope, a rename and a coercion in one call', () => {
    const { input } = normalizeToolInput(schema('read_file'), {
      name: 'read_file',
      arguments: '{"file_path":"a.ts","start_line":"10"}',
    })
    expect(input).toEqual({ path: 'a.ts', offset: 10 })
  })

  it('leaves a well-formed call completely untouched', () => {
    const clean = { path: 'a.ts', old_str: 'a', new_str: 'b', replace_all: true }
    const { input, repairs } = normalizeToolInput(schema('edit_file'), clean)
    expect(input).toEqual(clean)
    expect(repairs).toEqual([])
  })

  it('leaves an unsalvageable value for validation to reject', () => {
    const { input } = normalizeToolInput(schema('read_file'), { path: 'a.ts', offset: 'soon' })
    expect(input.offset).toBe('soon')
  })
})

describe('lone-argument adoption', () => {
  it('adopts the only leftover key for the only unfilled required field', () => {
    const { input, repairs } = normalizeToolInput(schema('run_bash'), { instruction: 'ls -la' })
    expect(input).toEqual({ command: 'ls -la' })
    expect(repairs.join()).toContain('only field left unfilled')
  })

  it('stays out of it when more than one field is missing', () => {
    const { input } = normalizeToolInput(schema('write_file'), { whatever: 'x' })
    expect(input).toEqual({ whatever: 'x' })
  })

  it('stays out of it when more than one key is unrecognised', () => {
    const { input } = normalizeToolInput(schema('run_bash'), { foo: 'ls', bar: 'pwd' })
    expect(input).toEqual({ foo: 'ls', bar: 'pwd' })
  })

  it('stays out of it when the type is wrong', () => {
    const { input } = normalizeToolInput(schema('run_bash'), { foo: 42 })
    expect(input).toEqual({ foo: 42 })
  })

  it('stays out of it when the required field is already filled', () => {
    const { input } = normalizeToolInput(schema('run_bash'), { command: 'ls', note: 'hi' })
    expect(input).toEqual({ command: 'ls', note: 'hi' })
  })
})
