import { workerData, parentPort } from 'worker_threads'
import { readFileSync, statSync, readdirSync, existsSync } from 'fs'
import { join, relative, extname } from 'path'

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt', '.svelte-kit',
  'out', '__pycache__', '.cache', 'coverage', '.nyc_output', 'vendor',
  'target', '.turbo', '.vercel', 'generated', '.gradle', '.expo',
  'bin', 'obj', 'tmp', 'temp', 'logs',
])
const SKIP_EXTS = new Set(['.map', '.lock', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.mp3', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.pyc', '.ttf', '.woff', '.woff2'])

interface Input {
  paths: string[]
  cwd: string
}

function safe(p: string): string | null {
  try {
    const s = statSync(p)
    if (s.size > 512 * 1024) return null
    return readFileSync(p, 'utf-8')
  } catch { return null }
}

function walk(dir: string, out: string[], cwd: string, depth = 0): void {
  if (depth > 4) return
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    if (SKIP_DIRS.has(name)) continue
    if (SKIP_EXTS.has(extname(name))) continue
    if (name.endsWith('.d.ts') || name.endsWith('.js.map')) continue
    const full = join(dir, name)
    try {
      const s = statSync(full)
      if (s.isDirectory()) walk(full, out, cwd, depth + 1)
      else out.push(full)
    } catch {}
  }
}

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function build(input: Input): string {
  const parts: string[] = []
  for (const p of input.paths) {
    if (!existsSync(p)) continue
    const s = statSync(p)
    if (s.isFile()) {
      const content = safe(p)
      if (content !== null) parts.push(`<file path="${xmlAttr(relative(input.cwd, p))}">\n${content}\n</file>`)
    } else if (s.isDirectory()) {
      const files: string[] = []
      walk(p, files, input.cwd)
      for (const f of files.slice(0, 100)) {
        const content = safe(f)
        if (content !== null) parts.push(`<file path="${xmlAttr(relative(input.cwd, f))}">\n${content}\n</file>`)
      }
    }
  }
  return parts.join('\n\n')
}

parentPort?.postMessage({ context: build(workerData as Input) })
