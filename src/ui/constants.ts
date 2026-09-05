/** UI constants & onboarding copy — kept out of components for easy editing. */

export interface Command {
  name: string
  description: string
}

/**
 * Slash commands, in the order the palette lists them. Single source of truth:
 * the palette filters this, and the welcome card quotes a subset by name, so a
 * description edited here updates both.
 */
export const COMMANDS: Command[] = [
  { name: '/models', description: 'pick model · tab to change provider · ←→ effort' },
  { name: '/provider', description: 'open provider picker (configured in ~/.miii/config.json)' },
  { name: '/new',    description: 'save current session and start fresh' },
  { name: '/sessions', description: 'list sessions and resume one' },
  { name: '/copy',   description: 'copy to clipboard · /copy last | code | tool | all' },
  { name: '/compact', description: 'summarize the conversation to free context · /compact <focus>' },
  { name: '/clear',  description: 'clear chat and reset context' },
  { name: '/exit',   description: 'quit miii' },
]

/** Commands featured on the welcome card, in display order. */
const WELCOME_COMMAND_NAMES = ['/models', '/sessions', '/new', '/copy', '/compact', '/clear']

/** The featured commands, resolved against COMMANDS so copy never drifts. */
export const WELCOME_COMMANDS: Command[] = WELCOME_COMMAND_NAMES.flatMap(
  (name) => COMMANDS.find((c) => c.name === name) ?? [],
)

export const WELCOME_PROMPT = 'To get started, describe a task or try one of these commands:'

/** Placeholder shown in the input bar while it's empty. */
export const INPUT_PLACEHOLDER = 'describe a task, or type / for commands'

/** Key hints under the input bar. Kept short — they share one line. */
export const INPUT_HINTS = '⏎ send · / commands · @ file · ctrl+y copy · ctrl+s select · scroll or pgup/pgdn to look back'

/** Key hints under the input bar while a turn is running. */
export const BUSY_HINTS = 'esc interrupt · click or ctrl+o expand tool output · ctrl+y copy · scroll to look back'
