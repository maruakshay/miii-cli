/**
 * useKeyboard — wires all keyboard input for the App.
 *
 * Centralises key routing so App.tsx stays declarative.
 * Depends on refs/setters passed in from App state.
 */
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { useInput, useStdout } from 'ink'
import { readClipboardImage, writeClipboardText } from '../clipboard.js'
import { collectCopyText, describeSize, describeTarget, parseCopyTarget, type CopyTarget } from '../copy.js'
import { setModel, setEffort, type NamedProvider, type Provider, type Effort } from '../../config.js'
import { filteredCommands } from '../CommandPalette.js'
import { invalidateFileCache, parseMention, searchFiles } from '../FilePicker.js'
import { toggleThinkingVisible } from '../ThinkingBlock.js'
import { toggleToolExpanded } from '../toolExpand.js'
import { parseMouseEvents, toggleMouse } from '../mouse.js'
import { scrollBy, scrollToBottom, resetScroll } from '../scroll.js'
import { setTerminalTitle, resetTerminalTitle } from '../terminalTitle.js'
import {
  persistSession,
  listSessions,
  loadSession,
  deleteSession,
  toDisplayMessages,
  newSessionId,
  type SessionMeta,
} from '../../session/store.js'
import { estimateHistoryTokens } from '../../agent/compact.js'
import { loadScopedRules, MODE_HINT, MODE_LABEL, type PermissionMode } from '../../permissions/policy.js'
import { expandCommand, findCustomCommand, invalidateCustomCommands } from '../../commands/custom.js'
import type { useAgentRunner } from './useAgentRunner.js'

const EFFORTS: Effort[] = ['low', 'medium', 'high']

// Rows moved per wheel notch — three matches what terminals scroll natively.
const WHEEL_ROWS = 3
// A page is the visible transcript minus two rows of overlap, so you keep your
// place across a jump.
const PAGE_ROWS = () => Math.max(1, (process.stdout.rows ?? 24) - 8)

// A paste collapses to a chip when it spans more than this many lines, or (for a
// single huge line) exceeds the char fallback. Words are a poor proxy — pasted
// code is often <20 words but hundreds of lines — so gate on lines/bytes.
const PASTE_CHIP_LINES = 4
const PASTE_CHIP_CHARS = 200

// Maps a chip placeholder (e.g. "[Pasted #1 · 34 lines]") to the real text it
// stands in for. Module-level so it survives re-renders; expanded at submit and
// wiped by clearPasteStore() on submit/clear/esc.
const pasteStore = new Map<string, string>()
let pasteCounter = 0

// Maps an image chip placeholder (e.g. "[Image #1 · shot.png]") to the base64
// bytes of a pasted image file path. Collected at submit and sent as the user
// message's `images[]` for vision models. Wiped alongside pasteStore.
const imageStore = new Map<string, string>()
let imageCounter = 0

// File-path paste → image: a pasted absolute path ending in one of these is read
// off disk, base64-encoded, and turned into an image chip.
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i

function clearPasteStore() {
  pasteStore.clear()
  pasteCounter = 0
  imageStore.clear()
  imageCounter = 0
}

/**
 * If `cleaned` is a single existing image file path, read it, base64-encode it,
 * stash it in imageStore under a fresh chip, and return that chip. Otherwise
 * return null so the caller falls back to normal paste handling.
 *
 * Handles surrounding quotes, macOS drag-drop backslash-escaped spaces, and ~.
 */
function tryImagePaste(cleaned: string): string | null {
  let p = cleaned.trim()
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1)
  }
  p = p.replace(/\\ /g, ' ')
  if (p.includes('\n') || !IMAGE_EXT_RE.test(p)) return null
  if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
  if (!existsSync(p)) return null
  try {
    const b64 = readFileSync(p).toString('base64')
    const chip = `[Image #${++imageCounter} · ${basename(p)}]`
    imageStore.set(chip, b64)
    return chip
  } catch {
    return null
  }
}

// Submitted-input history for up/down recall (Claude Code-style). Module-level
// so it survives re-renders. `historyIndex` walks backwards from the end;
// -1 means "not browsing" (showing the live draft, stashed in `historyDraft`).
const inputHistory: string[] = []
let historyIndex = -1
let historyDraft = ''

