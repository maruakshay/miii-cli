import {
  readFileSync, writeFileSync, unlinkSync,
  mkdirSync, readdirSync, statSync, existsSync, renameSync,
} from 'fs'
import { join, dirname, relative, extname, resolve, sep } from 'path'

export function guardPath(p: string, base = process.cwd()): string {
  const abs = resolve(base, p)
  const root = resolve(base)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path outside working directory: ${p}`)
  }
  return abs
}

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

function loadIgnorePatterns(cwd: string): Set<string> {
  const p = join(cwd, '.miiiignore')
  if (!existsSync(p)) return new Set()
  return new Set(
    readFileSync(p, 'utf-8').split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  )
}

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

export function listFiles(dir: string, recursive = false, cwd = process.cwd(), _ignore?: Set<string>): FileEntry[] {
  if (!existsSync(dir)) return []
  const ignore = _ignore ?? loadIgnorePatterns(cwd)
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
    const rel = relative(cwd, full)
    const type = stat.isDirectory() ? 'dir' : 'file'
    // check ignore patterns: match by name, rel path, or name/ for dirs
    if (ignore.size) {
      const dirSuffix = type === 'dir' ? name + '/' : ''
      if (ignore.has(name) || ignore.has(rel) || (dirSuffix && ignore.has(dirSuffix))) continue
      // *.ext pattern
      if ([...ignore].some(p => p.startsWith('*.') && name.endsWith(p.slice(1)))) continue
    }
    entries.push({ name, path: full, rel, type, size: stat.isFile() ? stat.size : undefined })
    if (recursive && type === 'dir') {
      entries.push(...listFiles(full, true, cwd, ignore))
    }
  }
  return entries
}
