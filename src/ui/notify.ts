import { loadSettings } from '../settings.js'

/**
 * A turn shorter than this, you watched. Past it you have likely switched to
 * another window, and a finished turn or a waiting prompt is worth a ping.
 */
export const NOTIFY_AFTER_MS = 30_000

/** Terminals that turn OSC 9 into a desktop notification. Elsewhere it's dropped, or worse, printed. */
const OSC9_TERMINALS = new Set(['iTerm.app', 'WezTerm', 'ghostty'])

/**
 * The bytes that get your attention: BEL always — every terminal and tmux
 * understand it as a bounce, a badge or a sound — and on terminals that show
 * them, a desktop notification carrying the message too.
 */
export function notifySequence(message: string, env: NodeJS.ProcessEnv = process.env): string {
  // eslint-disable-next-line no-control-regex
  const text = message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120)
  const osc9 = OSC9_TERMINALS.has(env.TERM_PROGRAM ?? '') ? `\x1b]9;miii — ${text}\x07` : ''
  return `${osc9}\x07`
}

/** Ring the terminal, unless stdout isn't one or `notifications: false` is set. */
export function notifyTerminal(message: string): void {
  if (!process.stdout.isTTY || loadSettings().notifications === false) return
  process.stdout.write(notifySequence(message))
}
