import { readFileSync, writeFileSync } from 'fs'
import { confinePath } from './paths.js'
import { verifyHint } from './verifyHint.js'
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
  return `\nClosest text in file (lines ${from + 1}-${to}):\n${ctx}`
}

/**
 * Find the unique char range of `old_str` in `src`: exact match first, then a
 * whitespace-tolerant fuzzy match. Used by batch mode, which has no replace_all
 * — every edit must resolve to exactly one location. Returns the range or a
 * reason string explaining why it couldn't (with the closest text on no match).
 */
function locate(src: string, old_str: string): [number, number] | { error: string } {
  const first = src.indexOf(old_str)
  if (first !== -1) {
    if (src.indexOf(old_str, first + 1) !== -1) {
      return { error: `old_str not unique — add surrounding context to disambiguate.` }
    }
    return [first, first + old_str.length]
  }
  const fuzzy = fuzzyRange(src, old_str)
  if (fuzzy) return fuzzy
  return { error: `old_str not found.${nearMiss(src, old_str)}` }
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
      return { error: `edits[${i}] must have string old_str and new_str.` }
    }
    if (old_str === '') return { error: `edits[${i}].old_str is empty.` }
    if (old_str === new_str) return { error: `edits[${i}] old_str and new_str are identical — nothing to change.` }
    const r = locate(src, old_str)
    if (!Array.isArray(r)) return { error: `edits[${i}]: ${r.error}` }
    ranges.push({ start: r[0], end: r[1], new_str })
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      return { error: `edits overlap in the file — split them into separate calls or widen the context.` }
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
    'Replace an exact string in a file. old_str must be unique unless replace_all is set. On no match, returns the closest text in the file. To make several edits to one file at once, pass an `edits` array of {old_str,new_str} — they apply atomically (all or nothing).',
  input_schema: {
    type: 'object',
    properties: {
      path:        { type: 'string', description: 'File path' },
      old_str:     { type: 'string', description: 'Exact text to replace (whitespace-sensitive). Omit when using edits[].' },
      new_str:     { type: 'string', description: 'Replacement text. Omit when using edits[].' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness' },
      edits: {
        type: 'array',
        description: 'Batch mode: several edits applied atomically. Each old_str must be unique in the file. Alternative to old_str/new_str.',
        items: {
          type: 'object',
          properties: {
            old_str: { type: 'string', description: 'Exact text to replace (whitespace-sensitive)' },
            new_str: { type: 'string', description: 'Replacement text' },
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
        const src = readFileSync(abs, 'utf-8')
        const res = applyBatch(src, edits)
        if ('error' in res) return { content: `${res.error} (in ${path})`, is_error: true }
        writeFileSync(abs, res.out, 'utf-8')
        return { content: `Edited ${path} (${res.count} edits).${verifyHint(path)}` }
      }
      if (typeof old_str !== 'string' || typeof new_str !== 'string') {
        return { content: `edit_file needs old_str and new_str (or an edits[] array) for ${path}.`, is_error: true }
      }
      if (old_str === new_str) {
        return {
          content: `old_str and new_str are identical — nothing to change in ${path}. If the file is already correct, do NOT edit again: finish with the respond action and tell the user it is done.`,
          is_error: true,
        }
      }
      const abs = confinePath(path)
      const src = readFileSync(abs, 'utf-8')
      const first = src.indexOf(old_str)
      if (first === -1) {
        // Exact match failed — try a unique whitespace-tolerant match before giving up.
        if (replace_all !== true) {
          const fuzzy = fuzzyRange(src, old_str)
          if (fuzzy) {
            const [s, e] = fuzzy
            const out = src.slice(0, s) + new_str + src.slice(e)
            writeFileSync(abs, out, 'utf-8')
            return { content: `Edited ${path} (whitespace-tolerant match).${verifyHint(path)}` }
          }
        }
        return { content: `old_str not found in ${path}.${nearMiss(src, old_str)}`, is_error: true }
      }
      const all = replace_all === true
      if (!all && src.indexOf(old_str, first + 1) !== -1) {
        return {
          content: `old_str not unique in ${path}. Add surrounding context to disambiguate, or set replace_all.`,
          is_error: true,
        }
      }
      const out = all ? src.split(old_str).join(new_str) : src.slice(0, first) + new_str + src.slice(first + old_str.length)
      const n = all ? src.split(old_str).length - 1 : 1
      writeFileSync(abs, out, 'utf-8')
      return { content: `Edited ${path}${all ? ` (${n} occurrences)` : ''}.${verifyHint(path)}` }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
  },
}
