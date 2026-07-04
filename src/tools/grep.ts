import { execa } from 'execa'
import { confinePath } from './paths.js'
import type { Tool } from './types.js'

interface Input {
  pattern: string
  path?: string
  glob?: string
  case_insensitive?: boolean
  max_results?: number
  context?: number
  files_only?: boolean
  type?: string
  multiline?: boolean
  count?: boolean
  fixed_strings?: boolean
}

const bool = (v: unknown) => v === true || String(v) === 'true'

export const grep: Tool<Input> = {
  name: 'grep',
  description: 'Search file contents for a regex pattern. Uses ripgrep if available, falls back to grep -R.',
  input_schema: {
    type: 'object',
    properties: {
      pattern:          { type: 'string', description: 'Regex pattern (literal when fixed_strings)' },
      path:             { type: 'string', description: 'Root path to search (default cwd)' },
      glob:             { type: 'string', description: 'File glob filter, e.g. "*.ts"' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive match' },
      max_results:      { type: 'number', description: 'Max matching lines (default 200)' },
      context:          { type: 'number', description: 'Lines of context before & after each match' },
      files_only:       { type: 'boolean', description: 'List matching filenames only' },
      type:             { type: 'string', description: 'ripgrep file type filter, e.g. "js" (ignored by grep fallback)' },
      multiline:        { type: 'boolean', description: 'Allow matches to span multiple lines' },
      count:            { type: 'boolean', description: 'Print count of matching lines per file' },
      fixed_strings:    { type: 'boolean', description: 'Treat pattern as literal string, not regex' },
    },
    required: ['pattern'],
  },
  handler: async ({
    pattern, path, glob, case_insensitive, max_results,
    context, files_only, type, multiline, count, fixed_strings,
  }) => {
    let root: string
    try {
      root = confinePath(path ?? '.')
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
    const limit = max_results ?? 200
    const ci = bool(case_insensitive)
    const filesOnly = bool(files_only)
    const ml = bool(multiline)
    const cnt = bool(count)
    const fixed = bool(fixed_strings)
    const ctx = typeof context === 'number' && context > 0 ? Math.floor(context) : 0

    const tryRg = async () => {
      const args = ['--line-number', '--no-heading', '--color=never', '-m', String(limit)]
      if (ci) args.push('-i')
      if (fixed) args.push('-F')
      if (glob) args.push('--glob', glob)
      if (type) args.push('-t', type)
      if (ctx) args.push('-C', String(ctx))
      if (ml) args.push('-U', '--multiline-dotall')
      if (filesOnly) args.push('-l')
      if (cnt) args.push('-c')
      args.push('--', pattern, root)
      return execa('rg', args, { reject: false, timeout: 20000 })
    }
    const tryGrep = async () => {
      const args = ['-R', '-n', '--color=never']
      if (ci) args.push('-i')
      if (fixed) args.push('-F')
      if (glob) args.push('--include', glob)
      if (ctx) args.push('-C', String(ctx))
      if (filesOnly) args.push('-l')
      if (cnt) args.push('-c')
      args.push('--', pattern, root)
      return execa('grep', args, { reject: false, timeout: 20000 })
    }

    const missing = (err: unknown) =>
      (err as { code?: string })?.code === 'ENOENT' ||
      (err as { errno?: string })?.errno === 'ENOENT'

    try {
      let res
      try {
        res = await tryRg()
        if (res.exitCode === 127 || (res.stderr ?? '').includes('command not found')) {
          res = await tryGrep()
        }
      } catch (err) {
        if (!missing(err)) throw err
        res = await tryGrep()
      }
      const lines = (res.stdout ?? '').split('\n').slice(0, limit)
      const out = lines.join('\n')
      const code = res.exitCode ?? 0
      const noMatch = `Nothing matched "${pattern}". Try a looser pattern, case_insensitive, or a wider path.`
      if (!out && code === 1) return { content: noMatch }
      return { content: out || res.stderr || noMatch, is_error: code > 1 }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
  },
}
