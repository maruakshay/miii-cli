import { writeFileShell, readTextShell, existsShell } from './shellFs.js'
import { confinePath } from './paths.js'
import { verifyHint } from './verifyHint.js'
import { buildFileDiff } from '../diff.js'
import type { Tool } from './types.js'

interface Input {
  path: string
  content: string
}

export const write_file: Tool<Input> = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given content. Parent dirs auto-created.',
  input_schema: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  handler: ({ path, content }) => {
    try {
      const abs = confinePath(path)
      // Read before writing: overwriting an existing file is an edit, and the
      // user should see which lines it actually changed, not a wall of green.
      let before = ''
      try {
        if (existsShell(abs)) before = readTextShell(abs)
      } catch {
        before = ''
      }
      writeFileShell(abs, content)
      return {
        content: `Wrote ${path} (${content.length} bytes).${verifyHint(path)}`,
        diff: buildFileDiff(path, before, content),
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
  },
}
