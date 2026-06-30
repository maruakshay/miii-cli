/**
 * App — root component.
 *
 * Owns top-level state (model list, selected model, app screen) and
 * delegates streaming logic to useAgentRunner and key handling to useKeyboard.
 */
import { useState, useEffect, useRef } from 'react'
import { Box, Text, useApp } from 'ink'
import { homedir } from 'os'
import { sep } from 'path'
import { listModels, modelContext, isAvailable, NOT_AVAILABLE } from '../llm/client.js'
import { loadConfig, setProvider, setModelContexts, providerEntries, resolveProvider, autoUpdateEnabled, type Effort, type Provider } from '../config.js'
import { WelcomeBlock, updateBannerText, type UpdateStatus } from './WelcomeBlock.js'
import { InputBar } from './InputBar.js'
import { ModelsView } from './ModelsView.js'
import { ProviderPicker } from './ProviderPicker.js'
import { SessionsView } from './SessionsView.js'
import { CommandPalette } from './CommandPalette.js'
import { persistSession, setSessionTitle, summarizeConversation, newSessionId, type SessionMeta } from '../session/store.js'
import { setTerminalTitle, resetTerminalTitle } from './terminalTitle.js'
import { FilePicker, parseMention, searchFiles } from './FilePicker.js'
import { ChatView } from './ChatView.js'
import { useAgentRunner } from './hooks/useAgentRunner.js'
import { useKeyboard } from './hooks/useKeyboard.js'
import { checkForUpdate, autoUpdate } from '../updateCheck.js'

type AppState = 'loading' | 'select-model' | 'ready' | 'models' | 'providers' | 'sessions'

