/**
 * User-defined slash commands.
 *
 * A Markdown file is a command: `.miii/commands/review.md` becomes `/review`,
 * and running it sends the file's body as the prompt. That is the whole idea —
 * the prompts you retype every week become part of the project instead of
 * living in your shell history.
 *
 *   <cwd>/.miii/commands/*.md   project scope — checked in, shared with the team
 *   ~/.miii/commands/*.md       user scope — yours, in every project
 *
 * A project command shadows a user command of the same name, so a repo can
 * override a personal default rather than collide with it.
 *
 * Optional YAML-ish frontmatter sets the palette description; everything after
 * it is the prompt:
 *
 *   ---
 *   description: review the staged diff
 *   ---
 *   Review the staged diff for bugs. Focus on $ARGUMENTS.
 *
 * Arguments: `$ARGUMENTS` is everything typed after the command name, and
 * `$1`…`$9` are its whitespace-separated words. A command with no placeholder
 * gets the arguments appended, so `/review src/a.ts` is never silently dropped.
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

export type CommandScope = 'project' | 'user'

export interface CustomCommand {
  /** Slash-prefixed, e.g. "/review". */
  name: string
  description: string
  /** The prompt body, before argument substitution. */
  body: string
  scope: CommandScope
  source: string
}

/** Only sane command names — the palette matches on these by prefix. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i

/** A command file bigger than this is a mistake, not a prompt. */
const MAX_BYTES = 64 * 1024

function commandsDir(scope: CommandScope, cwd: string): string {
  return scope === 'user'
    ? join(homedir(), '.miii', 'commands')
    : join(cwd, '.miii', 'commands')
}

/**
 * Split leading `---` frontmatter off the body. Deliberately not a YAML parser:
 * the only key that means anything is `description`, and a command file that
 * fails to parse should still run rather than vanish from the palette.
 */
export function parseFrontmatter(text: string): { description?: string; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { body: normalized.trim() }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { body: normalized.trim() }
  const head = normalized.slice(4, end)
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1)
  let description: string | undefined
  for (const line of head.split('\n')) {
    const m = /^\s*description\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    description = m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return { ...(description ? { description } : {}), body: body.trim() }
}

/** First non-empty line of the body, clipped — the fallback palette description. */
function summarize(body: string): string {
  const line = body.split('\n').find((l) => l.trim()) ?? ''
  const clean = line.replace(/^#+\s*/, '').trim()
  return clean.length > 60 ? clean.slice(0, 59) + '…' : clean || 'custom command'
}

function loadScope(scope: CommandScope, cwd: string): CustomCommand[] {
  const dir = commandsDir(scope, cwd)
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const out: CustomCommand[] = []
  for (const file of files.sort()) {
    const stem = basename(file, file.slice(file.lastIndexOf('.')))
    if (!NAME_RE.test(stem)) continue
    const source = join(dir, file)
    let raw: string
    try {
      raw = readFileSync(source, 'utf-8')
    } catch {
      continue
    }
    if (raw.length > MAX_BYTES) continue
    const { description, body } = parseFrontmatter(raw)
    if (!body) continue
    out.push({
      name: `/${stem.toLowerCase()}`,
      description: description || summarize(body),
      body,
      scope,
      source,
    })
  }
  return out
}

/**
 * Every custom command in force, project first. Callers rely on that order for
 * shadowing, so it is part of the contract rather than an accident of reading.
 */
export function loadCustomCommands(cwd: string = process.cwd()): CustomCommand[] {
  const project = loadScope('project', cwd)
  const taken = new Set(project.map((c) => c.name))
  const user = loadScope('user', cwd).filter((c) => !taken.has(c.name))
  return [...project, ...user]
}

/**
 * Cached view of loadCustomCommands, because the palette re-filters on every
 * keystroke and each call is a directory read. Dropped whenever a command could
 * have changed underneath us — see invalidateCustomCommands.
 */
let cache: CustomCommand[] | null = null

export function customCommands(cwd: string = process.cwd()): CustomCommand[] {
  if (!cache) cache = loadCustomCommands(cwd)
  return cache
}

/** Forget the cache — called when the palette opens, so an edit shows up. */
export function invalidateCustomCommands(): void {
  cache = null
}

export function findCustomCommand(name: string, cwd?: string): CustomCommand | undefined {
  return customCommands(cwd).find((c) => c.name === name.toLowerCase())
}

/**
 * Substitute the typed arguments into a command body.
 *
 * `$ARGUMENTS` takes the whole argument string and `$1`…`$9` take individual
 * words; an unfilled positional becomes empty rather than staying as literal
 * `$3`, which the model would otherwise treat as text to reason about. When the
 * body references no placeholder at all, the arguments are appended — typing
 * them and having them silently disappear is the worse failure.
 */
export function expandCommand(body: string, args: string): string {
  const argv = args.trim() ? args.trim().split(/\s+/) : []
  const hasPlaceholder = /\$ARGUMENTS\b|\$[1-9]\b/.test(body)
  const filled = body
    .replace(/\$ARGUMENTS\b/g, args.trim())
    .replace(/\$([1-9])\b/g, (_, d: string) => argv[Number(d) - 1] ?? '')
    .replace(/[ \t]+$/gm, '')
  if (hasPlaceholder || !args.trim()) return filled.trim()
  return `${filled.trim()}\n\n${args.trim()}`
}
