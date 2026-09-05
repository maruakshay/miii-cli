import { describe, it, expect } from 'vitest'
import { parseMouseEvent } from './mouse.js'

describe('parseMouseEvent', () => {
  it('parses a left-button press', () => {
    expect(parseMouseEvent('[<0;12;30M')).toEqual({
      button: 0, x: 12, y: 30, press: true, wheel: false, up: true,
    })
  })

  it('parses a release', () => {
    expect(parseMouseEvent('[<0;12;30m')?.press).toBe(false)
  })

  it('masks modifier bits off the button', () => {
    // 16 = ctrl held, still the left button.
    expect(parseMouseEvent('[<16;1;1M')?.button).toBe(0)
  })

  it('tells wheel up from wheel down', () => {
    const up = parseMouseEvent('[<64;1;1M')
    const down = parseMouseEvent('[<65;1;1M')
    expect(up).toMatchObject({ wheel: true, up: true })
    expect(down).toMatchObject({ wheel: true, up: false })
  })

  it('ignores ordinary typing and other escape sequences', () => {
    expect(parseMouseEvent('a')).toBeNull()
    expect(parseMouseEvent('[A')).toBeNull()
    expect(parseMouseEvent('[<0;1M')).toBeNull()
  })
})
