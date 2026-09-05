import { describe, it, expect, beforeEach } from 'vitest'
import { setScrollMetrics, scrollBy, scrollToBottom, resetScroll, maxScrollTop, __scrollState } from './scroll.js'

describe('scroll', () => {
  beforeEach(() => {
    resetScroll()
    // 100 rows of transcript in a 20-row viewport.
    setScrollMetrics(100, 20)
  })

  it('starts pinned to the tail', () => {
    expect(__scrollState()).toEqual({ top: 0, stick: true })
    expect(maxScrollTop()).toBe(80)
  })

  it('scrolls up from the tail, not from row 0', () => {
    scrollBy(-3)
    expect(__scrollState()).toEqual({ top: 77, stick: false })
  })

  it('clamps at the top', () => {
    scrollBy(-1000)
    expect(__scrollState()).toEqual({ top: 0, stick: false })
  })

  it('re-arms tail-following on reaching the bottom', () => {
    scrollBy(-10)
    scrollBy(10)
    expect(__scrollState()).toEqual({ top: 80, stick: true })
  })

  it('jumps back to the tail', () => {
    scrollBy(-40)
    scrollToBottom()
    expect(__scrollState()).toEqual({ top: 80, stick: true })
  })

  it('has nothing to scroll when the transcript fits', () => {
    setScrollMetrics(10, 20)
    expect(maxScrollTop()).toBe(0)
    scrollBy(-5)
    expect(__scrollState()).toEqual({ top: 0, stick: true })
  })
})
