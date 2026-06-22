<h1 align="center">miii</h1>

<p align="center">
  <strong>Small. Simple. Smart. Strategic. Semantic.</strong>
</p>

<p align="center">
  A local-first AI coding agent that lives in your terminal.<br>
  Your code never leaves your machine. No API keys. No cloud. No bullshit.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/miii-agent"><img src="https://img.shields.io/npm/v/miii-agent" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node version"></a>
  <a href="https://ollama.com"><img src="https://img.shields.io/badge/powered%20by-Ollama-black" alt="powered by Ollama"></a>
</p>

miii is a local-first AI coding agent that lives in your terminal. Powered by [Ollama](https://ollama.com) — or any OpenAI-compatible local server like [llama.cpp](https://github.com/ggml-org/llama.cpp) and [LM Studio](https://lmstudio.ai) — it reads your code, writes features, runs tests, and fixes bugs entirely on your hardware, at native speed.

---

## Contents

- [Demo](#demo)
- [The Local-First Advantage](#the-local-first-advantage)
- [Core Philosophy](#core-philosophy)
- [Quick Start](#quick-start)
- [Interaction Guide](#interaction-guide)
- [Technical Deep Dive](#technical-deep-dive)
- [Configuration](#configuration)
- [System Architecture](#system-architecture)
- [Development](#development)
- [Project Status](#project-status)
- [License](#license)

---

## Demo

![miii demo](demo.gif)

---

## The Local-First Advantage

Most AI coding tools are wrappers around cloud APIs. They are slow, expensive, and require you to trust your private codebase to a third-party server.

miii flips the script:

- **Absolute Privacy** — Powered by Ollama, llama.cpp, or any local OpenAI-compatible server. Your code stays on your disk, period.
- **Zero Friction** — No API keys, no billing, no accounts. Just `miii`.
- **True Agency** — miii doesn't just chat; it decomposes problems, invokes tools, and verifies results like a senior engineer.
- **Native Performance** — No network round-trips. Latency is limited by your GPU, not a CDN.

|                | Cloud AI agents          | **miii**                     |
|----------------|--------------------------|------------------------------|
| Your code      | Sent to a third party    | Never leaves your machine    |
| Cost           | Per-token billing        | Free — runs on your hardware |
| Setup          | API keys, accounts       | `npm i -g miii-agent`        |
| Offline        | No                       | Yes                          |
| Latency        | Network + queue          | Your GPU only                |

---

## Core Philosophy

miii is built on five foundational principles:

- **small** — A tight, bloat-free codebase. You can read the entire project in an afternoon.
- **simple** — No configuration ceremony. Install and run.
- **smart** — Decomposes complex tasks and verifies its own work.
- **strategic** — Plans before acting; tools are gated and paths are confined.
- **semantic** — Operates on the meaning of your code, not blind text matching.

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 18
- **Ollama** running locally — [Download here](https://ollama.com/download)
- A coding model pulled locally:

```bash
ollama pull qwen2.5-coder:14b
# or any model you prefer
ollama pull deepseek-coder-v2
```

### Installation & Launch

```bash
npm install -g miii-agent
miii
```

---

## Interaction Guide

Inside the TUI, interact naturally:

```
> refactor the auth module to use async/await
> @src/server.ts add rate limiting to all POST routes
> why are my tests failing in utils/parser.ts
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send prompt |
| `@filename` | Attach file to context |
| `/models` | Switch active Ollama model |
| `/clear` | Reset conversation history |
| `Esc` | Stop current generation or tool run |
| `Ctrl+O` | Toggle full tool output view |
| `Ctrl+C` | Quit |

### Project Instructions (`MIII.md`)

Drop a `MIII.md` file in your project and miii reads it first, every turn — the same idea as `CLAUDE.md`. Use it to teach the agent your conventions, build/test commands, architecture, and do's and don'ts.

```markdown
# MIII.md
- Use tabs, not spaces.
- Run `npm test` before declaring any task done.
- The HTTP layer lives in src/server/ — never import it from src/core/.
```

miii searches upward from the working directory to the repo root (the directory containing `.git`); the nearest `MIII.md` wins. It is treated as authoritative — higher priority than the agent's defaults — except it can never override the permission system or safety boundaries. Files over 32KB are truncated.

---

## Technical Deep Dive

### Capabilities

miii ships with a built-in tool suite that the agent invokes autonomously:

| Tool | Function |
|------|----------|
| `read_file` | Read any file in your workspace |
| `write_file` | Create new files |
| `edit_file` | Precise string-level edits with whitespace tolerance (no rewrites) |
| `glob` | Pattern-match files across the project |
| `grep` | Regex search across files |
| `run_bash` | Execute shell commands |

**Security & Safety:** Every sensitive operation is gated by a permission system. You approve what the agent can touch, and "always" approvals persist to `~/.miii/permissions.json`. The file tools (`read_file`, `write_file`, `edit_file`) are strictly confined to your working directory; `../` traversal and absolute paths outside the workspace are rejected. `run_bash` runs arbitrary shell commands and is **not** path-confined — its only boundary is the permission prompt, so review commands before approving (especially "always").

### Lossless Output Spill

Big tool outputs (like 50K-line test logs) usually get truncated, leaving the model to guess. miii doesn't truncate; it **spills**.

When a tool result exceeds the inline budget (~10K bytes), the full output is written to `~/.miii/output/<id>.txt`. Only a head + tail **preview** is inlined, followed by a pointer:

```
[command output truncated: 5184 lines / 412900 bytes.
 Full output at ~/.miii/output/9f3a1c.txt — read it with
 read_file offset/limit to see the elided middle.]
```

If the model needs the elided middle, it pages through it using `read_file` ranged reads. Nothing is ever lost. Spill files are garbage-collected after 24 hours.

### The Model Doctor

Not every local model can drive an agent. A model that cannot emit clean tool calls will simply chat at you instead of editing files. `miii doctor` validates your installed models against concrete engineering tasks.

```bash
miii doctor                     # check every local model (from `ollama list`)
miii doctor qwen2.5-coder:7b    # check one model
miii doctor gemma4:e4b grep     # check one model against "grep" scenarios
```

It verifies outcomes (did the file actually change?) and prints a verdict:

```
=== qwen3-coder ===
PASS  edit-exact-string   ...
PASS  read-then-answer    ...
PASS  create-new-file     ...
PASS  grep-locate         ...
  → qwen3-coder: 4/4 — ready

=== gemma4:e4b ===
  → gemma4:e4b: 1/4 — not recommended — weak tool-calling
```

---

## Configuration

Settings live in `~/.miii/config.json` and are created on first run.

```json
{
  "model": "qwen2.5-coder:14b",
  "ollamaHost": "http://localhost:11434",
  "effort": "medium"
}
```

| Field | Description | Values |
|-------|-------------|--------|
| `model` | Default Ollama model | any `ollama list` model |
| `ollamaHost` | Ollama API endpoint | URL string |
| `effort` | Controls temperature & limits | `low` \| `medium` \| `high` |

### Other Local Backends

Ollama is the default, but miii talks to any **OpenAI-compatible** local server — so you can run [llama.cpp](https://github.com/ggml-org/llama.cpp) or [LM Studio](https://lmstudio.ai) instead. Your code still never leaves your machine.

Start `llama-server` (ships with llama.cpp), then point a named provider at it:

```bash
llama-server -m ./qwen2.5-coder-14b.gguf --port 8080
```

```json
{
  "model": "qwen2.5-coder-14b",
  "provider": "llamacpp",
  "providers": {
    "llamacpp": { "type": "openai", "baseUrl": "http://localhost:8080" }
  }
}
```

| Field | Description | Values |
|-------|-------------|--------|
| `provider` | Active provider name (keys into `providers`) | e.g. `ollama`, `llamacpp` |
| `providers.<name>.type` | Wire protocol | `ollama` \| `openai` |
| `providers.<name>.baseUrl` | Server endpoint | URL string |
| `providers.<name>.apiKey` | Optional bearer token | string |

Switch the active provider at launch with `miii --provider llamacpp`. Any `openai`-type provider on a `localhost` URL counts as local — no key, no cloud.

---

## System Architecture

```mermaid
graph TD
    User["User (Terminal)"] -->|"prompt / @file / /cmd"| InputBar

    subgraph TUI ["Ink TUI (React)"]
        InputBar["InputBar"] --> App["App.tsx"]
        App --> ChatView["ChatView"]
        App --> CommandPalette["CommandPalette\n(/models, /clear)"]
        App --> FilePicker["FilePicker (@file)"]
        App --> ModelsView["ModelsView"]
    end

    App -->|"user message"| AgentLoop["Agent Loop\n(agent/loop.ts)"]

    subgraph Agent ["Agent Layer"]
        AgentLoop -->|"chat request"| Adapter["Ollama Adapter\n(agent/adapter.ts)"]
        AgentLoop -->|"1. validate input"| Validate["Input Validator\n(tools/validate.ts)"]
        AgentLoop -->|"2. permission check"| Policy["Permission Policy\n(permissions/policy.ts)"]
        AgentLoop -->|"3. tool call"| ToolRegistry["Tool Registry\n(tools/registry.ts)"]
        AgentLoop -->|"events"| EventBus["Event Bus\n(hooks/bus.ts)"]
    end

    subgraph Tools ["Tools"]
        ToolRegistry --> ReadFile["read_file"]
        ToolRegistry --> WriteFile["write_file"]
        ToolRegistry --> EditFile["edit_file"]
        ToolRegistry --> Glob["glob"]
        ToolRegistry --> Grep["grep"]
        ToolRegistry --> RunBash["run_bash"]
        ReadFile -.-> Confine["Path Confinement\n(tools/paths.ts)"]
        WriteFile -.-> Confine
        EditFile -.-> Confine
        RunBash -->|"large output"| SpillMod["Output Spill\n(tools/spill.ts)"]
        Grep -->|"large output"| SpillMod
        Glob -->|"large output"| SpillMod
        SpillMod -.->|"head+tail preview\n+ read pointer"| ToolRegistry
    end

    Adapter -->|"HTTP streaming"| Ollama["Ollama\n(local LLM server)"]
    Ollama -->|"model response\n+ tool calls"| Adapter

    Tools -->|"tool results"| AgentLoop
    EventBus -->|"stream events"| ChatView

    subgraph Storage ["Local Storage"]
        Config["~/.miii/config.json\n(model, host, effort)"]
        Rules["~/.miii/permissions.json\n(saved allow rules)"]
        Spill["~/.miii/output/\n(spilled tool output)"]
    end

    App -.->|"reads"| Config
    Policy -.->|"reads / persists 'always'"| Rules
    SpillMod -.->|"writes full output"| Spill
    ReadFile -.->|"pages elided middle\n(offset/limit)"| Spill
```

---

## Development

### Setup

```bash
git clone https://github.com/maruakshay/miii-cli.git
cd miii-cli
npm install
npm run dev
```

### Build & Test

```bash
npm run build       # production build
npm run start       # run built output
npm run typecheck   # type-check src + eval
npm run eval        # run the eval harness as a CI / regression gate
```

The eval harness in `eval/` powers `miii doctor` and serves as a regression gate. If `npm run eval` exits non-zero, a prompt or tool change has regressed a baseline model.

### Testing Local Changes

The global `miii` command points to the last installed version of `miii-agent`. To run your local working tree:

```bash
node dist/cli.js doctor <model>   # run the freshly built output directly
# — or —
npm run build && npm link         # point the global `miii` at this repo
```

`npm link` symlinks the global `miii` to `dist/cli.js` in this repo. Restore the published version later with `npm install -g miii-agent`.

---

## Project Status

**MVP.** Core agent loop is stable. Actively refining tool execution, streaming, and the permission model. PRs are welcome — fork it, break it, improve it.

---

## License

MIT © [maruakshay](https://github.com/maruakshay)

---

<p align="center">
  Built for engineers who'd rather own their tools than rent them.
</p>
