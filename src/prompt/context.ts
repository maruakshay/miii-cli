import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'

/** Filename users drop in their project to steer miii, analogous to CLAUDE.md. */
export const CONTEXT_FILENAME = 'MIII.md'

/** Hard cap so an oversized file cannot blow the context window. */
export const MAX_CONTEXT_BYTES = 32 * 1024

export interface ProjectContext {
  /** File body, possibly truncated. Empty string when no file was found. */
  content: string
  /** Absolute path of the loaded file, or null when none found. */
  source: string | null
  /** True when content was clipped to MAX_CONTEXT_BYTES. */
  truncated: boolean
}

const EMPTY: ProjectContext = { content: '', source: null, truncated: false }

/**
 * Walk up from `cwd` to the filesystem root looking for MIII.md. Stops at the
 * first match (nearest to cwd wins) or at a directory containing `.git` (repo
 * boundary) — whichever comes first. Project-scoped only; no global lookup.
 */
export function findContextFile(cwd: string): string | null {
  let dir = cwd
  for (;;) {
    const candidate = join(dir, CONTEXT_FILENAME)
    if (existsSync(candidate)) return candidate
    // Stop after checking the repo root for the file.
    if (existsSync(join(dir, '.git'))) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Load and read MIII.md for `cwd`. Never throws — read failures yield EMPTY. */
export function loadProjectContext(cwd: string): ProjectContext {
  const source = findContextFile(cwd)
  if (!source) return EMPTY
  try {
    if (statSync(source).size === 0) return { ...EMPTY, source }
    const raw = readFileSync(source, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONTEXT_BYTES) {
      const clipped = Buffer.from(raw, 'utf8').subarray(0, MAX_CONTEXT_BYTES).toString('utf8')
      return { content: clipped, source, truncated: true }
    }
    return { content: raw, source, truncated: false }
  } catch {
    return { ...EMPTY, source }
  }
}
