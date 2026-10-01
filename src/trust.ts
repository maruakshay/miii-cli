/**
 * Folder trust — whether a project's own `.miii/` config may act on this machine.
 *
 * `.miii/settings.json` can declare hooks (shell commands), MCP servers
 * (programs miii starts), standing allow rules, a starting permission mode and
 * env for every command. `.miii/permissions.json` holds allow rules. All of that
 * is checked in, so cloning a repo and running `miii` in it would otherwise hand
 * the repo's author a shell on your machine before you typed a word.
 *
 * So project config is ignored until you say otherwise. A yes is remembered in
 * ~/.miii/trusted.json against the folder's real path *and* a hash of those
 * files: a `git pull` that changes them asks again, because what you trusted is
 * not what is there any more.
 *
 * Deny rules are the exception — they can only take power away, so they apply
 * whether the folder is trusted or not (see settings.ts).
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** The files trust covers. All live in `<cwd>/.miii/`. */
export const PROJECT_CONFIG_FILES = ['settings.json', 'settings.local.json', 'permissions.json']

/** Resolved per call, not at import: tests and the CLI both move HOME and cwd. */
function storePath(): string {
  return join(homedir(), '.miii', 'trusted.json')
}

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** The project config files that exist here. */
export function projectConfigFiles(cwd: string = process.cwd()): string[] {
  return PROJECT_CONFIG_FILES.map((name) => join(cwd, '.miii', name)).filter((p) => existsSync(p))
}

/** One hash over every config file's name and bytes, or null when there are none. */
export function projectConfigHash(cwd: string = process.cwd()): string | null {
  const hash = createHash('sha256')
  let any = false
  for (const name of PROJECT_CONFIG_FILES) {
    const path = join(cwd, '.miii', name)
    if (!existsSync(path)) continue
    any = true
    hash.update(name).update('\0')
    try {
      hash.update(readFileSync(path))
    } catch {
      hash.update('<unreadable>')
    }
    hash.update('\0')
  }
  return any ? hash.digest('hex') : null
}

function readStore(): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(storePath(), 'utf-8')) as { projects?: Record<string, string> }
    return data.projects && typeof data.projects === 'object' ? data.projects : {}
  } catch {
    return {}
  }
}

function writeStore(projects: Record<string, string>): void {
  const path = storePath()
  mkdirSync(join(homedir(), '.miii'), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify({ projects }, null, 2), 'utf-8')
  renameSync(tmp, path)
}

/**
 * May this folder's `.miii/` config act? True when there is none to act, when
 * the folder is your home directory (where "project" config is your own user
 * config), or when you trusted exactly these files.
 */
export function isProjectTrusted(cwd: string = process.cwd()): boolean {
  if (real(cwd) === real(homedir())) return true
  const hash = projectConfigHash(cwd)
  if (hash === null) return true
  return readStore()[real(cwd)] === hash
}

/** Remember the folder's config, as it is right now, as trusted. */
export function trustProject(cwd: string = process.cwd()): void {
  const hash = projectConfigHash(cwd)
  if (hash === null) return
  writeStore({ ...readStore(), [real(cwd)]: hash })
}

/** A file that is not JSON shows up as a problem in settings.ts; here it just has nothing to list. */
function readJson(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * What the project config would do if trusted, one line each — the substance of
 * the question, so "trust this folder?" is not asked blind.
 */
export function describeProjectConfig(cwd: string = process.cwd()): string[] {
  const lines: string[] = []
  for (const name of ['settings.json', 'settings.local.json']) {
    const path = join(cwd, '.miii', name)
    if (!existsSync(path)) continue
    const s = readJson(path)
    const hooks = (s.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    for (const [event, matchers] of Object.entries(hooks)) {
      for (const m of Array.isArray(matchers) ? matchers : []) {
        for (const h of Array.isArray(m?.hooks) ? m.hooks : []) {
          if (typeof h?.command === 'string') lines.push(`runs on ${event}: ${h.command}`)
        }
      }
    }
    const servers = (s.mcpServers ?? {}) as Record<string, { command?: string; args?: string[]; url?: string }>
    for (const [server, def] of Object.entries(servers)) {
      const what = def?.url ?? [def?.command, ...(Array.isArray(def?.args) ? def.args : [])].filter(Boolean).join(' ')
      lines.push(`starts MCP server "${server}": ${what}`)
    }
    const perms = (s.permissions ?? {}) as { allow?: unknown; defaultMode?: unknown }
    if (Array.isArray(perms.allow)) for (const rule of perms.allow) lines.push(`auto-allows ${String(rule)}`)
    if (typeof perms.defaultMode === 'string') lines.push(`starts in ${perms.defaultMode} mode`)
    const env = s.env && typeof s.env === 'object' ? Object.keys(s.env) : []
    if (env.length) lines.push(`sets env for every command: ${env.join(', ')}`)
  }
  const perms = readJson(join(cwd, '.miii', 'permissions.json'))
  if (Array.isArray(perms.rules)) {
    for (const r of perms.rules as Array<{ tool?: string; pattern?: string }>) {
      if (r?.tool) lines.push(`auto-allows ${r.tool}(${r.pattern ?? '*'})`)
    }
  }
  return lines
}

/** The stderr line for a mode that cannot ask — headless, `miii fix`, a non-TTY web start. */
export function untrustedNotice(cwd: string = process.cwd()): string | null {
  if (isProjectTrusted(cwd)) return null
  return (
    'miii: ignoring this project\'s .miii/ settings and permissions — the folder is not trusted yet. ' +
    'Run `miii` here once and answer yes to trust it.'
  )
}

/**
 * Ask on the terminal, before any UI owns it. Resolves to whether the folder is
 * trusted now. Never asks without a terminal — that is untrustedNotice()'s job.
 */
export async function confirmTrust(cwd: string = process.cwd()): Promise<boolean> {
  if (isProjectTrusted(cwd)) return true
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false
  const err = process.stderr
  err.write(`\n  This folder has its own miii config (.miii/) that you have not trusted yet:\n\n`)
  const lines = describeProjectConfig(cwd)
  for (const line of lines.length ? lines : ['(nothing that runs — permission rules or settings only)']) {
    err.write(`    • ${line}\n`)
  }
  err.write(`\n  Only trust it if you trust whoever wrote this repo. Without trust, miii\n`)
  err.write(`  ignores it and asks before every command and edit.\n\n`)
  const { createInterface } = await import('readline')
  const rl = createInterface({ input: process.stdin, output: err })
  const answer = await new Promise<string>((resolve) => {
    rl.question('  Trust this folder? [y/N] ', resolve)
    rl.once('close', () => resolve(''))
  })
  rl.close()
  const yes = /^y(es)?$/i.test(answer.trim())
  if (yes) trustProject(cwd)
  err.write(yes ? '  Trusted.\n\n' : '  Not trusted — project config ignored this session.\n\n')
  return yes
}
