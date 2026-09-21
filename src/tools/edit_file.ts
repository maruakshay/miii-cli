import { readTextShell, writeFileShell } from './shellFs.js'
import { confinePath } from './paths.js'
import { verifyHint } from './verifyHint.js'
import { buildFileDiff } from '../diff.js'
import type { Tool } from './types.js'

interface EditSpec {
  old_str: string
  new_str: string
}

interface Input {
  path: string
  old_str?: string
  new_str?: string
  replace_all?: boolean
  /** Batch mode: apply several exact-string edits atomically in one call. */
  edits?: EditSpec[]
}

/** Cheap line-similarity: fraction of matching chars by position, ignoring leading/trailing ws. */
export function similarity(a: string, b: string): number {
  const x = a.trim()
  const y = b.trim()
  if (!x && !y) return 1
  const len = Math.max(x.length, y.length)
  if (len === 0) return 0
  let same = 0
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] === y[i]) same++
  return same / len
}

/**
 * Exact match failed. Try matching old_str against src ignoring per-line
 * leading/trailing whitespace — the most common reason a model's old_str misses.
 * Returns the [start, end] char range in src of a unique whitespace-tolerant
 * match, or null if there is no match or more than one.
 */
export function fuzzyRange(src: string, old_str: string): [number, number] | null {
  const srcLines = src.split('\n')
  const oldLines = old_str.split('\n')
  const norm = (l: string) => l.trim()
  const oldNorm = oldLines.map(norm)

  // Char offset of the start of each src line.
  const offsets: number[] = new Array(srcLines.length)
  let acc = 0
  for (let i = 0; i < srcLines.length; i++) {
    offsets[i] = acc
    acc += srcLines[i].length + 1 // +1 for the '\n'
  }

  const matches: Array<[number, number]> = []
  const window = oldLines.length
  for (let i = 0; i + window <= srcLines.length; i++) {
    let ok = true
    for (let j = 0; j < window; j++) {
      if (norm(srcLines[i + j]) !== oldNorm[j]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const start = offsets[i]
    const last = i + window - 1
    const end = offsets[last] + srcLines[last].length
    matches.push([start, end])
  }

  return matches.length === 1 ? matches[0] : null
}

/** The leading whitespace of a line, as a string. */
function leadingWs(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

/**
 * A whitespace-tolerant match means the model's indentation disagrees with the
 * file's. Splicing new_str in verbatim would write that disagreement into the
 * file — in Python, YAML or a Makefile that's a silent semantic break reported
 * back as a success, which the model then never revisits. So: work out the one
 * indent shift that maps old_str onto the source it actually matched, and apply
 * that same shift to new_str. Returns null when no single shift explains the
 * difference, or when new_str doesn't carry the prefix being stripped — in
 * either case the caller must not auto-apply.
 */
export function realignIndent(matched: string, old_str: string, new_str: string): string | null {
  const srcLines = matched.split('\n')
  const oldLines = old_str.split('\n')
  if (srcLines.length !== oldLines.length) return null

  // Only non-blank lines carry an indent worth learning from.
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < oldLines.length; i++) {
    if (!oldLines[i].trim()) continue
    pairs.push([leadingWs(srcLines[i]), leadingWs(oldLines[i])])
  }
  if (pairs.length === 0) return null

  // The model may have got old_str's indentation wrong while still writing
  // new_str at the file's real indentation — the tabs-vs-spaces case, where no
  // shift maps one onto the other but the replacement is already correct. This
  // check comes first: shifting an already-correct new_str would double it.
  const firstSrc = srcLines.find((l) => l.trim())
  const firstNew = new_str.split('\n').find((l) => l.trim())
  if (firstSrc !== undefined && firstNew !== undefined && leadingWs(firstSrc) === leadingWs(firstNew)) {
    return new_str
  }

  // Learn the shift from the first pair: either the source carries a prefix the
  // model dropped, or the model added one the source doesn't have.
  const [s0, o0] = pairs[0]
  let mode: 'add' | 'strip'
  let prefix: string
  if (s0.endsWith(o0)) {
    mode = 'add'
    prefix = s0.slice(0, s0.length - o0.length)
  } else if (o0.endsWith(s0)) {
    mode = 'strip'
    prefix = o0.slice(0, o0.length - s0.length)
  } else {
    // Tabs against spaces, or a reindent that isn't a uniform shift.
    return null
  }

  // Every other line must agree, or the mismatch is structural rather than a
  // shift, and re-indenting would be guessing at what the model meant.
  for (const [s, o] of pairs) {
    if (mode === 'add' ? s !== prefix + o : o !== prefix + s) return null
  }
  if (prefix === '') return new_str

  const out: string[] = []
  for (const line of new_str.split('\n')) {
    if (!line.trim()) {
      out.push(line)
      continue
    }
    if (mode === 'add') {
      out.push(prefix + line)
      continue
    }
    if (!line.startsWith(prefix)) return null
    out.push(line.slice(prefix.length))
  }
  return out.join('\n')
}

/**
 * old_str didn't match. Find the source region most like it and show it back
 * with line numbers, so the model can see the real whitespace/text instead of
 * guessing again. This is the most expensive failure in an agent loop.
 */
function nearMiss(src: string, old_str: string): string {
  const srcLines = src.split('\n')
  const needle = old_str.split('\n').find((l) => l.trim()) ?? old_str
  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i < srcLines.length; i++) {
    const s = similarity(srcLines[i], needle)
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  if (bestIdx === -1 || bestScore < 0.4) return ''
  const from = Math.max(0, bestIdx - 3)
  const to = Math.min(srcLines.length, bestIdx + 4)
  const width = String(to).length
  const ctx = srcLines
    .slice(from, to)
    .map((l, i) => `${String(from + i + 1).padStart(width, ' ')}\t${l}`)
    .join('\n')
  return `\nHere's the closest text I could find (lines ${from + 1}-${to}) — copy it exactly:\n${ctx}`
}

/**
 * Find the unique char range of `old_str` in `src`: exact match first, then a
 * whitespace-tolerant fuzzy match, whose new_str is re-indented onto the region
 * it matched. Used by batch mode, which has no replace_all — every edit must
 * resolve to exactly one location. Returns the range and the text to splice in,
 * or a reason it couldn't (with the closest text on no match).
 */
function locate(src: string, old_str: string, new_str: string): { start: number; end: number; text: string } | { error: string } {
  const first = src.indexOf(old_str)
  if (first !== -1) {
    if (src.indexOf(old_str, first + 1) !== -1) {
      return { error: `That text shows up in more than one place, so I can't tell which one you mean. Add a line or two around it to make it unique.` }
    }
    return { start: first, end: first + old_str.length, text: new_str }
  }
  const fuzzy = fuzzyRange(src, old_str)
  if (fuzzy) {
    const text = realignIndent(src.slice(fuzzy[0], fuzzy[1]), old_str, new_str)
    if (text === null) return { error: `I could only find that text by ignoring indentation, and the replacement doesn't line up with it in any one consistent way — writing it could silently break the file. Retry with old_str and new_str at the file's real indentation.${nearMiss(src, old_str)}` }
    return { start: fuzzy[0], end: fuzzy[1], text }
  }
  return { error: `I couldn't find that text — it may differ by whitespace or a stray character.${nearMiss(src, old_str)}` }
}

/**
 * Batch edit: resolve every edit against the ORIGINAL buffer, reject overlaps,
 * then apply right-to-left so earlier offsets stay valid. All-or-nothing — if
 * any edit fails to resolve or two edits overlap, nothing is written.
 */
export function applyBatch(src: string, edits: EditSpec[]): { out: string; count: number } | { error: string } {
  const ranges: Array<{ start: number; end: number; new_str: string }> = []
  for (let i = 0; i < edits.length; i++) {
    const { old_str, new_str } = edits[i]
    if (typeof old_str !== 'string' || typeof new_str !== 'string') {
      return { error: `Edit #${i + 1} is missing text — each edit needs both an old_str and a new_str string.` }
    }
    if (old_str === '') return { error: `Edit #${i + 1} has an empty old_str, so there's nothing to look for. Give it the exact text you want to replace.` }
    if (old_str === new_str) return { error: `Edit #${i + 1} has the same old_str and new_str, so it wouldn't change anything.` }
    const r = locate(src, old_str, new_str)
    if ('error' in r) return { error: `Edit #${i + 1}: ${r.error}` }
    ranges.push({ start: r.start, end: r.end, new_str: r.text })
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      return { error: `Two of these edits touch the same spot, so I can't apply them together. Split them into separate calls, or widen each old_str so they don't overlap.` }
    }
  }
  let out = src
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.new_str + out.slice(r.end)
  }
  return { out, count: ranges.length }
}

