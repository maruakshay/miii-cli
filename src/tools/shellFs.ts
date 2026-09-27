import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

/**
 * File I/O for the file tools, performed by shelling out to bash rather than
 * calling into `fs`. read_file, edit_file and write_file keep every rule they
 * had — confinePath, read-before-write, diffing, fuzzy matching — only the
 * syscall underneath changed. Changes to an existing file are applied with sed
 * (see replaceShell); new files are written with `cat`.
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
 *
 * On Windows, `bash` on PATH is often not a POSIX bash for Windows files at
 * all but WSL's launcher (System32\bash.exe): it runs inside Linux, can't see
 * `C:\...` paths, and drops $MIII_P unless WSLENV forwards it — so every call
 * would fail as an ordinary error and never reach the fallback. There, bash is
 * only used after a one-time `uname` probe says it is Git Bash / MSYS2 / Cygwin.
 */

/** 64MB, well past read_file's own 200k char cap — the limit is here so a runaway never buffers unbounded. */
const MAX_BUFFER = 64 * 1024 * 1024

/** Thrown when bash never ran. Distinct from a command that ran and failed. */
class NoShell extends Error {}

/** Thrown when bash ran and the script exited non-zero. Carries the exit status. */
class ShellFailed extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** null until the first call settles it; false once a spawn has failed to launch. */
let shellUsable: boolean | null = null

/**
 * True when `uname -s` output names a bash that works on Windows paths natively
 * (Git Bash and MSYS2 report MINGW64_NT-… / MSYS_NT-…, Cygwin CYGWIN_NT-…).
 * WSL reports plain "Linux".
 */
export function isNativeWindowsBash(uname: string): boolean {
  return /^(MINGW|MSYS|CYGWIN)/i.test(uname.trim())
}

/**
 * Windows only: settle shellUsable before the first real call by asking bash
 * what it is. Anything but a native Windows bash — WSL, a failed launch, a
 * hang — rules the shell out for the session.
 */
function probeWindowsBash(): void {
  try {
    const out = execFileSync('bash', ['-c', 'uname -s'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    shellUsable = isNativeWindowsBash(String(out))
  } catch {
    shellUsable = false
  }
}

/** True while bash is worth trying. Exported for tests and diagnostics. */
export function bashAvailable(): boolean {
  return shellUsable !== false
}

/**
 * Run one bash command with `abs` in $MIII_P. Returns stdout as raw bytes.
 * Throws NoShell if bash could not be started, Error if it ran and failed.
 */
function bash(script: string, abs: string, input?: Buffer, env: Record<string, string> = {}): Buffer {
  if (shellUsable === null && process.platform === 'win32') probeWindowsBash()
  if (shellUsable === false) throw new NoShell('bash unavailable')
  try {
    const out = execFileSync('bash', ['-c', script], {
      env: { ...process.env, ...env, MIII_P: abs },
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
    throw new ShellFailed(msg, e.status)
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

/**
 * Split text into sed's idea of lines: each keeps its '\n', and a final line
 * without one is still a line. Empty text has no lines.
 */
function sedLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * The one contiguous block of lines that turns `before` into `after`: the
 * 1-based inclusive line range [from, to] in `before`, and the text that
 * replaces it. Common leading and trailing lines are left out, so sed only
 * touches the region that actually changed. Null when nothing changed.
 */
export function changedBlock(before: string, after: string): { from: number; to: number; text: string } | null {
  if (before === after) return null
  const a = sedLines(before)
  const b = sedLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  // A pure insertion deletes no lines, but sed's `r` needs a line to hang off
  // and `d` needs a range — so widen the block by one line of context.
  if (head + tail === a.length) {
    if (head > 0) head--
    else tail--
  }
  return { from: head + 1, to: a.length - tail, text: b.slice(head, b.length - tail).join('') }
}

/**
 * Replace a file's content `before` with `after` using sed: the changed line
 * block goes in with `Nr` (queue the new text after line N) and `N,Md` (drop
 * the old lines). The new text travels in a temp file, never in the sed
 * script, so nothing in it — slashes, backslashes, `&`, newlines — is ever
 * read as sed syntax. Avoids `sed -i`, whose flags differ between GNU and BSD.
 *
 * sed's output is compared byte-for-byte with `after` before it lands (`cmp`);
 * the file is only overwritten on a match, in place, so its inode and mode are
 * kept. On a mismatch — the file changed under us, or a sed that mangles an
 * edge case — or where there is no bash or no sed, `after` is written directly
 * instead. Either way the file ends up exactly `after`.
 *
 * A file with no lines yet (new or empty) gives sed nothing to address, so it
 * is written directly.
 */
export function replaceShell(abs: string, before: string, after: string): void {
  const block = sedLines(before).length > 0 ? changedBlock(before, after) : null
  if (!block) {
    if (before !== after || !existsShell(abs)) writeFileShell(abs, after)
    return
  }
  const blk = Buffer.from(block.text, 'utf-8')
  try {
    // stdin carries the replacement block followed by the expected result;
    // MIII_BL says where one ends. It lands in a file first because head/tail
    // on a pipe may over-read and lose bytes meant for the other half.
    bash(
      [
        'set -e',
        'd=$(mktemp -d "${TMPDIR:-/tmp}/miii.XXXXXX")',
        'trap \'rm -rf "$d"\' EXIT',
        'cat > "$d/in"',
        // BSD head rejects -c 0, so an empty block is made with a bare redirect.
        'if [ "$MIII_BL" -gt 0 ]; then head -c "$MIII_BL" "$d/in" > "$d/blk"; else : > "$d/blk"; fi',
        'tail -c +"$((MIII_BL + 1))" "$d/in" > "$d/want"',
        'sed -e "${MIII_A}r $d/blk" -e "${MIII_A},${MIII_Z}d" "$MIII_P" > "$d/out"',
        'cmp -s "$d/out" "$d/want" || exit 3',
        'cat "$d/out" > "$MIII_P"',
      ].join('\n'),
      abs,
      Buffer.concat([blk, Buffer.from(after, 'utf-8')]),
      { MIII_A: String(block.from), MIII_Z: String(block.to), MIII_BL: String(blk.length) },
    )
  } catch (err) {
    // 3: sed's result didn't match. 127: sed/cmp/mktemp not installed.
    if (err instanceof NoShell || (err instanceof ShellFailed && (err.status === 3 || err.status === 127))) {
      writeFileShell(abs, after)
      return
    }
    throw err
  }
}
