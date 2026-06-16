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
  summarizeMessage,
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
    sessionId, setSessionId, sessions, setSessions, setNotice,
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
      if (paletteOpen && key.escape) { setInput(() => ''); setPaletteCursor(() => 0); return }

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
          // On the first message of a session, summarise it into a title and
          // persist (background, best-effort).
          if (!agentHistory.length && cfg.model) {
            const id = sessionId
            const model = cfg.model
            void (async () => {
              try {
                const title = await summarizeMessage(model, trimmed)
                persistSession(id, [{ role: 'user', content: trimmed }], title)
              } catch { /* best-effort */ }
            })()
          }
          sendMessage(trimmed)
        }
        setInput(() => '')
        setPaletteCursor(() => 0)
        return
      }

      // text editing
      if (key.backspace || key.delete) {
        setInput((s) => { setPaletteCursor(() => 0); setFilePickerCursor(() => 0); return s.slice(0, -1) })
      } else if (char && !key.ctrl && !key.meta && !key.tab) {
        setInput((s) => { setPaletteCursor(() => 0); setFilePickerCursor(() => 0); return s + char })
      }
    }
  })
}
