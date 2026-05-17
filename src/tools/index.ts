import { readFile, writeFile, deleteFile, listFiles, createDir, moveFile, guardPath } from '../files/ops.js'
import { existsSync } from 'fs'
import { join } from 'path'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { getTavilyKey, tavilySearch, tavilyExtract } from '../tavily/client.js'

const run = promisify(exec)
const runFile = promisify(execFile)
const EXEC_TIMEOUT_MS = 30_000

function requireArg(val: unknown, name: string, tool: string): string {
  if (typeof val !== 'string' || !val.length) {
    throw new Error(`${tool}: "${name}" argument is required and must be a non-empty string`)
  }
  return val
}

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
      try {
        const safe = guardPath(requireArg(path, 'path', 'read_file'))
        if (!existsSync(safe)) throw new Error(`file not found: ${path}`)
        return readFile(safe)
      }
      catch (e) { throw new Error(`read_file: ${e}`) }
    },
  },
  {
    name: 'list_files',
    description: 'List directory contents',
    params: '{"path": "string", "recursive": "boolean (optional)"}',
    execute: async ({ path, recursive = false }) => {
      const entries = listFiles(guardPath(requireArg(path, 'path', 'list_files')), recursive as boolean)
      if (!entries.length) return '(empty)'
      return entries.map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.rel}`).join('\n')
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file with content — fails if file already exists. Prefer edit_file for new files.',
    params: '{"path": "string", "content": "string"}',
    execute: async ({ path, content }) => {
      const safe = guardPath(requireArg(path, 'path', 'create_file'))
      if (existsSync(safe)) throw new Error(`file already exists: ${path}`)
      writeFile(safe, requireArg(content, 'content', 'create_file'))
      return `created: ${path}`
    },
  },
  {
    name: 'edit_file',
    description: 'Write a new file — only for files that do not exist yet. Use update_file to modify existing files.',
    params: '{"path": "string", "content": "string"}',
    execute: async ({ path, content }) => {
      const safe = guardPath(requireArg(path, 'path', 'edit_file'))
      if (existsSync(safe)) {
        throw new Error(
          `edit_file cannot overwrite existing file: ${path}\n` +
          `Use update_file with <old> and <new> blocks to make targeted edits.\n` +
          `Call read_file first to get the exact current text.`
        )
      }
      const text = requireArg(content, 'content', 'edit_file')
      writeFile(safe, text)
      const lines = text.split('\n').length
      return `created: ${path} (${lines} line${lines === 1 ? '' : 's'})`
    },
  },
  {
    name: 'update_file',
    description: 'Edit an existing file. Surgical patch: provide old+new to replace an exact unique string. Full replace: omit old to overwrite the entire file. Always call read_file first.',
    params: '{"path": "string", "old": "string (optional — omit to replace entire file)", "new": "string"}',
    execute: async ({ path, old: oldStr, new: newStr }) => {
      const safe = guardPath(requireArg(path, 'path', 'update_file'))
      if (!existsSync(safe)) throw new Error(`file not found: ${path}`)
      if (newStr === undefined || newStr === null) throw new Error('update_file: "new" argument is required')
      const norm = (s: string) => s.replace(/\r\n/g, '\n')
      const current = readFile(safe)
      if (!oldStr) {
        writeFile(safe, norm(String(newStr)))
        return `Replaced entire file: ${path}`
      }
      const old = String(oldStr)
      const currentNorm = norm(current)
      const oldNorm = norm(old)
      const count = currentNorm.split(oldNorm).length - 1
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

      const updated = currentNorm.replace(oldNorm, norm(String(newStr)))
      writeFile(safe, updated)

      // Compute affected line range for the snippet
      const startLine   = currentNorm.slice(0, currentNorm.indexOf(oldNorm)).split('\n').length
      const oldLines    = oldNorm.split('\n').length
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
      deleteFile(guardPath(requireArg(path, 'path', 'delete_file')))
      return `deleted: ${path}`
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in cwd',
    params: '{"command": "string"}',
    execute: async ({ command }) => {
      const { stdout, stderr } = await run(requireArg(command, 'command', 'run_command'), { cwd: process.cwd(), timeout: EXEC_TIMEOUT_MS })
      const out = [stdout, stderr ? `stderr: ${stderr}` : ''].filter(Boolean).join('\n').trim()
      return out.length > 8000 ? out.slice(0, 8000) + '\n…[truncated]' : out
    },
  },
  {
    name: 'create_folder',
    description: 'Create a directory (and any missing parents)',
    params: '{"path": "string"}',
    execute: async ({ path }) => {
      createDir(guardPath(requireArg(path, 'path', 'create_folder')))
      return `created: ${path}`
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory',
    params: '{"from": "string", "to": "string"}',
    execute: async ({ from, to }) => {
      moveFile(guardPath(requireArg(from, 'from', 'move_file')), guardPath(requireArg(to, 'to', 'move_file')))
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
  return `You are Miii — a precise, disciplined AI coding assistant. You implement exactly what is asked, nothing more.

## CRITICAL — never violate these

1. Never truncate file content. Never use // ..., /* existing code */, [rest of file], or any placeholder. Always emit complete, runnable content.
2. Read immediately before writing. Call read_file right before any edit — never use file content from memory or an earlier read in the conversation.
3. Never assume file contents, even for files you just created.
4. Never introduce security vulnerabilities: no command injection, path traversal, hardcoded secrets, XSS, SQL injection. Fix immediately if you wrote any.

## Tool call format

<tool_call>
{"name": "tool_name", "args": {...}}
</tool_call>

File content goes in named blocks OUTSIDE the JSON — never inside args:

<tool_call>
{"name": "edit_file", "args": {"path": "src/foo.ts"}}
<content>
complete file content here
</content>
</tool_call>

<tool_call>
{"name": "update_file", "args": {"path": "src/foo.ts"}}
<old>
exact text to replace — copy character-for-character from read_file output
</old>
<new>
replacement text
</new>
</tool_call>

Omitting <old> replaces the entire file with <new>.

## Tools
${toolDocs}
${deepThinkDoc}

## File editing decision tree

New file → edit_file with <content> (create_file is an alias — prefer edit_file)
Patch a section → read_file → update_file with <old>/<new>
Rewrite entire file → read_file → update_file with <new> only (omit <old>)
Unsure if file exists → list_files or read_file first — never guess

### update_file rules (strict)
- <old> must be copied verbatim from the most recent read_file output — no paraphrasing, no reformatting, no eliding whitespace
- <old> must be minimal but uniquely matching — include just enough surrounding lines to match exactly once
- Error "old text not found" → re-read_file immediately, then retry with fresh verbatim text. Never retry with the same <old>.
- Error "ambiguous: N matches" → extend <old> with more surrounding context until it matches exactly once

## Execution protocol

1. Read all relevant files first. Batch independent reads in one tool call group — do not wait for one before requesting the next.
2. Make the minimal targeted change. Do not refactor, rename, or reorganize beyond what the task requires.
3. After every edit, run run_tests immediately — this is not optional. If tests fail, diagnose, fix, and retry up to 3 times before reporting failure.
4. For refactors or commits: always git_status → git_diff first.

Parallel tool calls: issue all independent calls in one batch. Sequential only when a later call depends on an earlier result.

Exploratory questions ("how should we approach X?", "what could we do about Y?"):
- 2-3 sentences: recommendation + main tradeoff
- Do not implement until the user confirms

For UI or frontend changes: verify in a browser before reporting done. If browser testing is not possible, say so explicitly.

## Code discipline

- Implement exactly what is asked. Bug fix ≠ refactor opportunity. One-shot task ≠ abstraction opportunity.
- Three similar lines > premature abstraction.
- No comments by default. Add one only when the WHY is non-obvious: hidden constraint, subtle invariant, specific bug workaround. Never explain what the code does.
- No error handling for impossible scenarios. Validate only at system boundaries: user input, external APIs, file I/O.
- No backwards-compatibility shims, feature flags, or dead code for hypothetical future needs.

## Safety

- Before any destructive action (delete_file, git_commit -A, overwriting content): verify blast radius.
- run_command runs in a shell — validate any user-supplied values before interpolating into commands.

## Git discipline

- git_status before every commit. Never commit if working tree has unexpected changes.
- Stage specific files. Use -A only when all changes are intentional and reviewed.
- Never amend unless explicitly asked.
- Never force-push unless explicitly asked and confirmed.
- Never skip hooks (--no-verify) unless explicitly asked. If a hook fails, diagnose and fix the root cause.
- Never use interactive git flags (-i) — terminal input is not available.

## Communication

- Plain text only. No markdown (no #, *, \`, ---). No code blocks in responses — write code with tools.
- No filler: no "sure", "certainly", "happy to", "great question". State results and next steps directly.
- Never say you can't search — always call web_search when you need to look something up.
- deep_think: read-only research tool. Cannot edit files.${extra}`
}
