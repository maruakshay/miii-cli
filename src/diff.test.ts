import { describe, it, expect } from 'vitest'
import { diffLines, toHunks, buildFileDiff, MAX_DIFF_LINES } from './diff.js'

const L = (s: string) => s.split('|').join('\n')

describe('diffLines', () => {
  it('numbers unchanged lines in both files', () => {
    const d = diffLines(L('a|b|c'), L('a|b|c'))
    expect(d.map((l) => [l.sign, l.oldNo, l.newNo, l.text])).toEqual([
      [' ', 1, 1, 'a'],
      [' ', 2, 2, 'b'],
      [' ', 3, 3, 'c'],
    ])
  })

  it('marks a replaced line without touching its neighbours', () => {
    const d = diffLines(L('a|b|c'), L('a|B|c'))
    expect(d.map((l) => l.sign).join('')).toBe(' -+ ')
    const removed = d.find((l) => l.sign === '-')!
    const added = d.find((l) => l.sign === '+')!
    expect([removed.oldNo, removed.newNo]).toEqual([2, null])
    expect([added.oldNo, added.newNo]).toEqual([null, 2])
  })

  it('keeps shared lines as context instead of re-adding them', () => {
    // The whole block is rewritten, but two lines survive — they must not show
    // up as a delete plus an add.
    const d = diffLines(L('one|two|three'), L('one|zwei|three'))
    expect(d.filter((l) => l.sign === ' ').map((l) => l.text)).toEqual(['one', 'three'])
  })

  it('numbers lines after an insertion by the new file', () => {
    const d = diffLines(L('a|b'), L('a|x|b'))
    const last = d[d.length - 1]
    expect([last.sign, last.oldNo, last.newNo]).toEqual([' ', 2, 3])
  })

  it('treats an empty before as a pure addition', () => {
    const d = diffLines('', L('a|b'))
    expect(d.map((l) => l.sign).join('')).toBe('++')
    expect(d.map((l) => l.newNo)).toEqual([1, 2])
  })

  it('ignores the phantom line a trailing newline creates', () => {
    expect(diffLines('a\n', 'a\n')).toHaveLength(1)
    expect(diffLines('a\n', 'a')).toHaveLength(1)
  })

  it('reports a wholesale replace when the change is too big to align', () => {
    const before = Array.from({ length: 3500 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 3500 }, (_, i) => `new ${i}`).join('\n')
    const d = diffLines(before, after)
    expect(d.filter((l) => l.sign === '-')).toHaveLength(3500)
    expect(d.filter((l) => l.sign === '+')).toHaveLength(3500)
  })
})

describe('toHunks', () => {
  const file = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n')

  it('drops unchanged stretches outside the context window', () => {
    const before = file(20)
    const after = before.split('\n').map((l, i) => (i === 9 ? 'CHANGED' : l)).join('\n')
    const hunks = toHunks(diffLines(before, after), 3)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.map((l) => l.text)).toEqual([
      'line7', 'line8', 'line9', 'line10', 'CHANGED', 'line11', 'line12', 'line13',
    ])
  })

  it('splits far-apart changes into separate hunks', () => {
    const before = file(40)
    const after = before.split('\n').map((l, i) => (i === 2 || i === 30 ? 'X' : l)).join('\n')
    expect(toHunks(diffLines(before, after), 3)).toHaveLength(2)
  })

  it('merges changes whose context overlaps', () => {
    const before = file(40)
    const after = before.split('\n').map((l, i) => (i === 10 || i === 14 ? 'X' : l)).join('\n')
    expect(toHunks(diffLines(before, after), 3)).toHaveLength(1)
  })

  it('returns nothing when the file is unchanged', () => {
    expect(toHunks(diffLines(file(10), file(10)), 3)).toEqual([])
  })
})

describe('buildFileDiff', () => {
  it('counts added and removed lines', () => {
    const d = buildFileDiff('a.ts', L('a|b|c'), L('a|x|y|c'))
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    expect(d.path).toBe('a.ts')
  })

  it('reports no hunks for a no-op write', () => {
    const d = buildFileDiff('a.ts', L('a|b'), L('a|b'))
    expect(d.hunks).toEqual([])
    expect(d.added + d.removed).toBe(0)
  })

  it('caps the lines it carries and says how many it dropped', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `old${i}`).join('\n')
    const after = Array.from({ length: 1000 }, (_, i) => `new${i}`).join('\n')
    const d = buildFileDiff('big.ts', before, after)
    const kept = d.hunks.reduce((n, h) => n + h.lines.length, 0)
    expect(kept).toBe(MAX_DIFF_LINES)
    expect(d.truncated).toBe(2000 - MAX_DIFF_LINES)
  })
})
