/**
 * App — root component.
 *
 * Owns top-level state (model list, selected model, app screen) and
 * delegates streaming logic to useAgentRunner and key handling to useKeyboard.
 */
import { useState, useEffect } from 'react'
import { Box, Text, useApp } from 'ink'
import { homedir } from 'os'
import { sep } from 'path'
import { listModels, modelContext, isAvailable, NOT_AVAILABLE, providerName } from '../llm/client.js'
import { loadConfig, setProvider, type Effort, type Provider } from '../config.js'
import { WelcomeBlock } from './WelcomeBlock.js'
import { ModelList } from './ModelList.js'
import { InputBar } from './InputBar.js'
import { ModelsView } from './ModelsView.js'
import { SessionsView } from './SessionsView.js'
import { CommandPalette } from './CommandPalette.js'
import { persistSession, newSessionId, type SessionMeta } from '../session/store.js'
import { FilePicker, parseMention, searchFiles } from './FilePicker.js'
import { ChatView } from './ChatView.js'
import { useAgentRunner } from './hooks/useAgentRunner.js'
import { useKeyboard } from './hooks/useKeyboard.js'
import { checkForUpdate } from '../updateCheck.js'

type AppState = 'loading' | 'select-model' | 'ready' | 'models' | 'sessions'

export function App() {
  const { exit } = useApp()
  const cwd = process.cwd().replace(homedir(), '~').split(sep).join('/')

  // --- config & model list ---
  const [cfg, setCfg] = useState(loadConfig())
  const [models, setModels] = useState<string[]>([])
  const [contexts, setContexts] = useState<Record<string, number>>({})
  const [activeCtx, setActiveCtx] = useState<number | null>(null)
  const [state, setState] = useState<AppState>('loading')
  const [cursor, setCursor] = useState(0)
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null)
  const [ollamaDown, setOllamaDown] = useState(false)

  // --- sessions ---
  const [sessionId, setSessionId] = useState(() => newSessionId())
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  // --- input bar ---
  const [input, setInput] = useState('')
  const [paletteCursor, setPaletteCursor] = useState(0)
  const [filePickerCursor, setFilePickerCursor] = useState(0)

  // --- agent streaming & permission state (owned by hook) ---
  const agent = useAgentRunner(cfg.model, activeCtx)

  useEffect(() => {
    checkForUpdate().then((v) => { if (v) setUpdateAvailable(v) })
  }, [])

  // Auto-save the active session to disk every time the agent history grows.
  useEffect(() => {
    if (agent.agentHistory.length) persistSession(sessionId, agent.agentHistory)
  }, [agent.agentHistory, sessionId])

  const loadModels = () => {
    setOllamaDown(false)
    listModels()
      .then((m) => {
        setModels(m)
        setState(cfg.model ? 'ready' : 'select-model')
        Promise.all(m.map((name) => modelContext(name).then((ctx) => [name, ctx] as const)))
          .then((pairs) => {
            const map = Object.fromEntries(pairs)
            setContexts(map)
            const active = cfg.model ?? m[0]
            if (active && map[active]) setActiveCtx(map[active])
          })
          .catch(() => {})
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        agent.setError(isAvailable() ? msg : NOT_AVAILABLE())
        setOllamaDown(true)
        setModels([])
        setState(cfg.model ? 'ready' : 'select-model')
      })
  }

  // Load available models on mount; advance past loading screen once done.
  useEffect(loadModels, [])

  function switchProvider(p: Provider) {
    setProvider(p)
    setCfg((c) => ({ ...c, provider: p }))
    agent.setError(null)
    loadModels()
  }

  // Wire keyboard — all key routing lives in useKeyboard.
  useKeyboard({
    exit, state, setState,
    models, cursor, setCursor, contexts, cfg, setCfg, setActiveCtx,
    agent,
    input, setInput, paletteCursor, setPaletteCursor, filePickerCursor, setFilePickerCursor,
    sessionId, setSessionId, sessions, setSessions, setNotice,
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
      <WelcomeBlock model={cfg.model} activeCtx={activeCtx} effort={effort} cwd={cwd} error={agent.error} />

      {updateAvailable && (
        <Box marginLeft={2} marginBottom={1}>
          <Text color="yellow">{`↑ update available: v${updateAvailable} — run: miii --update`}</Text>
        </Box>
      )}

      {state === 'loading' && !agent.error && (
        <Box marginLeft={2} marginBottom={1}>
          <Text dimColor>{`connecting to ${providerName()}…`}</Text>
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
        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor>{`no model configured — select one (provider: ${providerName()})`}</Text>
          <Box marginTop={1}>
            <ModelList models={models} cursor={cursor} provider={providerName()} />
          </Box>
          {models.length > 0 && (
            <Box marginTop={1}>
              <Text dimColor>↑↓ navigate   enter select   p toggle provider   ctrl+c quit</Text>
            </Box>
          )}
        </Box>
      )}

      {state === 'models' && (
        <ModelsView
          models={models}
          cursor={cursor}
          model={cfg.model}
          ollamaHost={cfg.ollamaHost}
          provider={providerName()}
          effort={effort}
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

          {!ollamaDown && (
            <>
              <InputBar input={input} disabled={agent.busy} processingLabel={agent.processingLabel} />
              {!agent.busy && (
                <Box marginLeft={2} marginBottom={1}>
                  <Text dimColor>type / to see commands</Text>
                </Box>
              )}
            </>
          )}
        </>
      )}
    </Box>
  )
}
