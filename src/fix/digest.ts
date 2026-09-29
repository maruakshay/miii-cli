/**
 * Turn raw check output into something a small model can act on.
 *
 * A 7B model handed four hundred lines of test-runner output fixes the wrong
 * thing, or nothing: the one line that matters is buried under progress bars,
 * passing suites and stack frames from node_modules. What it can use is the
 * first failure, a few lines around it, and the source it points at. That is
 * all this builds — the model is always free to read more with its own tools.
 *
 * Everything here is pure (the source snippet takes a reader) so the parsing can
 * be tested against real runner output without touching the disk.
 */
import { isAbsolute, join, relative } from 'path'

export interface CheckResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  durationMs: number
}

export interface Digest {
  passed: boolean
  /**
   * Failures the runner reported, when its summary line could be read. null
   * means "failed, count unknown" — compared by `signature` instead.
   */
  failures: number | null
  /** The first error line, normalised. Two rounds with the same one made no progress. */
  signature: string
  /** What goes into the prompt: the trimmed failure plus a source snippet. */
  text: string
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(/\r(?!\n)/g, '\n')
}

/**
 * Lines that start a failure, across the runners people actually use. Ordered
 * loosely by how specific they are; the first line in the output that matches
 * any of them anchors the excerpt.
 */
const FAILURE_LINE = [
  /^\s*(FAIL|FAILED)\b/,                          // vitest, jest, pytest summary, go
  /^\s*[×✗✕]\s/,                                  // vitest / jest / mocha markers
  /^\s*\d+\)\s/,                                  // mocha numbered failures
  /error TS\d+:/,                                 // tsc
  /^\S+:\d+:\d+:?\s*(error|Error)\b/,             // gcc, eslint compact, go vet
  /^error(\[E\d+\])?:/,                           // rustc
  /^\s*(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error):/,
  /^Traceback \(most recent call last\)/,         // python
  /^E\s{2,}\S/,                                   // pytest assertion detail
  /^--- FAIL:/,                                   // go test
  /^thread '.*' panicked at/,                     // rust test
  /^\s*✘/,
  /^not ok \d+/,                                  // TAP (node --test)
]

/** Summary lines that state a failure count. First capture group is the number. */
const COUNT_PATTERNS: RegExp[] = [
  /Tests?:?\s+(\d+)\s+failed/i,                   // jest "Tests: 2 failed", vitest "Tests  2 failed"
  /(\d+)\s+failed(?:,|\s|$)/i,                    // pytest "2 failed, 10 passed", vitest
  /Found (\d+) errors?/,                          // tsc
  /(\d+)\s+failing\b/,                            // mocha
  /test result: FAILED\.\s+\d+ passed;\s+(\d+) failed/, // cargo
  /(\d+) problems? \((\d+) errors?/,              // eslint
  /^[#ℹ] fail (\d+)/m,                             // node --test (TAP and spec reporters)
]

export function countFailures(output: string): number | null {
  let best: number | null = null
  for (const re of COUNT_PATTERNS) {
    const all = [...output.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))]
    for (const m of all) {
      const n = Number(m[1])
      if (Number.isFinite(n)) best = best === null ? n : Math.max(best, n)
    }
  }
  if (best !== null) return best
  // No summary line. `go test` and plain tsc output list one line per failure.
  const goFails = output.match(/^--- FAIL:/gm)?.length ?? 0
  if (goFails) return goFails
  const tsErrors = output.match(/error TS\d+:/g)?.length ?? 0
  if (tsErrors) return tsErrors
  return null
}

function isFailureLine(line: string): boolean {
  return FAILURE_LINE.some((re) => re.test(line))
}

/** Frames from dependencies and the runtime are noise to a model fixing app code. */
function isNoiseFrame(line: string): boolean {
  return /node_modules|node:internal|<anonymous>|site-packages|\/rustc\/|runtime\/panic/.test(line)
}

