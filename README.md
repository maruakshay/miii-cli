<h1 align="center">miii</h1>

<p align="center">
  <strong>🇮🇳 Made in India. Free forever. Works with any model.</strong><br>
  A professional-grade coding agent for your terminal — it plans, reads, writes, and verifies code.<br>
  Bring your own keys (Claude, GPT, Gemini, DeepSeek) or run it 100% locally on your GPU.
</p>

<p align="center">
  <em>Apna code, apna model, apni marzi.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/miii-agent"><img src="https://img.shields.io/npm/v/miii-agent" alt="miii-agent npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="requires Node 18 or newer"></a>
  <img src="https://img.shields.io/badge/providers-14%2B-8A2BE2" alt="14+ model providers">
  <img src="https://img.shields.io/badge/Made%20in-India%20%F0%9F%87%AE%F0%9F%87%B3-FF9933" alt="Made in India">
  <a href="https://github.com/sponsors/maruakshay"><img src="https://img.shields.io/github/sponsors/maruakshay?label=sponsor&logo=githubsponsors&color=EA4AAA" alt="Sponsor miii on GitHub"></a>
</p>

<p align="center">
  <img src="demo4.gif" alt="miii local AI coding agent running in a terminal, powered by Ollama">
</p>

<p align="center">
  🆓 <strong>Free &amp; open source — no account, no subscription</strong> &nbsp;·&nbsp;
  🔌 <strong>Any provider, one tool</strong> &nbsp;·&nbsp;
  ⚡ <strong>Install to first edit in a minute</strong>
</p>

## 🎯 Why miii?
 
Most agentic coding tools lock you into a single vendor, a monthly subscription, and bills in dollars.
 
miii brings the professional "plan → edit → run → verify" workflow to everyone, on their own terms. Use the best hosted models for complex tasks, free tiers for experimentation, or local models for complete privacy. No accounts, no subscriptions—just your code and your choice of AI.

## 🚀 Get started in 60 seconds
 
### 1. Install
```bash
npm i -g miii-agent
```
 
### 2. Run
Pick your preferred backend:
 
