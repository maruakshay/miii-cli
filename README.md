# miii — Ollama Coding CLI. 176 KB. No API Key.

> **Claude Code UX. Ollama models. No invoice.**

![MIII Demo](mii-cli.gif)

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

**176 KB · no API key · works offline**

---

Buy hardware once. Pay for AI never.

Your code never leaves your machine. Nothing sent to Anthropic, OpenAI, or anyone. If you're already running Ollama, miii adds $0 to your stack.

```bash
npm install -g miii-cli && miii
```

---

## Why Miii Exists

**You're probably paying for something miii does for free.**

Claude Code bills against your Anthropic API key. miii runs open models on Ollama — Llama, Mistral, Qwen, Phi. Fully local. $0. Claude Code has no built-in undo for file changes. A bad edit is a bad edit. Miii checkpoints every file before touching it.

The gap is what miii adds on top: file checkpoints before every edit, npm skills, live model switching, and full air-gap support.

- **16 GB RAM, a GPU** — if you're already running Ollama, miii adds $0 to your stack
- **Try Llama 3, Mistral, Qwen, Phi** side by side without switching tools
- **Literally cannot use cloud AI** — miii with Ollama is purpose-built for zero-internet environments

---

## What Miii Actually Does

Not a chatbot with a file-write button. Miii is a **full autonomous agent loop** — reasons, plans, acts, self-corrects until the task is done.

1. Describe a goal in plain English
2. Miii reads your codebase, maps the changes, shows the plan
3. Asks permission before touching anything — every edit, command, delete
4. Shows exact diff of what changes *before* you approve
5. Runs tests. If they fail, reads the error, fixes autonomously
6. Every file checkpointed — hit Esc and everything rolls back

---

## What a Real Session Looks Like

```
> refactor the auth module to use JWT instead of sessions

  ● thinking…
  ● read_file src/auth/session.ts  (42 lines)
  ● read_file src/middleware/auth.ts  (28 lines)

  ─ plan  (2 actions)
    ◦ edit_file  src/auth/session.ts
    ◦ edit_file  src/middleware/auth.ts

  ⚠  edit_file  src/auth/session.ts
  ┌─ diff preview ──────────────────────┐
  │ - const session = req.session.user  │
  │ + const token = verifyJWT(req)      │
  └─────────────────────────────────────┘
  y approve   s approve all   n deny
  > s

  ● edit_file src/auth/session.ts    done
  ● edit_file src/middleware/auth.ts  done
  ● run_tests  ✅ passed
  ─ done in 14.2s  ·  branch: miii/task-2025-05-17-14-32
```

Parallel file reads. Diff preview before approval. Auto-branched off `main`. Tests ran. Session over.

---

## How Miii Compares

| | **Miii** | Claude Code | OpenCode | Codex CLI | Aider |
|---|:---:|:---:|:---:|:---:|:---:|
| Monthly cost | **$0** | $20–200 | API cost | API cost | $0 |
| Bundle size | **176 KB** | ~50 MB | ~30 MB | ~20 MB | ~200 MB |
| Startup time | **<100ms** | ~2s | ~1s | ~1s | ~4s |
| Local / offline (Ollama) | **✅** | ❌ | partial | ❌ | ⚠️ |
| Air-gapped | **✅** | ❌ | ❌ | ❌ | ❌ |
| Any model | **✅** | ❌ | partial | ❌ | ✅ |
| File checkpoints (undo) | **✅** | ❌ | ❌ | ❌ | ❌ |
| Diff preview before approve | **✅** | ❌ | ❌ | ❌ | ❌ |
| Git auto-branch on edit | **✅** | ❌ | ❌ | ❌ | ❌ |
| Switch provider live | **✅** | ❌ | ❌ | ❌ | ❌ |
| Native tool_calls (Anthropic + OpenAI) | **✅** | ✅ | ✅ | ✅ | ❌ |
| Parallel read-only tools | **✅** | partial | ❌ | ❌ | ❌ |
| Two-phase plan→execute | **✅** | ❌ | ❌ | ❌ | ❌ |
| Live streaming toggle | **✅** | always on | always on | always on | ❌ |
| Semantic codebase index | **✅** | ❌ | ❌ | ❌ | ❌ |
| npm skills | **✅** | plugins | ❌ | ❌ | ❌ |
| MCP client | **✅** | ✅ | ✅ | ❌ | ❌ |
| License | **MIT** | Proprietary | MIT | MIT | Apache 2.0 |

---

## Eight Core Capabilities

**Local / Offline** — Ollama runs on your machine. No internet required after model pull.

**Air-Gapped Ready** — regulated industries, defense, offline infrastructure. miii with Ollama works where cloud literally cannot.

