/**
 * mouse — terminal mouse reporting.
 *
 * The transcript scrolls inside miii's own viewport (see scroll.ts), so the app
 * needs the wheel: this turns on xterm button tracking (mode 1000) with
 * SGR-encoded reports (mode 1006). Motion tracking is deliberately left off, so
 * the terminal keeps as much native behaviour as it can — drag-to-select still
 * works with the usual override (option-drag on macOS, shift-drag elsewhere).
 *
 * Reporting can be switched off from the app (ctrl+s), which hands the mouse
 * back to the terminal so a plain drag selects text again — the one thing an
 * app that owns the mouse takes away, and the reason /copy exists too.
 *
 * Reports arrive on stdin as `ESC [ < b ; x ; y M|m`. Ink's parse-keypress
 * leaves them intact and strips only the leading ESC, so the keyboard handler
 * matches them with parseMouseEvents() and swallows them before they can reach
 * the input bar. A fast wheel spin or a drag emits reports quicker than the
 * event loop drains stdin, so a single chunk routinely holds several of them
 * (every one after the first keeping its own ESC) and can even be cut mid
 * report — hence the multi-event scan and the carried-over tail.
 */
const ENABLE = '\x1b[?1000h\x1b[?1006h'
export const DISABLE = '\x1b[?1006l\x1b[?1000l'

// SGR report minus the ESC that Ink strips: `[<button;col;row` + M (press) / m (release).
const SGR_RE = /^\[<(\d+);(\d+);(\d+)([Mm])$/
// The same report anywhere in a chunk; only the first has had its ESC stripped.
const SGR_ALL_RE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g
// A report severed by a chunk boundary: its head (`[<65;79`), then its tail
// (`;23M`) at the start of the chunk that follows.
const HEAD_RE = /\x1b?\[<[\d;]*$/
const TAIL_RE = /^[\d;]*[Mm]/

export type MouseEvent = {
  /** Button number with the modifier/motion bits masked off (0 = left). */
  button: number
  /** 1-based terminal column and row. */
  x: number
  y: number
  /** true = button press, false = release. */
  press: boolean
  /** Wheel notch rather than a button; `up` says which way. */
  wheel: boolean
  up: boolean
}

let enabled = false
// Notified whenever reporting is switched on or off, so the UI can say which
// mode it's in without threading the flag through the component tree.
const listeners = new Set<() => void>()

export function isMouseEnabled(): boolean {
  return enabled
}

function setMouse(on: boolean): void {
  if (on === enabled || !process.stdout.isTTY) return
  enabled = on
  process.stdout.write(on ? ENABLE : DISABLE)
  listeners.forEach((fn) => fn())
}

export function enableMouse(): void {
  setMouse(true)
}

export function disableMouse(): void {
  setMouse(false)
}

/** Flip reporting; returns the new state. */
export function toggleMouse(): boolean {
  setMouse(!enabled)
  return enabled
}

/** Subscribe to reporting changes; returns the unsubscribe. */
export function onMouseChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function toEvent(b: string, x: string, y: string, end: string): MouseEvent {
  const raw = Number(b)
  // Low 2 bits are the button (or the wheel direction); 4/8/16 are
  // shift/meta/ctrl, 32 is motion, 64 marks a wheel notch.
  return {
    button: raw & 3,
    x: Number(x),
    y: Number(y),
    press: end === 'M',
    wheel: (raw & 64) !== 0,
    up: (raw & 1) === 0,
  }
}

/** Parse one useInput chunk as a single mouse report; null when it isn't one. */
export function parseMouseEvent(input: string): MouseEvent | null {
  const m = SGR_RE.exec(input)
  return m ? toEvent(m[1]!, m[2]!, m[3]!, m[4]!) : null
}

// Set when a chunk ended mid-report, so the tail arriving next can be dropped.
let pendingTail = false

/** Forget a carried-over partial report (tests, and after a stdin reset). */
export function resetMouseParser(): void {
  pendingTail = false
}

/**
 * Pull every mouse report out of one useInput chunk.
 *
 * `rest` is what's left once they're removed, and `consumed` says whether
 * anything mouse-shaped was stripped at all — a torn report yields no event but
 * still must not reach the prompt. A dangling head is only trusted when the
 * chunk also held a whole report, so typing a bare `[<` is never swallowed.
 */
export function parseMouseEvents(
  input: string,
): { events: MouseEvent[]; rest: string; consumed: boolean } {
  let rest = input
  let consumed = false

  if (pendingTail) {
    pendingTail = false
    const tail = TAIL_RE.exec(rest)
    if (tail) {
      rest = rest.slice(tail[0].length)
      consumed = true
    }
  }

  const events: MouseEvent[] = []
  rest = rest.replace(SGR_ALL_RE, (_m, b: string, x: string, y: string, end: string) => {
    events.push(toEvent(b, x, y, end))
    return ''
  })

  if (events.length > 0) {
    consumed = true
    const head = HEAD_RE.exec(rest)
    if (head) {
      rest = rest.slice(0, rest.length - head[0].length)
      pendingTail = true
    }
  }

  return { events, rest, consumed }
}
