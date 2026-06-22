import { execa } from 'execa'
import { confinePath } from './paths.js'
import type { Tool } from './types.js'

interface Input {
  pattern: string
  path?: string
  glob?: string
  case_insensitive?: boolean
  max_results?: number
}

export const grep: Tool<Input> = {
  name: 'grep',
  description: 'Search file contents for a regex pattern. Uses ripgrep if available, falls back to grep -R.',
  input_schema: {
    type: 'object',
    properties: {
      pattern:          { type: 'string', description: 'Regex pattern' },
      path:             { type: 'string', description: 'Root path to search (default cwd)' },
      glob:             { type: 'string', description: 'File glob filter, e.g. "*.ts"' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive match' },
      max_results:      { type: 'number', description: 'Max matching lines (default 200)' },
    },
    required: ['pattern'],
  },
  handler: async ({ pattern, path, glob, case_insensitive, max_results }) => {
    let root: string
    try {
      root = confinePath(path ?? '.')
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
    const limit = max_results ?? 200
    const ci = case_insensitive === true || String(case_insensitive) === 'true'

    const tryRg = async () => {
      const args = ['--line-number', '--no-heading', '--color=never', '-m', String(limit)]
      if (ci) args.push('-i')
      if (glob) args.push('--glob', glob)
      args.push('--', pattern, root)
      return execa('rg', args, { reject: false, timeout: 20000 })
    }
    const tryGrep = async () => {
      const args = ['-R', '-n', '--color=never']
      if (ci) args.push('-i')
      if (glob) args.push('--include', glob)
      args.push('--', pattern, root)
      return execa('grep', args, { reject: false, timeout: 20000 })
    }

    try {
      let res
      try {
        res = await tryRg()
        if (res.exitCode === 127 || (res.stderr ?? '').includes('command not found')) {
          res = await tryGrep()
        }
      } catch {
        res = await tryGrep()
      }
      const lines = (res.stdout ?? '').split('\n').slice(0, limit)
      const out = lines.join('\n')
      const code = res.exitCode ?? 0
      if (!out && code === 1) return { content: 'No matches.' }
      return { content: out || res.stderr || 'No matches.', is_error: code > 1 }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
  },
}
