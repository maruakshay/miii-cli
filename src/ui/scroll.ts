import { useState, useEffect } from 'react'

/**
 * scroll — viewport scroll position for the chat transcript.
 *
 * The transcript is rendered into a fixed-height clipped viewport (ChatView)
 * rather than the terminal's own scrollback, so miii owns scrolling: the mouse
 * wheel and pageup/pagedown move this offset. Module-level store + subscriber
 * set, mirroring toolExpand, so the input handler can scroll without threading
 * state through the tree.
 *
 * `top` is the first visible content row. `stick` means "follow the tail": while
 * it's set the view pins to the bottom as new output lands, which is what you
 * want during a turn. Scrolling up clears it; scrolling back to the bottom (or
 * sending a message) sets it again.
 */
type ScrollState = { top: number; stick: boolean }

let state: ScrollState = { top: 0, stick: true }
const listeners = new Set<() => void>()

// Last rendered geometry, published by ChatView. Scrolling has to clamp against
// the content height, and the handlers that drive it live outside the view.
let contentHeight = 0
let viewportHeight = 0

function emit() {
  listeners.forEach((fn) => fn())
}

/** Called by ChatView after each measure so scroll commands can clamp. */
export function setScrollMetrics(content: number, viewport: number): void {
  contentHeight = content
  viewportHeight = viewport
}

export function maxScrollTop(): number {
  return Math.max(0, contentHeight - viewportHeight)
}

/** Move by `delta` rows (negative = towards older output). */
export function scrollBy(delta: number): void {
  const max = maxScrollTop()
  const from = state.stick ? max : Math.min(state.top, max)
  const top = Math.max(0, Math.min(max, from + delta))
  // Landing on the last row re-arms tail-following, so a scroll back down
  // behaves like a terminal that was never scrolled.
  const next = { top, stick: top >= max }
  if (next.top === state.top && next.stick === state.stick) return
  state = next
  emit()
}

/** Jump back to the tail and resume following it. */
export function scrollToBottom(): void {
  if (state.stick) return
  state = { top: maxScrollTop(), stick: true }
  emit()
}

/** Reset for a fresh transcript (/clear, /new, session load). */
export function resetScroll(): void {
  state = { top: 0, stick: true }
  emit()
}

/** Measured geometry — for tests. */
export function __scrollMetrics(): { content: number; viewport: number } {
  return { content: contentHeight, viewport: viewportHeight }
}

/** Current position — for tests; components use useScroll(). */
export function __scrollState(): ScrollState {
  return state
}

export function useScroll(): ScrollState {
  const [s, setS] = useState(state)
  useEffect(() => {
    const handler = () => setS(state)
    listeners.add(handler)
    return () => { listeners.delete(handler) }
  }, [])
  return s
}
