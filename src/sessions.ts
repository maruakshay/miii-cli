import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ChatMessage } from './types.js'

const SESSIONS_DIR = join(homedir(), '.config', 'miii', 'sessions')

function ensureDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true })
}

function sanitizeName(name: string): string {
  if (!/^[\w-]+$/.test(name)) throw new Error(`invalid session name: ${name}`)
  return name
}

export function listSessions(): Array<{ name: string; messageCount: number; updatedAt: number }> {
  ensureDir()
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const name = f.replace('.json', '')
      const p = join(SESSIONS_DIR, f)
      let messageCount = 0
      let updatedAt = 0
      try {
        updatedAt = statSync(p).mtimeMs
        const msgs = JSON.parse(readFileSync(p, 'utf-8'))
        messageCount = Array.isArray(msgs) ? msgs.length : 0
      } catch {}
      return { name, messageCount, updatedAt }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadSession(name: string): ChatMessage[] {
  ensureDir()
  const p = join(SESSIONS_DIR, `${sanitizeName(name)}.json`)
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function saveSession(name: string, messages: ChatMessage[]) {
  ensureDir()
  writeFileSync(join(SESSIONS_DIR, `${sanitizeName(name)}.json`), JSON.stringify(messages))
}

export function deleteSession(name: string) {
  const p = join(SESSIONS_DIR, `${sanitizeName(name)}.json`)
  if (existsSync(p)) unlinkSync(p)
}
