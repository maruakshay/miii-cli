# 🚀 Miii CLI — High-Performance Local AI Coding Agent

**The definitive local AI coding agent for your terminal. Automate complex engineering workflows with total control, zero cloud, and zero Python overhead.**

![MIII Demo](mii-cli.gif)

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![npm downloads](https://img.shields.io/npm/dm/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

## 📊 How Miii Stacks Up

| Feature | **Miii** | Claude Code | Codex CLI | Aider |
|---|---|---|---|---|
| **Runs locally** | ✅ Ollama / any API | ❌ Cloud only | ❌ Cloud only | ✅ Local + cloud |
| **Code stays private** | ✅ Never leaves machine | ❌ Sent to Anthropic | ❌ Sent to OpenAI | ⚠️ Depends on model |
| **Cost** | 🆓 Free (your compute) | 💳 Pay per token | 💳 Pay per token | 🆓 Free (local) |
| **Runtime** | ⚡ TypeScript — instant start | 🐍 Node (fast) | 🐍 Node | 🐢 Python |
| **Deep Think mode** | ✅ Gather + synthesize | ❌ | ❌ | ❌ |
| **Auto-test loop** | ✅ Jest / Vitest / Mocha | ⚠️ Manual | ❌ | ⚠️ Manual |
| **Web search built-in** | ✅ Tavily | ❌ | ❌ | ❌ |
| **Surgical patch edits** | ✅ `patch_file` | ✅ | ⚠️ | ✅ |
| **Session memory** | ✅ Named, persistent | ✅ | ❌ | ⚠️ Basic |
| **Skill / plugin system** | ✅ npm + `.md` skills | ⚠️ MCP only | ❌ | ❌ |
| **Open source** | ✅ MIT | ❌ | ❌ | ✅ Apache 2.0 |

> ✅ = supported &nbsp;|&nbsp; ⚠️ = partial &nbsp;|&nbsp; ❌ = not supported

## ⚡️ Quick Start

Get up and running in 30 seconds:

```bash
ollama pull qwen2.5-coder:7b
npm install -g miii-cli
miii
```

## 🧠 Why Miii?

Most AI coding tools are either heavy Python wrappers or expensive monthly subscriptions that send your code to the cloud. **miii is different.**

- **Local-First & Private**: Runs on Ollama or any OpenAI-compatible API. Your code never leaves your machine, ensuring 100% privacy and security.
- **Blazing Fast**: Built with TypeScript for near-instant startup. No heavy Python runtime overhead. Tiny footprint, massive power.
- **Fully Autonomous**: Miii doesn't just suggest code; it acts as a junior engineer—editing files, running your test suite, and iterating until the bugs are gone.
- **Deep Context Awareness**: Automatically analyzes git diffs and project architecture, eliminating the need for manual copy-pasting.

## 🔥 Killer Features

- **🛠 Precision Editing**: Using `patch_file`, miii makes surgical changes without rewriting entire files.
- **🔄 Auto-Test Loop**: Miii runs your Jest/Vitest/Mocha tests after every edit. If it breaks, it fixes itself.
- **🌐 Web Intelligence**: Integrated `web_search` and `web_extract` via Tavily for real-time documentation.
- **🧠 Deep Think**: Two-phase research mode — gathers from files, git, and web first, then synthesizes a complete answer. Available as `/think <query>` or as a tool the LLM calls autonomously.
- **📐 Planning Mode**: Use `/plan` to architect a solution before a single line of code is written.
- **📂 Session Memory**: Every conversation is auto-named and persisted. Resume your work instantly with `miii --session feature-auth`.
- **📦 Skill System**: Extend miii with npm skill plugins or custom `.md` files.

## 🧠 Deep Think

Deep think is a two-phase research engine built into miii:

1. **Gather phase** — runs a constrained inner loop with read-only tools: `read_file`, `list_files`, `git_status`, `git_log`, `git_diff`, `web_search`, `web_extract`. Guardrails enforce a hard cap of 6 tool calls and 4 web calls. No file writes, no shell mutations.
2. **Synthesize phase** — gathered findings feed into the main run loop for a complete, grounded answer.

**Two ways to trigger:**

```
/think how does the auth middleware handle token expiry?
/think what does this codebase do and how is it structured?
/think latest breaking changes in react 19
```

The LLM can also call `deep_think` autonomously mid-conversation when it decides a question needs multi-source research before answering.

> Requires a Tavily key (`/tavily-key tvly-...`) for web calls. File/git research works without it.

## ⌨️ Command Cheat Sheet

| Command | What it does |
|---|---|
| `/think <query>` | Deep research: gather from files + web, then synthesize answer |
| `/refactor <goal>` | The powerhouse: plans, edits, and tests across your whole codebase |
| `/git <sub>` | Instant git status, diffs, and automated commit messages |
| `/plan` | Stop coding, start thinking (Structured Planning Mode) |
| `/model <name>` | Swap LLMs on the fly |
| `/tavily-key <key>` | Enable real-time web browsing |
| `/sessions` | Travel back in time to previous coding sessions |

## ⚙️ Configuration

Customise your experience in `.miii.json` or `~/.config/miii/config.json`:

```json
{
  "model": "qwen2.5-coder:7b",
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "gitContext": true,
  "tavilyApiKey": "tvly-..."
}
```

## 🛠 Build from Source

```bash
git clone https://github.com/maruakshay/miii-cli
cd miii-cli && npm install && npm run build && npm link
```

## 🌟 Community & Philosophy

**Own your AI stack. Stop renting your intelligence. The future of coding is local.**

miii is built for the community. If this tool saves you hours of coding, help us grow:
- 🌟 **Star the repo** on GitHub
- 🐦 **Share on X**
- 🤖 **Post on Reddit**
- 💬 **Tell a fellow developer**

## 📜 License
MIT