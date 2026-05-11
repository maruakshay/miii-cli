import { readFile, writeFile, deleteFile, listFiles, createDir, moveFile, guardPath } from '../files/ops.js'
import { existsSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { getTavilyKey, tavilySearch, tavilyExtract } from '../tavily/client.js'

const run = promisify(exec)
const EXEC_TIMEOUT_MS = 30_000

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
      try { return readFile(guardPath(path as string)) }
      catch (e) { throw new Error(`read_file: ${e}`) }
    },
  },
  {
    name: 'list_files',
    description: 'List directory contents',
    params: '{"path": "string", "recursive": "boolean (optional)"}',
    execute: async ({ path, recursive = false }) => {
      const entries = listFiles(guardPath(path as string), recursive as boolean)
      if (!entries.length) return '(empty)'
      return entries.map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.rel}`).join('\n')
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file — fails if file already exists',
    params: '{"path": "string", "content": "string"}',
    execute: async ({ path, content }) => {
      const safe = guardPath(path as string)
      if (existsSync(safe)) throw new Error(`file already exists: ${path}`)
      writeFile(safe, content as string)
      return `created: ${path}`
    },
  },
  {
    name: 'edit_file',
    description: 'Overwrite entire file — use only for new files or full rewrites',
    params: '{"path": "string", "content": "string"}',
    execute: async ({ path, content }) => {
      writeFile(guardPath(path as string), content as string)
      return `written: ${path}`
    },
  },
  {
    name: 'patch_file',
    description: 'Replace an exact string in a file — use for targeted edits to existing files',
    params: '{"path": "string", "old": "string", "new": "string"}',
    execute: async ({ path, old: oldStr, new: newStr }) => {
      const safe = guardPath(path as string)
      const current = readFile(safe)
      if (!current) throw new Error(`file not found or empty: ${path}`)
      const old = oldStr as string
      const count = current.split(old).length - 1
      if (count === 0) throw new Error(`old text not found in ${path}`)
      if (count > 1) throw new Error(`ambiguous: ${count} matches found in ${path} — add more surrounding context to make unique`)
      writeFile(safe, current.replace(old, newStr as string))
      return `patched: ${path}`
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file',
    params: '{"path": "string"}',
    execute: async ({ path }) => {
      deleteFile(guardPath(path as string))
      return `deleted: ${path}`
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in cwd',
    params: '{"command": "string"}',
    execute: async ({ command }) => {
      const { stdout, stderr } = await run(command as string, { cwd: process.cwd(), timeout: EXEC_TIMEOUT_MS })
      return [stdout, stderr ? `stderr: ${stderr}` : ''].filter(Boolean).join('\n').trim()
    },
  },
  {
    name: 'create_folder',
    description: 'Create a directory (and any missing parents)',
    params: '{"path": "string"}',
    execute: async ({ path }) => {
      createDir(guardPath(path as string))
      return `created: ${path}`
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory',
    params: '{"from": "string", "to": "string"}',
    execute: async ({ from, to }) => {
      moveFile(guardPath(from as string), guardPath(to as string))
      return `moved: ${from} → ${to}`
    },
  },
  {
    name: 'git_status',
    description: 'Show git working tree status',
    params: '{}',
    execute: async () => {
      try {
        const { stdout } = await run('git status --short', { timeout: EXEC_TIMEOUT_MS })
        return stdout.trim() || '(clean — no changes)'
      } catch (e) { throw new Error(`git_status: ${e}`) }
    },
  },
  {
    name: 'git_diff',
    description: 'Show git diff. staged=true for staged changes, path for specific file',
    params: '{"staged": "boolean (optional)", "path": "string (optional)"}',
    execute: async ({ staged = false, path = '' }) => {
      const args = staged ? '--staged' : ''
      const target = path ? `-- "${path}"` : ''
      try {
        const { stdout } = await run(`git diff ${args} ${target}`.trim(), { timeout: EXEC_TIMEOUT_MS })
        const out = stdout.trim()
        if (!out) return '(no diff)'
        return out.length > 8000 ? out.slice(0, 8000) + '\n…[diff truncated at 8k chars]' : out
      } catch (e) { throw new Error(`git_diff: ${e}`) }
    },
  },
  {
    name: 'git_log',
    description: 'Show recent git commits',
    params: '{"n": "number (optional, default 10)"}',
    execute: async ({ n = 10 }) => {
      try {
        const { stdout } = await run(`git log --oneline -${Math.min(Number(n), 50)}`, { timeout: EXEC_TIMEOUT_MS })
        return stdout.trim() || '(no commits)'
      } catch (e) { throw new Error(`git_log: ${e}`) }
    },
  },
  {
    name: 'git_commit',
    description: 'Stage files and create a git commit. Use files="-A" to stage all.',
    params: '{"message": "string", "files": "string (optional, default -A)"}',
    execute: async ({ message, files = '-A' }) => {
      if (!message) throw new Error('git_commit: message required')
      try {
        await run(`git add ${files}`, { timeout: EXEC_TIMEOUT_MS })
        const { stdout } = await run(`git commit -m ${JSON.stringify(String(message))}`, { timeout: EXEC_TIMEOUT_MS })
        return stdout.trim()
      } catch (e) { throw new Error(`git_commit: ${e}`) }
    },
  },
  {
    name: 'run_tests',
    description: 'Run the test suite. Detects jest/vitest/mocha from package.json scripts.test. Pass path to run a specific file.',
    params: '{"path": "string (optional)"}',
    execute: async ({ path = '' }) => {
      const pkgPath = join(process.cwd(), 'package.json')
      if (!existsSync(pkgPath)) return '(no package.json found)'
      let testScript = ''
      try {
        const pkg = JSON.parse(readFile(pkgPath))
        testScript = pkg?.scripts?.test ?? ''
      } catch { return '(could not parse package.json)' }
      if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') {
        return '(no test script configured in package.json)'
      }
      const cmd = path ? `npm test -- ${path}` : 'npm test'
      try {
        const { stdout, stderr } = await run(cmd, { cwd: process.cwd(), timeout: 60_000 })
        const out = (stdout + (stderr ? '\nstderr: ' + stderr : '')).trim()
        return out.length > 4000 ? '…[truncated]\n' + out.slice(-4000) : out
      } catch (e: any) {
        const out = ((e.stdout ?? '') + (e.stderr ? '\n' + e.stderr : '') || String(e)).trim()
        return out.length > 4000 ? '…[truncated]\n' + out.slice(-4000) : out
      }
    },
  },
  {
    name: 'web_search',
    description: 'Search the web using Tavily. Returns relevant results and a direct answer.',
    params: '{"query": "string", "max_results": "number (optional, 1-10, default 5)", "search_depth": "string (optional: basic|advanced)", "include_domains": "string[] (optional)", "exclude_domains": "string[] (optional)"}',
    execute: async ({ query, max_results, search_depth, include_domains, exclude_domains }) => {
      const key = getTavilyKey()
      if (!key) throw new Error('Tavily API key not set — user must run /tavily-key <key> first')
      return tavilySearch({
        apiKey: key,
        query: String(query),
        maxResults: typeof max_results === 'number' ? max_results : undefined,
        searchDepth: search_depth as 'basic' | 'advanced' | undefined,
        includeDomains: include_domains as string[] | undefined,
        excludeDomains: exclude_domains as string[] | undefined,
      })
    },
  },
  {
    name: 'web_extract',
    description: 'Extract and scrape full content from one or more URLs using Tavily.',
    params: '{"urls": "string[]"}',
    execute: async ({ urls }) => {
      const key = getTavilyKey()
      if (!key) throw new Error('Tavily API key not set — user must run /tavily-key <key> first')
      const list = Array.isArray(urls) ? urls : [String(urls)]
      return tavilyExtract({ apiKey: key, urls: list })
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

Put file content in named blocks (never inside JSON — avoids escaping errors):

For edit_file / create_file use <content> block:
<tool_call>
{"name": "edit_file", "args": {"path": "src/foo.ts"}}
<content>
full file content here
</content>
</tool_call>

For patch_file use <old> and <new> blocks:
<tool_call>
{"name": "patch_file", "args": {"path": "src/foo.ts"}}
<old>
exact text to replace
</old>
<new>
replacement text
</new>
</tool_call>

Tools:
${toolDocs}

Rules:
- To modify an existing file: use patch_file with the exact old text and new replacement — do NOT rewrite the whole file
- To create a new file: use edit_file with full content in the <content> block
- read_file before patch_file so you know the exact text to match
- Never delete without confirming
- Use git_status and git_diff before any refactor to understand what has already changed
- Use git_log to understand recent history before suggesting changes
- Always call git_status before git_commit to verify what will be staged
- Be concise
- Output plain text only — never use markdown formatting in your responses
- No headers (no #, ##), no bold (**text**), no italic (*text*), no bullet points with *, no horizontal rules (---)
- NEVER show file content or code in your text response — always use edit_file, patch_file, or create_file tools to write code to files
- If you want to show the user code, write it to the file with a tool call instead
- No fenced code blocks (no \`\`\`). If you find yourself about to write a code block, use a tool call instead
- Use plain indentation and labels for structure. This is a terminal, not a chat UI
- After editing files that have tests, call run_tests to verify nothing broke
- If run_tests fails, read the failing test output and fix the code, then run_tests again (max 3 retries)
- You have web_search and web_extract tools — use them whenever the user asks about anything requiring internet access, current information, documentation, library versions, news, or external URLs
- NEVER say you cannot search the web — always call web_search instead${extra}`
}
