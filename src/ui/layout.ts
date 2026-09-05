// Pure formatting/sizing helpers shared across the chat UI components.

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
// re-parse. So we only ever show the tail here; the untruncated text renders
// once the turn commits to a message.
export function clipTail(rendered: string, max: number): { text: string; clipped: number } {
  const lines = rendered.split('\n')
  if (lines.length <= max) return { text: rendered, clipped: 0 }
  return { text: lines.slice(-max).join('\n'), clipped: lines.length - max }
}

// Strip SGR/ANSI escapes so width is measured in VISIBLE columns. Rendered
// markdown (marked-terminal + syntax highlight) embeds color codes that inflate
// String#length; counting them as columns over-estimates height and mis-clips.
const ANSI_RE = /\x1b\[[0-9;]*m/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
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
  const visualRows = (line: string) => Math.max(1, Math.ceil(stripAnsi(line).length / w))
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

// Width for assistant prose: marked emits long unwrapped lines, and the content
// sits offset by the `● ` bullet (2 cols) plus a left margin (1). Without an
// explicit width Ink wraps to the full terminal, overrunning the offset and
// spilling the last chars onto column 0. Constrain so wrapping stays inside the
// content column. Floor keeps it sane on narrow terminals.
export function contentWidth(): number {
  return Math.max(20, (process.stdout.columns ?? 80) - 4)
}

// Wrap `content` to `width` columns and pad every row out to exactly that many,
// so a background color paints a clean rectangle instead of hugging ragged text.
// Ink 5 has no Box-level background, so the fill has to come from the string
// itself; each source line yields at least one row, and words longer than the
// field are hard-broken rather than allowed to overrun it.
export function padLines(content: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const para of content.split('\n')) {
    const before = out.length
    let line = ''
    for (const word of para.split(' ')) {
      let rest = word
      while (rest.length > w) {
        if (line) out.push(line)
        out.push(rest.slice(0, w))
        line = ''
        rest = rest.slice(w)
      }
      if (rest === '') continue
      if (!line) line = rest
      else if (line.length + 1 + rest.length <= w) line += ' ' + rest
      else {
        out.push(line)
        line = rest
      }
    }
    if (line !== '') out.push(line)
    else if (out.length === before) out.push('')
  }
  return out.map((l) => l + ' '.repeat(Math.max(0, w - l.length)))
}

// Text columns inside a user message block, for a terminal `cols` wide. The app
// pads 1 either side, the accent rule takes 1, and the shaded body carries 1
// column of its own padding either side so the fill never sits flush against
// the glyphs. Floor keeps it usable on narrow terminals.
export function userTextWidth(cols: number): number {
  return Math.max(8, cols - 5)
}
