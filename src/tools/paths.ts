import { resolve, relative, isAbsolute, sep, join } from 'path'
import { homedir } from 'os'

/** App-owned spill directory (see spill.ts). Trusted so the model can page large
 *  tool output written here, even though it sits outside cwd. confinePath also
 *  backs write_file/edit_file, so this grants writes here too — acceptable: the
 *  dir is app-owned and auto-cleaned on startup. */
const SPILL_DIR = resolve(join(homedir(), '.miii', 'output'))

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Resolve a tool-supplied path against the current working directory and reject
 * any path that escapes it. Returns the absolute, confined path.
 *
 * Blocks `../` traversal, absolute paths outside cwd, and symlink-style escapes
 * expressed as relative segments. Throws a clear Error the tool turns into an
 * is_error result.
 */
export function confinePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('I need a file path here, but none was given.')
  }
  const root = process.cwd()
  const abs = resolve(root, p)
  // Allow reads/writes inside cwd, plus the app-owned spill dir (large tool
  // output the model needs to page back in).
  if (isUnder(root, abs) || isUnder(SPILL_DIR, abs)) {
    return abs
  }
  throw new Error(`"${p}" sits outside the working directory (${root}), so I can't touch it. Stay within the project folder.`)
}
