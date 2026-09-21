<h1 align="center">miii</h1>

<p align="center">
  <strong>Claude Code, but it runs on your own GPU.</strong><br>
  An open-source terminal coding agent that reads your files, writes the code,<br>
  runs your tests, and fixes what breaks — without sending a single line to anyone.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/miii-agent"><img src="https://img.shields.io/npm/v/miii-agent" alt="miii-agent npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="requires Node 18 or newer"></a>
  <a href="https://ollama.com"><img src="https://img.shields.io/badge/powered%20by-Ollama-black" alt="powered by Ollama"></a>
</p>

<p align="center">
  <img src="demo3.gif" alt="miii local AI coding agent running in a terminal, powered by Ollama">
</p>

<p align="center">
  🔒 <strong>Your code never leaves your machine</strong> &nbsp;·&nbsp;
  💸 <strong>$0 per token, forever</strong> &nbsp;·&nbsp;
  ✈️ <strong>Works on a plane</strong>
</p>

## 60 seconds to your first edit

```bash
ollama pull qwen3-coder:30b   # any coding model works
npm i -g miii-agent
miii
```

Then talk to it like a teammate:

```
> refactor the auth module to use async/await
> @src/server.ts add rate limiting to all POST routes
> why are my tests failing in utils/parser.ts
```

It plans before it acts, and runs your test suite before it claims to be done.

<sub>Windows: `irm https://raw.githubusercontent.com/maruakshay/miii-cli/main/install.ps1 | iex` · Needs Node 18+ and a POSIX shell (git-bash or WSL on Windows; without one, file tools fall back to Node's own filesystem calls).</sub>

## Why you might want this

|            | Cloud agents          | **miii**                     |
|------------|-----------------------|------------------------------|
| Your code  | Sent to a third party | Never leaves your machine    |
| Cost       | Per-token billing     | Free — runs on your hardware |
| Setup      | API keys, accounts    | `npm i -g miii-agent`        |
| Offline    | No                    | Yes                          |
| Latency    | Network + queue       | Your GPU only                |
| Rate limits| Yes                   | Your patience                |

The honest trade: a 30B model on your desk is not Opus. miii spends its engineering
on closing that gap — repairing malformed tool calls, re-indenting sloppy edits,
and refusing to stop on a half-finished task.

## What's actually in the box

- **⚖️ Decision Box** — A second, smaller model judges whether the work is *really* done before the agent stops. No more "I've updated the file!" when it hasn't.
- **📋 Plan Mode** — `/plan` makes the session read-only. It researches, then proposes. Nothing is written until you approve.
- **🔒 Permission-Gated** — You approve every write and every command. Saved rules persist in `.miii/permissions.json`.
- **⟲ /rewind** — Undo the agent's changes *and* the conversation, back to any previous turn. Checkpoints make bad turns cheap.
- **🧩 Subagents** — Delegated `task` loops burn their own context on a search, and hand back only the answer.
- **🧠 Model-Aware** — Small models emit broken tool calls. miii parses them anyway, and reshapes the prompt to fit your context window.
- **🔌 MCP Support** — Connect GitHub, Postgres, or internal services over Model Context Protocol.
- **🪝 Shell Hooks** — Fire your own commands on tool events — format on write, block a path, log everything.
- **🖥️ Headless** — `miii -p "prompt"` for scripts, CI, or piping a git diff straight in.
- **🐚 Shell-Backed Edits** — Reads and writes go through the shell, confined to your working directory, with a filesystem fallback when there's no shell.

<details>
<summary><strong>Every slash command</strong></summary>

`/plan` · `/models` · `/provider` · `/agents` · `/mcp` · `/permissions` · `/rewind` ·
`/sessions` · `/memory` · `/context` · `/compact` · `/cost` · `/review` · `/init` ·
`/export` · `/copy` · `/settings` · `/vim` · `/new` · `/clear`

</details>

## Bring your own backend

Local is the default, not the limit. `/provider add <name>` wires up a backend from a
preset — the endpoint is known, the key comes from the environment variable you already export.

| Local (no key)                        | Hosted (your key)                                                                               |
|---------------------------------------|-------------------------------------------------------------------------------------------------|
| Ollama · LM Studio · llama.cpp · vLLM | Anthropic · OpenAI · Gemini · Groq · OpenRouter · DeepSeek · Mistral · Together · Cerebras · xAI |

Anything else that speaks the OpenAI protocol works too: `/provider add <name> <baseUrl>`.

## Which model?

Budget a few GB above the download size for the context window.

| VRAM    | Model                          | Size    |
|---------|--------------------------------|---------|
| < 4GB   | `qwen2.5-coder:3b`             | 1.9 GB  |
| 8GB     | `qwen2.5-coder:7b`             | 4.7 GB  |
| 12–16GB | `qwen2.5-coder:14b`            | 9.0 GB  |
| 16–24GB | `gpt-oss:20b` · `devstral:24b` | ~14 GB  |
| 24GB+   | `qwen3-coder:30b` ⭐            | 18.6 GB |

Tool-calling is what separates a usable agent model from a frustrating one. `qwen3-coder`
and `devstral` are trained for it; miii repairs the calls from everything else.

## FAQ

<details>
<summary><strong>Is my code really never uploaded?</strong></summary>

With a local provider, your code only ever travels to `localhost:11434`. No telemetry and
no analytics — the one outbound call miii makes on its own is a version check against
`registry.npmjs.org`, which carries nothing but the package name. Add a hosted provider
and that provider sees what you send it, which is why local is the default.
</details>

<details>
<summary><strong>Can it break my repo?</strong></summary>

Every write and every shell command asks first, and file tools are confined to the
working directory. When something does go wrong, `/rewind` puts the files and the
conversation back.
</details>

<details>
<summary><strong>Do I need a GPU?</strong></summary>

No, but you want one. `qwen2.5-coder:3b` runs on CPU; it will be slow and it will need
more hand-holding. Apple Silicon works well — unified memory counts as VRAM here.
</details>

<details>
<summary><strong>Why not just use Claude Code / Cursor?</strong></summary>

Use them if you can. miii is for the cases where you can't or won't: air-gapped work,
NDA'd code, a token budget of zero, or a flight with no wifi.
</details>

---

<p align="center">
  <strong>⭐ Star it if your code should stay yours.</strong><br>
  <sub>Issues and PRs welcome · MIT © <a href="https://github.com/maruakshay">maruakshay</a></sub>
</p>
