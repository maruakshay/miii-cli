/**
 * Set the terminal tab/window title to the active session summary, Claude
 * Code-style, so a backgrounded `miii` tab reads "✳ Fix the auth bug" instead
 * of the bare process name (`node`). Uses the OSC 2 escape (window title);
 * harmless on terminals that ignore it. No-op when stdout isn't a TTY.
 */
const OSC = '\x1b]2;'
const BEL = '\x07'

/** Sanitise to a single safe line — strip control chars/newlines, clamp length. */
function clean(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** Set the terminal title to `✳ <title>`; clears it when title is empty. */
export function setTerminalTitle(title: string): void {
  if (!process.stdout.isTTY) return
  const text = clean(title)
  const label = text ? `✳ ${text}` : ''
  process.stdout.write(`${OSC}${label}${BEL}`)
}

/** Restore the terminal title to the default on exit. */
export function resetTerminalTitle(): void {
  setTerminalTitle('')
}
