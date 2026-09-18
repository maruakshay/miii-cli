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

- **🧠 Works with small models** — miii repairs malformed tool calls a 7B model emits instead of burning a turn on each one, and sizes its own prompt to your context window so the room goes to your code.
- **🧪 `miii doctor`** — not every local model can drive an agent. Grades your installed models on real engineering tasks, now with detailed repair tracking to show exactly where a model struggles.
- **🔌 Flexible providers** — switch between local (Ollama, llama.cpp) and hosted (Claude, OpenAI, Groq, DeepSeek, etc.) backends instantly via `/provider` or the CLI.
- **🖼️ Paste images** — `Ctrl+V` a screenshot to ask why a UI looks broken. Needs a vision model (`llava`, `llama3.2-vision`, …).
- **💧 Lossless output spill** — a 50K-line test log is never truncated. The full text goes to disk and the model pages through it.
- **📋 Plan mode** — `shift+tab` (or `/plan`) makes the session read-only. miii researches your code, proposes a plan, and touches nothing until you approve it. The block is enforced by the harness, not asked for in the prompt: with no write tools and only reporting commands, a model that tries `sed -i` or `cat > file` anyway gets refused.
- **🔒 Permission-gated tools** — you approve what the agent touches, and see the exact rule before you save it. A saved wildcard never stretches across a command boundary, so approving `npm test` can't quietly authorize `npm test && rm -rf ~`.
- **⌨️ Your own slash commands** — drop `review.md` in `.miii/commands/` and `/review` is a command, in the palette, checked into the repo with everything else.
- **📄 `MIII.md`** — drop one in your repo to teach miii your conventions and commands. Same idea as `CLAUDE.md`, read every turn. `# a fact` from the input bar appends to it.
- **🖥️ Headless** — `miii -p "fix the failing test"`, `git diff | miii -p "review this"`, `--output-format json`. The same agent loop with nothing to watch it, so it approves nothing by default and tells you what it refused.
- **🔌 MCP servers** — point it at GitHub, Sentry, Postgres, your internal service. Their tools join the registry as `mcp__<server>__<tool>`, permission-gated like everything else.
- **🪝 Hooks** — shell commands the harness runs before or after a tool, on submit, or when the agent tries to stop. Exit 2 blocks the call and the reason goes to the model. Prose in a prompt is a request; this is a rule.
- **🧩 Subagents** — `task` hands a search or a self-contained job to a second loop with its own context window, and keeps only the answer. On a 16k window that is the difference between finding something and having room left to use it.
- **⟲ `/rewind`** — every file the agent is about to change is copied first. Rewind puts the files *and* the conversation back to any earlier turn, without touching your own uncommitted work.

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
| `task` | Delegate a search or a self-contained job to a subagent |

File tools (`read_file`, `write_file`, `edit_file`) reject `../` traversal and absolute paths outside the workspace. `run_bash` is **not** path-confined — its only boundary is the permission prompt, so review commands before approving.
</details>

<details>
<summary><strong>How "always" approvals are scoped</strong></summary>

Answering "always" saves both the exact command and a generalized glob (`npm run build` → `npm run *`), and the prompt shows you the widest rule before you choose.

Two things are never widened: destructive programs (`rm`, `dd`, `sudo`, `git reset`, …) and compound commands, whose first token says nothing about what the rest of the line does. A saved glob also refuses to match any command containing an unquoted `;` `&&` `||` `|` `>` or `$(…)`, so an approval can't be stretched past the command you actually read.

Saved rules live in **`.miii/permissions.json` in the project** — that is what "always" writes to. Approval subjects are usually project-relative (`src/index.ts` means a different file in every repo), so a rule that followed you everywhere would be granting far more than you agreed to. Rules in `~/.miii/permissions.json` apply in every project; put the ones you really do mean globally there by hand. `/permissions` lists both and says which file each came from.

Gitignore `.miii/permissions.json` — it is a record of what *you* approved. `.miii/commands/` is meant to be committed.
</details>

<details>
<summary><strong>Permission modes</strong> — <code>shift+tab</code></summary>

`shift+tab` cycles the mode; the input frame changes colour with it.

