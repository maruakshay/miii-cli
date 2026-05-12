import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const MEMORY_DIR = join(homedir(), '.config', 'miii', 'memory')
const MAX_FACTS = 200

export interface MemoryFact {
  text: string
  ts: number
}

function ensureDir() {
  mkdirSync(MEMORY_DIR, { recursive: true })
}

export function loadLongMemory(sessionName: string): MemoryFact[] {
  ensureDir()
  const p = join(MEMORY_DIR, `${sessionName}.json`)
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function saveLongMemory(sessionName: string, facts: MemoryFact[]) {
  ensureDir()
  writeFileSync(join(MEMORY_DIR, `${sessionName}.json`), JSON.stringify(facts))
}

export function mergeFacts(existing: MemoryFact[], newTexts: string[]): MemoryFact[] {
  const existingSet = new Set(existing.map(f => f.text.toLowerCase()))
  const ts = Date.now()
  const added = newTexts
    .filter(t => t.trim() && !existingSet.has(t.toLowerCase()))
    .map(text => ({ text, ts }))
  const merged = [...existing, ...added]
  if (merged.length > MAX_FACTS) merged.splice(0, merged.length - MAX_FACTS)
  return merged
}

export function formatMemoryBlock(facts: MemoryFact[]): string {
  if (!facts.length) return ''
  return `\n\n[Long-term memory — recalled from prior conversation]\n${facts.map(f => `- ${f.text}`).join('\n')}`
}
