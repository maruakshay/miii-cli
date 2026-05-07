import { readFile, writeFile, deleteFile, listFiles, createDir, moveFile } from '../files/ops.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const run = promisify(exec)

export interface Tool {
  name: string
  description: string
  params: string
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const tools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read file contents',
    params: '{"path": "string"}',
    execute: async ({ path }) => {
      try { return readFile(path as string) }
      catch (e) { throw new Error(`read_file: ${e}`) }
    },
  },
  {
    name: 'list_files',
    description: 'List directory contents',
    params: '{"path": "string", "recursive": "boolean (optional)"}',
    execute: async ({ path, recursive = false }) => {
      const entries = listFiles(path as string, recursive as boolean)
      if (!entries.length) return '(empty)'
      return entries.map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.rel}`).join('\n')
    },
  },
  {
    name: 'edit_file',
    description: 'Write/overwrite file content',
    params: '{"path": "string", "content": "string"}',
    execute: async ({ path, content }) => {
      writeFile(path as string, content as string)
      return `written: ${path}`
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file',
    params: '{"path": "string"}',
    execute: async ({ path }) => {
      deleteFile(path as string)
      return `deleted: ${path}`
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in cwd',
    params: '{"command": "string"}',
    execute: async ({ command }) => {
      const { stdout, stderr } = await run(command as string, { cwd: process.cwd() })
      return [stdout, stderr ? `stderr: ${stderr}` : ''].filter(Boolean).join('\n').trim()
    },
  },
  {
    name: 'create_folder',
    description: 'Create a directory (and any missing parents)',
    params: '{"path": "string"}',
    execute: async ({ path }) => {
      createDir(path as string)
      return `created: ${path}`
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory',
    params: '{"from": "string", "to": "string"}',
    execute: async ({ from, to }) => {
      moveFile(from as string, to as string)
      return `moved: ${from} → ${to}`
    },
  },
]

export function getSystemPrompt(extra = ''): string {
  const toolDocs = tools.map(t => `- ${t.name}(${t.params}): ${t.description}`).join('\n')
  return `You are Miii — a fast, local AI coding assistant.

Use tools by emitting:
<tool_call>
{"name": "tool_name", "args": {...}}
</tool_call>

Tools:
${toolDocs}

Rules:
- Read existing files before editing them
- For new files that do not exist yet, call edit_file directly — do not read first
- read_file returns empty string for missing files, so a blank result means the file is new
- Show the full content when creating or editing
- Never delete without confirming
- Be concise
- Output plain text only — no markdown, no headers, no bold/italic, no bullet points with *, no fenced code blocks with backticks. Use indentation and plain labels instead. This is a CLI terminal, not a chat UI${extra}`
}
