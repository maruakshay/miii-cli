# miii

> Claude Code-level terminal AI — runs on your machine, zero cloud required.

```
╭──────────────────────────────────────────────────────────────────────╮
│  miii  v0.2.8                                                        │
│  model: qwen2.5-coder:7b                                             │
├──────────────────────────────────────────────────────────────────────┤
│  ✦ cross-referencing vibes…                              12s         │
│  ⚙ running patch_file…                                               │
│  ⚙ running run_tests…                                                │
├──────────────────────────────────────────────────────────────────────┤
│  ❯ █                                                                 │
│  @ file  / command  enter send  ctrl+c exit                          │
╰──────────────────────────────────────────────────────────────────────╯
```

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![npm downloads](https://img.shields.io/npm/dm/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

---

## What is this

A local AI coding assistant with the workflow depth of Claude Code — file editing, multi-file refactors, test running, git integration, web search — except it runs entirely on your machine using Ollama, or any OpenAI-compatible API.

No Python. No cloud. No API key required to start. 176K bundle.

---

## Why it beats the alternatives

| Feature | miii | aider | shell_gpt | open-interpreter |
|---|:---:|:---:|:---:|:---:|
| Ink terminal UI (not raw text) | ✅ | ❌ | ❌ | ❌ |
| Zero Python | ✅ | ❌ | ❌ | ❌ |
| Auto git context injection | ✅ | ✅ | ❌ | ❌ |
| Multi-file refactor queue | ✅ | partial | ❌ | ❌ |
| Context compaction (keeps local models on-track) | ✅ | ✅ | ❌ | ❌ |
| Auto-runs tests after file edits | ✅ | ❌ | ❌ | ❌ |
| Web search + extract (Tavily) | ✅ | ❌ | ❌ | partial |
| npm skill plugin system | ✅ | ❌ | ❌ | ❌ |
| Planning mode | ✅ | ❌ | ❌ | ❌ |
| Named sessions + persistence | ✅ | ❌ | ❌ | ❌ |
| `.miiiignore` | ✅ | ✅ | ❌ | ❌ |
| Live model switching mid-session | ✅ | ❌ | ❌ | ❌ |
| Bundle size | **176K** | ~50MB | ~40MB | ~100MB |

---

## Install

```bash
npm install -g miii-cli
```

**Requires:** Node.js 18+  and [Ollama](https://ollama.com)

Or any OpenAI-compatible API — see [configuration](#configuration).

---

## Quick start

```bash
ollama serve
ollama pull qwen2.5-coder:7b
miii
```

Model picker opens on launch. Select a model. Start coding.

```bash
miii                          # new session, named from first message
miii --model qwen2.5-coder    # specific model
miii --session myproject      # named session
miii -s work -m codellama     # short flags
```

miii checks for updates on startup and lets you know when a new version is available:

```
├── miii v0.2.7 → v0.2.8 available  run: npm install -g miii-cli ───┤
```

---

## Auto git context

miii watches `git status` and silently injects your changed files into context — before you even type `@file`.

```
❯ fix the type error in the auth middleware

[auto-loaded 3 changed file(s)]
```

Smart enough to skip it for non-code questions. Deduped — same files don't re-inject unless they change on disk. Disable per-project:

```json
{ "gitContext": false }
```

---

## Multi-file refactor

One goal, executed across the whole codebase:

```
/refactor extract all database queries into a repository layer
/refactor rename UserService to AccountService everywhere
/refactor add input validation to all API route handlers
```

How it works: model plans which files change → reads all in parallel → per-file LLM call with isolated context → writes queued changes → runs tests. Each file gets its own fresh context so local models never lose the thread.

---

## Auto-test after edits

Every time the model edits a file, miii runs your test suite automatically and feeds results back into the conversation — without you asking.

```
⚙ running run_tests…
● src/auth/middleware.test.ts — 2 tests failed
```

Model sees the failures and fixes them on the next hop. Supports jest, vitest, mocha — auto-detected from `package.json`.

---

## Web search

Add a Tavily key and the model can search the web and scrape pages as tools, mid-conversation:

```bash
/tavily-key tvly-your-key-here
```

Get a free key at [tavily.com](https://tavily.com) — 1000 free searches/month.

```
❯ what's the latest breaking change in React 19?
❯ find the docs for the Hono.js routing API and implement it here
❯ search for the error: "Cannot read properties of undefined (reading 'map')"
```

Tools available to the model: `web_search` (semantic search, configurable depth) and `web_extract` (scrape and summarize any URL). API key stored at `~/.config/miii/tavily.key` with mode 600.

---

## npm skill ecosystem

Write your own:

```typescript
// miii-skill-mytool/index.js
export default {
  name: 'mytool',
  ns: 'custom',
  description: 'does something useful',
  execute: async (args, ctx) => {
    ctx.setSystemPrompt(ctx.getSystemPrompt() + '\nExtra context here.')
    return 'skill activated'
  }
}
```

Markdown skills still work too — drop a `.md` file in `~/.config/miii/skills/` and it becomes a `/command` instantly.

---

## Planning mode

Think before you code:

```
/plan add OAuth2 to this Express app
/plan refactor the frontend to use React Query
```

Switches the model into a structured planning mode — no code, just questions, breakdowns, and concrete steps. Then:

```
/plan:next        next concrete steps
/plan:breakdown   break into subtasks
/plan:review      critique the plan so far
/plan:done        exit, go build
```

---

## File context with `@`

Type `@` anywhere to fuzzy-search and inject any project file into context:

```
❯ review the auth logic in @src/auth/middleware.ts
❯ what does @src/utils/parser.ts return when input is empty?
```

Files auto-excluded: `node_modules`, `dist`, `.git`, lock files, binaries, images.

---

## `.miiiignore`

Exclude files from `@` fuzzy picker and git auto-context:

```
# .miiiignore
secrets/
*.generated.ts
fixtures/
*.sql
```

Supports exact names, relative paths, and `*.ext` glob patterns.

---

## Git integration

```
/git status          working tree
/git diff            unstaged changes
/git diff --staged   staged diff
/git log             recent commits  (n optional: /git log 20)
/git review          AI reviews current changes for bugs + improvements
/git branch          list branches
/git commit <msg>    stage all and commit
```

The model also has `git_status`, `git_diff`, `git_log`, `git_commit` as autonomous tools — it checks status and commits without being asked.

---

## All built-in tools

The model calls these autonomously as needed:

| Tool | What it does |
|---|---|
| `read_file` | Read any file in cwd |
| `list_files` | List directory, respects `.miiiignore` |
| `create_file` | Create new file — throws if already exists |
| `edit_file` | Create or fully rewrite a file |
| `patch_file` | Targeted string replace — throws on ambiguous match |
| `delete_file` | Delete a file |
| `move_file` | Move or rename |
| `create_folder` | mkdir -p |
| `run_command` | Shell command, cwd, 30s timeout |
| `run_tests` | Run test suite (jest/vitest/mocha auto-detected) |
| `git_status` | Working tree status |
| `git_diff` | Diff, staged or unstaged, 8K truncated |
| `git_log` | Commit history |
| `git_commit` | Stage + commit |
| `web_search` | Tavily semantic search (requires API key) |
| `web_extract` | Scrape + summarize URLs (requires API key) |

Chains up to 6 tool hops per response — read, edit, test, verify, commit in one shot.

---

## Sessions

Every `miii` run starts a fresh session automatically. The session is named after your first message — so `fix the auth bug` becomes the session `fix-the-auth-bug`. Use `--session` to resume a specific one.

```bash
miii                          # new session every time, named from first message
miii --session feature-auth   # resumes or creates "feature-auth"
```

```
/session <name>        switch to a session (creates if new)
/session delete <name> delete a saved session
/sessions              list all sessions with message counts
/new                   fresh auto-named session
/clear                 clear current session history
```

Sessions at `~/.config/miii/sessions/`. History capped at 100 messages in-context, full history on disk. Debounced writes — no I/O on every message.

---

## Context compaction

Local models lose coherence around 15–20 messages. miii auto-compacts when context gets long: keeps system prompt + original goal + tool result summary + last 6 exchanges. You keep going without restarting. Session history always preserved on disk — only the LLM window gets trimmed.

---

## All commands

Type `/` to open the command palette with fuzzy search.

| Command | Description |
|---|---|
| `/model <name>` | Switch model mid-session — no restart |
| `/models` | Model picker, pull new Ollama models |
| `/session <name>` | Switch or create session |
| `/session delete <name>` | Delete a saved session |
| `/sessions` | List all sessions |
| `/new` | Fresh auto-named session |
| `/clear` | Clear current history |
| `/plan [topic]` | Planning mode |
| `/refactor <goal>` | Multi-file refactor |
| `/git <sub>` | Git commands |
| `/skills <sub>` | Install / uninstall / list npm skills |
| `/tavily-key <key>` | Set web search API key |
| `/version` | Show current version |
| `/list` | List all loaded skills |
| `/exit` | Exit |

---

## Configuration

Loaded in order from `.miii.json` (project) → `~/.config/miii/config.json` (global).

**Ollama (default):**
```json
{
  "model": "qwen2.5-coder:7b",
  "provider": "ollama",
  "baseUrl": "http://localhost:11434"
}
```

**Any OpenAI-compatible API** (LM Studio, vLLM, Groq, Together, OpenRouter…):
```json
{
  "model": "gpt-4o",
  "provider": "openai-compat",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-..."
}
```

**All options:**
```json
{
  "model": "qwen2.5-coder:7b",
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "apiKey": "",
  "gitContext": true,
  "tavilyApiKey": "tvly-...",
  "systemPrompt": "optional override"
}
```

---

## Security

| Threat | Defense |
|---|---|
| Path traversal (OWASP A01) | All file ops restricted to cwd via `guardPath()` |
| `@file` injection | Refs validated against cwd before reading |
| Session name injection | Names sanitized to alphanumeric + hyphens |
| Shell injection (OWASP A03) | `run_command` enforces 30s hard timeout |
| Config injection (OWASP A08) | Config key whitelist; session data validated as array |
| API key exposure | Tavily key stored at `~/.config/miii/tavily.key` mode 600 |

---

## Keybindings

| Key | Action |
|---|---|
| `enter` | Send |
| `↑ / ↓` | Navigate command palette or file picker |
| `esc` | Close overlay / abort in-flight request |
| `ctrl+c` | Abort current request or exit |
| `backspace` | Remove pasted content chip |

## Paste detection

Paste a large file or code block and miii collapses it into a chip instead of flooding the input:

```
❯ ⎘ pasted 84 lines
  backspace removes paste  enter to send
```

The full content is sent with your message when you press enter. Threshold: ≥ 3 lines or ≥ 200 characters.

---

## Build from source

```bash
git clone https://github.com/maruakshay/miii-cli
cd miii-cli
npm install
npm run build
npm link
npm test          # 8 integration tests
```

---

## What's new in 0.2.8

- **Auto-named sessions** — every run starts fresh; session named from first message (`fix-the-auth-bug`)
- **Session delete** — `/session delete <name>` to remove saved sessions
- **Paste detection** — large pastes collapse to `⎘ pasted N lines` chip; full content sent on enter
- **Thinking animation fix** — messages and tool calls no longer bleed into the scrollback buffer
