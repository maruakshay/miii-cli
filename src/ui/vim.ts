/**
 * Vim keys for the input bar.
 *
 * A pure reducer over {input, caret, mode}: given a keypress it returns the next
 * state, or says it did not handle the key so the caller's normal editing path
 * takes over. Nothing here touches React, which is the point — modal editing is
 * all edge cases, and edge cases you cannot write a test for are edge cases you
 * ship broken.
 *
 * Scope is one line of prompt text, so the bindings that earn their place are
 * motions and small edits. Deliberately absent: counts (`3w`), registers, marks,
 * undo — an undo stack for a prompt you can retype in four seconds is ceremony,
 * and a half-working `u` is worse than none.
 */

export type VimMode = 'insert' | 'normal'

/** An operator waiting for the motion that completes it — the `d` in `dw`. */
export type VimPending = 'd' | 'c' | null

export interface VimState {
  input: string
  caret: number
  mode: VimMode
  pending: VimPending
}

export interface VimResult extends VimState {
  /** False when the key means nothing in this mode — the caller handles it. */
  handled: boolean
}

/** The subset of ink's Key this cares about. */
export interface VimKey {
  escape?: boolean
  return?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  ctrl?: boolean
  meta?: boolean
  tab?: boolean
  backspace?: boolean
  delete?: boolean
}

const WORD = /[A-Za-z0-9_]/
const SPACE = /\s/

function classOf(ch: string | undefined): 'word' | 'punct' | 'space' | 'none' {
  if (ch === undefined) return 'none'
  if (SPACE.test(ch)) return 'space'
  return WORD.test(ch) ? 'word' : 'punct'
}

/** Start of the next word — vim `w`. */
export function nextWord(s: string, from: number): number {
  let i = from
  const start = classOf(s[i])
  // Step over the rest of the current word (or run of punctuation)…
  if (start !== 'space' && start !== 'none') {
    while (i < s.length && classOf(s[i]) === start) i++
  }
  // …then over the whitespace that follows it.
  while (i < s.length && classOf(s[i]) === 'space') i++
  return Math.min(i, s.length)
}

/** Start of the previous word — vim `b`. */
export function prevWord(s: string, from: number): number {
  let i = Math.min(from, s.length) - 1
  while (i >= 0 && classOf(s[i]) === 'space') i--
  if (i < 0) return 0
  const cls = classOf(s[i])
  while (i >= 0 && classOf(s[i]) === cls) i--
  return i + 1
}

/** End of the current/next word — vim `e`. */
export function wordEnd(s: string, from: number): number {
  let i = from + 1
  while (i < s.length && classOf(s[i]) === 'space') i++
  if (i >= s.length) return Math.max(0, s.length - 1)
  const cls = classOf(s[i])
  while (i + 1 < s.length && classOf(s[i + 1]) === cls) i++
  return i
}

/**
 * In normal mode the caret sits ON a character, so its rightmost position is
 * the last character rather than past it. Insert mode uses the usual bound.
 */
function clamp(caret: number, len: number, mode: VimMode): number {
  const max = mode === 'normal' ? Math.max(0, len - 1) : len
  return Math.max(0, Math.min(caret, max))
}

function unchanged(state: VimState, handled = false): VimResult {
  return { ...state, handled }
}

/**
 * Apply one keypress.
 *
 * Returns `handled: false` for anything vim has no opinion about — every key in
 * insert mode except Escape, and unbound keys in normal mode. The caller then
 * runs its ordinary handling, which is how submit, history recall, the command
 * palette and paste chips keep working untouched.
 */
