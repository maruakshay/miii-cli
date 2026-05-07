# miii

```
╭─ MIII - CLI ───────────────────────────────────────────╮
│  Claude Code-level terminal workflows, local models.   │
╰────────────────────────────────────────────────────────╯
```

A fast, local AI coding assistant that runs entirely on your machine.
No cloud. No API keys. Just you, your terminal, and whatever model you pull.

---

## Install

```bash
npm install -g miii
```

Or run from source:

```bash
git clone https://github.com/maruakshay/miii-cli
cd miii-cli
npm install
npm run build
npm link
```

---

## Quick start

```bash
miii                        # start with default session
miii --model codellama      # use a specific model
miii --session myproject    # start in a named session
miii -s work -m llama3.2    # short flags
```

On startup, miii opens the model picker — pick a model and start coding.

---

## Commands

Type `/` to open the command palette and browse everything.

| Command | What it does |
|---|---|
| `/models` | Open model picker — switch or pull Ollama models |
| `/clear` | Clear current session's chat history |
| `/sessions` | List all saved sessions |
| `/session <name>` | Switch to (or create) a named session |
| `/list` | List all loaded skills |
| `/exit` | Exit miii |

Skills loaded from `~/.config/miii/skills/` appear in the palette too.

---

## File context with `@`

Type `@` anywhere in your message to fuzzy-find project files and inject their content into the LLM context.

```
❯ review the auth logic in @src/auth/middleware.ts
```

The file content is injected automatically — the model sees the full source.

Filtered automatically: `node_modules`, `dist`, `.git`, lock files, binaries, images.

---

## Sessions

Every conversation is saved. Sessions persist between launches.

```bash
miii                          # continues "default" session
miii --session feature-auth   # continues or creates "feature-auth"
```

Mid-conversation:

```
/session feature-auth    switch sessions
/sessions                see all sessions with message counts
/clear                   wipe current session history
```

Sessions stored at `~/.config/miii/sessions/`.

---

## Tools

miii has built-in file and shell tools the model can use automatically:

| Tool | What it does |
|---|---|
| `read_file` | Read any file |
| `list_files` | List directory contents |
| `edit_file` | Create or overwrite a file |
| `delete_file` | Delete a file |
| `run_command` | Run a shell command in cwd |

The model calls these via `<tool_call>` tags, miii executes them and feeds results back automatically — up to 6 hops deep.

---

## Skills

Skills are custom commands you can invoke with `/`.

Create `~/.config/miii/skills/review.md`:

```markdown
---
name: review
description: review current changes for bugs and improvements
---

Review the code I'm about to share. Look for bugs, edge cases, and improvements.
Be direct and specific. No markdown.
```

Then use it:

```
/review
```

Skills can also be TypeScript files with an `execute` function for programmatic behavior.

---

## Configuration

miii looks for config in:
1. `.miii.json` in the current directory
2. `~/.config/miii/config.json`

```json
{
  "model": "llama3.2",
  "provider": "ollama",
  "baseUrl": "http://localhost:11434"
}
```

For OpenAI-compatible APIs:

```json
{
  "model": "gpt-4o",
  "provider": "openai",
  "baseUrl": "https://api.openai.com/v1"
}
```

Works with any OpenAI-compatible server: LM Studio, vLLM, Groq, Together, etc.

---

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) (or any OpenAI-compatible API)

---

## Keybindings

| Key | Action |
|---|---|
| `enter` | Send message |
| `ctrl+c` | Abort streaming |
| `ctrl+c` x2 | Exit |
| `esc` | Close overlay / abort |
| `↑ ↓` | Navigate command palette or file picker |