**Any Model** — Llama 3, Mistral, Qwen, Phi, or switch to Anthropic/OpenAI live. One tool, every model.

**File Checkpoints** — every file snapshotted before edit. Abort = full rollback. No bad edits stick.

**Permission Gates + Diff Preview** — approve every write, delete, or command. See the exact diff before you say yes.

**MCP Client** — plug in any MCP-compatible tool server. Tools discovered automatically.

**npm Skills** — extend miii with plain Markdown files or npm packages. Ship reusable agent behaviors to your whole team.

**$0 / Month** — no subscription, no invoice, no API key required for local use.

---

## Features Worth Knowing

**Git Auto-Branch** — first approved edit auto-creates `miii/task-YYYY-MM-DD-HH-MM`. Your `main` is never touched until you decide.

**Parallel Read-Only Tools** — reading five files + git status + web search? All fire at once. Write ops stay sequential. Speed where safe, safety where it matters.

**Two-Phase Plan → Execute**
```
/plan exec refactor the payment module
```
First turn: numbered plan, tools disabled — you read it, decide. Second turn: execution with plan as context. No surprises.

**Native Tool Calls** — Anthropic uses `tool_use` blocks, OpenAI uses `tool_calls` arrays, exactly as the API intended. Faster, more reliable, less hallucination. Ollama uses compact XML fallback.

**Live Streaming Toggle** — turn on in `/config` to watch tokens appear in real time. Turn off for clean batch output. Toggle mid-session, no restart.

**Semantic Codebase Search** — local vector index, no embeddings sent anywhere. `/index build` once. Ask "where is the payment logic?" by meaning, not grep.

---

## Quick Start

```bash
# Local — free, offline (recommended)
ollama pull qwen2.5-coder:7b
npm install -g miii-cli
cd your-project && miii

# Anthropic Claude
npm install -g miii-cli
ANTHROPIC_API_KEY=sk-... miii

# OpenAI or compatible endpoint
npm install -g miii-cli
miii   # set key + base URL in /config
```

Hardware requirements are real — this runs on your machine, not a server farm.

| | Minimum | Recommended |
|---|---|---|
| RAM | 16 GB | 32 GB+ |
| GPU | integrated | dedicated |
| Storage | 10 GB | 20 GB+ |

---

## Commands

| Command | What it does |
|---|---|
| `/config` | Interactive picker — provider, model, API key, base URL, Tavily, streaming |
| `/plan exec <task>` | Two-phase: plan turn (no tools) → execute with plan as context |
| `/think <question>` | Deep research: reads files + web, synthesizes answer |
| `/index build` | Build local semantic vector index |
| `/index search <q>` | Find code by concept, not string match |
| `/git review` | AI reviews current diff — bugs, risks, style |
| `/git commit <msg>` | Stage everything, commit in one shot |
| `/model <name>` | Hot-swap LLM mid-conversation |
| `/session <name>` | Named sessions — resume exactly where you left off |
| `@filename` | Inject any file into context |

Commands open in a picker — select to insert into input, Enter to run.

---

## Configuration

**Interactive:** type `/config` inside miii.

**File-based:** `.miii.json` in project root or `~/.config/miii/config.json` globally:

```json
{
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "gitContext": true,
  "streaming": false,
  "embedModel": "nomic-embed-text"
}
```

---

## MCP — Connect Any Tool Server

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    }
  }
}
```

Drop into global config. Tools discovered automatically.

---

## Semantic Index Setup

```bash
ollama pull nomic-embed-text   # one time
/index build                   # inside your project
# agent calls search_codebase automatically from here
```

---

## Build from Source

```bash
git clone https://github.com/maruakshay/miii-cli
cd miii-cli && npm install && npm run build && npm link
```

---

## Who This Is For

**Privacy-conscious developers** — proprietary code stays on your machine, always.

**Cost-sensitive teams** — API bills compound for every developer on the team, every month.

**Air-gapped environments** — regulated industries, defense, offline infrastructure where cloud is not an option.

**Model experimenters** — benchmark Llama 3 vs Qwen vs Claude vs GPT-4o in the same workflow.

**Anyone who's had an AI silently rewrite something they didn't want rewritten.**

---

The AI coding tools you're paying for will raise prices, change terms, and keep reading your code. Miii won't. MIT licensed, runs locally, gets better every time Ollama ships a new model.

**If this is the tool you've been waiting for — [⭐ star it](https://github.com/maruakshay/miii-cli) and tell someone.**

> Built by [@maruakshay](https://github.com/maruakshay) — PRs, issues, and model recommendations welcome.
> 
> [miii.in](https://www.miii.in)

---

MIT — do whatever you want with it.
