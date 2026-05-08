# miii

> A local AI coding assistant that actually works. No cloud. No Python. No API keys required.

```
╭──────────────────────────────────────────────────────────────╮
│  miii — Claude Code-level workflows, fully offline           │
╰──────────────────────────────────────────────────────────────╯
```

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

![miii demo](mii-cli.gif)

---

## Why miii exists

Every local AI coding tool is either too clunky to set up, requires cloud APIs, or has terminal output that's genuinely painful to read. miii is what happens when you build a local coding assistant that takes UX seriously — real Ink-based terminal UI, automatic git context, multi-file refactors with task queues, and a context compactor that keeps local models on-track.

Your code never leaves your machine.

---

## What makes it different

| Feature | miii | aider | shell_gpt | open-interpreter |
|---|---|---|---|---|
| Ink terminal UI | ✅ | ❌ | ❌ | ❌ |
| Zero Python | ✅ | ❌ | ❌ | ❌ |
| Auto git context | ✅ | ✅ | ❌ | ❌ |
| Context compaction | ✅ | ✅ | ❌ | ❌ |
| Multi-file refactor queue | ✅ | partial | ❌ | ❌ |
| `.miiiignore` | ✅ | ✅ | ❌ | ❌ |
| Session persistence | ✅ | ❌ | ❌ | ❌ |
| Planning mode | ✅ | ❌ | ❌ | ❌ |
| Bundle size | 176K | ~50MB | ~40MB | ~100MB |

---

## Install

```bash
npm install -g miii-cli
```

