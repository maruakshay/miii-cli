/**
 * App — root component.
 *
 * Owns top-level state (model list, selected model, app screen) and
 * delegates streaming logic to useAgentRunner and key handling to useKeyboard.
 */
import { useState, useEffect, useRef } from 'react'
import { Box, Text, measureElement, useApp, useStdout, type DOMElement } from 'ink'
import { homedir } from 'os'
import { sep } from 'path'
import { listModels, modelContext, isAvailable, NOT_AVAILABLE } from '../llm/client.js'
import { loadConfig, setProvider, setModelContexts, providerEntries, resolveProvider, autoUpdateEnabled, type Effort, type Provider } from '../config.js'
import { setFrameHeight } from './toolHit.js'
import { WelcomeBlock, updateBannerText, type UpdateStatus } from './WelcomeBlock.js'
import { InputBar } from './InputBar.js'
import { ModelsView } from './ModelsView.js'
import { ProviderPicker } from './ProviderPicker.js'
import { SessionsView } from './SessionsView.js'
import { CommandPalette } from './CommandPalette.js'
import { persistSession, setSessionTitle, summarizeConversation, newSessionId, listSessions, loadSession, toDisplayMessages, type SessionMeta } from '../session/store.js'
import { setTerminalTitle, resetTerminalTitle } from './terminalTitle.js'
import { enableMouse, disableMouse, isMouseEnabled, onMouseChange } from './mouse.js'
import { FilePicker, parseMention, searchFiles } from './FilePicker.js'
import { ChatView } from './ChatView.js'
import { useAgentRunner } from './hooks/useAgentRunner.js'
import { useKeyboard, vimIndicator } from './hooks/useKeyboard.js'
import { checkForUpdate, autoUpdate } from '../updateCheck.js'
import { initMcp, closeMcp, type McpServerStatus } from '../mcp/registry.js'
import { defaultPermissionMode, loadSettings } from '../settings.js'
import { estimateHistoryTokens } from '../agent/compact.js'

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

export interface AppProps {
  /** `--resume <id>` — open this session instead of a new one. */
  resumeId?: string
  /** `-c` / `--continue` — open the most recently updated session. */
  continueLast?: boolean
}

