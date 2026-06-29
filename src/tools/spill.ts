import { writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

/**
 * Overflow handling for tool output. Instead of truncating (lossy) we spill the
 * FULL output to a file and inline only a head+tail preview. The model pages the
 * rest through read_file with offset/limit, so nothing is ever lost and the
 * inline budget is just "how much to show", not "how much exists".
 */

const OUTPUT_DIR = join(homedir(), '.miii', 'output')

/** Bytes inlined before spilling. ~2.5K tokens — enough to read most results whole. */
export const INLINE_BUDGET = 10_000

/** Keep this fraction of the budget as head; the rest is tail (errors live at the bottom). */
const HEAD_FRACTION = 0.3

function ensureDir(): string {
  mkdirSync(OUTPUT_DIR, { recursive: true })
  return OUTPUT_DIR
}

/**
 * If `full` fits the budget, return it unchanged. Otherwise write it to a file
 * and return a head+tail preview plus a pointer telling the model how to read
 * the rest. `label` names the source (e.g. "command output") for the notice.
 */
export function spillIfLarge(full: string, label = 'output', budget = INLINE_BUDGET): string {
  if (full.length <= budget) return full

  const id = randomBytes(6).toString('hex')
  const file = join(ensureDir(), `${id}.txt`)
  let path = file
  try {
    writeFileSync(file, full, 'utf-8')
  } catch {
    // Spill failed (e.g. read-only home) — fall back to lossy head+tail so we
    // never blow the context window, but say the tail was dropped.
    path = ''
  }

  const head = Math.floor(budget * HEAD_FRACTION)
  const tail = budget - head
  const preview = full.slice(0, head) + '\n…\n' + full.slice(-tail)
  const notice = path
    ? `[${label} truncated: ${full.length} bytes. Full output at ${path} — read it with read_file offset/limit to see the elided middle.]`
    : `[${label} truncated to ${budget} bytes; spill to disk failed, middle is lost.]`
  return `${preview}\n${notice}`
}

/** Delete spilled output files older than `maxAgeMs` (default 24h). Best-effort. */
export function cleanupSpill(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const now = Date.now()
    for (const name of readdirSync(OUTPUT_DIR)) {
      const f = join(OUTPUT_DIR, name)
      try {
        if (now - statSync(f).mtimeMs > maxAgeMs) rmSync(f, { force: true })
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* dir missing — nothing to clean */
  }
}
