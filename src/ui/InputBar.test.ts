import { describe, it, expect } from 'vitest'
import { viewport, fieldWidth } from './InputBar.js'

describe('fieldWidth', () => {
  it('leaves room for the border, padding, prompt and scroll indicators', () => {
    expect(fieldWidth(80)).toBeLessThan(80)
    expect(fieldWidth(120) - fieldWidth(80)).toBe(40)
  })

  it('floors on a very narrow terminal instead of going negative', () => {
    expect(fieldWidth(10)).toBeGreaterThan(0)
    expect(fieldWidth(0)).toBeGreaterThan(0)
  })
})

describe('viewport', () => {
  it('shows short input whole, with the caret where it was asked for', () => {
    expect(viewport('hello', 2, 40)).toEqual({
      text: 'hello',
      caretCol: 2,
      more: false,
      less: false,
    })
  })

  it('does not scroll when the text plus the caret cell exactly fit', () => {
    const v = viewport('abcd', 4, 5)
    expect(v).toMatchObject({ text: 'abcd', caretCol: 4, less: false, more: false })
  })

  it('pins the caret to the right edge once the text outruns the field', () => {
    const input = 'abcdefghijklmnopqrstuvwxyz'
    const v = viewport(input, input.length, 10)
    expect(v.caretCol).toBe(9)
    expect(v.less).toBe(true)
    expect(v.more).toBe(false)
    expect(input.endsWith(v.text.trimEnd())).toBe(true)
  })

  it('shows the head, and flags more to the right, when the caret is at home', () => {
    const input = 'abcdefghijklmnopqrstuvwxyz'
    const v = viewport(input, 0, 10)
    expect(v.text).toBe('abcdefghij')
    expect(v.caretCol).toBe(0)
    expect(v.less).toBe(false)
    expect(v.more).toBe(true)
  })

  it('clamps a caret outside the string', () => {
    expect(viewport('abc', 99, 20).caretCol).toBe(3)
    expect(viewport('abc', -5, 20).caretCol).toBe(0)
  })

  it('handles an empty string', () => {
    expect(viewport('', 0, 20)).toEqual({ text: '', caretCol: 0, more: false, less: false })
  })

  // The invariant the whole component rests on: the rendered row is
  // `text` with one cell for the caret, so it must never exceed the field. A
  // row that overflows wraps, the bar grows, the live frame outgrows the
  // terminal, and Ink falls back to a full-screen repaint — the flicker.
  it('never renders more columns than the field, for any input/caret/width', () => {
    for (const len of [0, 1, 5, 9, 10, 11, 40, 500]) {
      const input = 'x'.repeat(len)
      for (const width of [1, 2, 8, 10, 37, 80]) {
        for (const caret of [0, 1, Math.floor(len / 2), len - 1, len, len + 5]) {
          const v = viewport(input, caret, width)
          const rendered = Math.max(v.text.length, v.caretCol + 1)
          expect(
            rendered,
            `len=${len} width=${width} caret=${caret} rendered=${rendered}`,
          ).toBeLessThanOrEqual(width)
          expect(v.caretCol).toBeGreaterThanOrEqual(0)
          expect(v.caretCol).toBeLessThanOrEqual(v.text.length)
        }
      }
    }
  })

  it('always keeps the caret inside the visible window', () => {
    const input = 'abcdefghijklmnopqrstuvwxyz0123456789'
    for (let caret = 0; caret <= input.length; caret++) {
      const v = viewport(input, caret, 12)
      // The character under the caret is the one at `caret` in the full string
      // (or the empty cell past the end).
      expect(v.text[v.caretCol] ?? '').toBe(input[caret] ?? '')
    }
  })
})
