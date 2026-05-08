import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useStdout } from 'ink'
import { InputArea } from './components/InputArea.js'
import { ModelPicker } from './components/ModelPicker.js'
import { Divider } from './components/StatusBar.js'
import { chat } from '../llm/stream.js'
import { listModels, pullModel } from '../llm/ollama.js'
import type { OllamaModel } from '../llm/ollama.js'
import { StreamParser } from '../parser/stream-parser.js'
import { tools, getSystemPrompt } from '../tools/index.js'
import { readFile } from '../files/ops.js'
import type { SkillLoader } from '../skills/loader.js'
import type { Status, ChatMessage, Config } from '../types.js'
import * as printer from './printer.js'
import { loadSession, saveSession, listSessions } from '../sessions.js'

interface Props {
  config: Config
  skills: SkillLoader
  cwd: string
  session: string
}

const MAX_TOOL_DEPTH = 6

const THINKING_PHRASES = [
  'oh wow, a question. let me pretend to care…',
  'consulting the void…',
  'making something up, just a sec…',
  'definitely not hallucinating right now…',
  'running 47 mental tabs…',
  'staring into the abyss (it blinked)…',
  'calculating your fate, no pressure…',
  'doing the thinking you pay me for…',
  'processing your questionable life choices…',
  'summoning coherent thoughts, rarely works…',
]
const SPARKLE = ['✦', '✧', '✶', '✷', '✸', '✹']

function buildAtContext(text: string): string {
  const refs = [...text.matchAll(/@([\w./\-]+)/g)]
  if (!refs.length) return ''
  const parts: string[] = []
  for (const m of refs) {
    try {
      const content = readFile(m[1])
      if (content) parts.push(`<file path="${m[1]}">\n${content}\n</file>`)
    } catch {}
  }
  return parts.length ? parts.join('\n\n') + '\n\n' : ''
}

