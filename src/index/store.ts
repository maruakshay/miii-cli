import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const INDEX_DIR = join(homedir(), '.config', 'miii', 'indexes')

export interface Chunk {
  file: string
  start: number
  end: number
  text: string
  vec: number[]
}

function cwdKey(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}

export function indexPath(cwd: string): string {
  return join(INDEX_DIR, `${cwdKey(cwd)}.jsonl`)
}

export function loadIndex(cwd: string): Chunk[] {
  const p = indexPath(cwd)
  if (!existsSync(p)) return []
  try {
    return readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Chunk)
  } catch { return [] }
}

export function saveIndex(cwd: string, chunks: Chunk[]): void {
  mkdirSync(INDEX_DIR, { recursive: true })
  writeFileSync(indexPath(cwd), chunks.map(c => JSON.stringify(c)).join('\n'))
}

export function indexStats(cwd: string): { count: number; sizeKb: number; mtime: number } | null {
  const p = indexPath(cwd)
  if (!existsSync(p)) return null
  try {
    const st = statSync(p)
    const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    return { count: lines.length, sizeKb: Math.round(st.size / 1024), mtime: st.mtimeMs }
  } catch { return null }
}

export function clearIndex(cwd: string): void {
  const p = indexPath(cwd)
  if (existsSync(p)) unlinkSync(p)
}
