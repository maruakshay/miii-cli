import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const MAX_FACTS = 200

export interface MemoryFact {
  text: string
  ts: number
}

function memoryPath(projectDir: string): string {
  return join(projectDir, 'memory.json')
}

export function loadLongMemory(projectDir: string): MemoryFact[] {
  mkdirSync(projectDir, { recursive: true })
  const p = memoryPath(projectDir)
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function saveLongMemory(projectDir: string, facts: MemoryFact[]) {
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(memoryPath(projectDir), JSON.stringify(facts))
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
  return `\n\n[Long-term memory — recalled from prior sessions in this project]\n${facts.map(f => `- ${f.text}`).join('\n')}`
}
