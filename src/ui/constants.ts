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
  { name: '/models', description: 'pick model · tab to change provider · ←→ effort' },
  { name: '/provider', description: 'open provider picker (configured in ~/.miii/config.json)' },
  { name: '/new',    description: 'save current session and start fresh' },
  { name: '/sessions', description: 'list sessions and resume one' },
  { name: '/copy',   description: 'copy to clipboard · /copy last | code | tool | all' },
  { name: '/compact', description: 'summarize the conversation to free context · /compact <focus>' },
  { name: '/permissions', description: 'list saved approval rules and where they live' },
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
export const BUSY_HINTS = 'esc interrupt · click or ctrl+o expand tool output · ctrl+y copy · scroll to look back'
