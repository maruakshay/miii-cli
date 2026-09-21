import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

/**
 * File I/O for the file tools, performed by shelling out to bash rather than
 * calling into `fs`. read_file, edit_file and write_file keep every rule they
 * had — confinePath, read-before-write, diffing, fuzzy matching — only the
 * syscall underneath changed.
 *
 * Two things make this safe to do:
 *  - The path never reaches the command text. It rides in an env var (`$MIII_P`)
 *    which bash expands after parsing, so a filename with a space, a quote, a
 *    `$` or a `;` is a filename and not shell.
 *  - Content moves as raw bytes over stdin/stdout with `cat`, so nothing is
 *    encoded, re-encoded, or line-mangled on the way through.
 *
 * Where there is no POSIX bash on PATH — a plain Windows box without git-bash
 * or WSL, a stripped container — every function falls back to `fs` and the
 * tools behave exactly as they did before. The fallback is decided once, by the
 * first spawn that fails to launch, and never retried: a machine does not grow
 * a bash mid-session, and re-probing would pay the spawn cost on every read.
 */

/** 64MB, well past read_file's own 200k char cap — the limit is here so a runaway never buffers unbounded. */
const MAX_BUFFER = 64 * 1024 * 1024

/** Thrown when bash never ran. Distinct from a command that ran and failed. */
class NoShell extends Error {}

/** null until the first call settles it; false once a spawn has failed to launch. */
let shellUsable: boolean | null = null

/** True while bash is worth trying. Exported for tests and diagnostics. */
export function bashAvailable(): boolean {
  return shellUsable !== false
}

/**
 * Run one bash command with `abs` in $MIII_P. Returns stdout as raw bytes.
 * Throws NoShell if bash could not be started, Error if it ran and failed.
 */
function bash(script: string, abs: string, input?: Buffer): Buffer {
  if (shellUsable === false) throw new NoShell('bash unavailable')
  try {
    const out = execFileSync('bash', ['-c', script], {
      env: { ...process.env, MIII_P: abs },
      input,
      maxBuffer: MAX_BUFFER,
      // stderr is captured so a failure message lands in the thrown Error rather
      // than leaking onto the terminal the UI is drawing into.
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    shellUsable = true
    return out
  } catch (err) {
    const e = err as { status?: number | null; stderr?: Buffer | string; message?: string }
    // A numeric exit status means bash ran and the script failed — a real error
    // about the file, which fs would report too. Anything else (ENOENT on the
    // binary, EACCES, a spawn that never happened) means the shell is not there.
    if (typeof e.status !== 'number') {
      shellUsable = false
      throw new NoShell(e.message ?? 'bash could not be started')
    }
    shellUsable = true
    const msg = (e.stderr ? String(e.stderr) : '').trim() || e.message || 'command failed'
    throw new Error(msg)
  }
}

/** Read a file's bytes with `cat`, or `fs` where there is no bash. */
export function readFileShell(abs: string): Buffer {
  try {
    // -f rather than -e: cat on a directory succeeds on some platforms and hands
    // back nothing useful on the rest.
    return bash('[ -f "$MIII_P" ] || { echo "no such file: $MIII_P" >&2; exit 1; }; cat -- "$MIII_P"', abs)
  } catch (err) {
    if (!(err instanceof NoShell)) throw err
    return readFileSync(abs)
  }
}

/** Read a file as UTF-8 text. */
export function readTextShell(abs: string): string {
  return readFileShell(abs).toString('utf-8')
}

/** True when the path exists. */
export function existsShell(abs: string): boolean {
  try {
    bash('test -e "$MIII_P"', abs)
    return true
  } catch (err) {
    if (err instanceof NoShell) return existsSync(abs)
    return false
  }
}

/** Create a directory and its parents. */
export function mkdirpShell(abs: string): void {
  try {
    bash('mkdir -p -- "$MIII_P"', abs)
  } catch (err) {
    if (!(err instanceof NoShell)) throw err
    mkdirSync(abs, { recursive: true })
  }
}

/**
 * Write `content` to `abs`, creating parent dirs. The redirect truncates the
 * file before `cat` starts, so this overwrites exactly as writeFileSync did.
 */
export function writeFileShell(abs: string, content: string): void {
  try {
    bash(`mkdir -p -- "$(dirname -- "$MIII_P")" && cat > "$MIII_P"`, abs, Buffer.from(content, 'utf-8'))
  } catch (err) {
    if (!(err instanceof NoShell)) throw err
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
}