export function InputBar({ config, skills, cwd, session }: Props) {
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 80

  const [status, setStatus] = useState<Status>('idle')
  const [tick, setTick] = useState(0)
  const [currentModel, setCurrentModel] = useState(config.model)
  const [sessionName, setSessionName] = useState(session)
  const [currentTool, setCurrentTool] = useState<string | undefined>()
  const [planningMode, setPlanningMode] = useState(false)

  // picker opens on mount — force model selection every launch
  const [pickerOpen, setPickerOpen] = useState(true)
  const [pickerModels, setPickerModels] = useState<OllamaModel[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | undefined>()
  const [pullState, setPullState] = useState<{ name: string; status: string; pct: number | undefined } | undefined>()

  const abortRef = useRef<AbortController | null>(null)
  const pullAbortRef = useRef<AbortController | null>(null)
  const systemPromptRef = useRef(getSystemPrompt(`\n- CWD: ${cwd}`))
  const currentModelRef = useRef(currentModel)
  const sessionNameRef = useRef(sessionName)
  const historyRef = useRef<ChatMessage[]>([])

  useEffect(() => { currentModelRef.current = currentModel }, [currentModel])
  useEffect(() => { sessionNameRef.current = sessionName }, [sessionName])

  // mount: load session history + fetch models for initial picker
  useEffect(() => {
    const history = loadSession(session)
    historyRef.current = history
    if (history.length) {
      printer.systemMsg(`resumed "${session}" — ${history.length} messages`)
    }
    setPickerLoading(true)
    listModels(config.baseUrl)
      .then(m => { setPickerModels(m); setPickerLoading(false) })
      .catch(e => { setPickerError(String(e)); setPickerLoading(false) })
  }, [])

  useEffect(() => {
    if (status === 'idle') return
    const t = setInterval(() => setTick(n => n + 1), 80)
    return () => clearInterval(t)
  }, [status])

  function buildContext(extra?: ChatMessage): ChatMessage[] {
    const ctx: ChatMessage[] = [{ role: 'system', content: systemPromptRef.current }]
    ctx.push(...historyRef.current)
    if (extra) ctx.push(extra)
    return ctx
  }

  const runLoop = useCallback(async (contextMsgs: ChatMessage[], depth = 0) => {
    if (depth >= MAX_TOOL_DEPTH) { setStatus('idle'); return }
    setStatus('thinking')

    abortRef.current = new AbortController()

    await chat({
      provider: config.provider,
      model: currentModelRef.current,
      baseUrl: config.baseUrl,
      messages: contextMsgs,
      signal: abortRef.current.signal,

      async onDone(fullText) {
        const pendingTools: Array<{ name: string; args: Record<string, unknown> }> = []
        const parser = new StreamParser()
        for (const item of [...parser.feed(fullText), ...parser.flush()]) {
          if (item.type === 'tool_call') pendingTools.push({ name: item.toolName, args: item.toolArgs })
        }

        printer.assistantMsg(fullText)
        historyRef.current.push({ role: 'assistant', content: fullText })
        saveSession(sessionNameRef.current, historyRef.current)

        if (!pendingTools.length) { setStatus('idle'); return }

        setStatus('tool')
        const next: ChatMessage[] = [...contextMsgs, { role: 'assistant', content: fullText }]

        for (const tc of pendingTools) {
          const tool = tools.find(t => t.name === tc.name)
          setCurrentTool(tc.name)
          if (tool) {
            try {
              const result = await tool.execute(tc.args)
              printer.toolMsg(tc.name, result)
              next.push({ role: 'user', content: `Tool ${tc.name} result:\n${result}` })
            } catch (e) {
              const err = `Tool ${tc.name} error: ${e}`
              printer.errorMsg(err)
              next.push({ role: 'user', content: err })
            }
          } else {
            printer.errorMsg(`unknown tool: ${tc.name}`)
            next.push({ role: 'user', content: `unknown tool: ${tc.name}` })
          }
        }
        setCurrentTool(undefined)

        await runLoop(next, depth + 1)
      },

      onError(err) {
        if (err.name !== 'AbortError') printer.errorMsg(err.message)
        setStatus('idle')
      },
    })
  }, [config])

  // ─── model picker ──────────────────────────────────────────────────────────

  const openPicker = useCallback(async () => {
    setPickerOpen(true)
    setPickerLoading(true)
    setPickerError(undefined)
    try { setPickerModels(await listModels(config.baseUrl)) }
    catch (e) { setPickerError(String(e)) }
    finally { setPickerLoading(false) }
  }, [config.baseUrl])

  const handleModelSelect = useCallback((name: string) => {
    setCurrentModel(name)
    currentModelRef.current = name
    setPickerOpen(false)
    printer.systemMsg(`model → ${name}`)
  }, [])

  const handleModelPull = useCallback(async (name: string) => {
    setPullState({ name, status: 'starting...', pct: undefined })
    pullAbortRef.current = new AbortController()
    try {
      await pullModel(config.baseUrl, name, (s, p) => setPullState({ name, status: s, pct: p }), pullAbortRef.current.signal)
      setPickerModels(await listModels(config.baseUrl))
      setPullState(undefined)
      setCurrentModel(name)
      currentModelRef.current = name
      setPickerOpen(false)
      printer.systemMsg(`pulled ${name} → active`)
    } catch (e) {
      setPullState(undefined)
      setPickerError(`pull failed: ${e}`)
    }
  }, [config.baseUrl])

  // ─── submit ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (text: string) => {
    const cmd = text.trim()

    if (cmd === '/models') { await openPicker(); return }

    if (cmd === '/new') {
      saveSession(sessionNameRef.current, historyRef.current)
      const newName = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      historyRef.current = []
      setSessionName(newName)
      setPlanningMode(false)
      systemPromptRef.current = getSystemPrompt(`\n- CWD: ${cwd}`)
      printer.systemMsg(`new session → ${newName}`)
      return
    }

    if (cmd === '/clear') {
      historyRef.current = []
      saveSession(sessionNameRef.current, [])
      setPlanningMode(false)
      systemPromptRef.current = getSystemPrompt(`\n- CWD: ${cwd}`)
      printer.systemMsg('chat cleared')
      return
    }

    if (cmd === '/exit') { process.exit(0) }

    if (cmd === '/plan' || cmd.startsWith('/plan ')) {
      const topic = cmd.slice(5).trim()
      setPlanningMode(true)
      systemPromptRef.current = getSystemPrompt(
        `\n- CWD: ${cwd}\n- MODE: Planning assistant. Help the user plan step by step. Ask clarifying questions. Suggest concrete next steps. Use plain text only — no markdown, no headers, no bold, no bullets with asterisks, no backtick blocks. Use numbered lists and plain indentation for structure.`
      )
      const msg = topic
        ? `I want to plan: ${topic}`
        : 'I want to start planning. Help me think through my goals step by step.'
      printer.userMsg(msg)
      historyRef.current.push({ role: 'user', content: msg })
      saveSession(sessionNameRef.current, historyRef.current)
      await runLoop(buildContext())
      return
    }

    if (cmd === '/plan:done') {
      setPlanningMode(false)
      systemPromptRef.current = getSystemPrompt(`\n- CWD: ${cwd}`)
      printer.systemMsg('planning mode off')
      return
    }

    if (cmd.startsWith('/plan:')) {
      const subCmd = cmd.slice(6)
      const subPrompts: Record<string, string> = {
        next:      'What are the next concrete steps I should take?',
        breakdown: 'Can you break this down into specific subtasks?',
        review:    'Please review and critique our plan so far. What are we missing?',
      }
      const msg = subPrompts[subCmd]
      if (msg) {
        printer.userMsg(msg)
        historyRef.current.push({ role: 'user', content: msg })
        saveSession(sessionNameRef.current, historyRef.current)
        await runLoop(buildContext())
        return
      }
    }

    if (cmd === '/sessions') {
      const sessions = listSessions()
      if (!sessions.length) { printer.systemMsg('no saved sessions'); return }
      printer.systemMsg(sessions.map(s =>
        `${s.name === sessionNameRef.current ? '▶ ' : '  '}${s.name}  (${s.messageCount} msgs)`
      ).join('\n'))
      return
    }

    if (cmd.startsWith('/session')) {
      const arg = cmd.slice(8).trim()
      if (!arg) {
        printer.systemMsg(`current: ${sessionNameRef.current}`)
        return
      }
      saveSession(sessionNameRef.current, historyRef.current)
      historyRef.current = loadSession(arg)
      setSessionName(arg)
      printer.systemMsg(`session → ${arg}  (${historyRef.current.length} messages)`)
      return
    }

    if (text.startsWith('/')) {
      const [slashCmd, ...rest] = text.slice(1).split(' ')
      const skill = skills.get(slashCmd)
      if (skill) {
        if (skill.name === 'list') {
          printer.systemMsg(skills.list().map(s =>
            `/${s.ns === 'default' ? '' : s.ns + ':'}${s.name}  — ${s.description}`
          ).join('\n'))
          return
        }
        if (skill.execute) {
          const ctx = {
            messages: historyRef.current.map(m => ({ role: m.role, content: m.content })),
            appendMessage: (_role: string, content: string) => printer.systemMsg(content),
            setSystemPrompt: (p: string) => { systemPromptRef.current = p },
            getSystemPrompt: () => systemPromptRef.current,
          }
          const result = await skill.execute(rest.join(' '), ctx)
          if (result) printer.systemMsg(result)
          return
        }
        if (skill.prompt) {
          printer.userMsg(skill.prompt)
          historyRef.current.push({ role: 'user', content: skill.prompt })
          await runLoop(buildContext())
          return
        }
      }
      printer.systemMsg(`unknown command: /${slashCmd}  —  try /list`)
      return
    }

    const contextPrefix = buildAtContext(text)
    printer.userMsg(text)
    historyRef.current.push({ role: 'user', content: contextPrefix + text })
    saveSession(sessionNameRef.current, historyRef.current)
    await runLoop(buildContext())
  }, [skills, runLoop, openPicker])

  const handleAbort = useCallback(() => {
    abortRef.current?.abort()
    setStatus('idle')
  }, [])

  const skillList = skills.list()

  // ─── render ────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column">
      {pickerOpen ? (
        <>
          <ModelPicker
            models={pickerModels}
            current={currentModel}
            loading={pickerLoading}
            error={pickerError}
            pull={pullState}
            onSelect={handleModelSelect}
            onPull={handleModelPull}
            onClose={() => { setPickerOpen(false); setPullState(undefined) }}
          />
          <Divider cols={cols} />
        </>
      ) : (status === 'thinking' || status === 'tool') ? (
        <>
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="green">miii</Text>
            <Box paddingLeft={2}>
              {status === 'thinking'
                ? <><Text color="yellow">{SPARKLE[tick % SPARKLE.length]} </Text><Text color="gray" dimColor italic>{THINKING_PHRASES[Math.floor(tick / 62) % THINKING_PHRASES.length]}</Text></>
                : <Text color="yellow" dimColor>⚙ running {currentTool ?? 'tool'}…</Text>
              }
            </Box>
          </Box>
          <Divider cols={cols} />
        </>
      ) : null}

      <InputArea
        status={status}
        skills={skillList}
        cwd={cwd}
        planningMode={planningMode}
        onSubmit={handleSubmit}
        onAbort={handleAbort}
      />
    </Box>
  )
}
