/**
 * The slash commands that answer a question rather than doing something.
 *
 * Each returns Markdown for the transcript. They live here rather than in the
 * keyboard handler because that file routes keys, and a report that has to
 * measure the context window has no business being in the middle of it.
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import { estimateHistoryTokens, estimateTokens } from '../agent/compact.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { loadProjectContext } from '../prompt/context.js'
import { toolsForMode, toOllamaTools } from '../tools/registry.js'
import { loadAgents } from '../agent/agents.js'
import { settingsSources } from '../settings.js'
import { isMcpTool } from '../mcp/registry.js'
import type { McpServerStatus } from '../mcp/registry.js'
import type { PermissionMode } from '../permissions/policy.js'
import type { MiiMessage } from '../agent/types.js'
import type { ChatMessage } from './types.js'
import type { SessionTotals } from './hooks/useAgentRunner.js'

/** A bar like ████░░░░░░ — the share of the window one thing accounts for. */
function bar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function pct(n: number, total: number): string {
  if (!total) return '—'
  return `${((n / total) * 100).toFixed(1)}%`
}

/**
 * Where the context window is going.
 *
 * The number in the header ("62% full") says there is a problem; this says what
 * is causing it, which is the part you can act on. A 4k MIII.md and a fat MCP
 * tool schema are both invisible until something breaks them out.
 */
export function contextReport(
  history: MiiMessage[],
  mode: PermissionMode,
  activeCtx: number | null,
  cwd: string,
): string {
  const project = loadProjectContext(cwd)
  const tools = toolsForMode(mode)
  const system = buildSystemPrompt(tools, cwd, project, activeCtx ?? undefined, mode)
  const schemas = JSON.stringify(toOllamaTools(tools))

  // The system prompt already embeds MIII.md, so counting both would
  // double-count it — subtract it back out to keep the rows additive.
  const projectTokens = estimateTokens(project.content)
  const systemTokens = Math.max(0, estimateTokens(system) - projectTokens)
  const schemaTokens = estimateTokens(schemas)
  const historyTokens = estimateHistoryTokens(history)
  const used = systemTokens + projectTokens + schemaTokens + historyTokens
  const window = activeCtx ?? 0

  const rows: Array<[string, number]> = [
    ['system prompt', systemTokens],
    ['tool schemas', schemaTokens],
    ['MIII.md', projectTokens],
    ['conversation', historyTokens],
  ]

  const scale = window || used || 1
  const lines = rows
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `\`${bar(n / scale)}\` ${label.padEnd(14)} ~${n.toLocaleString()} (${pct(n, scale)})`)

  const mcpTools = tools.filter((t) => isMcpTool(t.name))
  const free = window ? window - used : 0
  const footer = window
    ? `\`${bar(Math.max(0, free) / scale)}\` ${'free'.padEnd(14)} ~${Math.max(0, free).toLocaleString()} (${pct(Math.max(0, free), scale)})\n\n` +
      `Window: ${window.toLocaleString()} tokens · ${tools.length} tools offered` +
      (mcpTools.length ? ` (${mcpTools.length} from MCP)` : '')
    : `Total ~${used.toLocaleString()} tokens. The provider didn't report a window size, so there's nothing to measure it against.`

  return `⛁ **context**\n\n${lines.join('\n')}\n${footer}`
}

/**
 * What this session has spent. Deliberately reports tokens and wall time and
 * stops there: miii has no pricing table and one that shipped in a release would
 * be wrong within the month. Tokens are the number every provider bills on, so
 * they are the honest thing to report.
 */
export function costReport(totals: SessionTotals, model: string | undefined, provider: string, local: boolean): string {
  const minutes = totals.ms / 60000
  const lines = [
    `- model: \`${model ?? 'none'}\` via \`${provider}\``,
    `- turns: ${totals.turns}`,
    `- input: ~${totals.input.toLocaleString()} tokens`,
    `- output: ~${totals.output.toLocaleString()} tokens`,
    `- agent time: ${minutes >= 1 ? `${minutes.toFixed(1)} min` : `${(totals.ms / 1000).toFixed(1)}s`}`,
  ]
  const note = local
    ? '\nRunning locally — this cost you electricity and nothing else.'
    : `\nmiii doesn't track prices (they change faster than releases do). Multiply by ${provider}'s rates.`
  return `⏱ **session usage**\n\n${lines.join('\n')}\n${note}`
}

