import { useState, useRef, useMemo, useEffect } from 'react'
import { Box, Text, useStdout } from 'ink'
import { InputArea } from './components/InputArea.js'
import { ModelPicker } from './components/ModelPicker.js'
import { ConfigPicker } from './components/ConfigPicker.js'
import { Divider } from './components/StatusBar.js'
import { tools } from '../tools/index.js'
import type { Tool } from '../tools/index.js'
import type { SkillLoader } from '../skills/loader.js'
import type { Config } from '../types.js'
import { toolArgSummary } from './printer.js'
import { MacroQueue } from '../tasks/queue.js'
import { TaskExecutor } from '../tasks/executor.js'
import { THINKING_PHRASES, SPARKLE } from './thinking.js'
import { useSession } from './hooks/useSession.js'
import { useModelPicker } from './hooks/useModelPicker.js'
import { useRunLoop } from './hooks/useRunLoop.js'
import { useRefactor } from './hooks/useRefactor.js'
import { useGit } from './hooks/useGit.js'
import { useSubmit } from './hooks/useSubmit.js'
import { runDeepThink } from './deepThink.js'
import { setInkInstance } from './printer.js'
import { createSearchCodebaseTool } from '../index/tool.js'
import { saveConfig } from '../config.js'
import { getTavilyKey, saveTavilyKey } from '../tavily/client.js'
import { warmup } from '../llm/stream.js'