export function App({ resumeId, continueLast }: AppProps) {
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
  // Mirrors `contexts` for the async resolvers below, which would otherwise
  // close over a stale map and re-request numbers already in hand.
  const rootRef = useRef<DOMElement | null>(null)
  const contextsRef = useRef(contexts)
  contextsRef.current = contexts
  // Names with a lookup already in flight. Both resolvers below can want the
  // same model at once (the active one, when the picker is the opening screen);
  // without this it gets fetched twice.
  const ctxInFlight = useRef(new Set<string>())
  const [state, setState] = useState<AppState>('loading')
  const [cursor, setCursor] = useState(0)
  const [pickerQuery, setPickerQuery] = useState('')
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [providerDown, setProviderDown] = useState(false)

  // --- sessions ---
  /**
   * Resolved once, at mount: --resume names a session, --continue means the most
   * recent one, and anything else is a new session. Done in the initialiser so
   * the very first persistSession writes to the right file rather than minting a
   * new id and orphaning the one we were asked to continue.
   */
  const [sessionId, setSessionId] = useState(
    () => resumeId ?? (continueLast ? listSessions()[0]?.id : undefined) ?? newSessionId(),
  )
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
  const agent = useAgentRunner(cfg.model, activeCtx, sessionId)

  // --- MCP ---
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])

  /**
   * Connect the configured MCP servers once, on mount. Their tools join the
   * registry as they land, so a slow server simply shows up a moment later
   * rather than holding the session closed while it starts.
   */
  useEffect(() => {
    let live = true
    void initMcp(process.cwd())
      .then((servers) => {
        if (!live) return
        setMcpServers(servers)
        const broken = servers.filter((sv) => !sv.connected)
        if (broken.length) {
          setNotice(`MCP: ${broken.map((sv) => `${sv.name} unavailable`).join(', ')} — /mcp for details`)
        }
      })
      .catch(() => {})
    return () => {
      live = false
      void closeMcp()
    }
  }, [])

  /**
   * Restore a session named on the command line. Runs after mount rather than in
   * the state initialiser because it has to fill both halves — the transcript
   * the user reads and the history the model is sent — and those live in the
   * agent runner, not here.
   */
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    if (!resumeId && !continueLast) return
    restored.current = true
    const history = loadSession(sessionId)
    if (!history.length) {
      setNotice(resumeId ? `no session "${resumeId}" — started a new one` : 'no session to continue')
      return
    }
    agent.setAgentHistory(history)
    agent.setMessages(toDisplayMessages(history))
    agent.setUsedTokens(estimateHistoryTokens(history))
    // Already titled on disk; don't spend a summarisation call re-deriving it.
    titledSessions.current.add(sessionId)
    setNotice(`resumed session · ${history.length} messages`)
  }, [])

  /**
   * SessionStart fires once, when the session opens. Its stdout is not injected
   * anywhere — there is no turn to attach it to yet — so it is shown as a notice
   * instead: the use is "tell me what branch I'm on and whether CI is red", and
   * that is information for the user, not the model.
   */
  useEffect(() => {
    void agent.hooks
      ?.fireSessionStart(resumeId || continueLast ? 'resume' : 'startup')
      .then((out) => {
        for (const w of out.warnings) setNotice(w)
        if (out.context) setNotice(out.context.split('\n')[0])
      })
      .catch(() => {})
  }, [])

  /** A project can pin the mode a session opens in — see settings.json. */
  useEffect(() => {
    const pinned = defaultPermissionMode(process.cwd())
    if (pinned) agent.setMode(pinned)
    loadSettings(process.cwd())
  }, [])

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

  /**
   * Resolve one model's context window and make it the active one.
   *
   * Cheap when already known. The fetch is per-model because that's what the
   * providers expose, which is exactly why it isn't done for the whole list.
   */
  const ensureContext = async (model: string, stale: () => boolean = () => false) => {
    const known = contextsRef.current[model]
    if (known != null) {
      setActiveCtx(known)
      return
    }
    if (ctxInFlight.current.has(model)) return
    ctxInFlight.current.add(model)
    try {
      const ctx = await modelContext(model)
      if (stale()) return
      setContexts((c) => ({ ...c, [model]: ctx }))
      setActiveCtx(ctx)
      setModelContexts({ [model]: ctx })
    } catch {
      // A missing context number is cosmetic — the header shows "— ctx" and
      // everything else carries on.
    } finally {
      ctxInFlight.current.delete(model)
    }
  }

  /**
   * Fill in the context windows the picker displays, for models we don't have a
   * number for yet.
   *
   * Deliberately not on the launch path: providers answer this one model at a
   * time, so asking for the whole list up front turns a launch (and every
   * provider switch) into one round trip per model — for numbers that are only
   * ever shown inside the picker.
   */
  const resolveContexts = (names: string[]) => {
    const gen = loadGen.current
    const unknown = names.filter(
      (n) => contextsRef.current[n] === undefined && !ctxInFlight.current.has(n),
    )
    if (unknown.length === 0) return
    for (const n of unknown) ctxInFlight.current.add(n)
    Promise.all(
      unknown.map((name) =>
        modelContext(name)
          .then((ctx) => [name, ctx] as const)
          .catch(() => [name, null] as const),
      ),
    )
      .then((pairs) => {
        if (gen !== loadGen.current) return
        setContexts((c) => ({ ...c, ...Object.fromEntries(pairs) }))
        const resolved = Object.fromEntries(
          pairs.filter((p): p is readonly [string, number] => p[1] != null),
        )
        if (Object.keys(resolved).length) setModelContexts(resolved)
      })
      .catch(() => {})
      .finally(() => {
        for (const n of unknown) ctxInFlight.current.delete(n)
      })
  }

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
        // Only the model we're about to use. The rest are filled in when the
        // picker opens — see the effect below.
        const active = (hasModel ? cfg.model : undefined) ?? m[0]
        if (active) void ensureContext(active, stale)
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

  // The picker is the only place the full set of context windows is shown, so
  // that's when they get fetched.
  useEffect(() => {
    if (state === 'models' || state === 'select-model') resolveContexts(models)
  }, [state, models])

  function switchProvider(p: Provider) {
    setProvider(p)
    // Re-read from disk rather than patching state: /provider add writes a new
    // entry into the providers map, and the picker renders from cfg, so a
    // patch-in-place would leave the provider you just added invisible.
    setCfg({ ...loadConfig(), provider: p })
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
    models: filteredModels, cursor, setCursor, cfg, setCfg, setActiveCtx, ensureContext,
    providers: filteredProviders, pickerQuery, setPickerQuery,
    agent,
    input, setInput, caret, setCaret, paletteCursor, setPaletteCursor, filePickerCursor, setFilePickerCursor,
    sessionId, setSessionId,
    onResumeSession: (id) => titledSessions.current.add(id),
    sessions, setSessions, setNotice, setLogEpoch,
    switchProvider, mcpServers, activeCtx,
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

  // Ink draws this frame in place at the bottom of the terminal, so a mouse
  // report's row only means something once the frame's height is known — that's
  // what turns a click into the tool block under it (toolHit.ts).
  useEffect(() => {
    if (rootRef.current) setFrameHeight(measureElement(rootRef.current).height)
  })

  // Chat mode owns the whole screen: the root is pinned to the terminal height
  // (less one row, so writing the frame can't scroll it) and ChatView's viewport
  // flex-grows into whatever the input bar and pickers leave. Pre-ready screens
  // stay auto-height — they're short, and a full-height frame there would just
  // blank the terminal.
  const fullScreen = state === 'ready' || state === 'sessions' || state === 'models'

  return (
    <Box ref={rootRef} flexDirection="column" paddingX={1} height={fullScreen ? Math.max(8, termRows - 1) : undefined}>
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
                mode={agent.mode}
                vim={vimIndicator()}
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
