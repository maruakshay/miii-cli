/**
 * App — root component.
 *
 * Owns top-level state (model list, selected model, app screen) and
 * delegates streaming logic to useAgentRunner and key handling to useKeyboard.
 */
import { useState, useEffect, useRef } from 'react'
import { Box, Text, useApp, useStdout } from 'ink'
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
import { enableMouse, disableMouse, isMouseEnabled, onMouseChange } from './mouse.js'
import { FilePicker, parseMention, searchFiles } from './FilePicker.js'
import { ChatView } from './ChatView.js'
import { useAgentRunner } from './hooks/useAgentRunner.js'
import { useKeyboard } from './hooks/useKeyboard.js'
import { checkForUpdate, autoUpdate } from '../updateCheck.js'

/** Warn the user once this share of the context window is in use. */
const CONTEXT_WARN_AT = 0.7

/**
 * Compact automatically at this share. Deliberately below the hard limit: the
 * summariser needs room to read the transcript and write the recap, and a turn
 * that overflows mid-tool-call is a worse experience than one that pauses to
 * compact itself.
 */
const AUTO_COMPACT_AT = 0.85

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
  // Bumped on /clear and /new to remount ChatView's transcript so its measured
  // height restarts from the empty log.
  const [logEpoch, setLogEpoch] = useState(0)

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

  // The transcript scrolls inside the app's own viewport, so miii needs the
  // wheel: ask the terminal to report clicks and wheel notches while it runs,
  // and hand reporting back on the way out.
  useEffect(() => {
    enableMouse()
    return disableMouse
  }, [])

  // ctrl+s hands the mouse back to the terminal so a drag selects text again;
  // track it so the input bar can say the wheel has stopped scrolling. Synced on
  // subscribe because the effect above has already switched reporting on by now.
  const [mouseOn, setMouseOn] = useState(isMouseEnabled)
  useEffect(() => {
    setMouseOn(isMouseEnabled())
    return onMouseChange(() => setMouseOn(isMouseEnabled()))
  }, [])

  // Ink recalculates its layout on resize but doesn't re-render the tree, so the
  // fixed-height root below would keep the old row count. Bump state to force it.
  const { stdout } = useStdout()
  const [termRows, setTermRows] = useState(stdout?.rows ?? 24)
  useEffect(() => {
    const onResize = () => setTermRows(stdout?.rows ?? 24)
    stdout?.on('resize', onResize)
    return () => { stdout?.off('resize', onResize) }
  }, [stdout])

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
    sessions, setSessions, setNotice, setLogEpoch,
    switchProvider,
  })

  const effort: Effort = cfg.effort ?? 'medium'

  // How full the context is, as a fraction. usedTokens is the runner's live
  // reading — reported by the model after each turn, and corrected by
  // compaction — so it drops the moment the history shrinks.
  const contextPct = activeCtx && agent.usedTokens ? agent.usedTokens / activeCtx : 0
  const contextWarning = contextPct >= CONTEXT_WARN_AT ? Math.round(contextPct * 100) : null

  // Auto-compact when the window is nearly full, between turns. The ref latches
  // so a compaction that fails (or one whose summary is still large) isn't
  // retried on every render — it re-arms only once usage falls back under the
  // threshold.
  const autoCompacted = useRef(false)
  useEffect(() => {
    if (contextPct < AUTO_COMPACT_AT) { autoCompacted.current = false; return }
    if (autoCompacted.current || agent.busy || state !== 'ready' || !cfg.model) return
    autoCompacted.current = true
    void agent.compact()
  }, [contextPct, agent.busy, state, cfg.model])

  // Chat mode owns the whole screen: the root is pinned to the terminal height
  // (less one row, so writing the frame can't scroll it) and ChatView's viewport
  // flex-grows into whatever the input bar and pickers leave. Pre-ready screens
  // stay auto-height — they're short, and a full-height frame there would just
  // blank the terminal.
  const fullScreen = state === 'ready' || state === 'sessions' || state === 'models'

  return (
    <Box flexDirection="column" paddingX={1} height={fullScreen ? Math.max(8, termRows - 1) : undefined}>
      {/* Pre-ready screens render the banner dynamically. In ready/chat mode it
          moves inside the scrolling transcript, as its first row, so it scrolls
          away with the rest of the history. */}
      {state !== 'ready' && state !== 'sessions' && state !== 'models' && (
        <WelcomeBlock variant="compact" model={cfg.model} activeCtx={activeCtx} effort={effort} cwd={cwd} provider={provName} error={agent.error} updateAvailable={updateAvailable} updateStatus={updateStatus} />
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

      {state === 'select-model' && (
        <ModelsView
          models={filteredModels}
          cursor={cursor}
          model={cfg.model}
          host={provEntry.baseUrl}
          provider={provName}
          providerType={provEntry.type}
          effort={effort}
          query={pickerQuery}
          requireSelection
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

      {(state === 'ready' || state === 'sessions' || state === 'models') && (
        // Everything except the transcript is flexShrink={0}: the root is pinned
        // to the terminal height, and the viewport is what gives up rows when the
        // palette, a picker or a warning needs them.
        <>
          {notice && (
            <Box marginLeft={2} marginBottom={1} flexShrink={0}>
              <Text color="green">{`✓ ${notice}`}</Text>
            </Box>
          )}
          <ChatView
            messages={agent.messages}
            streaming={agent.streaming}
            streamingContent={agent.streamingContent}
            thinking={agent.thinking}
            thinkingTail={agent.thinkingTail}
            error={agent.error}
            pendingPermission={agent.pendingPermission}
            permissionCursor={agent.permissionCursor}
            activeToolUses={agent.activeToolUses}
            activeToolResults={agent.activeToolResults}
            header={<WelcomeBlock model={cfg.model} activeCtx={activeCtx} effort={effort} cwd={cwd} provider={provName} />}
            logEpoch={logEpoch}
          />

          {state === 'ready' && input.startsWith('/') && (
            <Box flexShrink={0} flexDirection="column">
              <CommandPalette filter={input} cursor={paletteCursor} />
            </Box>
          )}

          {state === 'ready' && contextWarning !== null && (
            <Box marginLeft={2} marginBottom={1} flexShrink={0}>
              <Text color="yellow">
                {contextPct >= AUTO_COMPACT_AT
                  ? `⚠ context ${contextWarning}% full — compacting automatically after this turn`
                  : `⚠ context ${contextWarning}% full — /compact to summarize and keep going, /clear to start over`}
              </Text>
            </Box>
          )}

          {state === 'ready' && !input.startsWith('/') && (() => {
            const m = parseMention(input)
            if (!m) return null
            return (
              <Box flexShrink={0} flexDirection="column">
                <FilePicker matches={searchFiles(process.cwd(), m.query)} cursor={filePickerCursor} />
              </Box>
            )
          })()}

          {/* Pickers have their own inline controls, so they drop the input bar
              entirely (avoids a stray "processing" prompt). */}
          {state === 'ready' && (
            <Box flexShrink={0} flexDirection="column">
              <InputBar
                input={input}
                caret={caret}
                disabled={agent.busy}
                processingLabel={agent.processingLabel}
                hint={
                  providerDown
                    ? 'provider unavailable — /provider to switch · /models to pick a model'
                    : mouseOn
                      ? undefined
                      : 'mouse off — drag to select and copy · ctrl+s to scroll with the wheel again'
                }
              />
            </Box>
          )}

          {/* Pickers render below the input bar (like the command palette) so the
              transcript's banner stays put — no duplicate header. */}
          {state === 'sessions' && (
            <Box flexShrink={0} flexDirection="column">
              <SessionsView sessions={sessions} cursor={cursor} />
            </Box>
          )}
          {state === 'models' && (
            <Box flexShrink={0} flexDirection="column">
              <ModelsView
                models={filteredModels}
                cursor={cursor}
                model={cfg.model}
                host={provEntry.baseUrl}
                provider={provName}
                providerType={provEntry.type}
                effort={effort}
                query={pickerQuery}
              />
            </Box>
          )}

          {updateAvailable && (
            <Box marginLeft={2} marginBottom={1} flexShrink={0}>
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
