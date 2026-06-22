import { execa } from 'execa'
import { statSync } from 'fs'
import { confinePath } from './paths.js'
import type { Tool } from './types.js'

// Sort newest-first; "what did I just touch" is the common intent.
// Files that vanish between listing and stat sink to the bottom.
function byMtimeDesc(paths: string[]): string[] {
  const mtime = new Map<string, number>()
  for (const p of paths) {
    try {
      mtime.set(p, statSync(p).mtimeMs)
    } catch {
      mtime.set(p, 0)
    }
  }
  return [...paths].sort((a, b) => (mtime.get(b) ?? 0) - (mtime.get(a) ?? 0))
}

interface Input {
  pattern: string
  path?: string
  max_results?: number
}

// Build `find` args approximating a glob, for machines without ripgrep.
// No slash after stripping a leading globstar -> match basename with -name.
// Slash remains (e.g. a "src" prefix) -> match full path with -path, globstar -> single star.
function globToFindArgs(root: string, glob: string): string[] {
  const stripped = glob.replace(/^\*\*\//, '')
  if (!stripped.includes('/')) {
    return [root, '-type', 'f', '-name', stripped]
  }
  const pathPat = '*/' + glob.replace(/\*\*/g, '*')
  return [root, '-type', 'f', '-path', pathPat]
}

export const glob: Tool<Input> = {
  name: 'glob',
  description: 'List files matching a glob pattern (e.g. "**/*.ts"). Uses ripgrep --files if available.',
  input_schema: {
    type: 'object',
    properties: {
      pattern:     { type: 'string', description: 'Glob pattern, e.g. "**/*.ts"' },
      path:        { type: 'string', description: 'Root path (default cwd)' },
      max_results: { type: 'number', description: 'Max paths returned (default 500)' },
    },
    required: ['pattern'],
  },
  handler: async ({ pattern, path, max_results }) => {
    let root: string
    try {
      root = confinePath(path ?? '.')
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
    const limit = max_results ?? 500

    const tryRg = () =>
      execa('rg', ['--files', '--hidden', '--glob', pattern, root], {
        reject: false,
        timeout: 20000,
      })

    const tryFind = () =>
      execa('find', globToFindArgs(root, pattern), {
        reject: false,
        timeout: 20000,
      })

    try {
      let res
      try {
        res = await tryRg()
        if (res.exitCode === 127 || (res.stderr ?? '').includes('command not found')) {
          res = await tryFind()
        }
      } catch {
        res = await tryFind()
      }
      const all = (res.stdout ?? '').split('\n').filter(Boolean)
      if (all.length === 0) return { content: 'No files matched.' }
      const lines = byMtimeDesc(all).slice(0, limit)
      return { content: lines.join('\n') }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
  },
}
