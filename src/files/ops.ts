import {
  readFileSync, writeFileSync, unlinkSync,
  mkdirSync, readdirSync, statSync, existsSync, renameSync,
} from 'fs'
import { join, dirname, relative, extname } from 'path'

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt', '.svelte-kit',
  'out', '__pycache__', '.cache', 'coverage', '.nyc_output', 'vendor',
  'target', '.turbo', '.vercel', 'generated', '.gradle', '.expo',
  'bin', 'obj', '.idea', '.vscode', 'tmp', 'temp', 'logs',
])

const SKIP_EXTS = new Set([
  '.map', '.lock',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.mp4', '.mp3', '.wav', '.ogg', '.pdf',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.pyc',
  '.ttf', '.woff', '.woff2', '.eot',
])

const SKIP_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'poetry.lock', 'Gemfile.lock', 'composer.lock',
  '.DS_Store', 'Thumbs.db', '.env.local', 'LICENSE', 'LICENSE.md',
])

export function readFile(p: string): string {
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf-8')
}

export function writeFile(p: string, content: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
}

export function deleteFile(p: string): void {
  unlinkSync(p)
}

export function createDir(p: string): void {
  mkdirSync(p, { recursive: true })
}

export function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}

export interface FileEntry {
  name: string
  path: string
  rel: string
  type: 'file' | 'dir'
  size?: number
}

export function listFiles(dir: string, recursive = false, cwd = process.cwd()): FileEntry[] {
  if (!existsSync(dir)) return []
  const entries: FileEntry[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    if (SKIP_NAMES.has(name)) continue
    if (SKIP_DIRS.has(name)) continue
    const ext = extname(name)
    if (SKIP_EXTS.has(ext)) continue
    if (name.endsWith('.d.ts') || name.endsWith('.js.map')) continue
    let stat
    try { stat = statSync(join(dir, name)) } catch { continue }
    const full = join(dir, name)
    const type = stat.isDirectory() ? 'dir' : 'file'
    entries.push({ name, path: full, rel: relative(cwd, full), type, size: stat.isFile() ? stat.size : undefined })
    if (recursive && type === 'dir') {
      entries.push(...listFiles(full, true, cwd))
    }
  }
  return entries
}
