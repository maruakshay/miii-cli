# miii

> Local AI coding assistant. Runs on Ollama or any OpenAI-compatible API. Zero cloud, zero Python.

```
╭──────────────────────────────────────────────────────────────────────╮
│  miii  v0.2.8                                                        │
│  model: qwen2.5-coder:7b                                             │
├──────────────────────────────────────────────────────────────────────┤
│  ✦ cross-referencing vibes…                              12s         │
│  ⚙ running patch_file…                                               │
│  ⚙ running run_tests…                                                │
├──────────────────────────────────────────────────────────────────────┤
│  ❯ ⎘ pasted 84 lines                                                 │
│  backspace removes paste  enter to send                              │
╰──────────────────────────────────────────────────────────────────────╯
```

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![npm downloads](https://img.shields.io/npm/dm/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

## Install

```bash
npm install -g miii-cli
```

Requires Node.js 18+ and [Ollama](https://ollama.com).

## Quick start

```bash
ollama pull qwen2.5-coder:7b
miii
```

Each run starts a fresh session named after your first message. Use `--session` to resume one.

```bash
miii                         # new session
miii --session feature-auth  # resume or create named session
miii -m codellama            # specific model
```

## What it does

- **File editing** — `edit_file`, `patch_file`, `create_file`, `delete_file`, `move_file`
- **Multi-file refactor** — `/refactor <goal>` plans, reads, edits, and tests across the whole codebase
- **Auto-test after edits** — runs jest/vitest/mocha after every file change, feeds failures back
- **Auto git context** — injects changed files into context before you even ask
- **Web search** — `web_search` + `web_extract` via Tavily (`/tavily-key tvly-...`)
- **Planning mode** — `/plan` switches the model to structured planning; no code until you say so
- **Sessions** — every conversation persists to `~/.config/miii/sessions/`, auto-named from first message
- **Paste detection** — large pastes collapse to `⎘ pasted N lines` chip instead of flooding input
- **npm skill plugins** — install `miii-skill-*` packages or drop `.md` files in `~/.config/miii/skills/`
- **Context compaction** — auto-trims LLM window when context gets long; history preserved on disk
- **176K bundle** — vs ~50MB for Python alternatives

## Commands

| Command | Description |
|---|---|
| `/model <name>` | Switch model mid-session |
| `/models` | Model picker, pull Ollama models |
| `/session <name>` | Switch or create session |
| `/session delete <name>` | Delete a saved session |
| `/sessions` | List all sessions |
| `/new` | Fresh session |
| `/clear` | Clear current history |
| `/plan [topic]` | Planning mode |
| `/refactor <goal>` | Multi-file refactor |
| `/git <sub>` | Git commands (status, diff, log, review, commit…) |
| `/skills install <name>` | Install npm skill |
| `/tavily-key <key>` | Set web search API key |
| `/list` | List all loaded skills |
| `/exit` | Exit |

## Configuration

`.miii.json` (project) or `~/.config/miii/config.json` (global):

```json
{
  "model": "qwen2.5-coder:7b",
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "apiKey": "",
  "gitContext": true,
  "tavilyApiKey": "tvly-...",
  "systemPrompt": ""
}
```

For OpenAI-compatible APIs (LM Studio, Groq, OpenRouter…): set `"provider": "openai-compat"` and point `baseUrl` at the API.

## Build from source

```bash
git clone https://github.com/maruakshay/miii-cli
cd miii-cli && npm install && npm run build && npm link
```

## What's new in 0.2.8

- **Auto-named sessions** — each run starts fresh, named from first message (`fix-the-auth-bug`)
- **Session delete** — `/session delete <name>`
- **Paste detection** — large pastes collapse to `⎘ pasted N lines` chip
- **Scrollback fix** — thinking animation and tool calls no longer bleed into terminal history