| Mode | What it does |
|------|--------------|
| **normal** | asks before writing files or running commands |
| **plan mode** | read-only — research and a plan, approved before anything happens |
| **auto-accept edits** | writes files without asking; commands still prompt, since a command can reach outside the workspace |
| **bypass permissions** | runs everything without asking (red frame — for a sandbox or a throwaway tree) |

In **plan mode** the write tools are not offered at all and `run_bash` runs only commands that report — `ls`, `cat`, `grep`, `find`, `git status/log/diff`, one at a time, no pipes or `&&`. A compound command is refused however harmless its first word, because `ls` tells you nothing about what comes after the `&&`. When the research is done miii calls `exit_plan_mode` with the plan and you get three choices: start work, start work and stop asking about the edits, or send it back for another pass.
</details>

<details>
<summary><strong>Scripting it — headless mode</strong></summary>

`-p` runs one turn and prints the answer. No TUI, no screen to take over, so it composes:

```bash
miii -p "what does the retry budget default to"
git diff | miii -p "review this for correctness bugs"
miii -p "fix the failing test" --permission-mode acceptEdits
miii -p "summarise today's commits" --output-format json | jq -r .result
```

Piped stdin is prepended to the prompt rather than replacing it, so the diff and the instruction both arrive. With no prompt argument at all, the piped text *is* the prompt.

**Nobody is watching, so nothing is approved.** A headless run refuses any call not already covered by a saved rule, and says on stderr what it refused and how many times — a run that did half the job because six calls were denied must not exit looking like a run that finished. Scripts that mean yes say so:

| Flag | |
|---|---|
| `--permission-mode acceptEdits` | file writes stop asking; commands still refuse |
| `--permission-mode bypass` | runs everything (alias: `--dangerously-skip-permissions`) |
| `--allowed-tools read_file,grep,glob` | restrict the agent to these tools |
| `--max-turns <n>` | stop after n tool-use turns |
| `--output-format text\|json\|stream-json` | `text` prints the final answer and nothing else; `json` is one result object; `stream-json` is one event per line, for watching a long run |
| `-c` / `--resume <id>` | continue the last session, or a named one |

Exit codes: `0` finished, `1` the agent errored, `2` miii is misconfigured (no model, bad flags) — so a script can tell "the agent says no" from "this was never going to work".

</details>

<details>
<summary><strong>Settings — <code>.miii/settings.json</code></strong></summary>

Config (`~/.miii/config.json`) is your machine: which model, which provider. Settings are the project: what it does and what it may do here. Three files, later ones winning:

```text
~/.miii/settings.json            yours, in every project
<cwd>/.miii/settings.json        the project's — check this in
<cwd>/.miii/settings.local.json  yours, this project only — gitignore it
```

The merge is not a blind overwrite. Hook lists are appended to and permission rules concatenated, so a project adding a lint gate cannot silently delete the one in your user settings.

```json
{
  "permissions": {
    "allow": ["run_bash(npm test *)", "run_bash(git status)"],
    "deny": ["run_bash(git push *)", "edit_file(prisma/migrations/*)"],
    "defaultMode": "plan"
  },
  "env": { "NODE_ENV": "test" },
  "checkpoints": true,
  "vimMode": false
}
```

`deny` is checked before everything, **bypass mode included** — a rule that a single `shift+tab` disarms is worse than no rule. `allow` is read-only from miii's side: answering "always" at a prompt writes to `.miii/permissions.json`, never into a file you check in. `/settings` says which files are actually in force.

</details>

<details>
<summary><strong>Hooks</strong></summary>

