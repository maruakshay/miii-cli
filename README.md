# miii-cli

> Local AI coding assistant for your terminal. No cloud. No API keys. No latency.

```
╭─────────────────────────────────────────────────────────╮
│  miii — Claude Code-level workflows, local models only  │
╰─────────────────────────────────────────────────────────╯
```

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

![miii demo](mii-cli.gif)

---

## Why I built this

I couldn't find a local CLI AI tool that actually worked well. The ones that existed were either too clunky to set up, required cloud APIs, or had terminal output that was genuinely painful to read — weird formatting, broken renders, text that ran together. I wanted something that felt as clean as Claude Code but ran entirely on local models. So I built miii.

---

## What is miii?

`miii` is a terminal-native AI coding assistant powered by local models via [Ollama](https://ollama.com) or any OpenAI-compatible API (LM Studio, vLLM, Groq, Together, etc.).

- **Runs 100% locally** — your code never leaves your machine
- **File-aware** — type `@filename` to inject any file into context instantly
- **Tool-enabled** — reads, writes, edits, and runs shell commands autonomously
- **Session memory** — conversations persist across launches
- **Extensible** — add custom slash commands via Markdown or TypeScript skill files

---

## Install

```bash
npm install -g miii-cli
```

**Requirements:** Node.js 18+ and [Ollama](https://ollama.com) (or any OpenAI-compatible API)

---

## Quick start

```bash
# Make sure Ollama is running
ollama serve

# Start miii
miii
```

On launch, miii opens a model picker. Select a model and start coding.

```bash
miii                          # default session
miii --model codellama        # specific model
miii --session myproject      # named session
miii -s work -m llama3.2      # short flags
```

---

## File context with `@`

Type `@` anywhere in your message to fuzzy-search and inject project files into the model's context:

```
❯ review the auth logic in @src/auth/middleware.ts
❯ refactor @src/utils/parser.ts to handle edge cases
```

Automatically excluded: `node_modules`, `dist`, `.git`, lock files, binaries, images.

---

## Built-in commands

Type `/` to open the command palette.

| Command | Description |
|---|---|
| `/models` | Switch or pull Ollama models |
| `/session <name>` | Switch to or create a named session |
| `/sessions` | List all sessions with message counts |
| `/clear` | Clear current session history |
| `/mkdir <path>` | Create a folder (and any missing parents) |
| `/touch <path>` | Create an empty file |
| `/mv <from> <to>` | Move or rename a file or folder |
| `/list` | Show loaded skills |
| `/exit` | Exit miii |

---

## Built-in tools

The model can call these tools automatically — no setup needed.

| Tool | Description |
|---|---|
| `read_file` | Read any file |
| `list_files` | List directory contents |
| `edit_file` | Create or overwrite a file (auto-creates parent dirs) |
| `create_folder` | Create a directory and any missing parents |
| `move_file` | Move or rename a file or directory |
| `delete_file` | Delete a file |
| `run_command` | Run a shell command in the current directory |

Tool calls chain up to 6 hops deep — the model reads, edits, runs, and verifies on its own.

---

## Sessions

Every conversation is saved and resumed automatically.

```bash
miii                          # resumes "default" session
miii --session feature-auth   # resumes or creates "feature-auth"
```

Sessions stored at `~/.config/miii/sessions/`.

---

## Skills

Skills are custom `/` commands. Create a Markdown file in `~/.config/miii/skills/`:

```markdown
---
name: review
description: review current changes for bugs and improvements
---

Review the code I'm about to share. Look for bugs, edge cases, and improvements.
Be direct and specific. No markdown.
```

Use it:

```
/review
```

Skills can also be TypeScript files with an `execute` function for programmatic behavior.

---

## Configuration

Config is loaded from (in order):
1. `.miii.json` in the current directory
2. `~/.config/miii/config.json`

**Ollama (default):**
```json
{
  "model": "llama3.2",
  "provider": "ollama",
  "baseUrl": "http://localhost:11434"
}
```

**OpenAI-compatible API:**
```json
{
  "model": "gpt-4o",
  "provider": "openai",
  "baseUrl": "https://api.openai.com/v1"
}
```

Works with LM Studio, vLLM, Groq, Together, and any other OpenAI-compatible server.

---

## Keybindings

| Key | Action |
|---|---|
| `enter` | Send message |
| `ctrl+c` | Abort streaming response |
| `ctrl+c` x2 | Exit miii |
| `esc` | Close overlay or abort |
| `↑ / ↓` | Navigate command palette or file picker |

---

## Security

miii **0.1.5** addresses the following OWASP issues:

| Issue | Fix |
|---|---|
| Path traversal (A01) | All file tool operations are now restricted to the current working directory via `guardPath()` |
| Path traversal (A01) | `@filename` references validated against `cwd` before reading |
| Path traversal (A01) | `/mv`, `/mkdir`, `/touch` commands restricted to `cwd` |
| Path traversal (A01) | Session names sanitized to alphanumeric + hyphens only |
| Injection (A03) | `run_command` tool enforces a 30-second execution timeout |
| Insecure deserialization (A08) | Config loading whitelists allowed keys; session data validated as array |
| XML injection | File paths in context XML attributes are properly escaped |
| Configurable API key | OpenAI-compatible provider token now configurable via `apiKey` in config (no longer hardcoded) |

---

## Source

```bash
git clone https://github.com/maruakshay/miii-cli
cd miii-cli
npm install
npm run build
npm link
```
