/**
 * Line diffs for the edit/write tools, rendered by the UI.
 *
 * The tool is the only place that sees the file both before and after, so it
 * computes the diff there and hands it to the renderer. The alternative — the
 * UI reconstructing a diff from old_str/new_str — can't know real line numbers
 * and shows every line of the hunk as changed even when only one word moved.
 *
 * Pure: no fs, no React. Both sides import this.
 */

export interface DiffLine {
  sign: '+' | '-' | ' '
  /** 1-based line number in the file before the edit; null for added lines. */
  oldNo: number | null
  /** 1-based line number in the file after the edit; null for removed lines. */
  newNo: number | null
  text: string
}

/** A run of changed lines plus its surrounding context. */
export interface DiffHunk {
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  added: number
  removed: number
  hunks: DiffHunk[]
  /** Lines dropped to keep the diff small enough to carry and store. */
  truncated?: number
}

/** Lines of `s`, without the phantom empty line a trailing newline creates. */
function splitLines(s: string): string[] {
  if (s === '') return []
  const body = s.endsWith('\n') ? s.slice(0, -1) : s
  return body.split('\n')
}

/**
 * A full LCS table is O(n·m) cells — fine for an edit, ruinous for two 50k-line
 * files. Past this many lines on either side (after common prefix/suffix are
 * trimmed) we stop trying to align and report the region as a wholesale
 * replace, which is what a rewrite of that size looks like anyway.
 */
const MAX_LCS_LINES = 3000

/** Longest-common-subsequence backtrace over two line arrays. */
function lcsDiff(a: string[], b: string[]): Array<{ sign: '+' | '-' | ' '; text: string }> {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0 || n > MAX_LCS_LINES || m > MAX_LCS_LINES) {
    return [
      ...a.map((text) => ({ sign: '-' as const, text })),
      ...b.map((text) => ({ sign: '+' as const, text })),
    ]
  }
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: Array<{ sign: '+' | '-' | ' '; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ sign: ' ', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ sign: '-', text: a[i] })
      i++
    } else {
      out.push({ sign: '+', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ sign: '-', text: a[i++] })
  while (j < m) out.push({ sign: '+', text: b[j++] })
  return out
}

/** Every line of both files, in order, tagged and numbered. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)

  // Identical head and tail are the bulk of any edit; trimming them keeps the
  // LCS table to the size of the change, not the size of the file.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const middle = lcsDiff(a.slice(head, a.length - tail), b.slice(head, b.length - tail))

  const out: DiffLine[] = []
  let oldNo = 1
  let newNo = 1
  const push = (sign: '+' | '-' | ' ', text: string) => {
    if (sign === ' ') out.push({ sign, oldNo: oldNo++, newNo: newNo++, text })
    else if (sign === '-') out.push({ sign, oldNo: oldNo++, newNo: null, text })
    else out.push({ sign, oldNo: null, newNo: newNo++, text })
  }

  for (let k = 0; k < head; k++) push(' ', a[k])
  for (const l of middle) push(l.sign, l.text)
  for (let k = a.length - tail; k < a.length; k++) push(' ', a[k])

  return out
}

/**
 * Group changed lines into hunks with `context` unchanged lines either side,
 * merging hunks whose context would overlap. Unchanged stretches between hunks
 * are dropped — that's the point: the reader sees what moved, not the file.
 */
export function toHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const changed: number[] = []
  for (let i = 0; i < lines.length; i++) if (lines[i].sign !== ' ') changed.push(i)
  if (changed.length === 0) return []

  const ranges: Array<[number, number]> = []
  for (const i of changed) {
    const start = Math.max(0, i - context)
    const end = Math.min(lines.length - 1, i + context)
    const last = ranges[ranges.length - 1]
    // +1 so two hunks separated by a single context line stay one block —
    // a one-line gap costs more in "…" than it saves in rows.
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }
  return ranges.map(([s, e]) => ({ lines: lines.slice(s, e + 1) }))
}

/** Hunk lines kept per diff, across all hunks. Guards the transcript on disk. */
export const MAX_DIFF_LINES = 400

/**
 * The diff a tool attaches to its result. `before`/`after` are whole-file
 * contents; an unchanged file yields no hunks and renders as a plain result.
 */
export function buildFileDiff(
  path: string,
  before: string,
  after: string,
  context = 3,
): FileDiff {
  const lines = diffLines(before, after)
  const added = lines.filter((l) => l.sign === '+').length
  const removed = lines.filter((l) => l.sign === '-').length

  let hunks = toHunks(lines, context)
  let truncated = 0
  let budget = MAX_DIFF_LINES
  const capped: DiffHunk[] = []
  for (const h of hunks) {
    if (budget <= 0) {
      truncated += h.lines.length
      continue
    }
    if (h.lines.length > budget) {
      capped.push({ lines: h.lines.slice(0, budget) })
      truncated += h.lines.length - budget
      budget = 0
      continue
    }
    capped.push(h)
    budget -= h.lines.length
  }
  hunks = capped

  return { path, added, removed, hunks, ...(truncated > 0 ? { truncated } : {}) }
}
