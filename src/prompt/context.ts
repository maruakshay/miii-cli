import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

/** Filename users drop in their project to steer miii, analogous to CLAUDE.md. */
export const CONTEXT_FILENAME = 'MIII.md'

/** Hard cap so an oversized file cannot blow the context window. */
export const MAX_CONTEXT_BYTES = 32 * 1024

export interface ProjectContext {
  /** The merged body sent to the model, possibly truncated. */
  content: string
  /** Absolute path of the project file, or null when none was found. */
  source: string | null
  /** Absolute path of the user-wide file, when one exists. */
  userSource?: string
  /** True when content was clipped to MAX_CONTEXT_BYTES. */
  truncated: boolean
}

const EMPTY: ProjectContext = { content: '', source: null, truncated: false }

/** The user-wide instructions file — conventions that follow you between repos. */
export function userContextPath(): string {
  return join(homedir(), '.miii', CONTEXT_FILENAME)
}

/**
 * Walk up from `cwd` to the filesystem root looking for MIII.md. Stops at the
 * first match (nearest to cwd wins) or at a directory containing `.git` (repo
 * boundary) — whichever comes first.
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

/** Read one context file, or '' if it is missing, empty or unreadable. */
function readContext(path: string | null): string {
  if (!path) return ''
  try {
    if (statSync(path).size === 0) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Load the instructions in force for `cwd`.
 *
 * Two files, merged: `~/.miii/MIII.md` first, then the project's own. Order is
 * the precedence — a project that says "we use tabs" must win over a personal
 * file that says spaces, and models weight later instructions more heavily.
 * Never throws; a read failure is the same as no file.
 */
export function loadProjectContext(cwd: string): ProjectContext {
  const source = findContextFile(cwd)
  const userPath = userContextPath()
  const userBody = readContext(existsSync(userPath) ? userPath : null).trim()
  const projectBody = readContext(source).trim()
  if (!userBody && !projectBody) return source ? { ...EMPTY, source } : EMPTY

  // Headers only when both files are in play. With one file they are noise —
  // the prompt already names where the instructions came from.
  const raw =
    userBody && projectBody
      ? `## From ${userPath} (your defaults)\n\n${userBody}\n\n## From ${source} (this project — wins on conflict)\n\n${projectBody}`
      : userBody || projectBody

  const merged: ProjectContext = {
    content: raw,
    source,
    ...(userBody ? { userSource: userPath } : {}),
    truncated: false,
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONTEXT_BYTES) {
    merged.content = Buffer.from(raw, 'utf8').subarray(0, MAX_CONTEXT_BYTES).toString('utf8')
    merged.truncated = true
  }
  return merged
}

export type MemoryScope = 'project' | 'user'

/**
 * Append one remembered line to a MIII.md, creating the file if needed.
 *
 * This is what `# some fact` in the input bar does. It is a one-line append
 * rather than anything cleverer on purpose: the file is the user's to edit, and
 * an agent reorganising it behind their back is how a steering file stops being
 * trusted.
 */
export function appendMemory(text: string, scope: MemoryScope, cwd = process.cwd()): string {
  const line = text.trim().replace(/\s+/g, ' ')
  const path = scope === 'user' ? userContextPath() : findContextFile(cwd) ?? join(cwd, CONTEXT_FILENAME)
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) {
    writeFileSync(path, `# ${CONTEXT_FILENAME}\n\nInstructions for miii in this project.\n\n- ${line}\n`, 'utf8')
    return path
  }
  const existing = readFileSync(path, 'utf8')
  appendFileSync(path, `${existing.endsWith('\n') ? '' : '\n'}- ${line}\n`, 'utf8')
  return path
}