A hook is a shell command the harness runs at a fixed point in a turn. It exists because some things should not be requests. "Run prettier after every edit" in the system prompt is followed most of the time by a 7B model, which is the same as not having it; as a hook it is mechanical.

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "edit_file|write_file",
        "hooks": [{ "command": "npx prettier --write \"$MIII_TOOL_PATH\"" }] }
    ],
    "PreToolUse": [
      { "matcher": "write_file|edit_file",
        "hooks": [{ "command": "case \"$MIII_TOOL_PATH\" in *.lock) echo 'lockfiles are generated' >&2; exit 2;; esac" }] }
    ]
  }
}
```

| Event | Fires | A block (exit 2) means |
|---|---|---|
| `PreToolUse` | before a tool runs | the call never happens; stderr goes to the model as the reason |
| `PostToolUse` | after it returns | the result is marked failed with your reason attached |
| `UserPromptSubmit` | before your message is sent | the turn is dropped |
| `Stop` | when the agent means to stop | it goes back to work with your reason (bounded to twice) |
| `SessionStart` | once, when a session opens | — |

The exit code is the whole contract: **0** fine (stdout becomes context for `UserPromptSubmit`, a notice elsewhere), **2** block, **anything else** your hook is broken — shown to you, never to the model, and the turn carries on. A typo in a hook must not brick the session.

The event arrives as JSON on stdin. `$MIII_TOOL_NAME`, `$MIII_TOOL_PATH`, `$MIII_TOOL_COMMAND` and `$MIII_PROJECT_DIR` are set for the common one-liner. `matcher` is an anchored regex over the tool name.

</details>

<details>
<summary><strong>MCP servers</strong></summary>

Everything that is not a file — issues, errors, databases, designs — reaches miii through MCP. Servers are declared in settings and connected at launch; a server that fails to start is reported and skipped rather than holding the session closed.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": { "type": "http", "url": "https://mcp.internal/api", "readOnly": true }
  }
}
```

`${VAR}` is expanded from your environment, so a token stays in your shell profile rather than in a file you might commit. stdio and streamable-HTTP transports are both supported.

Server tools are registered as `mcp__<server>__<tool>`. That prefix is not decoration: it namespaces two servers that both call something `search`, it tells you at the permission prompt where a call is about to go, and it is what a rule like `mcp__github__*` matches. `/mcp` lists what connected.

**Plan mode withholds MCP tools** unless the server is declared `"readOnly": true`. miii cannot tell whether a server's `create_issue` writes something, and a read-only claim is the server author's to make, not ours to guess.

</details>

<details>
<summary><strong>Subagents</strong></summary>

The `task` tool runs a second agent loop with its own context window and hands back only its final message.

The point is context, not parallelism. "Where does this project handle retries" costs a dozen greps and half a dozen partial reads, and on a 16k window that search *is* the budget — the model finds the answer and has no room left to act on it. Delegated, the main conversation gains three lines.

Two agents ship: **explore** (read-only search, the default) and **general** (a self-contained job, end to end). Define your own as Markdown:

```markdown
---
name: reviewer
description: Reviews a diff for correctness bugs. Use after writing code.
tools: read_file, grep, glob, run_bash
---
You are a code reviewer. Read the diff and report only real defects…
```

`.miii/agents/*.md` is the project's, `~/.miii/agents/*.md` is yours everywhere, and either shadows a built-in of the same name. `description` is what the main model reads when choosing, so write it as *when to use this*. A subagent inherits the session's permission mode — it is not a way around plan mode — and never gets `task` itself. `/agents` lists them.

</details>

<details>
<summary><strong>Undo — <code>/rewind</code></strong></summary>

Small models are wrong more often, and wrong here means four files edited in a direction you did not want. `git checkout` is the usual answer and it is wrong twice over: the work is rarely committed at the point you want back, and it discards your own uncommitted edits along with the agent's.

So every file the agent is about to change is copied first, tagged with the turn it belonged to. `/rewind` lists those points; `/rewind 6` puts the files back as they were and truncates the conversation to match.

Both halves matter. Restore only the files and the model stays certain it made edits that are no longer there, then builds its next turn on that. Restore only the transcript and the edits are still on disk.

Checkpoints live in `~/.miii/projects/<project>/checkpoints/`, are deleted with their session, and skip files over 2MB. Turn them off with `"checkpoints": false`.

</details>

<details>
<summary><strong>Custom slash commands</strong></summary>

A Markdown file is a command. `.miii/commands/review.md` becomes `/review`:

```markdown
---
description: review the staged diff
---
Review the staged diff for bugs and unhandled errors. Focus on $ARGUMENTS.
```

`$ARGUMENTS` is everything typed after the command; `$1`…`$9` are its individual words. A command that references neither gets the arguments appended, so nothing you type is silently dropped.

`.miii/commands/` is project scope — check it in, and the whole team gets it. `~/.miii/commands/` is yours in every project. A project command shadows a personal one of the same name, and neither can shadow a built-in.
</details>

<details>
<summary><strong>Keyboard shortcuts and commands</strong></summary>