interface Props {
  config: Config
  skills: SkillLoader
  cwd: string
  session: string
  version?: string
  mcpTools?: Tool[]
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`
}

const MAX_DIFF_LINES = 5

function DiffPreview({ toolName, args }: { toolName: string; args: Record<string, unknown> }) {
  if (toolName === 'patch_file' && (args.old || args.new)) {
    const oldLines = String(args.old ?? '').split('\n')
    const newLines = String(args.new ?? '').split('\n')
    return (
      <Box flexDirection="column" paddingLeft={2}>
        {oldLines.slice(0, MAX_DIFF_LINES).map((line, i) => (
          <Text key={`o${i}`} color="red" dimColor>- {line.slice(0, 72)}</Text>
        ))}
        {oldLines.length > MAX_DIFF_LINES && (
          <Text color="gray" dimColor>  …{oldLines.length - MAX_DIFF_LINES} more</Text>
        )}
        {newLines.slice(0, MAX_DIFF_LINES).map((line, i) => (
          <Text key={`n${i}`} color="green" dimColor>+ {line.slice(0, 72)}</Text>
        ))}
        {newLines.length > MAX_DIFF_LINES && (
          <Text color="gray" dimColor>  …{newLines.length - MAX_DIFF_LINES} more</Text>
        )}
      </Box>
    )
  }
  if ((toolName === 'edit_file' || toolName === 'create_file') && args.content) {
    const n = String(args.content).split('\n').length
    return (
      <Box paddingLeft={2}>
        <Text color="gray" dimColor>{n} line{n === 1 ? '' : 's'}</Text>
      </Box>
    )
  }
  return null
}

export function InputBar({ config: initialConfig, skills, cwd, session, version, mcpTools = [] }: Props) {
  const [config, setConfig] = useState(initialConfig)
  const { stdout, write: stdoutWrite } = useStdout()
  const cols = stdout.columns ?? 80

  useEffect(() => {
    setInkInstance(stdoutWrite)
    warmup(initialConfig.provider, initialConfig.baseUrl, initialConfig.model)
  }, [])

  const phraseSeq = useMemo(() =>
    Array.from({ length: 100 }, () => Math.floor(Math.random() * THINKING_PHRASES.length))
  , [])

  const [planningMode, setPlanningMode] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [tavilyKey, setTavilyKey] = useState(() => getTavilyKey())
  const macroQueueRef = useRef(new MacroQueue())
  const executorRef = useRef(new TaskExecutor(tools))
  const lastGitStatusRef = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)

  const {
    projectDir,
    setSessionName, sessionNameRef,
    historyRef, saveTimerRef, systemPromptRef,
    pushHistory, buildContext, renameFromMessage, updateMemory,
  } = useSession(session, cwd, config, mcpTools)

  const {
    currentModel, setCurrentModel, currentModelRef,
    pickerOpen, setPickerOpen,
    pickerModels, pickerLoading, pickerError, pullState,
    handleModelSelect, handleModelPull,
  } = useModelPicker(config)

  const deepThinkTool = useMemo<Tool>(() => ({
    name: 'deep_think',
    description: 'Research tool: gather info from files and web before answering.',
    params: '{"query": "string", "needs_web": "boolean (optional)"}',
    execute: async ({ query }) => {
      const result = await runDeepThink(
        String(query), config, currentModelRef.current, abortRef.current?.signal,
      )
      return `Research complete (${result.toolCalls} tool calls, ${result.webCalls} web):\n\n${result.findings}`
    },
  }), [config])

  const searchTool = useMemo<Tool>(() => createSearchCodebaseTool(config, cwd), [config, cwd])
  const allTools = useMemo<Tool[]>(() => [...tools, deepThinkTool, searchTool, ...mcpTools], [deepThinkTool, searchTool, mcpTools])

  const {
    status, setStatus, tick,
    currentTool, setCurrentTool,
    taskLabel, setTaskLabel,
    thinkingStartRef,
    runLoop, handleAbort,
    permissionRequest, resolvePermission,
    compactRequest, resolveCompact,
  } = useRunLoop(config, currentModelRef, pushHistory, allTools, abortRef)

  const { runRefactor } = useRefactor({
    config, currentModelRef, systemPromptRef, abortRef,
    macroQueueRef, executorRef,
    setStatus, setTaskLabel, setCurrentTool, pushHistory,
  })

  const { handleGit } = useGit({ pushHistory, buildContext, runLoop })

  const { handleSubmit } = useSubmit({
    config, skills, cwd, projectDir, version, currentModelRef, setCurrentModel,
    historyRef, sessionNameRef, saveTimerRef, systemPromptRef, abortRef,
    setPlanningMode, runLoop, buildContext, pushHistory,
    setSessionName, renameFromMessage,
    setStatus, setTaskLabel, setCurrentTool,
    runRefactor, handleGit, lastGitStatusRef, mcpTools, setConfig,
    setConfigOpen, updateMemory,
  })

  const skillList = skills.list()

  return (
    <Box flexDirection="column">
      {configOpen ? (
        <>
          <ConfigPicker
            config={config}
            currentModel={currentModel}
            tavilyKey={tavilyKey}
            onUpdate={({ model, ...configPatch }) => {
              if (model) setCurrentModel(model)
              if (Object.keys(configPatch).length) {
                setConfig(c => ({ ...c, ...configPatch }))
                saveConfig(configPatch)
              }
            }}
            onTavilyKey={(key) => { saveTavilyKey(key); setTavilyKey(key) }}
            onClose={() => { setConfigOpen(false) }}
          />
          <Divider cols={cols} />
        </>
      ) : pickerOpen ? (
        <>
          <ModelPicker
            models={pickerModels}
            current={currentModel}
            loading={pickerLoading}
            error={pickerError}
            pull={pullState}
            onSelect={handleModelSelect}
            onPull={handleModelPull}
            onClose={() => { setPickerOpen(false) }}
          />
          <Divider cols={cols} />
        </>
      ) : compactRequest ? (
        <Box paddingX={1} flexDirection="column">
          <Box gap={1}>
            <Text color="yellow">⚠</Text>
            <Text color="white" bold>context is large</Text>
            <Text color="gray">(~{compactRequest.messageCount}k chars)</Text>
          </Box>
          <Text color="gray" dimColor>compact to keep responses fast, or keep full history</Text>
        </Box>
      ) : permissionRequest ? (
        <Box paddingX={1} flexDirection="column">
          <Box gap={1}>
            <Text color="yellow">⚠</Text>
            <Text color="white" bold>{permissionRequest.toolName}</Text>
            <Text color="gray">{toolArgSummary(permissionRequest.args)}</Text>
          </Box>
          <DiffPreview toolName={permissionRequest.toolName} args={permissionRequest.args} />
        </Box>
      ) : (status === 'thinking' || status === 'tool') ? (
        <Box flexDirection="column" paddingX={1}>
          <Box>
            {status === 'thinking'
              ? <><Text color="yellow">{SPARKLE[tick % SPARKLE.length]} </Text><Text color="gray" dimColor italic>{THINKING_PHRASES[phraseSeq[Math.floor(tick / 62) % phraseSeq.length]]}</Text></>
              : <Text color="yellow" dimColor>⚙ running {currentTool ?? 'tool'}…</Text>
            }
          </Box>
          <Box gap={2}>
            <Text color="gray" dimColor>{formatElapsed(Date.now() - thinkingStartRef.current)}</Text>
            {taskLabel && <Text color="cyan" dimColor>{taskLabel}</Text>}
          </Box>
        </Box>
      ) : null}

      <InputArea
        status={status}
        skills={skillList}
        cwd={cwd}
        planningMode={planningMode}
        permissionRequest={permissionRequest}
        onPermissionResponse={resolvePermission}
        compactRequest={compactRequest}
        onCompactResponse={resolveCompact}
        onSubmit={handleSubmit}
        onAbort={handleAbort}
        history={historyRef.current.filter(m => m.role === 'user').map(m => m.content)}
      />
    </Box>
  )
}
