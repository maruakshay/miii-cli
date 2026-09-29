import { stripVTControlCharacters } from 'util'
import stringWidth from 'string-width'

/**
 * selection — drag-to-select inside miii, with the wheel still scrolling.
 *
 * A terminal hands the whole mouse to an app that asks for wheel reports, so a
 * plain drag stops selecting text. Rather than make the user trade one for the
 * other (ctrl+s still does, for terminals that need it), miii does the
 * selecting itself: button-event tracking reports the drag, the cells under it
 * are painted in reverse video, and on release the text is put on the
 * clipboard — the terminal's own copy-on-select, just done from inside.
 *
 * The text comes from the screen, not the message log: what you drag over is
 * what you get. That needs the frame Ink last drew, which Ink keeps to itself,
 * so captureFrames() wraps the stream Ink writes to and records each frame on
 * its way out. The highlight is painted over that frame with absolute cursor
 * moves between a cursor save/restore, so Ink's own relative redraws never
 * notice it was there.
 */

export type Cell = { row: number; col: number }

const ESC = '\x1b['
// What log-update puts in front of a frame: eraseLines(n) — erase, cursor up,
// repeated — then cursor-to-column-1. The tall-frame path clears the screen
// instead. Anything else written through the stream isn't a frame.
const ERASE_LINES_RE = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/
const CLEAR_TERMINAL_RE = /^\x1b\[2J(?:\x1b\[3J\x1b\[H|\x1b\[0f)/

/**
 * The frame lines in one chunk Ink wrote, or null for a chunk that isn't a
 * frame. log-update ends a frame with a newline for the cursor; that isn't a
 * row of the frame.
 */
export function parseFrameWrite(chunk: string, first: boolean): string[] | null {
  let body: string
  const erase = ERASE_LINES_RE.exec(chunk) ?? CLEAR_TERMINAL_RE.exec(chunk)
  if (erase) body = chunk.slice(erase[0].length)
  // The very first frame has nothing to erase, so it arrives bare.
  else if (first && chunk.endsWith('\n') && !chunk.startsWith('\x1b]')) body = chunk
  else return null
  if (!body) return null
  return body.replace(/\n$/, '').split('\n')
}

const segmenter = new Intl.Segmenter()

/**
 * The part of a plain-text row covering terminal columns [from, to), 0-based.
 * Columns are cells, not characters — a CJK glyph or an emoji takes two, and a
 * wide glyph cut in half by an edge is kept whole.
 */
export function sliceCells(line: string, from: number, to: number): string {
  let col = 0
  let out = ''
  for (const { segment } of segmenter.segment(line)) {
    const w = stringWidth(segment)
    if (col >= to) break
    if (col + Math.max(w, 1) > from) out += segment
    col += w
  }
  return out
}

/** Order two cells top-left first. */
function ordered(a: Cell, b: Cell): [Cell, Cell] {
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a]
}

/**
 * Per-row column spans covered by a selection from `a` to `b` (inclusive of
 * both end cells), the way a terminal selects: the first row runs to the edge,
 * the last from the edge, everything between is whole.
 */
export function selectionSpans(a: Cell, b: Cell, width: number): Array<{ row: number; from: number; to: number }> {
  const [start, end] = ordered(a, b)
  const spans: Array<{ row: number; from: number; to: number }> = []
  for (let row = start.row; row <= end.row; row++) {
    const from = row === start.row ? start.col : 0
    const to = row === end.row ? end.col + 1 : width
    if (to > from) spans.push({ row, from, to })
  }
  return spans
}

/** The text a selection covers, trailing padding trimmed from each row. */
export function selectedText(lines: string[], a: Cell, b: Cell, width: number): string {
  return selectionSpans(a, b, width)
    .map(({ row, from, to }) => sliceCells(lines[row] ?? '', from, to).trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

// ── live state ──────────────────────────────────────────────────────────────

let rawLines: string[] = []
let plainLines: string[] = []
let sawFrame = false
let write: (s: string) => void = () => {}

// Frame coordinates (0-based row within the frame, 0-based column).
let anchor: Cell | null = null
let focus: Cell | null = null
// Rows currently carrying the highlight, so they can be put back.
let painted: number[] = []

/**
 * Wrap the stream Ink renders to so each frame is recorded as it's written,
 * and the highlight re-laid over any frame that lands mid-drag. Everything
 * other than write() passes straight through, so size, resize events and
 * isTTY are the real stream's.
 */
export function captureFrames(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  const realWrite = stdout.write.bind(stdout) as (s: string) => boolean
  write = (s) => { realWrite(s) }
  const wrapped = ((chunk: unknown, ...rest: unknown[]) => {
    const ok = (stdout.write as (...a: unknown[]) => boolean).call(stdout, chunk, ...rest)
    if (typeof chunk === 'string') {
      const lines = parseFrameWrite(chunk, !sawFrame)
      if (lines) {
        sawFrame = true
        rawLines = lines
        plainLines = lines.map((l) => stripVTControlCharacters(l))
        // Ink just redrew every row, so there's nothing left to restore.
        painted = []
        if (anchor && focus) paint()
      }
    }
    return ok
  }) as NodeJS.WriteStream['write']
  return new Proxy(stdout, {
    get(target, prop) {
      if (prop === 'write') return wrapped
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Terminal row (1-based) of frame row `i`. Ink draws in place at the bottom
 * of the terminal, followed by the cursor's newline, so the frame's last row
 * is the terminal's second-to-last.
 */
function terminalRow(i: number): number {
  return i + (process.stdout.rows ?? 24) - plainLines.length
}

/** Frame cell under a 1-based terminal report, clamped into the frame. */
function frameCell(x: number, y: number): Cell {
  const row = y - ((process.stdout.rows ?? 24) - plainLines.length)
  return {
    row: Math.max(0, Math.min(plainLines.length - 1, row)),
    col: Math.max(0, x - 1),
  }
}

function width(): number {
  return process.stdout.columns ?? 80
}

function restoreSeq(): string {
  let out = ''
  for (const row of painted) {
    out += `${ESC}${terminalRow(row)};1H${ESC}2K${rawLines[row] ?? ''}`
  }
  painted = []
  return out
}

function paint(): void {
  let out = restoreSeq()
  if (anchor && focus) {
    for (const { row, from, to } of selectionSpans(anchor, focus, width())) {
      // Blank cells past a row's text still show, so the block reads as one.
      const text = sliceCells(plainLines[row] ?? '', from, to)
      const pad = Math.max(0, Math.min(to, width()) - from - stringWidth(text))
      out += `${ESC}${terminalRow(row)};${from + 1}H${ESC}7m${text}${' '.repeat(pad)}${ESC}27m`
      painted.push(row)
    }
  }
  if (out) write(`\x1b7${out}\x1b8`)
}

/** A left press: the selection's fixed end, nothing painted until it moves. */
export function beginSelection(x: number, y: number): void {
  clearSelection()
  if (!plainLines.length) return
  anchor = frameCell(x, y)
}

/** Drag motion with the button held: move the free end and repaint. */
export function extendSelection(x: number, y: number): void {
  if (!anchor) return
  const next = frameCell(x, y)
  if (focus && next.row === focus.row && next.col === focus.col) return
  focus = next
  paint()
}

/**
 * The button came up. Returns the dragged-over text, or null when the press
 * never moved — that was a click, and the caller should treat it as one.
 */
export function endSelection(): string | null {
  const text = anchor && focus ? selectedText(plainLines, anchor, focus, width()) : null
  clearSelection()
  return text
}

/** Drop the selection and put the rows under it back. */
export function clearSelection(): void {
  anchor = null
  focus = null
  const out = restoreSeq()
  if (out) write(`\x1b7${out}\x1b8`)
}

export function isSelecting(): boolean {
  return anchor !== null
}
