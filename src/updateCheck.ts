import { createRequire } from 'module'
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

const require = createRequire(import.meta.url)
const PKG_NAME = 'miii-agent'

// Rate-limit window for background self-updates. A user who quits and relaunches
// repeatedly while npm is still installing would otherwise spawn concurrent
// global installs that fight over npm's lock.
const UPDATE_ATTEMPT_PATH = join(homedir(), '.miii', '.last-update-attempt')
const UPDATE_ATTEMPT_COOLDOWN_MS = 10 * 60 * 1000

function recentlyAttemptedUpdate(): boolean {
  try {
    const last = Number(readFileSync(UPDATE_ATTEMPT_PATH, 'utf8').trim())
    return Number.isFinite(last) && Date.now() - last < UPDATE_ATTEMPT_COOLDOWN_MS
  } catch {
    return false
  }
}

function markUpdateAttempt(): void {
  try {
    mkdirSync(join(homedir(), '.miii'), { recursive: true })
    writeFileSync(UPDATE_ATTEMPT_PATH, String(Date.now()))
  } catch {
    // ignore — worst case we lose the rate-limit guard
  }
}

export function currentVersion(): string {
  try {
    return (require('../package.json') as { version: string }).version
  } catch {
    return ''
  }
}

function newerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [ca, cb, cc] = parse(current)
  const [la, lb, lc] = parse(latest)
  if (la !== ca) return la > ca
  if (lb !== cb) return lb > cb
  return lc > cc
}

// Install the latest release detached in the background so it never blocks the
// running session. The new version takes effect on the next launch. Best-effort:
// a global install needing sudo, or no npm on PATH, just fails silently.
//
// Returns true only when an install was actually kicked off, so callers can show
// a "downloading" state honestly. Returns false on the rate-limit cooldown or a
// synchronous spawn failure — the manual `miii update` banner stands instead.
//
// `onDone` (optional) reports the eventual outcome while this process is still
// alive: true if npm exited 0, false on non-zero exit or async spawn error. It
// never fires when autoUpdate returns false. The child stays detached/unref'd so
// the install survives the user quitting before it finishes.
export function autoUpdate(onDone?: (ok: boolean) => void): boolean {
  if (recentlyAttemptedUpdate()) return false
  try {
    markUpdateAttempt()
    const { spawn } = require('child_process') as typeof import('child_process')
    const child = spawn('npm', ['i', '-g', `${PKG_NAME}@latest`], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      onDone?.(ok)
    }
    // A failed spawn (e.g. npm not on PATH) emits 'error' asynchronously; an
    // unhandled 'error' on a ChildProcess throws and would crash the TUI.
    child.on('error', () => settle(false))
    child.on('exit', (code) => settle(code === 0))
    child.unref()
    return true
  } catch {
    // ignore — fall back to the manual `miii update` banner
    return false
  }
}

export async function checkForUpdate(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    const data = await res.json() as { version: string }
    const latest = data.version
    const current = currentVersion()
    if (current && newerVersion(current, latest)) return latest
    return null
  } catch {
    return null
  }
}
