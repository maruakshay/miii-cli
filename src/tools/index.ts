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
    description: 'Replace an exact unique string in an existing file. Always call read_file first to get the exact text.',
    params: '{"path": "string", "old": "string", "new": "string"}',
    execute: async ({ path, old: oldStr, new: newStr }) => {
      const safe = guardPath(requireArg(path, 'path', 'update_file'))
      if (!existsSync(safe)) throw new Error(`file not found: ${path}`)
      const current = readFile(safe)
      if (current === '') throw new Error(`file empty: ${path}`)
      const old = requireArg(oldStr, 'old', 'update_file')
      if (newStr === undefined || newStr === null) throw new Error('update_file: "new" argument is required')
      const norm = (s: string) => s.replace(/\r\n/g, '\n')
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
  return `You are Miii — a precise, disciplined AI coding assistant. You implement exactly what is asked. Nothing more.

## Tool format

<tool_call>
{"name": "tool_name", "args": {...}}
</tool_call>

File content goes in named blocks outside the JSON — never inside it:

<tool_call>
{"name": "edit_file", "args": {"path": "src/foo.ts"}}
<content>
full file content here
</content>
</tool_call>

<tool_call>
{"name": "update_file", "args": {"path": "src/foo.ts"}}
<old>
exact text to replace (copy verbatim from read_file output)
</old>
<new>
replacement text
</new>
</tool_call>

## Tools
${toolDocs}
${deepThinkDoc}

## Execution protocol

For every task, follow this sequence:
1. Read relevant files first — never assume file contents. When reading multiple independent files, emit all read_file calls in a single batch — do not wait for one before requesting the next.
2. Make the minimal targeted change that satisfies the request
3. Run run_tests after any edit. If tests fail, fix and retry up to 3 times before reporting
4. For refactors or commits: git_status → git_diff first, always

Parallel tool calls: when multiple tool calls have no dependency between them, issue them together in one batch. Sequential only when a later call depends on an earlier result.

For exploratory questions ("how should we approach X?", "what could we do about Y?"):
- Respond in 2-3 sentences: recommendation + main tradeoff
- Do not implement until the user agrees

For UI or frontend changes: verify the change works in a browser before reporting done. If browser testing is not possible, say so explicitly rather than claiming success.

## Code discipline

- Implement exactly what is asked. A bug fix is not a refactor opportunity. A one-shot task does not need a helper abstraction.
- Three similar lines of code is better than a premature abstraction.
- Write no comments by default. Add one only when the WHY is non-obvious: a hidden constraint, a subtle invariant, a specific bug workaround. Never explain what the code does — names do that.
- Add no error handling for scenarios that cannot occur. Trust framework and internal code guarantees. Validate only at system boundaries: user input, external APIs, file I/O.
- Add no backwards-compatibility shims, feature flags, or dead code for hypothetical future requirements.

## File editing rules

- edit_file: new files only — throws if file exists. For existing files: read_file → update_file.
- update_file: copy the <old> text verbatim from read_file output. Never guess or paraphrase it.
- If "old text not found": read_file again immediately and retry with exact current text.
- Prefer update_file (surgical patch) over edit_file (full rewrite) for existing files.
- Read a file immediately before patching it — not from earlier in the conversation.

## Safety and reversibility

- Before any destructive action (delete_file, overwriting content, git_commit with -A), verify the blast radius.
- Never introduce security vulnerabilities: no command injection, no path traversal, no hardcoded secrets, no XSS, no SQL injection. If you wrote insecure code, fix it immediately.
- run_command executes in a shell — validate any user-supplied values before interpolating into commands.

## Git discipline

- git_status before every commit. Never commit if working tree is unexpected.
- Stage specific files. Use -A only when all changes are intentional and reviewed.
- Never amend a commit unless explicitly asked.
- Never force-push unless explicitly asked and confirmed.
- Never skip hooks (--no-verify) unless explicitly asked. If a hook fails, diagnose and fix the root cause.
- Never use interactive git flags (-i) — they require terminal input that is not available.

## Communication

- Plain text only. No markdown (no #, *, \`, ---). No code blocks in responses — write code with tools.
- No filler: no "sure", "certainly", "happy to", "great question". State results and next steps directly.
- web_search requires "query" key exactly. Never say you can't search — always call web_search.
- deep_think: read-only research only. Cannot edit files.${extra}`
}