**Hosted** (uses existing env keys like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
```bash
miii provider add gemini
miii
```
 
**Local** (100% free, offline, no account needed)
```bash
ollama pull qwen3-coder:30b
miii
```
 
Switch anytime with `/provider` inside miii.
 
### 3. Code
Talk to it like a teammate:
 
```
> refactor the auth module to use async/await
> @src/server.ts add rate limiting to all POST routes
> why are my tests failing in utils/parser.ts
```
 
It plans before it acts, and runs your test suite before it claims to be done.
 
> [!TIP]
> **Windows Users:** Use `irm https://raw.githubusercontent.com/maruakshay/miii-cli/main/install.ps1 | iex`. 
> *Needs Node 18+ and a POSIX shell (git-bash or WSL); otherwise, miii falls back to Node's filesystem calls.*

## 🔌 Your model, your choice
 
One command wires up any backend: `/provider add <name>` inside miii, or
`miii provider add <name>` from your shell. The endpoint is built-in; the key comes from
the environment variable you already export.
 
| ☁️ Hosted (your key)                                                                    | 🏠 Local (free, offline)          |
|----------------------------------------------------------------------------------------|----------------------------------|
| Anthropic · OpenAI · Gemini · Groq · OpenRouter · DeepSeek · Mistral · Together · xAI | Ollama · LM Studio · llama.cpp · vLLM  |
 
Anything else that speaks the OpenAI protocol works too: `/provider add <name> <baseUrl>`.
 
**Paying nothing is a real option.** miii is free, local models are free, and providers
like Gemini, Groq, OpenRouter, and Cerebras offer free tiers — enough to get real work done
without a credit card.

|            | Single-vendor agents   | **miii**                                  |
|------------|------------------------|-------------------------------------------|
| The tool   | Subscription           | Free, MIT-licensed                        |
| Models     | One vendor's           | 14+ providers, or your own GPU            |
| Setup      | Account + login        | `npm i -g miii-agent`                     |
| Your code  | Goes to that vendor    | Goes where you choose — or stays local    |
| Offline    | No                     | Yes, with a local model                   |

## ✨ Power Features
 
miii delivers the advanced workflow of top-tier agents without the vendor lock-in:
 
- **⚖️ Decision Box** — A second, smaller model verifies if the work is *actually* complete before the agent stops. No more false positives.
- **📋 Plan Mode** — Use `/plan` for a read-only session. miii researches and proposes a strategy; nothing is written until you approve.
- **🔒 Permission-Gated** — You are in control. Approve every file write and shell command. Rules persist in `.miii/permissions.json`.
- **⟲ /rewind** — Undo agent changes *and* the conversation history. Checkpoints make experimenting risk-free.
- **🧩 Subagents** — Delegated `task` loops handle complex searches in their own context, returning only the final answer.
- **🧠 Model-Aware** — miii handles broken tool calls from smaller models and optimizes prompts for various context windows.
- **🔀 Hot-Swapping** — Use `/provider` and `/models` to switch backends instantly without restarting your session.
- **🔌 MCP Support** — Connect to GitHub, Postgres, or your own internal services via Model Context Protocol.
- **🪝 Shell Hooks** — Trigger custom commands on tool events (e.g., auto-format on write or block specific paths).
- **🖥️ Headless Mode** — Run `miii -p "prompt"` for scripts, CI/CD, or piping git diffs directly into the agent.
- **🐚 Shell-Backed Edits** — Operations run through the shell for maximum compatibility, with a robust Node.js fallback.

<details>
<summary><strong>Every slash command</strong></summary>

`/plan` · `/models` · `/provider` · `/agents` · `/mcp` · `/permissions` · `/rewind` ·
`/sessions` · `/memory` · `/context` · `/compact` · `/cost` · `/review` · `/init` ·
`/export` · `/copy` · `/settings` · `/vim` · `/new` · `/clear`

</details>

## 🏠 Going local? Pick a model for your GPU
 
Budget a few GB above the download size for the context window.
 
| VRAM    | Recommended Model              | Size    | Note                               |
|---------|--------------------------------|---------|-------------------------------------|
| < 4GB   | `qwen2.5-coder:3b`             | 1.9 GB  | Fast, lightweight                   |
| 8GB     | `qwen2.5-coder:7b`             | 4.7 GB  | Great balance                      |
| 12–16GB | `qwen2.5-coder:14b`            | 9.0 GB  | Professional grade                 |
| 16–24GB | `gpt-oss:20b` · `devstral:24b` | ~14 GB  | High reasoning                     |
| 24GB+   | `qwen3-coder:30b` ⭐            | 18.6 GB | State-of-the-art local coding      |
 
**Pro Tip:** Tool-calling is what separates a usable agent from a frustrating one. `qwen3-coder` and `devstral` are natively trained for it; miii automatically repairs calls from other models to keep them working.

## FAQ

<details>
<summary><strong>Is miii really free?</strong></summary>

Yes. miii itself is MIT-licensed with no paid tier, no account and no sign-up. What you
pay for is the model: nothing if it runs on your machine, and whatever your provider
charges if you use a hosted one — several of which have free tiers.
</details>

<details>
<summary><strong>Is my code ever uploaded?</strong></summary>

With a local provider, your code only ever travels to `localhost`. No telemetry and
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

No. Use a hosted provider and any laptop will do. For fully local models you want one — `qwen2.5-coder:3b` runs on CPU, but it will be slow and it will need
more hand-holding. Apple Silicon works well — unified memory counts as VRAM here.
</details>

<details>
<summary><strong>Why not just use Claude Code / Cursor?</strong></summary>

Use them if you can. miii is for when you want the same workflow without being tied to
one vendor or one subscription: pick any model, pay only for what that model costs,
or go fully offline for air-gapped work, NDA'd code, or a flight with no wifi.
</details>

## Sponsor miii 💛

miii is built and maintained independently, from India, with no VC money and no paid tier.
Sponsorship is what keeps it that way — it pays for GPU and API time to evaluate new
models across providers, test hardware, and the hours that go into making every model,
big or small, behave like a real coding agent.

- **Individuals** — [GitHub Sponsors](https://github.com/sponsors/maruakshay), any amount, one-time or monthly.
- **Companies** — if your team uses miii for private or air-gapped work, sponsoring gets
  your logo here and a direct line for the features you need. Open an issue or reach out
  via [GitHub](https://github.com/maruakshay).
- **Free ways to help** — star the repo, share it with your dev community, file issues,
  and send PRs.

<!-- Sponsor logos go here -->

## Contributing

Issues and PRs are welcome from anyone, anywhere. Good places to start: model
compatibility reports (which models work well on which hardware), bug reports with a
repro, and docs improvements.

---

<p align="center">
  <strong>⭐ Star it if you think great coding tools should be free for everyone.</strong><br>
  <sub>Built with ❤️ in India 🇮🇳 · MIT © <a href="https://github.com/maruakshay">maruakshay</a></sub>
</p>
