import { readFile, writeFile, deleteFile, listFiles, createDir, moveFile, guardPath } from '../files/ops.js'
import { existsSync } from 'fs'
import { join } from 'path'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { getTavilyKey, tavilySearch, tavilyExtract } from '../tavily/client.js'

const run = promisify(exec)
const runFile = promisify(execFile)
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
    description: 'Create a new file with content — fails if file already exists. Prefer edit_file for new files.',
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
    description: 'Write a new file — only for files that do not exist yet. Use patch_file to modify existing files.',
    params: '{"path": "string", "content": "string"}',
    execute: async ({ path, content }) => {
      const safe = guardPath(path as string)
      if (existsSync(safe)) {
        throw new Error(
          `edit_file cannot overwrite existing file: ${path}\n` +
          `Use patch_file with <old> and <new> blocks to make targeted edits.\n` +
          `Call read_file first to get the exact current text.`
        )
      }
      const text = content as string
      writeFile(safe, text)
      const lines = text.split('\n').length
      return `created: ${path} (${lines} line${lines === 1 ? '' : 's'})`
    },
  },
  {
    name: 'patch_file',
    description: 'Replace an exact unique string in an existing file. Always call read_file first to get the exact text.',
    params: '{"path": "string", "old": "string", "new": "string"}',
    execute: async ({ path, old: oldStr, new: newStr }) => {
      const safe = guardPath(path as string)
      const current = readFile(safe)
      if (current === null) throw new Error(`file not found: ${path}`)
      if (current === '') throw new Error(`file empty: ${path}`)
      const old = oldStr as string
      const count = current.split(old).length - 1
      if (count === 0) {
        throw new Error(
          `old text not found in ${path} — file may have changed since last read.\n` +
          `Call read_file again to get current content, then retry with exact matching text.`
        )
      }
      if (count > 1) {
        throw new Error(
          `ambiguous: ${count} matches found in ${path} — extend <old> block with more surrounding lines to make it unique`
        )
      }

      const updated = current.replace(old, String(newStr))
      writeFile(safe, updated)

      // Compute affected line range for the snippet
      const startLine   = current.slice(0, current.indexOf(old)).split('\n').length
      const oldLines    = old.split('\n').length
      const newLines    = (newStr as string).split('\n').length
      const updatedArr  = updated.split('\n')
      const snippetStart = Math.max(0, startLine - 3)
      const snippetEnd   = Math.min(updatedArr.length, startLine + newLines + 2)
      const snippet = updatedArr
        .slice(snippetStart, snippetEnd)
        .map((l, i) => `${String(snippetStart + i + 1).padStart(4)} │ ${l}`)
        .join('\n')

      const delta = newLines - oldLines
      const deltaStr = delta === 0 ? '' : delta > 0 ? ` (+${delta} line${delta === 1 ? '' : 's'})` : ` (${delta} line${Math.abs(delta) === 1 ? '' : 's'})`

      return `patched: ${path}${deltaStr}\n\nLines ${snippetStart + 1}–${snippetEnd}:\n${snippet}`
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
      try {
        const args = ['diff']
        if (staged) args.push('--staged')
        if (path) args.push('--', String(path))
        const { stdout } = await runFile('git', args, { timeout: EXEC_TIMEOUT_MS })
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
        const { stdout } = await runFile('git', ['log', '--oneline', `-${Math.min(Number(n), 50)}`], { timeout: EXEC_TIMEOUT_MS })
        return stdout.trim() || '(no commits)'
      } catch (e) { throw new Error(`git_log: ${e}`) }
    },
  },
  {
    name: 'git_commit',
    description: 'Stage files and create a git commit. Use files="-A" to stage all, or list specific paths.',
    params: '{"message": "string", "files": "string (optional, default -A)"}',
    execute: async ({ message, files = '-A' }) => {
      if (!message) throw new Error('git_commit: message required')
      const fileStr = String(files)
      if (/\.\./.test(fileStr) || !/^(-A|\.|[\w./\-]+(?: [\w./\-]+)*)$/.test(fileStr)) throw new Error('git_commit: invalid files argument — use -A, ., or space-separated paths (no .. allowed)')
      try {
        const fileArgs = fileStr === '-A' ? ['-A'] : fileStr === '.' ? ['.'] : fileStr.split(/\s+/).filter(Boolean)
        await runFile('git', ['add', ...fileArgs], { timeout: EXEC_TIMEOUT_MS })
        const { stdout } = await runFile('git', ['commit', '-m', String(message)], { timeout: EXEC_TIMEOUT_MS })
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
      const npmArgs = path ? ['test', '--', String(path)] : ['test']
      try {
        const { stdout, stderr } = await runFile('npm', npmArgs, { cwd: process.cwd(), timeout: 60_000 })
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
      const q = query != null ? String(query).trim() : ''
      if (!q) throw new Error('web_search: "query" argument is required and must be a non-empty string')
      return tavilySearch({
        apiKey: key,
        query: q,
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
      if (!urls) throw new Error('web_extract: "urls" argument is required')
      const list = Array.isArray(urls) ? urls : [String(urls)]
      return tavilyExtract({ apiKey: key, urls: list })
    },
  },
]

export function getSystemPrompt(extra = '', extraTools: Tool[] = []): string {
  const allTools = extraTools.length ? [...tools, ...extraTools] : tools
  const toolDocs = allTools.map(t => `- ${t.name}(${t.params}): ${t.description}`).join('\n')
  const deepThinkDoc = `- deep_think({"query": "string", "needs_web": "boolean (optional)"}): Research tool — gathers information from files, git, and optionally the web before answering. Returns a compiled research summary. Guardrails: read-only tools only, max 6 tool calls, max 4 web calls inside. Use when a question requires reading multiple files or searching the web first.
- search_codebase({"query": "string", "k": "number (optional)"}): Semantic vector search over the indexed codebase. Returns top-k relevant code snippets by meaning. Requires the user to have run /index build. Use this when you need to find code by concept rather than exact string — e.g. "authentication logic", "error handling patterns", "database queries".`
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
${deepThinkDoc}

Rules:
- edit_file only works on NEW files — it throws an error if the file exists. Never call it on existing files
- To modify any existing file: call read_file first, then patch_file with the exact text from that read as the <old> block
- Never guess or reuse old text from earlier in the conversation — always re-read immediately before patching
- If patch_file reports "old text not found", call read_file again and retry with the exact current text
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
- NEVER say you cannot search the web — always call web_search instead
- web_search REQUIRES the "query" key exactly — never omit it, never use "q" or "search_query" or any other key name
- Use deep_think when the question requires gathering from multiple files or sources before you can answer well — it runs a safe read-only research phase and returns a summary you can reason over
- deep_think cannot edit files or run shell commands — it is purely for information gathering${extra}`
}
