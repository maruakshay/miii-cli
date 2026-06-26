// Pure formatting/sizing helpers shared across the chat UI components.

import type { ToolUseDisplay, ToolResultDisplay } from './types.js'

export function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'
  return String(n)
}

export function formatDuration(ms: number): string {
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`
  const m = Math.floor(totalSec / 60)
  const s = Math.round(totalSec - m * 60)
  return `${m}m ${s}s`
}

export function countLines(s: string): number {
  if (!s) return 0
  return s.split('\n').length
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// Clip rendered text to the last `max` lines. The live frame is redrawn in place
// each streaming flush; if it grows taller than the terminal, Ink can't reach the
// lines that scrolled off the top — causing flicker and orphaned blocks stuck in
// scrollback. So we only ever show the tail here; the full text lands in the
// <Static> log (real scrollback) once the turn commits.
export function clipTail(rendered: string, max: number): { text: string; clipped: number } {
  const lines = rendered.split('\n')
  if (lines.length <= max) return { text: rendered, clipped: 0 }
  return { text: lines.slice(-max).join('\n'), clipped: lines.length - max }
}

// Clip text to the last lines that fit `maxRows` of VISUAL rows at the given
// wrap `width` — long lines occupy multiple rows, so a plain line count
// under-estimates height. Used by the thinking block: clipping by logical lines
// alone lets a wrapped block grow past the terminal, which breaks Ink's in-place
// redraw and orphans stale frames in scrollback.
export function clipTailVisual(
  content: string,
  maxRows: number,
  width: number,
): { text: string; clipped: number } {
  const w = Math.max(1, width)
  const lines = content.split('\n')
  const visualRows = (line: string) => Math.max(1, Math.ceil(line.length / w))
  let rows = 0
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = visualRows(lines[i])
    if (rows + h > maxRows && start < lines.length) break
    rows += h
    start = i
  }
  if (start === 0) return { text: content, clipped: 0 }
  return { text: lines.slice(start).join('\n'), clipped: start }
}

// Rows available to the live frame, leaving room for the input bar, hints and
// margins. Floor keeps it usable on tiny terminals.
export function liveFrameRows(): number {
  const rows = process.stdout.rows ?? 24
  return Math.max(6, rows - 8)
}

// Estimated rendered height (rows) of a live tool block, matching the collapsed
// layout in ToolBlock. Used to keep the active-tool region inside the live-frame
// budget — an overflowing live frame forces Ink's full-screen clear, which is the
// flicker. The expanded (ctrl+o) view is the user's choice and is not budgeted.
const COLLAPSED_LINES = 3
export function estimateToolRows(use: ToolUseDisplay, result?: ToolResultDisplay): number {
  const input = (use.input ?? {}) as Record<string, unknown>
  const noErr = !result?.is_error
  // write/edit render a header + summary + (clipped) diff preview.
  if (use.name === 'write_file' && noErr) {
    const total = countLines(String(input.content ?? ''))
    const shown = Math.min(total, COLLAPSED_LINES)
    return 2 + shown + (total > shown ? 1 : 0)
  }
  if (use.name === 'edit_file' && noErr) {
    const total = countLines(String(input.old_str ?? '')) + countLines(String(input.new_str ?? ''))
    const shown = Math.min(total, COLLAPSED_LINES)
    return 2 + shown + (total > shown ? 1 : 0)
  }
  let rows = 1 // header line
  if (result) {
    const lines = (result.content ?? '').split('\n')
    const multi =
      (use.name === 'run_bash' || use.name === 'grep' || use.name === 'glob' || result.is_error) &&
      lines.length > 1
    if (multi) {
      const shown = Math.min(lines.length, COLLAPSED_LINES)
      rows += 1 + shown + (lines.length > shown ? 1 : 0)
    } else {
      rows += 1
    }
  }
  return rows
}

// Width for assistant prose: marked emits long unwrapped lines, and the content
// sits offset by the `● ` bullet (2 cols) plus a left margin (1). Without an
// explicit width Ink wraps to the full terminal, overrunning the offset and
// spilling the last chars onto column 0. Constrain so wrapping stays inside the
// content column. Floor keeps it sane on narrow terminals.
export function contentWidth(): number {
  return Math.max(20, (process.stdout.columns ?? 80) - 4)
}
