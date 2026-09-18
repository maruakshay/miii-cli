/** UI constants & onboarding copy — kept out of components for easy editing. */

export interface Command {
  name: string
  description: string
  /**
   * Where the command came from. Built-ins are the ones below; the others are
   * Markdown files under .miii/commands, and the palette dims their origin so
   * you can tell a repo's command from your own.
   */
  origin?: 'builtin' | 'project' | 'user'
}

/**
 * Slash commands, in the order the palette lists them. Single source of truth:
 * the palette filters this, and the welcome card quotes a subset by name, so a
 * description edited here updates both.
 */
export const COMMANDS: Command[] = [
  { name: '/plan',   description: 'plan first — research read-only, then approve the plan' },
  { name: '/init',   description: 'survey the repo and write a MIII.md for it' },
  { name: '/review', description: 'review the uncommitted changes · /review <branch|path>' },
  { name: '/models', description: 'pick model · tab to change provider · ←→ effort' },
  { name: '/provider', description: 'switch backend · /provider add <name> [apiKey] · remove <name>' },
  { name: '/new',    description: 'save current session and start fresh' },
  { name: '/sessions', description: 'list sessions and resume one' },
  { name: '/rewind', description: 'undo the agent’s file changes and rewind the conversation' },
  { name: '/context', description: 'show what is filling the context window' },
  { name: '/cost',   description: 'tokens and time spent this session' },
  { name: '/copy',   description: 'copy to clipboard · /copy last | code | tool | all' },
  { name: '/export', description: 'write the transcript to a Markdown file' },
  { name: '/compact', description: 'summarize the conversation to free context · /compact <focus>' },
  { name: '/memory', description: 'where MIII.md lives · # to append a line to it' },
  { name: '/agents', description: 'subagents the task tool can call' },
  { name: '/mcp',    description: 'connected MCP servers and their tools' },
  { name: '/permissions', description: 'list saved approval rules and where they live' },
  { name: '/settings', description: 'which settings files are in force' },
  { name: '/vim',    description: 'toggle vim keys in the input bar' },
  { name: '/clear',  description: 'clear chat and reset context' },
  { name: '/exit',   description: 'quit miii' },
]

/** Commands featured on the welcome card, in display order. */
const WELCOME_COMMAND_NAMES = ['/plan', '/models', '/sessions', '/compact', '/clear']

/** The featured commands, resolved against COMMANDS so copy never drifts. */
export const WELCOME_COMMANDS: Command[] = WELCOME_COMMAND_NAMES.flatMap(
  (name) => COMMANDS.find((c) => c.name === name) ?? [],
)

export const WELCOME_PROMPT = 'To get started, describe a task or try one of these commands:'

/** Placeholder shown in the input bar while it's empty. */
export const INPUT_PLACEHOLDER = 'describe a task, or type / for commands'

/** Key hints under the input bar. Kept short — they share one line. */
export const INPUT_HINTS = '⏎ send · / commands · @ file · shift+tab mode · ctrl+y copy · ctrl+s select · pgup/pgdn to look back'

/** Key hints under the input bar while a turn is running. */
export const BUSY_HINTS = 'esc interrupt · click a tool for details · ctrl+o all · ctrl+y copy · scroll to look back'
