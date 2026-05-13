# Miii — The High-Performance Local AI Coding Agent

> **You're paying $200/month for an AI that reads your private code and sends it to a cloud server you don't control. There's a better way.**

![MIII Demo](mii-cli.gif)

[![npm version](https://img.shields.io/npm/v/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![npm downloads](https://img.shields.io/npm/dm/miii-cli)](https://www.npmjs.com/package/miii-cli)
[![license](https://img.shields.io/npm/l/miii-cli)](LICENSE)
[![node](https://img.shields.io/node/v/miii-cli)](https://nodejs.org)

---

**Miii is a fully autonomous coding agent that runs entirely on your machine.** It plans, edits files, runs your tests, searches the web, indexes your codebase semantically, and iterates until the job is done — all without a single byte of your code leaving your network.

Zero subscription. Zero cloud dependency. Zero Python overhead. **176 KB total.** Just raw engineering horsepower in your terminal.

```bash
npm install -g miii-cli && miii
```

---

## Why Engineers Are Switching

Claude Code is impressive. It's also a 50 MB binary that costs $200/month, requires an internet connection, and sends every line of your codebase to a server you don't own.

**Miii does everything Claude Code does. It's 176 KB. It's free. It runs on your laptop.**

GitHub Copilot streams your proprietary code to Microsoft. Aider is a Python monolith that takes longer to boot than to write a function. All of them charge you monthly for the privilege of being the product.

Miii flips the model. Your compute. Your data. Your rules.

---

## What Miii Actually Does

This isn't a fancy autocomplete. Miii is a **full autonomous agent loop:**

1. You describe a goal
2. Miii reads your codebase, plans the changes, edits the files
3. It runs your test suite automatically after every change
4. If tests fail, it reads the error, fixes the code, re-runs
5. It repeats until the work is done

No babysitting. No copy-pasting error messages. No broken half-edits.

---

## What a Session Looks Like

```
> refactor the auth module to use JWT instead of sessions

  ● Researching: refactor auth module to use JWT
  ● Reading src/auth/session.ts
  ● Reading src/middleware/auth.ts
  ● Reading src/routes/login.ts

  Planning: 3 file(s) to change

  ● Editing src/auth/session.ts
  ● Editing src/middleware/auth.ts
  ● Editing src/routes/login.ts
  ● Running tests

  ─ refactor done — 3 file(s) processed
```

No prompts asking which files to change. No copy-pasting error messages. Just: describe the goal, watch it work.

---

## Killer Features

**🔍 Semantic Codebase Indexing** *(new in v0.3.2)*
Build a vector index of your entire codebase using local embeddings. Ask "where is the auth logic?" and Miii finds it by meaning, not keyword. No data leaves your machine.

**🧠 Deep Think Engine**
Before answering complex questions, Miii runs a constrained research phase — reading files, checking git history, searching the web — then synthesizes a grounded answer. Not a hallucination. A conclusion.

**🌐 Real-Time Web Access**
Tavily-powered web search and page extraction, built in. Ask about breaking changes in a library you just upgraded. Get an answer that's actually current.

**🛠 Surgical File Editing**
`patch_file` replaces exact strings in your files. No full rewrites. No formatting destruction. No token waste. Exactly the change, nothing more.

**🔄 Self-Healing Test Loop**
Miii runs `npm test` after every file change. If something breaks, it reads the failure trace and fixes it autonomously — up to 3 retries before surfacing the issue to you.

**📂 Persistent Sessions**
Pick up exactly where you left off. Named sessions mean your context, your history, and your goal survive terminal restarts.

**📦 Skill System**
Extend Miii with plain Markdown files or npm packages. Ship reusable agent behaviors as versioned packages your whole team can pull.

---

## The Numbers That Matter

| | **Miii** | Claude Code | Aider |
|---|:---:|:---:|:---:|
| Monthly cost | **$0** | $20–200 | $0 |
| Bundle size | **176 KB** | ~50 MB | ~200 MB |
| Your code stays local | **✅** | ❌ | ⚠️ |
| Startup time | **<100ms** | ~2s | ~4s |
| Semantic codebase index | **✅** | ❌ | ❌ |
| Deep research mode | **✅** | ❌ | ❌ |
| Auto test loop | **✅** | ⚠️ | ⚠️ |
| Works air-gapped | **✅** | ❌ | ❌ |
| License | **MIT** | Proprietary | Apache 2.0 |

---

## Get Running in 60 Seconds

```bash
# 1. Start Ollama and pull a model
ollama pull qwen2.5-coder:7b

# 2. Install Miii
npm install -g miii-cli

# 3. Go to your project and start
cd your-project
miii
```

That's it. No API keys. No account. No sign-up form.

---

## Power Commands

| Command | What it does |
|---|---|
| `/think <question>` | Deep research: reads files + web, then answers |
| `/refactor <goal>` | Autonomous multi-file refactor with test validation |
| `/index build` | Build semantic vector index of your codebase |
| `/index search <query>` | Find code by meaning, not string match |
| `/git review` | AI reviews your current diff for bugs and issues |
| `/git commit <msg>` | Stage everything and commit in one shot |
| `/plan <topic>` | Structured planning mode before you write a line |
| `/model <name>` | Hot-swap your LLM mid-conversation |
| `/session <name>` | Switch between named project sessions |
| `@filename` | Inject any file directly into context |

---

## Semantic Codebase Indexing

For large codebases, Miii can build and query a local vector index — no third-party APIs, no embeddings sent anywhere.

```bash
# Pull an embedding model (one time)
ollama pull nomic-embed-text

# Index your project
/index build

# The agent now calls search_codebase automatically
# when it needs to find code by concept
```

The agent calls `search_codebase` on its own when needed. You don't have to think about it.

---

## Configuration

Drop a `.miii.json` in your project root or `~/.config/miii/config.json` globally:

```json
{
  "model": "qwen2.5-coder:7b",
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "gitContext": true,
  "tavilyApiKey": "tvly-...",
  "embedModel": "nomic-embed-text"
}
```

---

## Build from Source

```bash
git clone https://github.com/maruakshay/miii-cli
cd miii-cli && npm install && npm run build && npm link
```

---

## The Bottom Line

The AI coding tools you're paying for right now will raise their prices, change their terms, and keep reading your code. **Miii won't.** It's MIT licensed, runs locally, and gets better every time Ollama ships a new model.

One engineer built a 176 KB tool that replaces a $200/month cloud product. That shouldn't be a surprise — it should be the baseline.

If this saves you time or money, **star the repo**. It's the only metric that tells other engineers this is worth their attention.

**[⭐ Star on GitHub](https://github.com/maruakshay/miii-cli)**

> Built by [@maruakshay](https://github.com/maruakshay) — open to PRs, issues, and model recommendations.

---

## License

MIT — do whatever you want with it.