/** Connected MCP servers and what they contributed. */
export function mcpReport(servers: McpServerStatus[]): string {
  if (!servers.length) {
    return (
      '🔌 **MCP**\n\nNo servers configured. Add one under `mcpServers` in `.miii/settings.json`:\n\n' +
      '```json\n{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"],\n      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }\n    }\n  }\n}\n```\n\n' +
      'Add `"readOnly": true` to a server whose tools only read — those are the only ones offered in plan mode.'
    )
  }
  const lines = servers.map((s) => {
    const mark = s.connected ? '✓' : '✗'
    const detail = s.connected
      ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}${s.readOnly ? ' · read-only' : ''}`
      : (s.error ?? 'unavailable')
    return `- ${mark} \`${s.name}\` (${s.transport}) — ${detail}`
  })
  return `🔌 **MCP**\n\n${lines.join('\n')}\n\nServer tools are called as \`mcp__<server>__<tool>\`.`
}

/** Subagents available to the `task` tool. */
export function agentsReport(cwd: string): string {
  const agents = loadAgents(cwd)
  const lines = agents.map((a) => {
    const tools = a.tools.length ? a.tools.join(', ') : 'default set'
    return `- **${a.name}** _(${a.source})_ — ${a.description}\n  tools: \`${tools}\`${a.model ? ` · model: \`${a.model}\`` : ''}`
  })
  return (
    `🧩 **subagents**\n\n${lines.join('\n')}\n\n` +
    'Define your own as Markdown in `.miii/agents/` (checked in) or `~/.miii/agents/` (yours everywhere). ' +
    'The agent calls them with the `task` tool.'
  )
}

/** Where settings are being read from — the answer to "why is that hook firing". */
export function settingsReport(cwd: string): string {
  const sources = settingsSources(cwd)
  if (!sources.length) return 'No settings files. Create `.miii/settings.json` to configure hooks, MCP servers or standing permissions.'
  return sources.map((s) => `- **${s.scope}** — \`${s.path}\``).join('\n')
}

/**
 * Write the visible transcript to a Markdown file.
 *
 * The transcript, not the model's history: what the user read is what they mean
 * by "the conversation", and the history is full of tool results they never saw.
 */
export function exportTranscript(messages: ChatMessage[], cwd: string, name?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = join(cwd, name?.trim() || `miii-session-${stamp}.md`)
  const parts: string[] = [`# miii session — ${new Date().toLocaleString()}\n`]
  for (const m of messages) {
    if (m.role === 'user') {
      parts.push(`## You\n\n${m.content}\n`)
      continue
    }
    const body: string[] = []
    if (m.content.trim()) body.push(m.content.trim())
    for (const use of m.tool_uses ?? []) {
      body.push(`\n> \`${use.name}\` ${JSON.stringify(use.input).slice(0, 200)}`)
    }
    if (body.length) parts.push(`## miii\n\n${body.join('\n')}\n`)
  }
  writeFileSync(file, parts.join('\n'), 'utf-8')
  return file
}

/**
 * The prompt `/init` sends. A canned message rather than a code path: writing
 * MIII.md means reading the repo and deciding what matters, which is the agent's
 * job — this just says what a good one contains.
 */
export const INIT_PROMPT = `Create a MIII.md file at the root of this project.

Read enough of the repository to write it honestly: the build/test/lint commands from package.json or the Makefile, the directory layout and what each part is for, the conventions this code actually follows (not the ones you'd prefer), and anything a new engineer would get wrong on their first change.

Rules for the file itself:
- Under 60 lines. It is sent on every single turn, so every line costs context forever.
- Commands must be ones you verified exist in this repo — never a plausible guess.
- Skip anything derivable from reading a file in ten seconds. Include what takes an afternoon to learn.
- No preamble about what the project is unless it is genuinely non-obvious.

If a MIII.md already exists, read it first and improve it in place rather than replacing it.`

/** The prompt `/review` sends, with anything the user typed after it. */
export function reviewPrompt(args: string): string {
  const target = args.trim()
  return `Review ${target || 'the uncommitted changes in this repository'} for defects.

Start by reading the actual diff (\`git diff\` for unstaged, \`git diff --cached\` for staged, \`git diff main...HEAD\` for a branch) — review what changed, not the whole file.

Report only defects you can point at: a bug with the input that triggers it, a case the code doesn't handle, a resource that leaks, an invariant the change breaks. For each one give the \`path:line\`, what goes wrong, and what input causes it.

Do not report style preferences, missing comments, or "consider extracting this". If the change is clean, say so in one line — a review that invents findings to look thorough is worse than no review.`
}
