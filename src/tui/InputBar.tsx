import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { existsSync } from 'fs'
import { join } from 'path'
import { Box, Text, useStdout } from 'ink'
import { InputArea } from './components/InputArea.js'
import { ModelPicker } from './components/ModelPicker.js'
import { ConfigPicker } from './components/ConfigPicker.js'
import { Divider } from './components/StatusBar.js'
import { DesignTeachModal, DESIGN_TEACH_QUESTIONS, buildDesignPrompt } from './components/DesignTeachModal.js'
import { tools } from '../tools/index.js'
import type { Tool } from '../tools/index.js'
import type { SkillLoader } from '../skills/loader.js'
import type { Config } from '../types.js'
import { toolArgSummary, formatElapsed } from './printer.js'
import { MacroQueue } from '../tasks/queue.js'
import { TaskExecutor } from '../tasks/executor.js'
import { THINKING_PHRASES, SPARKLE } from './thinking.js'
import { useSession } from './hooks/useSession.js'
import { useModelPicker } from './hooks/useModelPicker.js'
import { useRunLoop } from './hooks/useRunLoop.js'
import { useRefactor } from './hooks/useRefactor.js'
import { useGit } from './hooks/useGit.js'
import { useSubmit } from './hooks/useSubmit.js'
import { useWatch } from './hooks/useWatch.js'
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

const MAX_DIFF_LINES = 40
const DIFF_CTX = 2

type DiffLine = { type: 'eq' | 'del' | 'add'; line: string }

function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const m = a.length, n = b.length
  if (m * n > 10000) {
    return [...a.map(line => ({ type: 'del' as const, line })), ...b.map(line => ({ type: 'add' as const, line }))]
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1])
  const result: DiffLine[] = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { result.push({ type: 'eq', line: a[i++] }); j++ }
    else if (j < n && (i >= m || dp[i + 1][j] <= dp[i][j + 1])) { result.push({ type: 'add', line: b[j++] }) }
    else { result.push({ type: 'del', line: a[i++] }) }
  }
  return result
}

function diffHunks(diff: DiffLine[]): DiffLine[] {
  const changedIdxs = diff.reduce<number[]>((acc, d, i) => { if (d.type !== 'eq') acc.push(i); return acc }, [])
  if (!changedIdxs.length) return []
  const inHunk = new Set<number>()
  for (const ci of changedIdxs)
    for (let k = Math.max(0, ci - DIFF_CTX); k <= Math.min(diff.length - 1, ci + DIFF_CTX); k++)
      inHunk.add(k)
  return diff.filter((_, i) => inHunk.has(i))
}