**Requirements:** Node.js 18+ and [Ollama](https://ollama.com) (or any OpenAI-compatible API)

---

## Quick start

```bash
# Start Ollama
ollama serve

# Pull a model
ollama pull qwen2.5-coder:7b

# Launch miii
miii
```

A model picker opens on launch. Select a model and start coding.

```bash
miii                          # default session
miii --model qwen2.5-coder    # specific model
miii --session myproject      # named session
miii -s work -m codellama     # short flags
```

---

## Auto git context

miii automatically detects changed files via `git status` and injects their contents into the model's context — no `@file` needed for files you're actively working on.

```
❯ fix the type error in the auth middleware

[auto-loaded 3 changed file(s)]
```

Only fires for code-related messages. Pure questions ("what is a closure?") skip the git scan entirely. Deduped — same files don't re-inject unless they change.

Disable per-project:
```json
{ "gitContext": false }
```

---

## File context with `@`

Type `@` to fuzzy-search and inject any project file:

```
❯ review the auth logic in @src/auth/middleware.ts
❯ what does @src/utils/parser.ts return when input is empty?
```

Automatically excluded: `node_modules`, `dist`, `.git`, lock files, binaries, images.

---

## `.miiiignore`

Create `.miiiignore` in your project root to exclude files from `@` picker and auto-context:

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

Full git workflow from the terminal:

```
/git status          show working tree
/git diff            unstaged changes
/git diff --staged   staged changes
/git log             recent commits
/git review          AI reviews current changes for bugs + improvements
/git branch          list branches
/git commit <msg>    stage all and commit
```

The model also has access to git tools directly — it can check status, read diffs, and commit as part of autonomous workflows.

---

## Multi-file refactor

Describe a goal, miii plans and executes across multiple files with isolated context per file:

```
/refactor extract all database queries into a repository layer
/refactor rename UserService to AccountService everywhere
/refactor add input validation to all API route handlers
```

Uses a priority task queue (P0=blocking, P1=reads parallel, P2=writes sequential, P3=verify). Each file gets its own fresh context — the local model never loses the thread on large codebases.

---

## Planning mode

Structured step-by-step planning before writing any code:

```
/plan add OAuth2 to this Express app
/plan refactor the frontend to use React Query
```

In planning mode:
```
/plan:next        suggest next concrete steps
/plan:breakdown   break topic into subtasks
/plan:review      critique the plan so far
/plan:done        exit planning mode
```

---

## Built-in commands

Type `/` to open the command palette with fuzzy search.

| Command | Description |
|---|---|
| `/model <name>` | Switch model mid-session — no restart needed |
| `/models` | Open model picker, pull new Ollama models |
| `/session <name>` | Switch to or create a named session |
| `/sessions` | List all sessions with message counts |
| `/new` | Start a fresh auto-named session |
| `/clear` | Clear current session history |
| `/plan [topic]` | Enter planning mode |
| `/refactor <goal>` | Multi-file AI refactor |
| `/git <subcommand>` | Git commands (see above) |
| `/list` | Show all loaded skills |
| `/exit` | Exit miii |

---

## Built-in tools

The model calls these autonomously — reads, writes, edits, runs, tests, and commits on its own.

| Tool | Description |
|---|---|
| `read_file` | Read any file |
| `list_files` | List directory contents |
| `create_file` | Create a new file (fails if exists) |
| `edit_file` | Create or fully rewrite a file |
| `patch_file` | Targeted string replacement — throws if match is ambiguous |
| `delete_file` | Delete a file |
| `move_file` | Move or rename a file or directory |
| `create_folder` | Create directory with parents |
| `run_command` | Run shell command in cwd (30s timeout) |
| `run_tests` | Run test suite, auto-detects jest/vitest/mocha from package.json |
| `git_status` | Working tree status |
| `git_diff` | Unstaged or staged diff (truncated at 8K) |
| `git_log` | Recent commit history |
| `git_commit` | Stage files and commit |

Tool calls chain up to 6 hops — model reads, edits, runs tests, and verifies autonomously.

---

## Context compaction

Local models lose the thread after ~15-20 messages. miii auto-compacts context at threshold: keeps system prompt + original goal + tool result summary + last 6 exchanges. The session history is preserved on disk — only the LLM context window gets trimmed.

---

## Thinking indicator

```
✦ staring into the abyss (it blinked)…   [0:12]

⚙ running patch_file…
⚙ running run_tests…
```

Phrase rotates every 5 seconds. Tool name updates live as each call fires. Elapsed time shown throughout.

---

## Sessions

Every conversation persists automatically.

```bash
miii                          # resumes "default" session
miii --session feature-auth   # resumes or creates "feature-auth"
```

Sessions stored at `~/.config/miii/sessions/`. History capped at 100 messages in memory, full history on disk.

---

## Skills

Custom `/` commands via Markdown in `~/.config/miii/skills/`:

```markdown
---
name: review
description: review current changes for bugs and improvements
---

Review the code I'm about to share. Look for bugs, edge cases, and improvements.
Be direct and specific. No markdown.
```

```
/review
```

TypeScript skills with `execute` functions available for programmatic behavior.

---

## Configuration

Config loaded from (in order):
1. `.miii.json` in current directory
2. `~/.config/miii/config.json`

**Ollama:**
```json
{
  "model": "qwen2.5-coder:7b",
  "provider": "ollama",
  "baseUrl": "http://localhost:11434"
}
```

**OpenAI-compatible (LM Studio, vLLM, Groq, Together, etc.):**
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
  "systemPrompt": "optional override"
}
```

---

## Keybindings

| Key | Action |
|---|---|
| `enter` | Send message |
| `↑ / ↓` | Navigate command palette or file picker |
| `esc` | Close overlay / abort request |
| `ctrl+c` | Abort current request or exit |

---

## Security

| Issue | Fix |
|---|---|
| Path traversal (OWASP A01) | All file operations restricted to cwd via `guardPath()` |
| Path traversal (OWASP A01) | `@file` refs validated against cwd before reading |
| Path traversal (OWASP A01) | Session names sanitized to alphanumeric + hyphens |
| Injection (OWASP A03) | `run_command` enforces 30s execution timeout |
| Insecure deserialization (OWASP A08) | Config whitelists allowed keys; session data validated as array |

---

## Build from source

```bash
git clone https://github.com/maruakshay/miii-cli
cd miii-cli
npm install
npm run build
npm link
```

---

## What's in 0.2.x

- **Auto git context** — changed files injected automatically, code-gated heuristic
- **`.miiiignore`** — per-project file exclusions
- **Multi-file refactor** — macro/micro task queue, isolated context per file
- **Planning mode** — structured `/plan` workflow
- **Git integration** — full git toolkit in commands and model tools
- **`run_tests` tool** — model runs and retries tests autonomously
- **`/model` live switch** — change models mid-session
- **Context compaction** — auto-trim at 18 messages, keep goal + summary + recent
- **Ambiguous patch detection** — `patch_file` throws on multiple matches instead of silently corrupting
- **176K bundle** — removed dead workers, sourcemaps, unused deps (was 468K)
- **Debounced session saves** — writes at most once per 2s, no I/O on every keypress
