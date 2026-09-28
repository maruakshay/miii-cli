/**
 * The palette's matching rule. Narrow, but it guards a real trap: matching on
 * the command word instead of the whole line leaves the list open over your
 * arguments, where tab-completion then overwrites them.
 */
import { describe, it, expect } from 'vitest'
import { filteredCommands, allCommands, paletteWindow } from './CommandPalette.js'

describe('command palette', () => {
  it('offers the built-ins', () => {
    const names = allCommands().map((c) => c.name)
    expect(names).toContain('/plan')
    expect(names).toContain('/permissions')
    expect(names.every((n) => n.startsWith('/'))).toBe(true)
  })

  it('marks every built-in as such', () => {
    expect(allCommands().some((c) => c.origin === 'builtin')).toBe(true)
  })

  it('narrows by prefix', () => {
    expect(filteredCommands('/pl').map((c) => c.name)).toEqual(['/plan'])
    expect(filteredCommands('/zzz')).toEqual([])
  })

  it('closes once the line has arguments', () => {
    // `/copy last` and `/compact <focus>` both take arguments; the palette must
    // stop matching so tab cannot replace the line with the bare command name.
    expect(filteredCommands('/copy last')).toEqual([])
    expect(filteredCommands('/compact just the bug')).toEqual([])
  })
})

describe('paletteWindow', () => {
  it('shows everything when it fits', () => {
    expect(paletteWindow(5, 3, 10)).toEqual({ start: 0, end: 5 })
  })
  it('keeps the cursor in view, centred, pinned at the ends', () => {
    expect(paletteWindow(30, 0, 10)).toEqual({ start: 0, end: 10 })
    expect(paletteWindow(30, 15, 10)).toEqual({ start: 10, end: 20 })
    expect(paletteWindow(30, 29, 10)).toEqual({ start: 20, end: 30 })
  })
})