/** Strip what varies between identical failures: timings, addresses, tmp paths. */
export function normaliseSignature(line: string): string {
  return line
    .replace(/\d+(\.\d+)?\s*m?s\b/g, '')
    .replace(/0x[0-9a-f]+/gi, '0x')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** `path:line` references inside the project, first one first. */
export function sourceRefs(text: string, cwd: string): { path: string; line: number }[] {
  const refs: { path: string; line: number }[] = []
  const seen = new Set<string>()
  const re = /((?:[A-Za-z]:)?[\w./\\-]+\.[A-Za-z]{1,5}):(\d+)(?::\d+)?/g
  for (const m of text.matchAll(re)) {
    const raw = m[1]
    if (isNoiseFrame(raw)) continue
    const rel = isAbsolute(raw) ? relative(cwd, raw) : raw.replace(/^\.\//, '')
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    const key = `${rel}:${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ path: rel, line: Number(m[2]) })
  }
  return refs
}

/** ±`radius` lines around `line`, numbered, with the target line marked. */
export function snippet(content: string, line: number, radius = 12): string {
  const lines = content.split('\n')
  const start = Math.max(1, line - radius)
  const end = Math.min(lines.length, line + radius)
  const width = String(end).length
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    out.push(`${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1]}`)
  }
  return out.join('\n')
}

export interface DigestOptions {
  cwd: string
  /** Reads a project file; returns null when it can't. Injected for tests. */
  readFile?: (absPath: string) => string | null
  /** Most lines of runner output to keep. */
  maxLines?: number
}

/**
 * Keep the part of `output` a model needs: from the first failure line, a
 * bounded window with dependency frames removed. Falls back to the tail, which
 * is where runners put their verdict, when no failure line is recognised.
 */
export function excerpt(output: string, maxLines = 60): string {
  const lines = stripAnsi(output).split('\n')
  const first = lines.findIndex(isFailureLine)
  let window: string[]
  if (first === -1) {
    window = lines.slice(-maxLines)
  } else {
    // A little context above the anchor: runners often print the test name there.
    window = lines.slice(Math.max(0, first - 3), first + maxLines * 2)
  }
  const kept = window.filter((l) => !isNoiseFrame(l))
  // Collapse runs of blank lines — they cost tokens and carry nothing.
  const compact: string[] = []
  for (const l of kept) {
    if (!l.trim() && !compact[compact.length - 1]?.trim()) continue
    compact.push(l)
  }
  const trimmed = compact.slice(0, maxLines)
  if (compact.length > maxLines) trimmed.push(`… (${compact.length - maxLines} more lines cut)`)
  return trimmed.join('\n').trim()
}

export function digest(result: CheckResult, opts: DigestOptions): Digest {
  const clean = stripAnsi(result.output)
  const passed = result.exitCode === 0 && !result.timedOut
  if (passed) return { passed, failures: 0, signature: '', text: '' }

  const lines = clean.split('\n')
  const anchor = lines.find(isFailureLine) ?? lines.filter((l) => l.trim()).slice(-1)[0] ?? ''
  const body = excerpt(clean, opts.maxLines ?? 60)
  const parts: string[] = []
  if (result.timedOut) parts.push(`The check timed out after ${Math.round(result.durationMs / 1000)}s.`)
  parts.push('```\n' + body + '\n```')

  // Show the code the failure points at, so the model starts from the right
  // place instead of spending turns grepping for it.
  const read = opts.readFile
  if (read) {
    for (const ref of sourceRefs(body, opts.cwd).slice(0, 2)) {
      const content = read(join(opts.cwd, ref.path))
      if (content === null) continue
      parts.push(`${ref.path} around line ${ref.line}:\n\`\`\`\n${snippet(content, ref.line)}\n\`\`\``)
    }
  }

  return {
    passed,
    failures: countFailures(clean),
    signature: normaliseSignature(anchor),
    text: parts.join('\n\n'),
  }
}

/**
 * Did `next` move closer to green than `prev`? Strictly fewer known failures is
 * progress. Without both counts to compare, a different first error counts as
 * progress too — the old failure is gone even if another surfaced behind it —
 * unless the new output got markedly longer, which usually means more broke.
 */
export function improved(prev: Digest, next: Digest, prevLen: number, nextLen: number): boolean {
  if (next.passed) return true
  // Same count with a different first error is a swap, not progress.
  if (prev.failures !== null && next.failures !== null) return next.failures < prev.failures
  if (next.signature === prev.signature) return false
  return nextLen <= prevLen * 1.5
}