export function applyVimKey(state: VimState, char: string, key: VimKey): VimResult {
  const { input } = state

  if (state.mode === 'insert') {
    // Escape is the only key insert mode claims: everything else is typing, and
    // intercepting it would mean reimplementing the input bar in here.
    if (key.escape) {
      return { ...state, mode: 'normal', pending: null, caret: clamp(state.caret - 1, input.length, 'normal'), handled: true }
    }
    return unchanged(state)
  }

  // --- normal mode ---
  // Enter still submits, and the palette/history keys still work, so those fall
  // through to the caller rather than being swallowed here.
  if (key.return || key.tab || key.ctrl || key.meta) return unchanged(state)

  const caret = state.caret
  const move = (to: number): VimResult => ({
    ...state,
    caret: clamp(to, input.length, 'normal'),
    pending: null,
    handled: true,
  })
  const edit = (next: string, nextCaret: number, mode: VimMode = 'normal'): VimResult => ({
    input: next,
    caret: clamp(nextCaret, next.length, mode),
    mode,
    pending: null,
    handled: true,
  })

  // An operator is pending — this key is its motion.
  if (state.pending) {
    const op = state.pending
    const enterInsert = op === 'c'
    // `dd` / `cc` — the doubled operator acts on the whole line.
    if (char === op) return edit('', 0, enterInsert ? 'insert' : 'normal')
    if (char === 'w') {
      const to = nextWord(input, caret)
      return edit(input.slice(0, caret) + input.slice(to), caret, enterInsert ? 'insert' : 'normal')
    }
    if (char === 'b') {
      const to = prevWord(input, caret)
      return edit(input.slice(0, to) + input.slice(caret), to, enterInsert ? 'insert' : 'normal')
    }
    if (char === '$') {
      return edit(input.slice(0, caret), caret, enterInsert ? 'insert' : 'normal')
    }
    if (char === '0') {
      return edit(input.slice(caret), 0, enterInsert ? 'insert' : 'normal')
    }
    // Not a motion we know — abandon the operator rather than guessing.
    return { ...state, pending: null, handled: true }
  }

  switch (char) {
    // entering insert
    case 'i': return { ...state, mode: 'insert', pending: null, handled: true }
    case 'a': return { ...state, mode: 'insert', caret: Math.min(caret + 1, input.length), pending: null, handled: true }
    case 'I': return { ...state, mode: 'insert', caret: 0, pending: null, handled: true }
    case 'A': return { ...state, mode: 'insert', caret: input.length, pending: null, handled: true }
    // `o` has no second line to open on a one-line prompt, so it does the thing
    // it is reached for instead: start typing at the end.
    case 'o': return { ...state, mode: 'insert', caret: input.length, pending: null, handled: true }
    case 'O': return { ...state, mode: 'insert', caret: 0, pending: null, handled: true }

    // motions
    case 'h': return move(caret - 1)
    case 'l': return move(caret + 1)
    case '0': return move(0)
    case '^': return move(input.search(/\S/) === -1 ? 0 : input.search(/\S/))
    case '$': return move(input.length - 1)
    case 'w': return move(nextWord(input, caret))
    case 'b': return move(prevWord(input, caret))
    case 'e': return move(wordEnd(input, caret))

    // edits
    case 'x': return input.length === 0 ? unchanged(state, true) : edit(input.slice(0, caret) + input.slice(caret + 1), caret)
    case 'D': return edit(input.slice(0, caret), caret)
    case 'C': return edit(input.slice(0, caret), caret, 'insert')
    case 's': return edit(input.slice(0, caret) + input.slice(caret + 1), caret, 'insert')
    case 'S': return edit('', 0, 'insert')
    case 'd': return { ...state, pending: 'd', handled: true }
    case 'c': return { ...state, pending: 'c', handled: true }
    default: break
  }

  if (key.leftArrow) return move(caret - 1)
  if (key.rightArrow) return move(caret + 1)

  // An unbound PRINTABLE key is swallowed. Normal mode's whole promise is that
  // letters are commands, not text — letting an unknown one fall through to the
  // editor would type a stray `z` into the prompt, which is the one outcome a
  // vim user will not forgive. Non-printables (arrows, backspace, escape
  // sequences) still fall through so history recall and the pickers work.
  if (char && char.length === 1 && char >= ' ') return unchanged(state, true)
  return unchanged(state)
}
