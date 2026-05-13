# 🚀 Miii CLI — High-Performance Local AI Coding Agent

**The definitive local AI coding agent for your terminal. Automate complex engineering workflows with total control, zero cloud, and zero Python overhead.**

![MIII Demo](mii-cli.gif)

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![npm downloads](https://img.shields.io/npm/dm/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

## 📊 The Competitive Edge

| Feature | **Miii** | Claude Code | Codex CLI | Aider |
|---|---|---|---|---|
| **Execution Environment** | ✅ Local / Hybrid | ❌ Cloud only | ❌ Cloud only | ✅ Local + cloud |
| **Data Privacy** | ✅ Air-gapped possible | ❌ Cloud-streamed | ❌ Cloud-streamed | ⚠️ Model-dependent |
| **Cost Structure** | 🆓 Free (Your Compute) | 💳 Token-based | 💳 Token-based | 🆓 Free (local) |
| **Runtime Efficiency** | ⚡ TS (Instant Start) | 🐍 Node (Fast) | 🐍 Node | 🐢 Python (Heavy) |
| **Research Engine** | ✅ Deep Think Mode | ❌ | ❌ | ❌ |
| **Validation Loop** | ✅ Auto-test (Jest/Vitest) | ⚠️ Manual | ❌ | ⚠️ Manual |
| **Live Web Access** | ✅ Tavily Integrated | ❌ | ❌ | ❌ |
| **Edit Precision** | ✅ Surgical `patch_file` | ✅ | ⚠️ | ✅ |
| **State Persistence** | ✅ Named Sessions | ✅ | ❌ | ⚠️ Basic |
| **Extensibility** | ✅ npm + `.md` Skills | ⚠️ MCP only | ❌ | ❌ |
| **License** | ✅ MIT | ❌ | ❌ | ✅ Apache 2.0 |

> ✅ = Native &nbsp;|&nbsp; ⚠️ = Partial &nbsp;|&nbsp; ❌ = Unsupported

## ⚡️ Quick Start

Deploy Miii in your environment in 30 seconds:

```bash
# 1. Pull a capable local model
ollama pull qwen2.5-coder:7b

# 2. Install the CLI globally
npm install -g miii-cli

# 3. Start engineering
miii
```

## 🧠 Why Miii?

The industry is saturated with heavy Python wrappers and expensive monthly subscriptions that trade your intellectual property for convenience. **Miii breaks this cycle.**

- **Privacy by Default**: Your codebase never leaves your machine. Period.
- **Zero Latency**: Built with TypeScript for near-instant startup. No virtual environments, no dependency hell, just raw performance.
- **True Autonomy**: Miii isn't a chatbot; it's a junior engineer. It plans, edits, runs tests, and iterates until the PR is ready.
- **Architectural Intelligence**: By analyzing git diffs and project structure, Miii understands context without requiring manual copy-pasting.

## 🔥 Killer Features

- **🛠 Surgical Precision**: Instead of overwriting files, Miii uses `patch_file` to inject changes, preserving your formatting and reducing token waste.
- **🔄 The Self-Healing Loop**: Miii executes your test suite (Jest, Vitest, Mocha) after every change. If a test fails, it analyzes the trace and fixes the code autonomously.
- **🌐 Real-time Intelligence**: Integrated `web_search` and `web_extract` via Tavily allow Miii to reference the latest documentation and API changes.
- **🧠 Deep Think Engine**: A sophisticated two-phase research mode that gathers data before synthesizing a solution.
- **📐 Strategic Planning**: Use `/plan` to map out complex refactors before a single character is typed.
- **📂 Persistent Context**: Workflows are saved as named sessions. Jump back into a specific feature branch with `miii --session feature-auth`.
- **📦 Modular Skill System**: Extend Miii's capabilities using npm plugins or simple Markdown-based skill files.

## 🔬 Deep Think Explained

Deep Think is a recursive research engine designed to eliminate "hallucinations" by grounding the AI in facts:

1. **Gather Phase**: A constrained, read-only loop utilizing `read_file`, `list_files`, `git_status`, `git_log`, `git_diff`, and web tools. 
   - **Guardrails**: Strict limit of 6 tool calls and 4 web calls to prevent infinite loops.
   - **Safety**: Zero write permissions. No mutations.
2. **Synthesize Phase**: All gathered intelligence is aggregated and fed into the main execution loop for a grounded, verified response.

**Trigger Research:**
```bash
/think "How does the auth middleware handle token expiry?"
/think "Analyze the project structure and explain the data flow."
/think "What are the breaking changes in React 19 for this project?"
```
*The LLM also triggers `deep_think` autonomously when it detects a high-complexity query.*

## ⌨️ Command Cheat Sheet

| Command | Purpose | Impact |
|---|---|---|
| `/think <query>` | Deep Research | High-fidelity synthesis of files + web |
| `/refactor <goal>` | Full-scale Engineering | Plan $\rightarrow$ Edit $\rightarrow$ Test loop |
| `/git <sub>` | Git Automation | Instant status, diffs, and AI commit messages |
| `/plan` | Architecture Mode | Structured blueprinting before coding |
| `/model <name>` | LLM Hot-swap | Switch models instantly based on task |
| `/tavily-key <key>` | Enable Web Access | Unlocks real-time internet browsing |
| `/sessions` | Context Recovery | Resume previous engineering sessions |

## ⚙️ Configuration

Fine-tune your agent in `.miii.json` or `~/.config/miii/config.json`:

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

**Stop renting your intelligence. Own your AI stack.**

Miii is built for engineers who value privacy, speed, and total control. If this tool has accelerated your workflow, support the project:
- 🌟 **Star the repo** on GitHub
- 🐦 **Share your wins** on X
- 🤖 **Discuss the future** on Reddit

## 📜 License
MIT