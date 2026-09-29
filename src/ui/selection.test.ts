import { describe, it, expect } from 'vitest'
import { parseFrameWrite, selectedText, selectionSpans, sliceCells } from './selection.js'

describe('parseFrameWrite', () => {
  it('takes the rows after log-update erases the previous frame', () => {
    const chunk = '\x1b[2K\x1b[1A\x1b[2K\x1b[Gone\ntwo\n'
    expect(parseFrameWrite(chunk, false)).toEqual(['one', 'two'])
  })

  it('takes a tall frame drawn after a full clear', () => {
    expect(parseFrameWrite('\x1b[2J\x1b[3J\x1b[Hone\ntwo', false)).toEqual(['one', 'two'])
  })

  it('accepts the bare first frame, and nothing bare after it', () => {
    expect(parseFrameWrite('hello\n', true)).toEqual(['hello'])
    expect(parseFrameWrite('hello\n', false)).toBeNull()
  })
})

describe('sliceCells', () => {
  it('slices by column', () => {
    expect(sliceCells('hello world', 6, 11)).toBe('world')
  })

  it('counts wide glyphs as two cells', () => {
    expect(sliceCells('ab日本cd', 2, 6)).toBe('日本')
    expect(sliceCells('ab日本cd', 6, 8)).toBe('cd')
  })
})

describe('selection', () => {
  const lines = ['  first line   ', '  middle', '  last line']

  it('runs the first row to the edge and the last from it', () => {
    expect(selectionSpans({ row: 0, col: 8 }, { row: 2, col: 5 }, 20)).toEqual([
      { row: 0, from: 8, to: 20 },
      { row: 1, from: 0, to: 20 },
      { row: 2, from: 0, to: 6 },
    ])
  })

  it('reads the same either way you drag', () => {
    const down = selectedText(lines, { row: 0, col: 8 }, { row: 2, col: 5 }, 20)
    const up = selectedText(lines, { row: 2, col: 5 }, { row: 0, col: 8 }, 20)
    expect(down).toBe('line\n  middle\n  last')
    expect(up).toBe(down)
  })

  it('selects within one row', () => {
    expect(selectedText(lines, { row: 1, col: 2 }, { row: 1, col: 7 }, 20)).toBe('middle')
  })
})