export const edit_file: Tool<Input> = {
  name: 'edit_file',
  description:
    'Replace exact strings in a file. To change several places, pass `edits` — one atomic call beats several round trips. old_str must be unique unless replace_all. On no match, returns the closest text found.',
  input_schema: {
    type: 'object',
    properties: {
      path:        { type: 'string', description: 'File path' },
      old_str:     { type: 'string', description: 'Exact text to replace. Omit when using edits.' },
      new_str:     { type: 'string', description: 'Replacement. Omit when using edits.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      edits: {
        type: 'array',
        description: 'Several edits, applied atomically (all or nothing). Preferred over old_str/new_str.',
        items: {
          type: 'object',
          properties: {
            old_str: { type: 'string', description: 'Exact text to replace, unique in the file' },
            new_str: { type: 'string', description: 'Replacement' },
          },
          required: ['old_str', 'new_str'],
        },
      },
    },
    required: ['path'],
  },
  handler: ({ path, old_str, new_str, replace_all, edits }) => {
    try {
      // Batch mode: resolve + apply all edits atomically against the original.
      if (Array.isArray(edits) && edits.length > 0) {
        const abs = confinePath(path)
        const src = readTextShell(abs)
        const res = applyBatch(src, edits)
        if ('error' in res) return { content: `${res.error} (in ${path})`, is_error: true }
        writeFileShell(abs, res.out)
        return {
          content: `Edited ${path} (${res.count} edits).${verifyHint(path)}`,
          diff: buildFileDiff(path, src, res.out),
        }
      }
      if (typeof old_str !== 'string' || typeof new_str !== 'string') {
        return { content: `To edit ${path} I need either an old_str/new_str pair or an edits[] array — neither came through.`, is_error: true }
      }
      if (old_str === new_str) {
        return {
          content: `old_str and new_str are the same, so there's nothing to change in ${path}. If the file is already correct, don't edit it again — finish with the respond action and tell the user it's done.`,
          is_error: true,
        }
      }
      const abs = confinePath(path)
      const src = readTextShell(abs)
      const first = src.indexOf(old_str)
      if (first === -1) {
        // Exact match failed — try a unique whitespace-tolerant match before giving up.
        if (replace_all !== true) {
          const fuzzy = fuzzyRange(src, old_str)
          if (fuzzy) {
            const [s, e] = fuzzy
            // The match ignored indentation, so new_str's indentation can't be
            // trusted either — shift it onto the region before writing.
            const text = realignIndent(src.slice(s, e), old_str, new_str)
            if (text === null) {
              return {
                content: `I could only find that text in ${path} by ignoring indentation, and the replacement doesn't line up with it in any one consistent way — writing it could silently break the file. Retry with old_str and new_str at the file's real indentation.${nearMiss(src, old_str)}`,
                is_error: true,
              }
            }
            const out = src.slice(0, s) + text + src.slice(e)
            writeFileShell(abs, out)
            const how = text === new_str ? 'whitespace-tolerant match' : 'whitespace-tolerant match, re-indented to match the file'
            return {
              content: `Edited ${path} (${how}).${verifyHint(path)}`,
              diff: buildFileDiff(path, src, out),
            }
          }
        }
        return { content: `I couldn't find that text in ${path} — it may differ by whitespace or a stray character.${nearMiss(src, old_str)}`, is_error: true }
      }
      const all = replace_all === true
      if (!all && src.indexOf(old_str, first + 1) !== -1) {
        return {
          content: `That text appears more than once in ${path}, so I don't know which one to change. Add a line or two around it to single it out, or set replace_all to change them all.`,
          is_error: true,
        }
      }
      const out = all ? src.split(old_str).join(new_str) : src.slice(0, first) + new_str + src.slice(first + old_str.length)
      const n = all ? src.split(old_str).length - 1 : 1
      writeFileShell(abs, out)
      return {
        content: `Edited ${path}${all ? ` (${n} occurrences)` : ''}.${verifyHint(path)}`,
        diff: buildFileDiff(path, src, out),
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
  },
}