| Key | Action |
|-----|--------|
| `Enter` | Send prompt |
| `/` | Open the command palette |
| `Shift+Tab` | Cycle permission mode — normal → plan → auto-accept → bypass |
| `@filename` | Attach file to context |
| `Ctrl+V` | Paste clipboard image (needs a vision model) |
| `Ctrl+T` | Toggle the model's thinking |
| `Ctrl+O` / left click | Toggle full tool output |
| Mouse wheel | Scroll the transcript |
| `PgUp` / `PgDn` | Scroll the transcript a page at a time |
| `Shift+↑` / `Shift+↓` | Scroll the transcript a row at a time |
| `Ctrl+A` / `Ctrl+E` | Jump to start / end of line |
| `Esc` | Stop generation or tool run |
| `Ctrl+Y` | Copy the last reply to the clipboard |
| `Ctrl+S` | Hand the mouse back to the terminal, so a drag selects text |
| `Ctrl+C` | Quit |
| `#` … | Append the line to the project's `MIII.md` — `##` for your own |
| `Esc` (vim on) | Leave insert mode — `hjkl w b 0 $ x dd dw cw D C i a A o` |

| Command | Action |
|---------|--------|
| `/plan` | Toggle plan mode — research read-only, then approve the plan |
| `/permissions` | List saved approval rules and which file each lives in |
| `/models` | Switch model, provider (`tab`) and effort (`←→`) |
| `/provider` | switch backend · `/provider add <name> [apiKey]` · `/provider remove <name>` |
| `/new` | Save this session and start fresh |
| `/sessions` | List and resume a saved session |
| `/copy` | Copy to the clipboard — `last` (default), `code`, `tool` or `all` |
| `/compact` | Summarize the conversation to free context — `/compact <focus>` to steer it |
| `/init` | Survey the repo and write a `MIII.md` for it |
| `/review` | Review the uncommitted changes — `/review <branch\|path>` for something else |
| `/rewind` | Undo the agent's file changes and rewind the conversation to match |
| `/context` | Show what is actually filling the context window |
| `/cost` | Tokens and time spent this session |
| `/export` | Write the transcript to a Markdown file |
| `/memory` | Where `MIII.md` lives — `#` a line to append to it, `##` for your own |
| `/agents` | Subagents the `task` tool can call |
| `/mcp` | Connected MCP servers and their tools |
| `/settings` | Which settings files are in force |
| `/vim` | Toggle vim keys in the input bar |
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

**Other backends.** miii is local-first, not local-only: add any backend by name and it runs the same agent loop, same tools, same permissions.

```bash
miii provider add anthropic        # picks up $ANTHROPIC_API_KEY
miii provider add openai sk-…      # or pass the key once
miii provider list --all           # every name you can add
```

Or from inside the TUI: `/provider add groq`, then `/models` to pick one. Names known out of the box:

| | |
|---|---|
| **Local** | `ollama` · `lmstudio` · `llamacpp` · `vllm` |
| **Hosted** | `anthropic` (Claude) · `openai` · `groq` · `openrouter` · `deepseek` · `mistral` · `together` · `cerebras` · `xai` · `gemini` |

Keys are read from the provider's usual environment variable (`$ANTHROPIC_API_KEY`, `$GROQ_API_KEY`, …) at request time, so nothing has to be written to disk. Pass a key explicitly and it's saved to `~/.miii/config.json` instead.

Anything not on that list still works — give it an endpoint and miii assumes the OpenAI-compatible wire format:

```bash
miii provider add mycorp https://llm.corp.internal/v1 <apiKey>
```

which is the same as writing it out by hand:

```json
{
  "provider": "mycorp",
  "providers": {
    "mycorp": { "type": "openai", "baseUrl": "https://llm.corp.internal/v1", "apiPath": "" }
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
 ├── permissions/ # Approval rules, modes, and how they're scoped
 ├── commands/    # User-defined slash commands (.miii/commands/*.md)
 ├── llm/         # Ollama and OpenAI-compatible backends
 ├── mcp/         # MCP client (stdio + HTTP) and its tool registry
 ├── hooks/       # The hook bus and the shell hooks settings.json declares
 ├── session/     # Saved conversations and file checkpoints
 ├── ui/          # Ink terminal UI and input handling
 ├── settings.ts  # .miii/settings.json — hooks, MCP, standing permissions
 ├── headless.ts  # miii -p, for scripts and CI
 └── config.ts    # Model/provider settings and resolution
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
