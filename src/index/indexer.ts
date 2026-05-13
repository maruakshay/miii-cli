import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, relative, extname } from 'path'
import type { Config } from '../types.js'
import { embed } from './embedder.js'
import { saveIndex } from './store.js'
import type { Chunk } from './store.js'

const CHUNK_LINES = 40
const MAX_FILE_BYTES = 80_000

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt', '.svelte-kit',
  'out', '__pycache__', '.cache', 'coverage', 'vendor', 'target', '.turbo',
  '.vercel', 'generated', '.expo', 'tmp', 'temp', 'logs',
])

const INDEX_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.sh',
  '.css', '.scss', '.html', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.md', '.sql', '.graphql',
])

const SKIP_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'poetry.lock', 'Gemfile.lock', '.DS_Store',
])

function collectFiles(dir: string, cwd: string): string[] {
  const out: string[] = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const abs = join(dir, name)
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) {
      out.push(...collectFiles(abs, cwd))
    } else if (st.isFile()) {
      if (SKIP_NAMES.has(name)) continue
      if (!INDEX_EXTS.has(extname(name).toLowerCase())) continue
      if (st.size > MAX_FILE_BYTES) continue
      out.push(abs)
    }
  }
  return out
}

function chunkFile(absPath: string, cwd: string): Array<{ start: number; end: number; text: string }> {
  let content: string
  try { content = readFileSync(absPath, 'utf-8') } catch { return [] }
  if (!content.trim()) return []

  const rel = relative(cwd, absPath)
  const lines = content.split('\n')
  const chunks: Array<{ start: number; end: number; text: string }> = []

  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const end = Math.min(i + CHUNK_LINES, lines.length) - 1
    const body = lines.slice(i, end + 1).join('\n').trim()
    if (!body) continue
    chunks.push({ start: i, end, text: `// ${rel}\n${body}` })
  }

  return chunks
}

export interface IndexProgress {
  file: string
  done: number
  total: number
}

export interface IndexResult {
  indexed: number
  skipped: number
  files: number
}

export async function buildIndex(
  config: Config,
  cwd: string,
  onProgress?: (p: IndexProgress) => void,
): Promise<IndexResult> {
  const embedModel = config.embedModel ?? 'nomic-embed-text'
  const files = collectFiles(cwd, cwd)
  const chunks: Chunk[] = []
  let skipped = 0

  for (let fi = 0; fi < files.length; fi++) {
    const abs = files[fi]
    const rel = relative(cwd, abs)
    onProgress?.({ file: rel, done: fi, total: files.length })

    for (const c of chunkFile(abs, cwd)) {
      try {
        const vec = await embed(config.baseUrl, embedModel, c.text)
        chunks.push({ file: rel, start: c.start, end: c.end, text: c.text, vec })
      } catch {
        skipped++
      }
    }
  }

  saveIndex(cwd, chunks)
  return { indexed: chunks.length, skipped, files: files.length }
}
