/**
 * Per-round undo for `miii fix`.
 *
 * The session checkpointer (session/checkpoint.ts) is built for a person
 * scrolling back through turns: it persists to disk and is keyed by
 * conversation turn. The fix loop needs something narrower — "put back exactly
 * what this one attempt changed" — and needs it to be cheap, because on a small
 * model most attempts get rolled back.
 *
 * So each round gets its own in-memory snapshot, fed by the same pre-tool
 * traffic: the first time a round is about to touch a file, its content is kept.
 * Shell commands are covered as far as bashWriteTargets can see into them, and a
 * stat fingerprint of the tree catches the rest — a file changed that way can't
 * be put back, but it is reported rather than silently left behind.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { bashWriteTargets } from '../agent/bashWrites.js'
import type { ToolUse } from '../agent/types.js'

const MAX_BYTES = 2 * 1024 * 1024
const EDIT_TOOLS = new Set(['write_file', 'edit_file'])

export interface RollbackResult {
  restored: string[]
  removed: string[]
  /** Changed during the round but never snapshotted — left as they are. */
  unrestorable: string[]
}

export class RoundSnapshot {
  /** Project-relative path → content before the round touched it (null: did not exist). */
  private before = new Map<string, string | null>()
  private tooBig = new Set<string>()

  constructor(private readonly cwd: string) {}

  private rel(p: string): string | null {
    const abs = isAbsolute(p) ? p : resolve(this.cwd, p)
    const rel = relative(this.cwd, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return rel
  }

  capture(path: string): void {
    const rel = this.rel(path)
    if (rel === null || this.before.has(rel) || this.tooBig.has(rel)) return
    const abs = join(this.cwd, rel)
    if (!existsSync(abs)) {
      this.before.set(rel, null)
      return
    }
    try {
      if (statSync(abs).size > MAX_BYTES) {
        this.tooBig.add(rel)
        return
      }
      this.before.set(rel, readFileSync(abs, 'utf-8'))
    } catch { /* unreadable — it will show up as unrestorable if it changes */ }
  }

  /** Pre-tool listener: snapshot whatever this call is about to write. */
  onPreTool = (use: ToolUse): void => {
    if (EDIT_TOOLS.has(use.name)) {
      const p = use.input?.path
      if (typeof p === 'string' && p) this.capture(p)
    } else if (use.name === 'run_bash') {
      const cmd = use.input?.command
      if (typeof cmd === 'string') for (const t of bashWriteTargets(cmd)) this.capture(t)
    }
  }

  /** Snapshotted paths whose content is different now. */
  changed(): string[] {
    const out: string[] = []
    for (const [rel, prev] of this.before) {
      const abs = join(this.cwd, rel)
      const now = existsSync(abs) ? safeRead(abs) : null
      if (now !== prev) out.push(rel)
    }
    return out
  }

  /**
   * Put every snapshotted file back. `otherChanges` are paths the tree
   * fingerprint saw move that the snapshot never covered.
   */
  rollback(otherChanges: string[] = []): RollbackResult {
    const result: RollbackResult = { restored: [], removed: [], unrestorable: [] }
    for (const [rel, prev] of this.before) {
      const abs = join(this.cwd, rel)
      try {
        if (prev === null) {
          if (existsSync(abs)) {
            rmSync(abs, { force: true })
            result.removed.push(rel)
          }
        } else if (safeRead(abs) !== prev) {
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, prev, 'utf-8')
          result.restored.push(rel)
        }
      } catch {
        result.unrestorable.push(rel)
      }
    }
    for (const rel of otherChanges) {
      if (!this.before.has(rel)) result.unrestorable.push(rel)
    }
    return result
  }
}

function safeRead(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf-8')
  } catch {
    return null
  }
}

/**
 * size+mtime for every file git would show — tracked, plus untracked that are
 * not ignored. null outside a git repo, where there is no cheap, honest answer
 * to "which files are the project's".
 */
export function fingerprint(cwd: string): Map<string, string> | null {
  let listing: string
  try {
    listing = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const map = new Map<string, string>()
  for (const rel of listing.split('\0')) {
    if (!rel) continue
    try {
      const st = statSync(join(cwd, rel))
      map.set(rel, `${st.size}:${st.mtimeMs}`)
    } catch {
      map.set(rel, 'missing')
    }
  }
  return map
}

/** Paths added, removed or modified between two fingerprints. */
export function fingerprintDiff(a: Map<string, string> | null, b: Map<string, string> | null): string[] {
  if (!a || !b) return []
  const out = new Set<string>()
  for (const [k, v] of b) if (a.get(k) !== v) out.add(k)
  for (const k of a.keys()) if (!b.has(k)) out.add(k)
  return [...out].sort()
}
