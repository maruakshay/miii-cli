<h1 align="center">miii — Local AI Coding Agent for Your Terminal</h1>

<p align="center">
  <strong>The open-source, offline alternative to Claude Code, Cursor, and GitHub Copilot.</strong><br>
  A private AI pair programmer that runs on your machine with Ollama — no API keys, no cloud.<br>
  Private by default. Free forever. Works offline.
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
  🔒 <strong>100% local</strong> — your code never leaves your machine &nbsp;·&nbsp;
  💸 <strong>Free</strong> — no API keys, no per-token billing &nbsp;·&nbsp;
  ⚡ <strong>Offline</strong> — runs on your own GPU
</p>

## Install

```bash
ollama pull qwen2.5-coder:14b   # any coding model works
curl -fsSL https://raw.githubusercontent.com/maruakshay/miii-cli/main/install.sh | sh
miii
```

Windows: `irm https://raw.githubusercontent.com/maruakshay/miii-cli/main/install.ps1 | iex` &nbsp;·&nbsp; any platform: `npm i -g miii-agent` &nbsp;·&nbsp; needs Node ≥ 18 and [Ollama](https://ollama.com/download).

## Then just talk to it

```
> refactor the auth module to use async/await
> @src/server.ts add rate limiting to all POST routes
> why are my tests failing in utils/parser.ts
```

miii reads your files, writes the code, runs your tests, and fixes what breaks — planning before it acts, and verifying after. Entirely on your own GPU.

## Why local-first?

|            | Cloud agents          | **miii**                     |
|------------|-----------------------|------------------------------|
| Your code  | Sent to a third party | Never leaves your machine    |
| Cost       | Per-token billing     | Free — runs on your hardware |
| Setup      | API keys, accounts    | `npm i -g miii-agent`        |
| Offline    | No                    | Yes                          |
| Latency    | Network + queue       | Your GPU only                |

## Features

- **🧠 Works with small models** — miii repairs the malformed tool calls a 7B model emits instead of burning a turn on each one, and sizes its own prompt to your context window so the room goes to your code.
- **🧪 `miii doctor`** — not every local model can drive an agent. Grades your installed models on real engineering tasks.
- **🖼️ Paste images** — `Ctrl+V` a screenshot to ask why a UI looks broken. Needs a vision model (`llava`, `llama3.2-vision`, …).
- **💧 Lossless output spill** — a 50K-line test log is never truncated. The full text goes to disk and the model pages through it.
- **🔒 Permission-gated tools** — you approve what the agent touches, and see the exact rule before you save it. A saved wildcard never stretches across a command boundary, so approving `npm test` can't quietly authorize `npm test && rm -rf ~`.
- **📄 `MIII.md`** — drop one in your repo to teach miii your conventions and commands. Same idea as `CLAUDE.md`, read every turn.

**Picking a model:** 8GB VRAM → `qwen2.5-coder:7b` · 16–24GB → `qwen2.5-coder:14b` (sweet spot) · 48GB+ → `qwen2.5-coder:32b`.

---

<details>
<summary><strong>Built-in tools</strong></summary>

| Tool | Function |
|------|----------|
| `read_file` | Read any file in your workspace |
| `write_file` | Create new files |
| `edit_file` | Precise string-level edits, whitespace-tolerant |
| `glob` | Pattern-match files across the project |
| `grep` | Regex search across files |
| `run_bash` | Execute shell commands |
| `write_todos` | Track multi-step work as a live checklist |

File tools (`read_file`, `write_file`, `edit_file`) reject `../` traversal and absolute paths outside the workspace. `run_bash` is **not** path-confined — its only boundary is the permission prompt, so review commands before approving.
</details>

<details>
<summary><strong>How "always" approvals are scoped</strong></summary>

Answering "always" saves both the exact command and a generalized glob (`npm run build` → `npm run *`), and the prompt shows you the widest rule before you choose.

Two things are never widened: destructive programs (`rm`, `dd`, `sudo`, `git reset`, …) and compound commands, whose first token says nothing about what the rest of the line does. A saved glob also refuses to match any command containing an unquoted `;` `&&` `||` `|` `>` or `$(…)`, so an approval can't be stretched past the command you actually read.

Saved rules live in `~/.miii/permissions.json`.
</details>

<details>
<summary><strong>Keyboard shortcuts and commands</strong></summary>

| Key | Action |
|-----|--------|
| `Enter` | Send prompt |
| `/` | Open the command palette |
| `@filename` | Attach file to context |
| `Ctrl+V` | Paste clipboard image (needs a vision model) |
| `Ctrl+T` | Toggle the model's thinking |
| `Ctrl+O` / left click | Toggle full tool output |
| Mouse wheel | Scroll the transcript |
| `PgUp` / `PgDn` | Scroll the transcript a page at a time |
| `Shift+↑` / `Shift+↓` | Scroll the transcript a row at a time |
| `Ctrl+A` / `Ctrl+E` | Jump to start / end of line |
| `Esc` | Stop generation or tool run |
| `Ctrl+C` | Quit |

| Command | Action |
|---------|--------|
| `/models` | Switch model, provider (`tab`) and effort (`←→`) |
| `/provider` | Pick a configured provider |
| `/new` | Save this session and start fresh |
| `/sessions` | List and resume a saved session |
| `/clear` | Reset conversation |
| `/exit` | Quit |
</details>

<details>
<summary><strong>Configuration, other backends, and updates</strong></summary>

Settings live in `~/.miii/config.json`, created on first run:

```json
{
  "model": "qwen2.5-coder:14b",
  "effort": "medium",
  "providers": {
    "ollama": { "type": "ollama", "baseUrl": "http://localhost:11434" }
  }
}
```

`effort` (`low` \| `medium` \| `high`) controls temperature and the output token cap. `numCtxCap` (default `16384`) bounds the context window miii asks for, so a model advertising a 131k window can't make Ollama size a KV cache that eats your RAM — it only ever lowers, never raises. A top-level `ollamaHost` still works and is folded into the `ollama` provider on load.

miii talks to any **OpenAI-compatible** local server too — [llama.cpp](https://github.com/ggml-org/llama.cpp), [LM Studio](https://lmstudio.ai), vLLM:

```json
{
  "model": "qwen2.5-coder-14b",
  "provider": "llamacpp",
  "providers": {
    "llamacpp": { "type": "openai", "baseUrl": "http://localhost:8080" }
  }
}
```

Switch at launch with `miii --provider llamacpp`. Any `openai`-type provider on `localhost` counts as local — no key, no cloud.

**Updates:** miii checks npm on launch and pulls a newer release in the background, applied on next start. `miii update` to do it now, `miii --version` to check. Opt out with `"autoUpdate": false`.

**Install failing on permissions?** Your global npm prefix isn't writable:
```bash
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"   # add to ~/.bashrc or ~/.zshrc
```
</details>

<details>
<summary><strong>How output spill works</strong></summary>

When a tool result exceeds the inline budget (~10K bytes), the full output is written to `~/.miii/output/<id>.txt`. Only a head + tail preview is inlined, with a pointer:

```
[This command output was long (412900 bytes), so I'm showing the start and
 end. The full text is saved at ~/.miii/output/9f3a1c.txt — read it with
 read_file offset/limit to see the middle.]
```

The model pages through the middle with ranged `read_file` reads. Spill files are garbage-collected after 24 hours.
</details>

<details>
<summary><strong>Development</strong></summary>

```text
src/
 ├── agent/       # The core reasoning loop, and tool-call repair
 ├── tools/       # read/write/edit/bash/grep/glob/todos + output spill
 ├── prompt/      # System prompt and MIII.md project context
 ├── permissions/ # Approval rules and how they're scoped
 ├── llm/         # Ollama and OpenAI-compatible backends
 ├── session/     # Saved conversations
 ├── ui/          # Ink terminal UI and input handling
 └── config.ts    # Settings and provider resolution
```

```bash
git clone https://github.com/maruakshay/miii-cli.git && cd miii-cli
npm install && npm run dev
```

```bash
npm run build       # production build
npm run typecheck   # type-check src + eval
npm test            # unit tests
npm run eval        # regression gate (powers `miii doctor`)
```

To run your working tree as the global `miii`: `npm run build && npm link` (restore with `npm i -g miii-agent`).
</details>

---

## FAQ

**Does miii work without internet?** Yes. Once you've pulled a model with Ollama, miii runs fully offline — no network calls, no account, no cloud.

**Is my code sent anywhere?** No. Every file read, edit, and inference happens on your machine — privacy is the default, not a setting.

**How is miii different from Claude Code, Cursor, or GitHub Copilot?** Those are cloud services — metered, account-gated, and they ship your code to a third-party server. miii is open-source, free, and runs entirely on your hardware, with the same terminal-agent workflow.

**How is it different from Continue.dev?** Continue.dev is an IDE extension. miii is a standalone terminal agent — no editor required.

**Which local LLM is best for coding?** `qwen2.5-coder` at the largest size your VRAM allows. Run `miii doctor` to grade what you have installed.

**Do I need a GPU?** No, but it helps. Smaller models run on CPU; a GPU makes larger ones fast enough for real work.

## Status

**MVP.** The core agent loop is stable; actively refining tool execution, streaming, and the permission model. PRs welcome.

## License

MIT © [maruakshay](https://github.com/maruakshay)

<p align="center">
  <em>Built for engineers who'd rather own their tools than rent them.</em>
</p>
