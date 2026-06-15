/**
 * Session store — Claude Code-style persistent chat sessions.
 *
 * Sessions live globally under `~/.miii/projects/<encoded-cwd>/session/`,
 * keyed by the project directory (like Claude Code) so each project keeps its
 * own history without writing into the project tree. Each session is an
 * append-style JSONL file at `<dir>/<id>.jsonl`:
 *   line 1   → { type: 'meta', ...SessionMeta }
 *   line 2.. → { type: 'message', message: MiiMessage }
 *
 * Sessions auto-save every turn; the title is an LLM summary of the user's
 * first message; `/resume` lists and reloads them.
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { chat } from '../llm/client.js'
import type { MiiMessage } from '../agent/types.js'
import type { ChatMessage } from '../ui/types.js'

/** Encode the cwd into a single dir-safe segment, Claude Code-style. */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:/\\]+/g, '-').replace(/^-+/, '')
}

const SESSION_DIR = join(homedir(), '.miii', 'projects', encodeProjectDir(process.cwd()), 'session')

export interface SessionMeta {
  id: string
  createdAt: string
  updatedAt: string
  /** LLM one-line summary of the session; falls back to first user message. */
  title: string
  messageCount: number
}

type MetaLine = { type: 'meta' } & SessionMeta
type MessageLine = { type: 'message'; message: MiiMessage }

export function newSessionId(): string {
  return randomUUID()
}

function sessionPath(id: string): string {
  return join(SESSION_DIR, `${id}.jsonl`)
}

/** Flatten a MiiMessage's content (string or blocks) to plain text. */
function messageText(m: MiiMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content
    .map((b) => {
      if (b.type === 'text') return b.text
      if (b.type === 'tool_use') return `[tool ${b.name}]`
      if (b.type === 'tool_result') return '[result]'
      return ''
    })
    .join(' ')
}

function firstUserText(messages: MiiMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return 'untitled'
  return messageText(first).trim().slice(0, 80) || 'untitled'
}

/** Read just the meta line (first line) of a session file. */
function readMeta(id: string): SessionMeta | null {
  try {
    const raw = readFileSync(sessionPath(id), 'utf-8')
    const firstLine = raw.slice(0, raw.indexOf('\n') === -1 ? raw.length : raw.indexOf('\n'))
    const parsed = JSON.parse(firstLine) as MetaLine
    if (parsed.type !== 'meta') return null
    const { type: _t, ...meta } = parsed
    return meta
  } catch {
    return null
  }
}

/**
 * Persist the full history for a session, rewriting its JSONL file.
 * Preserves createdAt and any existing title across saves; pass `title` to
 * override with an LLM summary.
 */
export function persistSession(id: string, messages: MiiMessage[], title?: string): void {
  if (!messages.length) return
  mkdirSync(SESSION_DIR, { recursive: true })

  const existing = readMeta(id)
  const now = new Date().toISOString()
  const meta: SessionMeta = {
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    title: title ?? existing?.title ?? firstUserText(messages),
    messageCount: messages.length,
  }

  const lines: string[] = [JSON.stringify({ type: 'meta', ...meta } satisfies MetaLine)]
  for (const message of messages) {
    lines.push(JSON.stringify({ type: 'message', message } satisfies MessageLine))
  }
  writeFileSync(sessionPath(id), lines.join('\n') + '\n', 'utf-8')
}

/** All saved sessions, most-recently-updated first. */
export function listSessions(): SessionMeta[] {
  if (!existsSync(SESSION_DIR)) return []
  const metas: SessionMeta[] = []
  for (const file of readdirSync(SESSION_DIR)) {
    if (!file.endsWith('.jsonl')) continue
    const meta = readMeta(file.replace(/\.jsonl$/, ''))
    if (meta) metas.push(meta)
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Delete a session's JSONL file. No-op if it doesn't exist. */
export function deleteSession(id: string): void {
  try {
    rmSync(sessionPath(id), { force: true })
  } catch {
    /* best-effort */
  }
}

/** Load a session's full message history. */
export function loadSession(id: string): MiiMessage[] {
  try {
    const raw = readFileSync(sessionPath(id), 'utf-8')
    const messages: MiiMessage[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as MetaLine | MessageLine
      if (parsed.type === 'message') messages.push(parsed.message)
    }
    return messages
  } catch {
    return []
  }
}

/**
 * Rebuild display messages (ChatMessage[]) from agent history (MiiMessage[]).
 * Pairs assistant tool_use blocks with the tool_result blocks that follow in
 * the next user message, mirroring the live renderer.
 */
export function toDisplayMessages(history: MiiMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of history) {
    if (m.role === 'system') continue
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text' as const, text: m.content }]

    if (m.role === 'user') {
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const results = blocks.filter((b) => b.type === 'tool_result')
      if (results.length && out.length) {
        const last = out[out.length - 1]
        last.tool_results = [
          ...(last.tool_results ?? []),
          ...results.map((r) => ({
            tool_use_id: r.tool_use_id,
            content: r.content,
            is_error: r.is_error,
          })),
        ]
      }
      if (text.trim()) out.push({ role: 'user', content: text })
    } else {
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const uses = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }))
      out.push({
        role: 'assistant',
        content: text,
        tool_uses: uses.length ? uses : undefined,
      })
    }
  }
  return out
}

/**
 * Ask the model for a short title summarising the user's message.
 * Falls back to the truncated message text on error.
 */
export async function summarizeMessage(model: string, text: string): Promise<string> {
  const fallback = text.trim().slice(0, 80) || 'untitled'

  const prompt =
    'Summarize this user request as a short title, 3-6 words, no punctuation. ' +
    'Reply with the title only.\n\n' +
    `Request:\n${text.slice(0, 2000)}`

  try {
    let out = ''
    for await (const chunk of chat(
      model,
      [{ role: 'user', content: prompt }],
      undefined,
      { temperature: 0.2, num_predict: 32 },
    )) {
      if (chunk.content) out += chunk.content
    }
    return out.trim().split('\n').filter(Boolean)[0]?.trim() || fallback
  } catch {
    return fallback
  }
}
