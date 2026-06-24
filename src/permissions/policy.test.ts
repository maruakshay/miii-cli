import { describe, it, expect } from 'vitest'
import { globToRegExp, subjectFor, generalizeCommand, patternToPersist } from './policy.js'

describe('globToRegExp', () => {
  it('matches an exact literal', () => {
    expect(globToRegExp('git status').test('git status')).toBe(true)
    expect(globToRegExp('git status').test('git status -s')).toBe(false)
  })

  it('treats * as a wildcard run', () => {
    expect(globToRegExp('npm test *').test('npm test src/a')).toBe(true)
    expect(globToRegExp('npm test *').test('npm test')).toBe(false) // needs a space + something
  })

  it('treats ? as a single char', () => {
    expect(globToRegExp('rm a?').test('rm ab')).toBe(true)
    expect(globToRegExp('rm a?').test('rm abc')).toBe(false)
  })

  it('escapes regex metacharacters in the literal', () => {
    // dots are literal, not "any char"
    expect(globToRegExp('cat a.txt').test('cat a.txt')).toBe(true)
    expect(globToRegExp('cat a.txt').test('cat aXtxt')).toBe(false)
  })

  it('anchors fully — no partial match', () => {
    expect(globToRegExp('ls').test('ls -la')).toBe(false)
    expect(globToRegExp('ls').test('please ls')).toBe(false)
  })

  it('documents the footgun: * spans shell separators', () => {
    // A hand-added "npm test *" rule also matches a chained destructive command,
    // because * compiles to .* with no separator awareness. Captured so a future
    // change to tighten this breaks the test deliberately.
    expect(globToRegExp('npm test *').test('npm test x; rm -rf /')).toBe(true)
  })
})

describe('generalizeCommand', () => {
  it('keeps only the program for non-wrapper commands', () => {
    expect(generalizeCommand("git commit -m 'x'")).toBe('git *')
    expect(generalizeCommand('node script.js')).toBe('node *')
  })

  it('keeps two tokens for wrapper programs', () => {
    expect(generalizeCommand('npm run build')).toBe('npm run *')
    expect(generalizeCommand('npm install left-pad')).toBe('npm install *')
    expect(generalizeCommand('npx tsc --noEmit')).toBe('npx tsc *')
    expect(generalizeCommand('brew list --versions')).toBe('brew list *')
  })

  it('falls back to one token when a wrapper has no subcommand', () => {
    expect(generalizeCommand('npm')).toBe('npm *')
  })

  it('collapses repeated whitespace', () => {
    expect(generalizeCommand('git   status')).toBe('git *')
  })

  it('generalizes the resulting glob to match later variants', () => {
    expect(globToRegExp(generalizeCommand('git commit -m "a"')).test('git push origin')).toBe(true)
    expect(globToRegExp(generalizeCommand('npm run build')).test('npm install x')).toBe(false)
  })
})

describe('patternToPersist', () => {
  it('generalizes run_bash commands', () => {
    expect(patternToPersist('run_bash', "git commit -m 'x'")).toBe('git *')
  })

  it('leaves path subjects untouched', () => {
    expect(patternToPersist('write_file', 'src/a.ts')).toBe('src/a.ts')
  })
})

describe('subjectFor', () => {
  it('uses the command for run_bash', () => {
    expect(subjectFor('run_bash', { command: 'ls -la' })).toBe('ls -la')
  })

  it('uses the path for file tools', () => {
    expect(subjectFor('write_file', { path: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('returns empty string when the subject field is missing', () => {
    expect(subjectFor('run_bash', {})).toBe('')
    expect(subjectFor('write_file', {})).toBe('')
    expect(subjectFor('run_bash', null)).toBe('')
  })
})
