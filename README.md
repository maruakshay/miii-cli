# 🚀 MIII - CLI

**The fastest, local AI coding assistant. Zero cloud. Zero Python. Total Control.**

![MIII Demo](mii-cli.gif)

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![npm downloads](https://img.shields.io/npm/dm/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

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

## ⚡️ Quick Start

Get up and running in 30 seconds:

```bash
ollama pull qwen2.5-coder:7b
npm install -g miii-cli
miii
```

## 🧠 Why miii?

Most AI coding tools are either heavy Python wrappers or expensive monthly subscriptions that send your code to the cloud. **miii is different.**

- **Local-First**: Runs on Ollama or any OpenAI-compatible API. Your code stays on your machine.
- **Blazing Fast**: Written in TypeScript. No Python overhead. 176K bundle size.
- **Autonomous**: Doesn't just suggest code; it edits files, runs your tests, and fixes bugs until they are gone.
- **Context Aware**: Automatically injects git diffs and project structure so you don't have to copy-paste.

## 🔥 Killer Features

- **🛠 Precision Editing**: Using `patch_file`, miii makes surgical changes without rewriting entire files.
- **🔄 Auto-Test Loop**: Miii runs your Jest/Vitest/Mocha tests after every edit. If it breaks, it fixes itself.
- **🌐 Web Intelligence**: Integrated `web_search` and `web_extract` via Tavily for real-time documentation.
- **📐 Planning Mode**: Use `/plan` to architect a solution before a single line of code is written.
- **📂 Session Memory**: Every conversation is auto-named and persisted. Resume your work instantly with `miii --session feature-auth`.
- **📦 Skill System**: Extend miii with npm skill plugins or custom `.md` files.

## ⌨️ Command Cheat Sheet

| Command | What it does |
|---|---|
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

**Own your AI stack. Stop renting your intelligence.**

miii is built for the community. If this tool saves you hours of coding, help us grow:
- 🌟 **Star the repo** on GitHub
- 🐦 **Share on X**
- 🤖 **Post on Reddit**
- 💬 **Tell a fellow developer**

## 📜 License
MIT