/**
 * Checkpoints — undo for the agent.
 *
 * miii targets small models, which are wrong more often than a frontier model
 * is, and "wrong" here means four files edited in a direction you did not want.
 * `git checkout` is the usual answer and it is the wrong one twice over: the
 * work is rarely committed at the point you want back, and it discards your own
 * uncommitted edits along with the agent's.
 *
 * So every file the agent is about to change is copied first, tagged with the
 * turn it belonged to. Restoring a turn writes those copies back and truncates
 * the conversation to match — the files and the transcript move together, which
 * is the part that makes it usable: rewinding the text alone leaves the model
 * reasoning about a tree that no longer matches what it can see.
 *
 *   ~/.miii/projects/<encoded-cwd>/checkpoints/<session>.jsonl
 *
 * One line per file per turn, holding the content *before* the change (null for
 * a file that did not exist yet, so restoring deletes it again). Append-only:
 * a crash mid-turn costs the last line, never the history.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs'
import { dirname, join, relative } from 'path'
import { homedir } from 'os'
import { loadSettings } from '../settings.js'
import type { ToolUse } from '../agent/types.js'

/** Tools that change a file on disk. The only calls worth snapshotting. */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file'])

/**
 * Files bigger than this are not snapshotted. A checkpoint is meant to cost
 * nothing on every edit; copying a 50MB fixture on the way past is not that,
 * and an agent editing one is not the case this exists for.
 */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

interface ChangeLine {
  turn: number
  ts: string
  path: string
  /** File content before the change; null when the file did not exist. */
  before: string | null
}

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:/\\]+/g, '-').replace(/^-+/, '')
}

function checkpointDir(cwd: string): string {
  return join(homedir(), '.miii', 'projects', encodeProjectDir(cwd), 'checkpoints')
}

function checkpointPath(sessionId: string, cwd: string): string {
  return join(checkpointDir(cwd), `${sessionId}.jsonl`)
}

/**
 * Which turn the next snapshot belongs to. Module state rather than a parameter
 * because the snapshotting happens inside a pre-tool hook, which sees the tool
 * call and nothing about where the conversation is.
 */
let currentTurn = 0
let currentSession: string | null = null

/** Open a new turn boundary. Called by the runner before each tool turn. */
export function snapshotForTurn(sessionId: string, turn: number): void {
  currentSession = sessionId
  currentTurn = turn
}

export function checkpointsEnabled(cwd = process.cwd()): boolean {
  return loadSettings(cwd).checkpoints !== false
}

/**
 * Record a file's current state, if this turn has not already recorded it.
 *
 * Only the FIRST snapshot of a path in a turn is kept: that is the state the
 * turn started from, which is what restoring wants. Later edits in the same
 * turn are steps along the way, not places to come back to.
 */
export function snapshotFile(absPath: string, cwd = process.cwd()): void {
  if (!currentSession || !checkpointsEnabled(cwd)) return
  const rel = relative(cwd, absPath)
  // Outside the project (the spill dir, mostly) — not ours to restore.
  if (rel.startsWith('..')) return

  const file = checkpointPath(currentSession, cwd)
  if (existsSync(file)) {
    // Already captured this path this turn? Scanning the tail is enough: turns
    // are appended in order, so this turn's lines are all at the end.
    try {
      const lines = readFileSync(file, 'utf-8').trimEnd().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]) as ChangeLine
        if (entry.turn !== currentTurn) break
        if (entry.path === rel) return
      }
    } catch { /* unreadable log — record anyway, a duplicate is harmless */ }
  }

  let before: string | null = null
  if (existsSync(absPath)) {
    try {
      if (statSync(absPath).size > MAX_SNAPSHOT_BYTES) return
      before = readFileSync(absPath, 'utf-8')
    } catch {
      return
    }
  }

  const line: ChangeLine = { turn: currentTurn, ts: new Date().toISOString(), path: rel, before }
  try {
    mkdirSync(checkpointDir(cwd), { recursive: true })
    appendFileSync(file, JSON.stringify(line) + '\n', 'utf-8')
  } catch { /* checkpointing is best-effort; never fail a turn over it */ }
}

/** The pre-tool listener that does the snapshotting. Registered on the bus. */
export function checkpointPreToolHook(use: ToolUse, cwd = process.cwd()): void {
  if (!MUTATING_TOOLS.has(use.name)) return
  const p = use.input?.path
  if (typeof p !== 'string' || !p) return
  snapshotFile(join(cwd, p), cwd)
}

function readLog(sessionId: string, cwd: string): ChangeLine[] {
  const file = checkpointPath(sessionId, cwd)
  if (!existsSync(file)) return []
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ChangeLine)
  } catch {
    return []
  }
}

export interface Checkpoint {
  turn: number
  ts: string
  /** Project-relative paths this turn was about to change. */
  files: string[]
}

/** Turns with file changes behind them, oldest first — what `/rewind` lists. */
export function listCheckpoints(sessionId: string, cwd = process.cwd()): Checkpoint[] {
  const byTurn = new Map<number, Checkpoint>()
  for (const line of readLog(sessionId, cwd)) {
    const found = byTurn.get(line.turn)
    if (found) {
      if (!found.files.includes(line.path)) found.files.push(line.path)
    } else {
      byTurn.set(line.turn, { turn: line.turn, ts: line.ts, files: [line.path] })
    }
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn)
}

export interface RestoreResult {
  restored: string[]
  removed: string[]
  failed: string[]
}

/**
 * Put every file back the way it was at the start of `turn`.
 *
 * Applied oldest-first per path so the earliest recorded state wins: if a file
 * was touched in turns 3, 5 and 7 and you rewind to 3, what you want back is
 * what turn 3 found, not what turn 7 found.
 */
export function restoreTo(sessionId: string, turn: number, cwd = process.cwd()): RestoreResult {
  const result: RestoreResult = { restored: [], removed: [], failed: [] }
  const earliest = new Map<string, ChangeLine>()
  for (const line of readLog(sessionId, cwd)) {
    if (line.turn < turn) continue
    if (!earliest.has(line.path)) earliest.set(line.path, line)
  }

  for (const [rel, line] of earliest) {
    const abs = join(cwd, rel)
    try {
      if (line.before === null) {
        rmSync(abs, { force: true })
        result.removed.push(rel)
      } else {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, line.before, 'utf-8')
        result.restored.push(rel)
      }
    } catch {
      result.failed.push(rel)
    }
  }

  // Drop the rewound turns so a second /rewind to the same point is a no-op
  // rather than re-restoring stale content over newer work.
  const kept = readLog(sessionId, cwd).filter((l) => l.turn < turn)
  try {
    const file = checkpointPath(sessionId, cwd)
    if (kept.length) writeFileSync(file, kept.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
    else rmSync(file, { force: true })
  } catch { /* best-effort */ }

  return result
}

/** Forget a session's checkpoints — called when its session is deleted. */
export function clearCheckpoints(sessionId: string, cwd = process.cwd()): void {
  try {
    rmSync(checkpointPath(sessionId, cwd), { force: true })
  } catch { /* best-effort */ }
}