export function App() {
  const { exit } = useApp()
  const cwd = process.cwd().replace(homedir(), '~').split(sep).join('/')

  // --- config & model list ---
  const [cfg, setCfg] = useState(loadConfig())
  const [models, setModels] = useState<string[]>([])
  // Seed from the cached context windows so the header shows a real value on the
  // first render, before the live `show` request resolves.
  const [contexts, setContexts] = useState<Record<string, number | null>>(() => cfg.modelContexts ?? {})
  const [activeCtx, setActiveCtx] = useState<number | null>(
    () => (cfg.model ? cfg.modelContexts?.[cfg.model] ?? null : null),
  )
  const [state, setState] = useState<AppState>('loading')
  const [cursor, setCursor] = useState(0)
  const [pickerQuery, setPickerQuery] = useState('')
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [providerDown, setProviderDown] = useState(false)

  // --- sessions ---
  const [sessionId, setSessionId] = useState(() => newSessionId())
  // Live mirror of sessionId so async callbacks can check the *current* active
  // session, not the one captured when they started.
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  // --- input bar ---
  const [input, setInput] = useState('')
  // Caret column into `input` (0..input.length); enables mid-string editing.
  const [caret, setCaret] = useState(0)
  const [paletteCursor, setPaletteCursor] = useState(0)
  const [filePickerCursor, setFilePickerCursor] = useState(0)

  // --- agent streaming & permission state (owned by hook) ---
  const agent = useAgentRunner(cfg.model, activeCtx)

  useEffect(() => {
    checkForUpdate().then((v) => {
      if (!v) return
      setUpdateAvailable(v)
      // Pull the new release in the background; it applies on next launch. Track
      // the real outcome: downloading while it runs, then installed or failed.
      // Stays 'idle' (manual banner) on the rate-limit cooldown or a failed spawn.
      if (autoUpdateEnabled()) {
        const started = autoUpdate((ok) => setUpdateStatus(ok ? 'installed' : 'failed'))
        if (started) setUpdateStatus('downloading')
      }
    })
  }, [])

  // Restore the terminal tab title when miii exits (component unmounts).
  useEffect(() => resetTerminalTitle, [])

  // Tracks sessions whose LLM title has been generated, so we summarise once.
  const titledSessions = useRef<Set<string>>(new Set())

  // Auto-save the active session to disk every time the agent history grows.
  // Once the first assistant reply lands, summarise the exchange into a title
  // (Claude Code-style) — background, best-effort, generated exactly once.
  useEffect(() => {
    const history = agent.agentHistory
    if (!history.length) return
    persistSession(sessionId, history)

    if (
      !titledSessions.current.has(sessionId) &&
      cfg.model &&
      history.some((m) => m.role === 'assistant')
    ) {
      titledSessions.current.add(sessionId)
      const id = sessionId
      const model = cfg.model
      const snapshot = history
      void (async () => {
        try {
          const title = await summarizeConversation(model, snapshot)
          setSessionTitle(id, title)
          // Reflect the summary in the terminal tab title, if still the active session.
          if (id === sessionIdRef.current) setTerminalTitle(title)
        } catch { /* best-effort */ }
      })()
    }
  }, [agent.agentHistory, sessionId, cfg.model])

  // afterProvider=true forces the model picker (provider just changed); otherwise
  // a configured-and-available model goes straight to chat. Any load error bounces
  // back to the provider picker so the user can choose a reachable backend.
  // Bumped on every loadModels call so a stale in-flight request (e.g. from a
  // provider the user already switched away from) can't clobber current state.
  const loadGen = useRef(0)

  const loadModels = (afterProvider = false) => {
    const gen = ++loadGen.current
    const stale = () => gen !== loadGen.current
    setProviderDown(false)
    listModels()
      .then((m) => {
        if (stale()) return
        setModels(m)
        const hasModel = !!cfg.model && m.includes(cfg.model)
        if (afterProvider) {
          setState(hasModel ? 'models' : 'select-model')
        } else {
          setState(hasModel ? 'ready' : 'select-model')
        }
        Promise.all(
          m.map((name) =>
            modelContext(name)
              .then((ctx) => [name, ctx] as const)
              .catch(() => [name, null] as const),
          ),
        )
          .then((pairs) => {
            if (stale()) return
            const map = Object.fromEntries(pairs)
            setContexts(map)
            const resolved = Object.fromEntries(
              pairs.filter((p): p is readonly [string, number] => p[1] != null),
            )
            if (Object.keys(resolved).length) setModelContexts(resolved)
            const active = (hasModel ? cfg.model : undefined) ?? m[0]
            if (active && map[active] != null) setActiveCtx(map[active])
          })
          .catch(() => {})
      })
      .catch((err: unknown) => {
        if (stale()) return
        const msg = err instanceof Error ? err.message : String(err)
        agent.setError(isAvailable() ? msg : NOT_AVAILABLE())
        setProviderDown(true)
        setModels([])
        setPickerQuery('')
        setCursor(() => 0)
        // Error reaching the provider — drop to chat with the error shown and the
        // input live, so the user can run /provider, /models, etc. to recover.
        setState('ready')
      })
  }

  // Load available models on mount; advance past loading screen once done.
  useEffect(loadModels, [])

  function switchProvider(p: Provider) {
    setProvider(p)
    setCfg((c) => ({ ...c, provider: p }))
    setPickerQuery('')
    setCursor(() => 0)
    agent.setError(null)
    loadModels(true)
  }

  // Active provider derived from cfg state (no disk reads per render).
  const { name: provName, entry: provEntry } = resolveProvider(cfg)

  // Filtered lists for the pickers (case-insensitive substring match).
  const q = pickerQuery.toLowerCase()
  const filteredModels = q ? models.filter((m) => m.toLowerCase().includes(q)) : models
  const allProviders = providerEntries(cfg)
  const filteredProviders = q
    ? allProviders.filter((p) => p.name.toLowerCase().includes(q))
    : allProviders

  // Wire keyboard — all key routing lives in useKeyboard.
  useKeyboard({
    exit, state, setState,
    models: filteredModels, cursor, setCursor, contexts, cfg, setCfg, setActiveCtx,
    providers: filteredProviders, pickerQuery, setPickerQuery,
    agent,
    input, setInput, caret, setCaret, paletteCursor, setPaletteCursor, filePickerCursor, setFilePickerCursor,
    sessionId, setSessionId,
    onResumeSession: (id) => titledSessions.current.add(id),
    sessions, setSessions, setNotice,
    switchProvider,
  })

  const effort: Effort = cfg.effort ?? 'medium'

  // Context usage warning threshold — warn when >= 70% of context window used.
  const contextWarning = (() => {
    if (!activeCtx) return null
    const last = [...agent.messages].reverse().find((m) => m.role === 'assistant' && m.tokens)
    const used = last?.tokens ? last.tokens.prompt_eval + last.tokens.eval : 0
    if (used < activeCtx * 0.7) return null
    return Math.round((used / activeCtx) * 100)
  })()

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Pre-ready screens render the banner dynamically. In ready/chat mode the
          banner moves into ChatView's <Static> log (Ink prints Static above the
          live frame, so a dynamic banner here would sink below the scrollback). */}
      {state !== 'ready' && (
        <WelcomeBlock model={cfg.model} activeCtx={activeCtx} effort={effort} cwd={cwd} error={agent.error} updateAvailable={updateAvailable} updateStatus={updateStatus} />
      )}

      {state === 'loading' && !agent.error && (
        <Box marginLeft={2} marginBottom={1}>
          <Text dimColor>{`connecting to ${provName}…`}</Text>
        </Box>
      )}

      {agent.error && state !== 'ready' && (
        <ChatView
          messages={[]}
          streaming={false}
          streamingContent=""
          thinking={false}
          error={agent.error}
        />
      )}

      {(state === 'select-model' || state === 'models') && (
        <ModelsView
          models={filteredModels}
          cursor={cursor}
          model={cfg.model}
          host={provEntry.baseUrl}
          provider={provName}
          effort={effort}
          query={pickerQuery}
          requireSelection={state === 'select-model'}
        />
      )}

      {state === 'providers' && (
        <ProviderPicker
          entries={filteredProviders}
          cursor={cursor}
          activeName={provName}
          query={pickerQuery}
        />
      )}

      {state === 'sessions' && (
        <SessionsView sessions={sessions} cursor={cursor} />
      )}

      {state === 'ready' && (
        <>
          {notice && (
            <Box marginLeft={2} marginBottom={1}>
              <Text color="green">{`✓ ${notice}`}</Text>
            </Box>
          )}
          <ChatView
            messages={agent.messages}
            streaming={agent.streaming}
            streamingContent={agent.streamingContent}
            thinking={agent.thinking}
            thinkingContent={agent.thinkingContent}
            error={agent.error}
            pendingPermission={agent.pendingPermission}
            permissionCursor={agent.permissionCursor}
            activeToolUses={agent.activeToolUses}
            activeToolResults={agent.activeToolResults}
            header={<WelcomeBlock model={cfg.model} activeCtx={activeCtx} effort={effort} cwd={cwd} />}
          />

          {input.startsWith('/') && (
            <CommandPalette filter={input} cursor={paletteCursor} />
          )}

          {contextWarning !== null && (
            <Box marginLeft={2} marginBottom={1}>
              <Text color="yellow">
                {`⚠ context ${contextWarning}% full — run /clear and start fresh`}
              </Text>
            </Box>
          )}

          {!input.startsWith('/') && (() => {
            const m = parseMention(input)
            if (!m) return null
            return <FilePicker matches={searchFiles(process.cwd(), m.query)} cursor={filePickerCursor} />
          })()}

          <InputBar input={input} caret={caret} disabled={agent.busy} processingLabel={agent.processingLabel} />
          {!agent.busy && (
            <Box marginLeft={2} marginBottom={1}>
              <Text dimColor>
                {providerDown
                  ? 'provider unavailable — /provider to switch · /models to pick a model'
                  : 'type / to see commands'}
              </Text>
            </Box>
          )}
          {updateAvailable && (
            <Box marginLeft={2} marginBottom={1}>
              <Text color={updateStatus === 'failed' ? 'red' : updateStatus === 'installed' ? 'green' : 'yellow'}>
                {updateBannerText(updateAvailable, updateStatus)}
              </Text>
            </Box>
          )}
        </>
      )}
    </Box>
  )
}