function DiffPreview({ toolName, args }: { toolName: string; args: Record<string, unknown> }) {
  if (toolName === 'update_file' && (args.old != null || args.new != null)) {
    const path = String(args.path ?? '')
    const diff = diffHunks(lineDiff(String(args.old ?? ''), String(args.new ?? '')))
    const visible = diff.slice(0, MAX_DIFF_LINES)
    const hidden = diff.length - visible.length
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="gray" dimColor>  {path}</Text>
        {visible.map((d, i) => (
          <Text key={i} color={d.type === 'del' ? 'red' : d.type === 'add' ? 'green' : 'gray'} dimColor={d.type === 'eq'}>
            {d.type === 'del' ? '- ' : d.type === 'add' ? '+ ' : '  '}{d.line.slice(0, 76)}
          </Text>
        ))}
        {hidden > 0 && <Text color="gray" dimColor>  …{hidden} more line{hidden === 1 ? '' : 's'}</Text>}
      </Box>
    )
  }
  if ((toolName === 'edit_file' || toolName === 'create_file') && args.content) {
    const path = String(args.path ?? '')
    const lines = String(args.content).split('\n')
    const visible = lines.slice(0, MAX_DIFF_LINES)
    const hidden = lines.length - visible.length
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="gray" dimColor>  {path}</Text>
        {visible.map((line, i) => (
          <Text key={i} color="green">+ {line.slice(0, 76)}</Text>
        ))}
        {hidden > 0 && <Text color="gray" dimColor>  …{hidden} more line{hidden === 1 ? '' : 's'}</Text>}
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
  const [designTeachState, setDesignTeachState] = useState<{ answers: string[]; idx: number } | null>(null)
  const [designReadyPrompt, setDesignReadyPrompt] = useState<string | null>(null)

  const {
    projectDir,
    setSessionName, sessionNameRef,
    historyRef, saveTimerRef, systemPromptRef,
    pushHistory, setHistory, buildContext, renameFromMessage, updateMemory,
  } = useSession(session, cwd, config, mcpTools)

  const startDesignTeach = useCallback(() => {
    setDesignTeachState({ answers: [], idx: 0 })
  }, [])

  const handleDesignAnswer = useCallback((answer: string) => {
    setDesignTeachState(prev => {
      if (!prev) return null
      const answers = [...prev.answers, answer]
      const nextIdx = prev.idx + 1
      if (nextIdx >= DESIGN_TEACH_QUESTIONS.length) {
        const exists = existsSync(join(cwd, 'DESIGN.md'))
        setDesignReadyPrompt(buildDesignPrompt(DESIGN_TEACH_QUESTIONS, answers, exists))
        return null
      }
      return { answers, idx: nextIdx }
    })
  }, [])

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
  } = useRunLoop(config, currentModelRef, pushHistory, allTools, abortRef, setHistory)

  const { runRefactor } = useRefactor({
    config, currentModelRef, systemPromptRef, abortRef,
    macroQueueRef, executorRef,
    setStatus, setTaskLabel, setCurrentTool, pushHistory,
  })

  const { handleGit } = useGit({ pushHistory, buildContext, runLoop })

  const { watchActive, startWatch, stopWatch } = useWatch(cwd, { runLoop, buildContext, pushHistory })

  const { handleSubmit } = useSubmit({
    config, skills, cwd, projectDir, version, currentModelRef, setCurrentModel,
    historyRef, sessionNameRef, saveTimerRef, systemPromptRef, abortRef,
    setPlanningMode, runLoop, buildContext, pushHistory,
    setSessionName, renameFromMessage,
    setStatus, setTaskLabel, setCurrentTool,
    runRefactor, handleGit, lastGitStatusRef, mcpTools, setConfig,
    setConfigOpen, updateMemory,
    startWatch, stopWatch, watchActive,
    startDesignTeach,
  })

  useEffect(() => {
    if (!designReadyPrompt) return
    setDesignReadyPrompt(null)
    pushHistory({ role: 'user', content: designReadyPrompt })
    runLoop(buildContext(), 0, 'create or update DESIGN.md')
  }, [designReadyPrompt, pushHistory, buildContext, runLoop])

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
      ) : designTeachState ? (
        <DesignTeachModal
          question={DESIGN_TEACH_QUESTIONS[designTeachState.idx]}
          index={designTeachState.idx}
          total={DESIGN_TEACH_QUESTIONS.length}
        />
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
        <Box paddingX={1} gap={1}>
          {status === 'thinking'
            ? <>
                <Text color="yellow">{SPARKLE[tick % SPARKLE.length]}</Text>
                <Text color={Math.floor(tick / 4) % 6 >= 2 && Math.floor(tick / 4) % 6 <= 4 ? 'white' : 'gray'} italic>{THINKING_PHRASES[phraseSeq[Math.floor(tick / 62) % phraseSeq.length]]}</Text>
                <Text color="gray" dimColor>{formatElapsed(Date.now() - thinkingStartRef.current)}</Text>
                {taskLabel && <Text color="cyan" dimColor>{taskLabel}</Text>}
              </>
            : <>
                <Text color="yellow" dimColor>⚙ running {currentTool ?? 'tool'}…</Text>
                <Text color="gray" dimColor>{formatElapsed(Date.now() - thinkingStartRef.current)}</Text>
                {taskLabel && <Text color="cyan" dimColor>{taskLabel}</Text>}
              </>
          }
        </Box>
      ) : null}

      <InputArea
        status={status}
        skills={skillList}
        cwd={cwd}
        planningMode={planningMode}
        permissionRequest={permissionRequest}
        onPermissionResponse={resolvePermission}
        designTeach={designTeachState ? {
          question: DESIGN_TEACH_QUESTIONS[designTeachState.idx],
          index: designTeachState.idx,
          total: DESIGN_TEACH_QUESTIONS.length,
        } : null}
        onDesignTeachAnswer={handleDesignAnswer}
        onSubmit={handleSubmit}
        onAbort={handleAbort}
        history={historyRef.current.filter(m => m.role === 'user').map(m => m.content)}
        watchActive={watchActive}
      />
    </Box>
  )
}
