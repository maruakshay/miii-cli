import { describe, it, expect } from 'vitest'
import { padLines, userTextWidth } from './layout.js'

describe('padLines', () => {
  it('pads a short line out to the full width', () => {
    expect(padLines('hi', 6)).toEqual(['hi    '])
  })

  it('wraps on word boundaries and pads every row', () => {
    const out = padLines('one two three', 7)
    expect(out).toEqual(['one two', 'three  '])
    expect(out.every((l) => l.length === 7)).toBe(true)
  })

  it('hard-breaks a word longer than the field', () => {
    expect(padLines('abcdefgh', 3)).toEqual(['abc', 'def', 'gh '])
  })

  it('keeps blank source lines as a filled row', () => {
    expect(padLines('a\n\nb', 2)).toEqual(['a ', '  ', 'b '])
  })

  it('yields a filled row for empty content, never a zero-height Text', () => {
    expect(padLines('', 4)).toEqual(['    '])
  })

  it('never emits a row shorter or longer than the width', () => {
    const out = padLines('the quick brown fox jumps over the lazy dog', 10)
    expect(out.every((l) => l.length === 10)).toBe(true)
  })
})

describe('userTextWidth', () => {
  it('leaves room for the app padding, the rule and the body padding', () => {
    expect(userTextWidth(80)).toBe(75)
  })

  it('floors on a narrow terminal rather than going negative', () => {
    expect(userTextWidth(6)).toBe(8)
    expect(userTextWidth(0)).toBe(8)
  })
})