/** Record a submitted line for recall, skipping empty/duplicate-of-last. */
function pushHistory(line: string) {
  if (!line) return
  if (inputHistory[inputHistory.length - 1] === line) return
  inputHistory.push(line)
}

/** Replace every chip placeholder in `text` with its stored content. */
function expandPastes(text: string): string {
  let out = text
  for (const [chip, full] of pasteStore) out = out.split(chip).join(full)
  return out
}

/** Strip bracketed-paste markers and control bytes, preserving newlines. */
function stripControls(chunk: string): string {
  return chunk
    // bracketed-paste start/end markers
    .replace(/\x1b\[20[01]~/g, '')
    // tabs -> space
    .replace(/\t/g, ' ')
    // C0/C1 control chars except \n (line count + chip storage need newlines)
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
}

/**
 * Turn a typed/pasted chunk into the text to insert into the input.
 *
 * Single chars (normal typing) pass straight through. A multi-char chunk is a
 * paste: a big one (> PASTE_CHIP_LINES lines or > PASTE_CHIP_CHARS chars) is
 * stashed in pasteStore — newlines intact, so the model gets the real block —
 * and replaced by a compact chip; a small one collapses newlines to spaces and
 * goes inline. expandPastes() restores chips at submit time.
 */
function sanitizePaste(chunk: string): string {
  // Gate the paste machinery on length>1 — typing is the hot path.
  if (chunk.length <= 1) return chunk
  const cleaned = stripControls(chunk).replace(/\r/g, '')
  // A pasted image file path becomes an image chip (sent as images[] at submit).
  const imageChip = tryImagePaste(cleaned)
  if (imageChip) return imageChip
  const lines = cleaned.split('\n').length
  if (lines > PASTE_CHIP_LINES || cleaned.length > PASTE_CHIP_CHARS) {
    const chip = `[Pasted #${++pasteCounter} · ${lines} line${lines === 1 ? '' : 's'}]`
    pasteStore.set(chip, cleaned)
    return chip
  }
  return cleaned.replace(/\n/g, ' ')
}

interface KeyboardOptions {
  exit: () => void
  state: string
  setState: (s: any) => void

  // model selection
  models: string[]
  cursor: number
  setCursor: (fn: (i: number) => number) => void
  contexts: Record<string, number | null>
  cfg: { model?: string; provider?: Provider; effort?: Effort }
  setCfg: (fn: (c: any) => any) => void
  setActiveCtx: (n: number) => void

  // provider picker
  providers: NamedProvider[]
  pickerQuery: string
  setPickerQuery: (s: string) => void

  // agent runner (streaming, permission, chat actions, refs)
  agent: ReturnType<typeof useAgentRunner>

  // input bar
  input: string
  setInput: (fn: (s: string) => string) => void
  /** Caret column into `input`. */
  caret: number
  setCaret: (fn: (i: number) => number) => void
  paletteCursor: number
  setPaletteCursor: (fn: (i: number) => number) => void
  filePickerCursor: number
  setFilePickerCursor: (fn: (i: number) => number) => void

  // sessions
  sessionId: string
  setSessionId: (id: string) => void
  /** Called when an existing session is resumed; it already has a title. */
  onResumeSession: (id: string) => void
  sessions: SessionMeta[]
  setSessions: (s: SessionMeta[]) => void
  setNotice: (s: string | null) => void
  /** Bumped on /clear and /new to remount the transcript after a hard clear. */
  setLogEpoch: (fn: (n: number) => number) => void

  // provider switching
  switchProvider: (p: Provider) => void
}

export function useKeyboard(opts: KeyboardOptions) {
  const {
    exit, state, setState,
    models, cursor, setCursor, contexts, cfg, setCfg, setActiveCtx,
    providers, pickerQuery, setPickerQuery,
    agent,
    input, setInput, caret, setCaret, paletteCursor, setPaletteCursor, filePickerCursor, setFilePickerCursor,
    sessionId, setSessionId, onResumeSession, sessions, setSessions, setNotice, setLogEpoch,
    switchProvider,
  } = opts

  const {
    pendingPermissionRef, permissionCursor, setPermissionCursor, resolvePermission, cancelPermission,
    busyRef, abortRef,
    sendMessage, compact, messages, agentHistory, setMessages, setAgentHistory, setStreamingContent, setThinkingTail,
    setActiveToolUses, setActiveToolResults, setError, setUsedTokens,
    setMode, cycleMode, modeRef,
  } = agent

  const { write } = useStdout()

  /**
   * Hard-clear the terminal: erase the screen AND the scrollback buffer, then
   * home the cursor (\x1b[2J = screen, \x1b[3J = scrollback, \x1b[H = home).
   * The transcript itself is state (cleared alongside this), so this is only
   * about the terminal's own buffer: anything printed before miii started, and
   * whatever Ink last painted, so the fresh session opens on a clean screen.
   */
  function hardClear() {
    write('\x1b[2J\x1b[3J\x1b[H')
  }

  /** Wipe all chat/streaming state back to an empty session. */
  function clearSession() {
    setMessages(() => [])
    setAgentHistory([])
    setUsedTokens(0)
    setStreamingContent('')
    setThinkingTail('')
    setActiveToolUses([])
    setActiveToolResults([])
    setError(null)
    setNotice(null)
    clearPasteStore()
    resetScroll()
    // Remount the transcript so its measured height restarts from the empty log
    // instead of the heights Ink last laid out.
    setLogEpoch((n) => n + 1)
  }

  /**
   * Put part of the transcript on the system clipboard and report what happened.
   * Reads the message log rather than the screen, so the copy is the real text —
   * no wrapping, no gutter, no truncated tool output.
   */
  function copyToClipboard(target: CopyTarget) {
    const text = collectCopyText(messages, target)
    if (!text) {
      setNotice(`nothing to copy — no ${describeTarget(target)} yet`)
      return
    }
    setNotice(
      writeClipboardText(text)
        ? `copied ${describeTarget(target)} · ${describeSize(text)}`
        : 'no clipboard tool found — install pbcopy/wl-copy/xclip, or ctrl+s to select with the mouse',
    )
  }

  const effort: Effort = cfg.effort ?? 'medium'

  /**
   * Resolve a submitted line to a custom command plus its argument string.
   * Returns null for anything that isn't one, so the caller can fall through to
   * treating the line as an ordinary message.
   */
  function customCommandFor(line: string) {
    if (!line.startsWith('/')) return null
    const name = line.split(/\s/)[0]
    const command = findCustomCommand(name)
    return command ? { command, args: line.slice(name.length) } : null
  }

  /** Announce a mode the user just moved to. */
  function noticeMode(mode: PermissionMode) {
    setNotice(`${MODE_LABEL[mode]} — ${MODE_HINT[mode]}`)
  }

  /**
   * Print the saved approval rules into the transcript, grouped by where they
   * live. Answers the question the permission prompt raises and never closes:
   * what have I already agreed to, and does it follow me to my next project?
   */
  function showPermissions() {
    const sections = (['project', 'user'] as const).map((scope) => {
      const rules = loadScopedRules(scope)
      const where = scope === 'project' ? '`.miii/permissions.json` (this project)' : '`~/.miii/permissions.json` (every project)'
      if (!rules.length) return `**${scope}** — ${where}\n\nnothing saved yet.`
      const lines = rules.map((r) => `- \`${r.tool}\` → \`${r.pattern}\``).join('\n')
      return `**${scope}** — ${where}\n\n${lines}`
    })
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content:
          `⚖ **approval rules**\n\n${sections.join('\n\n')}\n\n` +
          'Delete a rule by editing the file. "Yes, don\'t ask again" writes to the project file.',
      },
    ])
  }

  useInput((char, key) => {
    // --- mouse ---
    // The transcript lives in miii's own viewport, so wheel notches scroll it
    // (the terminal's scrollback isn't in play). Every report is swallowed here
    // so an escape sequence can never land in the prompt — a spin of the wheel
    // packs several into one chunk, so they're drained as a batch and the wheel
    // rows summed into a single scroll. A left click toggles the collapsed tool
    // output, same as ctrl+o.
    const mouse = parseMouseEvents(char)
    if (mouse.consumed) {
      let rows = 0
      for (const ev of mouse.events) {
        if (!ev.press) continue
        if (ev.wheel) rows += ev.up ? -WHEEL_ROWS : WHEEL_ROWS
        else if (ev.button === 0) toggleToolExpanded()
      }
      if (rows !== 0) scrollBy(rows)
      return
    }

    // --- scrolling ---
    if (key.pageUp) { scrollBy(-PAGE_ROWS()); return }
    if (key.pageDown) { scrollBy(PAGE_ROWS()); return }
    // shift+arrow nudges the view a line at a time, leaving the bare arrows to
    // the pickers and history.
    if (key.shift && key.upArrow) { scrollBy(-1); return }
    if (key.shift && key.downArrow) { scrollBy(1); return }

    // --- global shortcuts ---
    if (key.ctrl && char === 'c') { exit(); return }
    // Ctrl+T toggles thinking block content visibility
    if (key.ctrl && char === 't') { toggleThinkingVisible(); return }
    // Ctrl+O toggles full tool output (collapsed to a few lines by default)
    if (key.ctrl && char === 'o') { toggleToolExpanded(); return }
    // Ctrl+Y yanks the last reply to the clipboard — /copy for anything else.
    if (key.ctrl && char === 'y') { copyToClipboard('last'); return }
    // Ctrl+S hands the mouse back to the terminal so a drag selects text again.
    // The wheel stops scrolling the transcript while it's off (pgup/pgdn still
    // do), which is the trade the notice spells out.
    if (key.ctrl && char === 's') {
      const on = toggleMouse()
      setNotice(
        on
          ? 'mouse on — wheel scrolls the transcript'
          : 'mouse off — drag to select and copy · ctrl+s to scroll again',
      )
      return
    }

    if (key.escape && busyRef.current && abortRef.current) {
      // Settle a permission prompt that's waiting on the user before aborting.
      // The agent loop is parked on that promise; aborting alone never wakes it,
      // so the turn would hang with the input locked. 'no' is the honest answer
      // — they cancelled rather than approved.
      cancelPermission()
      abortRef.current.abort()
      return
    }

    // --- provider picker (opencode-style) ---
    if (state === 'providers') {
      if (key.upArrow) { setCursor((i) => Math.max(0, i - 1)); return }
      if (key.downArrow) { setCursor((i) => Math.min(providers.length - 1, i + 1)); return }
      if (key.escape) {
        setPickerQuery('')
        setCursor(() => 0)
        setState(cfg.model ? 'models' : 'select-model')
        return
      }
      if (key.return && providers[cursor]) {
        const chosen = providers[cursor].name
        setNotice(`switched to ${chosen}`)
        // switchProvider reloads models and routes to the model picker (or back
        // here on error).
        switchProvider(chosen)
        return
      }
      if (key.backspace || key.delete) { setPickerQuery(pickerQuery.slice(0, -1)); setCursor(() => 0); return }
      if (char && !key.ctrl && !key.meta && char.length === 1 && char >= ' ') {
        setPickerQuery(pickerQuery + char)
        setCursor(() => 0)
      }
      return
    }

    // --- model selection screen (initial pick or /models) ---
    if (state === 'select-model' || state === 'models') {
      if (key.upArrow) { setCursor((i) => Math.max(0, i - 1)); return }
      if (key.downArrow) { setCursor((i) => Math.min(models.length - 1, i + 1)); return }
      if (key.return && models[cursor]) {
        const chosen = models[cursor]
        setModel(chosen)
        setCfg((c) => ({ ...c, model: chosen }))
        if (contexts[chosen]) setActiveCtx(contexts[chosen])
        setPickerQuery('')
        setCursor(() => 0)
        setState('ready')
        return
      }
      // tab opens the provider picker
      if (key.tab) {
        setPickerQuery('')
        setCursor(() => 0)
        setState('providers')
        return
      }
      // effort adjustment with arrows
      if (key.rightArrow) {
        const next = EFFORTS[Math.min(EFFORTS.indexOf(effort) + 1, EFFORTS.length - 1)]
        setEffort(next)
        setCfg((c) => ({ ...c, effort: next }))
        return
      }
      if (key.leftArrow) {
        const next = EFFORTS[Math.max(EFFORTS.indexOf(effort) - 1, 0)]
        setEffort(next)
        setCfg((c) => ({ ...c, effort: next }))
        return
      }
      // esc closes /models (but not the forced initial pick)
      if (key.escape) {
        if (state === 'models') { setPickerQuery(''); setCursor(() => 0); setState('ready') }
        return
      }
      // type to filter
      if (key.backspace || key.delete) { setPickerQuery(pickerQuery.slice(0, -1)); setCursor(() => 0); return }
      if (char && !key.ctrl && !key.meta && char.length === 1 && char >= ' ') {
        setPickerQuery(pickerQuery + char)
        setCursor(() => 0)
      }
      return
    }

    // --- resume picker screen (/resume) ---
    if (state === 'sessions') {
      if (key.upArrow) { setCursor((i) => Math.max(0, i - 1)); return }
      if (key.downArrow) { setCursor((i) => Math.min(sessions.length - 1, i + 1)); return }
      if (key.escape) { setState('ready'); return }
      // delete the highlighted session (d / x / delete / backspace)
      if ((char === 'd' || char === 'x' || key.delete || key.backspace) && sessions[cursor]) {
        const meta = sessions[cursor]
        deleteSession(meta.id)
        const next = listSessions()
        setSessions(next)
        setCursor((i) => Math.max(0, Math.min(i, next.length - 1)))
        setNotice(`deleted · ${meta.title}`)
        return
      }
      if (key.return && sessions[cursor]) {
        const meta = sessions[cursor]
        const history = loadSession(meta.id)
        setAgentHistory(history)
        setUsedTokens(estimateHistoryTokens(history))
        setMessages(toDisplayMessages(history))
        setStreamingContent('')
        setThinkingTail('')
        setActiveToolUses([])
        setActiveToolResults([])
        setError(null)
        setSessionId(meta.id)
        // A resumed transcript opens at its tail, like the session never left.
        resetScroll()
        setTerminalTitle(meta.title)
        onResumeSession(meta.id)
        setNotice(`resumed · ${meta.title}`)
        setState('ready')
      }
      return
    }

    // --- permission prompt overlay ---
    if (state === 'ready' && pendingPermissionRef.current) {
      if (key.upArrow) { setPermissionCursor((i) => Math.max(0, i - 1)); return }
      if (key.downArrow) { setPermissionCursor((i) => Math.min(2, i + 1)); return }
      if (key.return) { resolvePermission(permissionCursor); return }
      return
    }

    // --- main chat input ---
    if (state === 'ready') {
      if (busyRef.current) return

      // shift+tab cycles the permission mode. Handled before the palette's tab
      // completion below, which matches on key.tab alone and would otherwise
      // swallow it whenever the input happens to start with '/'. Only while
      // idle: the running turn captured its mode when it started, so changing
      // it mid-run would show a mode the agent is not actually operating under.
      if (key.tab && key.shift) {
        noticeMode(cycleMode())
        return
      }

      // Ctrl+V — paste an image off the OS clipboard (Cmd+V only pastes text, so
      // a copied screenshot needs an explicit reader). Inserts an image chip.
      if (key.ctrl && char === 'v') {
        const b64 = readClipboardImage()
        if (!b64) { setNotice('no image in clipboard'); return }
        const chip = `[Image #${++imageCounter} · clipboard]`
        imageStore.set(chip, b64)
        historyIndex = -1
        setInput((s) => s.slice(0, caret) + chip + s.slice(caret))
        setCaret((i) => i + chip.length)
        return
      }

      const paletteOpen = input.startsWith('/')
      const matches = paletteOpen ? filteredCommands(input) : []
      // typing the '@' that opens a mention drops the file cache, so a picker
      // opened just after creating a file still lists it.
      if (char === '@') invalidateFileCache()
      // Same idea for '/': a command file written a moment ago should show up
      // in the palette that is about to open, not on the next launch.
      if (char === '/') invalidateCustomCommands()
      const mention = !paletteOpen ? parseMention(input) : null
      const fileMatches = mention ? searchFiles(process.cwd(), mention.query) : []
      const fileOpen = mention !== null && fileMatches.length > 0

      // command palette navigation (yields to history browsing once started, so a
      // recalled "/command" line still navigates history with up/down).
      if (paletteOpen && historyIndex === -1 && key.upArrow) { setPaletteCursor((i) => Math.max(0, i - 1)); return }
      if (paletteOpen && historyIndex === -1 && key.downArrow) { setPaletteCursor((i) => Math.min(matches.length - 1, i + 1)); return }
      if (paletteOpen && (key.tab || key.return) && matches[paletteCursor] && input !== matches[paletteCursor].name) {
        const name = matches[paletteCursor].name
        setInput(() => name)
        setCaret(() => name.length)
        setPaletteCursor(() => 0)
        return
      }
      if (paletteOpen && key.escape) { clearPasteStore(); setInput(() => ''); setCaret(() => 0); setPaletteCursor(() => 0); return }

      // file picker navigation
      if (fileOpen && historyIndex === -1 && key.upArrow) { setFilePickerCursor((i) => Math.max(0, i - 1)); return }
      if (fileOpen && historyIndex === -1 && key.downArrow) { setFilePickerCursor((i) => Math.min(fileMatches.length - 1, i + 1)); return }
      if (fileOpen && key.tab && fileMatches[filePickerCursor]) {
        const picked = fileMatches[filePickerCursor]
        setInput((s) => {
          const next = s.slice(0, mention!.start) + '@' + picked + ' '
          setCaret(() => next.length)
          return next
        })
        setFilePickerCursor(() => 0)
        return
      }
      if (fileOpen && key.escape) { setFilePickerCursor(() => 0); return }

      // --- input history recall (up = older, down = newer) ---
      // Only when no overlay is open; pickers consume arrows above.
      // Up enters/continues history; allowed when browsing (historyIndex !== -1)
      // even if the recalled line opens a palette/picker.
      if ((historyIndex !== -1 || (!paletteOpen && !fileOpen)) && key.upArrow) {
        if (inputHistory.length === 0) return
        if (historyIndex === -1) { historyDraft = input; historyIndex = inputHistory.length - 1 }
        else if (historyIndex > 0) historyIndex--
        const val = inputHistory[historyIndex]
        setInput(() => val); setCaret(() => val.length)
        return
      }
      if ((historyIndex !== -1 || (!paletteOpen && !fileOpen)) && key.downArrow) {
        if (historyIndex === -1) return
        if (historyIndex < inputHistory.length - 1) {
          historyIndex++
          const val = inputHistory[historyIndex]
          setInput(() => val); setCaret(() => val.length)
        } else {
          historyIndex = -1
          setInput(() => historyDraft); setCaret(() => historyDraft.length)
        }
        return
      }

      // submit / built-in commands
      if (key.return) {
        // Whatever you were reading, sending snaps the view back to the tail so
        // the reply is visible as it arrives.
        scrollToBottom()
        const trimmed = input.trim()
        // Resolved once, up front: the built-in chain below tests it as a
        // condition and then uses it, and looking it up twice re-reads the
        // command directory on every send.
        const custom = customCommandFor(trimmed)
        pushHistory(trimmed)
        historyIndex = -1
        historyDraft = ''
        if (trimmed === '/models') {
          setPickerQuery('')
          setCursor(() => Math.max(0, models.findIndex((m) => m === cfg.model)))
          setState('models')
        } else if (trimmed === '/provider' || trimmed === '/providers') {
          setPickerQuery('')
          setCursor(() => Math.max(0, providers.findIndex((p) => p.name === cfg.provider)))
          setState('providers')
        } else if (trimmed === '/copy' || trimmed.startsWith('/copy ')) {
          const arg = trimmed.slice('/copy'.length).trim()
          const target = parseCopyTarget(arg)
          if (target) copyToClipboard(target)
          else setNotice(`unknown /copy target "${arg}" — try last, code, tool or all`)
        } else if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
          // Summarise and carry on rather than starting over. The transcript is
          // left on screen; only the history sent to the model shrinks.
          const instructions = trimmed.slice('/compact'.length).trim()
          setNotice(null)
          void compact(instructions || undefined)
        } else if (trimmed === '/clear') {
          hardClear()
          clearSession()
        } else if (trimmed === '/new') {
          // Current session is already auto-saved with an LLM title; just start
          // a fresh session id and wipe the chat.
          if (agentHistory.length) setNotice('session saved')
          setSessionId(newSessionId())
          resetTerminalTitle()
          hardClear()
          clearSession()
        } else if (trimmed === '/sessions') {
          setSessions(listSessions())
          setCursor(() => 0)
          setState('sessions')
        } else if (trimmed === '/plan') {
          // Explicit way in, for people who haven't found shift+tab. Toggles,
          // so the same key gets you back out of a plan you no longer want.
          const next: PermissionMode = modeRef.current === 'plan' ? 'default' : 'plan'
          setMode(next)
          noticeMode(next)
        } else if (trimmed === '/permissions') {
          showPermissions()
        } else if (trimmed === '/exit') {
          exit()
        } else if (trimmed.startsWith('/provider ')) {
          const p = trimmed.slice('/provider '.length).trim() as Provider
          const names = providers.map((x) => x.name)
          if (names.includes(p)) {
            setNotice(`switched to ${p}`)
            switchProvider(p)
          } else {
            setNotice(`unknown provider "${p}" — configured: ${names.join(', ')}`)
          }
        } else if (custom) {
          // A Markdown file under .miii/commands. Its body becomes the prompt,
          // so from here on it is an ordinary turn — which is the point: a
          // custom command is a saved message, not a new kind of thing.
          setNotice(null)
          sendMessage(expandCommand(custom.command.body, custom.args))
        } else if (trimmed) {
          setNotice(null)
          // Pull any image chips out of the text, gathering their base64 bytes
          // to send as the message's images[]. The chip text itself is removed.
          const images: string[] = []
          let textPart = trimmed
          for (const [chip, b64] of imageStore) {
            if (textPart.includes(chip)) {
              images.push(b64)
              textPart = textPart.split(chip).join('').trim()
            }
          }
          // Expand any paste chips back into their real text before sending.
          // The session title is generated after the first assistant reply
          // (see the auto-save effect in App.tsx), not from this raw message.
          const message = expandPastes(textPart) || 'Describe the attached image.'
          sendMessage(message, images.length ? images : undefined)
        }
        clearPasteStore()
        setInput(() => '')
        setCaret(() => 0)
        setPaletteCursor(() => 0)
        return
      }

      // --- caret movement (left/right, home/end, ctrl+a/ctrl+e) ---
      if (key.leftArrow) { setCaret((i) => Math.max(0, i - 1)); return }
      if (key.rightArrow) { setCaret((i) => Math.min(input.length, i + 1)); return }
      if (key.ctrl && char === 'a') { setCaret(() => 0); return }
      if (key.ctrl && char === 'e') { setCaret(() => input.length); return }

      // text editing — any edit drops out of history browsing
      if (key.backspace || key.delete) {
        historyIndex = -1
        setPaletteCursor(() => 0); setFilePickerCursor(() => 0)
        if (caret <= 0) return
        const before = input.slice(0, caret)
        // If the text just left of the caret ends with a paste chip, delete it
        // whole (longest match wins so adjacent chips don't clip) and forget it.
        let match = ''
        for (const chip of pasteStore.keys()) {
          if (before.endsWith(chip) && chip.length > match.length) match = chip
        }
        for (const chip of imageStore.keys()) {
          if (before.endsWith(chip) && chip.length > match.length) match = chip
        }
        const cut = match ? match.length : 1
        if (match) { pasteStore.delete(match); imageStore.delete(match) }
        setInput((s) => s.slice(0, caret - cut) + s.slice(caret))
        setCaret((i) => Math.max(0, i - cut))
      } else if (char && !key.ctrl && !key.meta && !key.tab) {
        const text = sanitizePaste(char)
        if (text) {
          historyIndex = -1
          setPaletteCursor(() => 0); setFilePickerCursor(() => 0)
          setInput((s) => s.slice(0, caret) + text + s.slice(caret))
          setCaret((i) => i + text.length)
        }
      }
    }
  })
}
