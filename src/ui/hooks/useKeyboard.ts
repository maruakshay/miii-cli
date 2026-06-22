/**
 * useKeyboard — wires all keyboard input for the App.
 *
 * Centralises key routing so App.tsx stays declarative.
 * Depends on refs/setters passed in from App state.
 */
import { useInput } from 'ink'
import { setModel, setEffort, type NamedProvider, type Provider, type Effort } from '../../config.js'
import { filteredCommands } from '../CommandPalette.js'
import { parseMention, searchFiles } from '../FilePicker.js'
import { toggleThinkingVisible } from '../ThinkingBlock.js'
import { toggleToolExpanded } from '../ChatView.js'
import {
  persistSession,
  listSessions,
  loadSession,
  deleteSession,
  toDisplayMessages,
  newSessionId,
  type SessionMeta,
} from '../../session/store.js'
import type { useAgentRunner } from './useAgentRunner.js'

const EFFORTS: Effort[] = ['low', 'medium', 'high']

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

function clearPasteStore() {
  pasteStore.clear()
  pasteCounter = 0
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
  contexts: Record<string, number>
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

  // provider switching
  switchProvider: (p: Provider) => void
}

export function useKeyboard(opts: KeyboardOptions) {
  const {
    exit, state, setState,
    models, cursor, setCursor, contexts, cfg, setCfg, setActiveCtx,
    providers, pickerQuery, setPickerQuery,
    agent,
    input, setInput, paletteCursor, setPaletteCursor, filePickerCursor, setFilePickerCursor,
    sessionId, setSessionId, onResumeSession, sessions, setSessions, setNotice,
    switchProvider,
  } = opts

  const {
    pendingPermissionRef, permissionCursor, setPermissionCursor, resolvePermission,
    busyRef, abortRef,
    sendMessage, agentHistory, setMessages, setAgentHistory, setStreamingContent, setThinkingContent,
    setActiveToolUses, setActiveToolResults, setError,
  } = agent

  /** Wipe all chat/streaming state back to an empty session. */
  function clearSession() {
    setMessages(() => [])
    setAgentHistory([])
    setStreamingContent('')
    setThinkingContent('')
    setActiveToolUses([])
    setActiveToolResults([])
    setError(null)
    setNotice(null)
    clearPasteStore()
  }

  const effort: Effort = cfg.effort ?? 'medium'

  useInput((char, key) => {
    // --- global shortcuts ---
    if (key.ctrl && char === 'c') { exit(); return }
    // Ctrl+T toggles thinking block content visibility
    if (key.ctrl && char === 't') { toggleThinkingVisible(); return }
    // Ctrl+O toggles full tool output (collapsed to a few lines by default)
    if (key.ctrl && char === 'o') { toggleToolExpanded(); return }

    if (key.escape && busyRef.current && abortRef.current) {
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
        setMessages(toDisplayMessages(history))
        setStreamingContent('')
        setThinkingContent('')
        setActiveToolUses([])
        setActiveToolResults([])
        setError(null)
        setSessionId(meta.id)
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

      const paletteOpen = input.startsWith('/')
      const matches = paletteOpen ? filteredCommands(input) : []
      const mention = !paletteOpen ? parseMention(input) : null
      const fileMatches = mention ? searchFiles(process.cwd(), mention.query) : []
      const fileOpen = mention !== null && fileMatches.length > 0

      // command palette navigation
      if (paletteOpen && key.upArrow) { setPaletteCursor((i) => Math.max(0, i - 1)); return }
      if (paletteOpen && key.downArrow) { setPaletteCursor((i) => Math.min(matches.length - 1, i + 1)); return }
      if (paletteOpen && (key.tab || key.return) && matches[paletteCursor] && input !== matches[paletteCursor].name) {
        setInput(() => matches[paletteCursor].name)
        setPaletteCursor(() => 0)
        return
      }
      if (paletteOpen && key.escape) { clearPasteStore(); setInput(() => ''); setPaletteCursor(() => 0); return }

      // file picker navigation
      if (fileOpen && key.upArrow) { setFilePickerCursor((i) => Math.max(0, i - 1)); return }
      if (fileOpen && key.downArrow) { setFilePickerCursor((i) => Math.min(fileMatches.length - 1, i + 1)); return }
      if (fileOpen && key.tab && fileMatches[filePickerCursor]) {
        const picked = fileMatches[filePickerCursor]
        setInput((s) => s.slice(0, mention!.start) + '@' + picked + ' ')
        setFilePickerCursor(() => 0)
        return
      }
      if (fileOpen && key.escape) { setFilePickerCursor(() => 0); return }

      // submit / built-in commands
      if (key.return) {
        const trimmed = input.trim()
        if (trimmed === '/models') {
          setPickerQuery('')
          setCursor(() => Math.max(0, models.findIndex((m) => m === cfg.model)))
          setState('models')
        } else if (trimmed === '/provider' || trimmed === '/providers') {
          setPickerQuery('')
          setCursor(() => Math.max(0, providers.findIndex((p) => p.name === cfg.provider)))
          setState('providers')
        } else if (trimmed === '/clear') {
          clearSession()
        } else if (trimmed === '/new') {
          // Current session is already auto-saved with an LLM title; just start
          // a fresh session id and wipe the chat.
          if (agentHistory.length) setNotice('session saved')
          setSessionId(newSessionId())
          clearSession()
        } else if (trimmed === '/sessions') {
          setSessions(listSessions())
          setCursor(() => 0)
          setState('sessions')
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
        } else if (trimmed) {
          setNotice(null)
          // Expand any paste chips back into their real text before sending.
          // The session title is generated after the first assistant reply
          // (see the auto-save effect in App.tsx), not from this raw message.
          const message = expandPastes(trimmed)
          sendMessage(message)
        }
        clearPasteStore()
        setInput(() => '')
        setPaletteCursor(() => 0)
        return
      }

      // text editing
      if (key.backspace || key.delete) {
        setInput((s) => {
          setPaletteCursor(() => 0); setFilePickerCursor(() => 0)
          // If the input ends with a paste chip, delete it whole (longest suffix
          // match wins, so adjacent chips don't clip each other) and forget it.
          let match = ''
          for (const chip of pasteStore.keys()) {
            if (s.endsWith(chip) && chip.length > match.length) match = chip
          }
          if (match) { pasteStore.delete(match); return s.slice(0, -match.length) }
          return s.slice(0, -1)
        })
      } else if (char && !key.ctrl && !key.meta && !key.tab) {
        const text = sanitizePaste(char)
        if (text) setInput((s) => { setPaletteCursor(() => 0); setFilePickerCursor(() => 0); return s + text })
      }
    }
  })
}
