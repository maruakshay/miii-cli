import { describe, it, expect } from 'vitest'
import { applyVimKey, nextWord, prevWord, wordEnd, type VimState } from './vim.js'

const normal = (input: string, caret: number): VimState => ({ input, caret, mode: 'normal', pending: null })
const insert = (input: string, caret: number): VimState => ({ input, caret, mode: 'insert', pending: null })

describe('word motions', () => {
  it('w moves to the start of the next word', () => {
    expect(nextWord('fix the auth bug', 0)).toBe(4)
    expect(nextWord('fix the auth bug', 4)).toBe(8)
  })
  it('w treats punctuation as its own word', () => {
    expect(nextWord('a.b', 0)).toBe(1)
    expect(nextWord('src/index.ts', 0)).toBe(3)
  })
  it('w stops at the end rather than running off it', () => {
    expect(nextWord('one', 0)).toBe(3)
    expect(nextWord('one', 3)).toBe(3)
  })
  it('b moves back to the start of the previous word', () => {
    expect(prevWord('fix the auth bug', 8)).toBe(4)
    expect(prevWord('fix the auth bug', 4)).toBe(0)
    expect(prevWord('fix', 0)).toBe(0)
  })
  it('e moves to the end of the current word', () => {
    expect(wordEnd('fix the bug', 0)).toBe(2)
    expect(wordEnd('fix the bug', 2)).toBe(6)
  })
})

describe('mode switching', () => {
  it('escape leaves insert mode and steps the caret back onto a character', () => {
    const r = applyVimKey(insert('hello', 5), '', { escape: true })
    expect(r.mode).toBe('normal')
    expect(r.caret).toBe(4)
    expect(r.handled).toBe(true)
  })
  it('insert mode ignores everything else, so normal typing is untouched', () => {
    expect(applyVimKey(insert('a', 1), 'b', {}).handled).toBe(false)
  })
  it('i, a, I and A all enter insert mode at the right place', () => {
    expect(applyVimKey(normal('hello', 2), 'i', {}).caret).toBe(2)
    expect(applyVimKey(normal('hello', 2), 'a', {}).caret).toBe(3)
    expect(applyVimKey(normal('hello', 2), 'I', {}).caret).toBe(0)
    expect(applyVimKey(normal('hello', 2), 'A', {}).caret).toBe(5)
    expect(applyVimKey(normal('hello', 2), 'A', {}).mode).toBe('insert')
  })
})

describe('normal mode edits', () => {
  it('x deletes the character under the caret', () => {
    const r = applyVimKey(normal('hello', 1), 'x', {})
    expect(r.input).toBe('hllo')
    expect(r.caret).toBe(1)
  })
  it('x on an empty line changes nothing', () => {
    const r = applyVimKey(normal('', 0), 'x', {})
    expect(r.input).toBe('')
    expect(r.handled).toBe(true)
  })
  it('D deletes to the end of the line', () => {
    expect(applyVimKey(normal('fix the bug', 4), 'D', {}).input).toBe('fix ')
  })
  it('C deletes to the end and enters insert', () => {
    const r = applyVimKey(normal('fix the bug', 4), 'C', {})
    expect(r.input).toBe('fix ')
    expect(r.mode).toBe('insert')
  })
  it('dd clears the line', () => {
    const pending = applyVimKey(normal('fix the bug', 4), 'd', {})
    expect(pending.pending).toBe('d')
    expect(applyVimKey(pending, 'd', {}).input).toBe('')
  })
  it('dw deletes to the next word', () => {
    const pending = applyVimKey(normal('fix the bug', 4), 'd', {})
    expect(applyVimKey(pending, 'w', {}).input).toBe('fix bug')
  })
  it('cw deletes the word and enters insert', () => {
    const pending = applyVimKey(normal('fix the bug', 4), 'c', {})
    const r = applyVimKey(pending, 'w', {})
    expect(r.input).toBe('fix bug')
    expect(r.mode).toBe('insert')
  })
  it('an unknown motion abandons the operator instead of guessing', () => {
    const pending = applyVimKey(normal('fix the bug', 4), 'd', {})
    const r = applyVimKey(pending, 'z', {})
    expect(r.input).toBe('fix the bug')
    expect(r.pending).toBe(null)
  })
})

describe('caret bounds', () => {
  it('normal mode keeps the caret on a character, not past the end', () => {
    expect(applyVimKey(normal('abc', 2), 'l', {}).caret).toBe(2)
    expect(applyVimKey(normal('abc', 0), '$', {}).caret).toBe(2)
  })
  it('h stops at the start', () => {
    expect(applyVimKey(normal('abc', 0), 'h', {}).caret).toBe(0)
  })
  it('enter is left to the caller so submitting still works', () => {
    expect(applyVimKey(normal('hi', 0), '', { return: true }).handled).toBe(false)
  })
})

describe('normal mode swallows stray letters', () => {
  it('an unbound printable key does not get typed into the prompt', () => {
    const r = applyVimKey(normal('hello', 0), 'z', {})
    expect(r.input).toBe('hello')
    expect(r.handled).toBe(true)
  })
  it('arrow keys still fall through for history recall', () => {
    expect(applyVimKey(normal('hi', 0), '', { escape: true }).handled).toBe(false)
  })
})
