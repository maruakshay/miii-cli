import { describe, it, expect, beforeAll } from 'vitest'
import { renderMarkdown } from './markdown.js'

beforeAll(() => {
  Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true })
})

// eslint-disable-next-line no-control-regex
const render = (md: string) => renderMarkdown(md).replace(/\x1b\[[0-9;]*m/g, '')

describe('renderMarkdown lists', () => {
  it('numbers an ordered list without counting its nested bullets', () => {
    expect(render('1. one\n   * a\n   * b\n2. two\n   * c')).toBe('1. one\n   • a\n   • b\n2. two\n   • c')
  })

  it('draws a loose list tight', () => {
    expect(render('- one\n\n- two\n\n- three')).toBe('• one\n• two\n• three')
  })

  it('wraps a long item under its text, not under the marker', () => {
    const lines = render('- ' + 'word '.repeat(20)).split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0].startsWith('• word')).toBe(true)
    for (const l of lines.slice(1)) expect(l.startsWith('  word')).toBe(true)
  })

  it('starts numbering where the source does', () => {
    expect(render('3. c\n4. d')).toBe('3. c\n4. d')
  })
})

describe('renderMarkdown wrapping', () => {
  it('never starts a wrapped paragraph row with a space', () => {
    const rows = render('word '.repeat(30).trim()).split('\n')
    expect(rows.length).toBeGreaterThan(1)
    for (const r of rows) {
      expect(r.startsWith(' ')).toBe(false)
      expect(r.length).toBeLessThanOrEqual(45)
    }
  })
})
