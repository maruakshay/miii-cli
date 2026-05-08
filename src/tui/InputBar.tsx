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
import { resolve } from 'path'
import type { SkillLoader } from '../skills/loader.js'
import type { Status, ChatMessage, Config } from '../types.js'
import * as printer from './printer.js'
import { loadSession, saveSession, listSessions } from '../sessions.js'
import { shouldCompact, compactContext, fileEditContext } from '../tasks/compactor.js'
import { MacroQueue, MicroQueue } from '../tasks/queue.js'
import { TaskExecutor } from '../tasks/executor.js'
import type { MacroTask, MicroTask } from '../tasks/types.js'
import { generateId } from '../types.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const gitRun = promisify(exec)

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
  'asking my imaginary friend for help…',
  'pretending this is a hard problem…',
  'yes, yes, very interesting. anyway…',
  'googling it (not really, I can\'t)…',
  'simulating intelligence… please wait…',
  'having a brief existential crisis…',
  'cross-referencing vibes…',
  'totally not making this up…',
  'the answer is 42. now finding the question…',
  'my other tab is loading…',
  'channelling the spirit of stack overflow…',
  'trying not to confidently be wrong…',
  'applying artificial to the intelligence…',
  'phoning a friend who also doesn\'t know…',
  'checking if this is even my problem to solve…',
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

const CODE_PATTERN = /\.(ts|js|tsx|jsx|py|go|rs|java|rb|sh|css|html|json|yaml|yml)\b|function|class|import|export|const|let|var|def |async|await|error|bug|fix|refactor|implement|`[^`]+`/i

function looksCodeRelated(text: string): boolean {
  return text.length >= 10 && CODE_PATTERN.test(text)
}

async function buildGitContext(cwd: string, lastStatusRef: { current: string }): Promise<{ prefix: string; label: string }> {
  try {
    const { stdout } = await gitRun('git status --short', { cwd, timeout: 5000 })
    const status = stdout.trim()
    if (!status || status === lastStatusRef.current) return { prefix: '', label: '' }
    lastStatusRef.current = status

    const MAX_TOTAL = 40_000
    const MAX_FILE  = 15_000
    let total = 0
    const parts: string[] = []
    const skipped: string[] = []

    for (const line of status.split('\n')) {
      const code = line.slice(0, 2)
      if (code.includes('D')) continue
      const raw = line.slice(3).trim().replace(/^"|"$/g, '')
      const rel  = raw.includes(' -> ') ? raw.split(' -> ')[1]! : raw
      if (!rel) continue
      try {
        const content = readFile(resolve(cwd, rel))
        if (!content || content.length > MAX_FILE) { skipped.push(rel); continue }
        total += content.length
        if (total > MAX_TOTAL) { skipped.push(rel); continue }
        parts.push(`<file path="${rel}">\n${content}\n</file>`)
      } catch { skipped.push(rel) }
    }

    if (!parts.length && !skipped.length) return { prefix: '', label: '' }
    let prefix = '[Auto-context: git-changed files]\n' + parts.join('\n') + '\n'
    if (skipped.length) prefix += `Files changed but too large to auto-load: ${skipped.join(', ')}\n`
    prefix += '\n'
    const label = `auto-loaded ${parts.length} changed file(s)${skipped.length ? `, skipped ${skipped.length} (too large)` : ''}`
    return { prefix, label }
  } catch {
    return { prefix: '', label: '' }
  }
}

export function InputBar({ config, skills, cwd, session }: Props) {
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 80

  const [status, setStatus] = useState<Status>('idle')
  const [tick, setTick] = useState(0)
  const [currentModel, setCurrentModel] = useState(config.model)
  const [sessionName, setSessionName] = useState(session)
  const [currentTool, setCurrentTool] = useState<string | undefined>()
  const [taskLabel, setTaskLabel] = useState<string | undefined>()
  const [planningMode, setPlanningMode] = useState(false)

  // picker opens on mount — force model selection every launch
  const [pickerOpen, setPickerOpen] = useState(true)
  const [pickerModels, setPickerModels] = useState<OllamaModel[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | undefined>()
  const [pullState, setPullState] = useState<{ name: string; status: string; pct: number | undefined } | undefined>()

  const abortRef = useRef<AbortController | null>(null)
  const pullAbortRef = useRef<AbortController | null>(null)
  const thinkingStartRef = useRef<number>(0)
  const macroQueueRef = useRef(new MacroQueue())
  const executorRef = useRef(new TaskExecutor(tools))
  const systemPromptRef = useRef(getSystemPrompt(`\n- CWD: ${cwd}`))
  const currentModelRef = useRef(currentModel)
  const sessionNameRef = useRef(sessionName)
  const historyRef = useRef<ChatMessage[]>([])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastGitStatusRef = useRef<string>('')

  function scheduleSave() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveSession(sessionNameRef.current, historyRef.current)
      saveTimerRef.current = null
    }, 2000)
  }

  function pushHistory(msg: ChatMessage) {
    historyRef.current.push(msg)
    if (historyRef.current.length > 100) historyRef.current.splice(0, historyRef.current.length - 100)
    scheduleSave()
  }

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

  const runLoop = useCallback(async (contextMsgs: ChatMessage[], depth = 0, goal?: string) => {
    if (depth >= MAX_TOOL_DEPTH) { setStatus('idle'); return }
    setStatus('thinking')
    if (depth === 0) thinkingStartRef.current = Date.now()

    // Auto-compact context when local model starts losing the thread
    const msgs = shouldCompact(contextMsgs) ? compactContext(contextMsgs, goal) : contextMsgs

    abortRef.current = new AbortController()

    await chat({
      provider: config.provider,
      model: currentModelRef.current,
      baseUrl: config.baseUrl,
      messages: msgs,
      signal: abortRef.current.signal,

      async onDone(fullText) {
        const pendingTools: Array<{ name: string; args: Record<string, unknown> }> = []
        const parser = new StreamParser()
        for (const item of [...parser.feed(fullText), ...parser.flush()]) {
          if (item.type === 'tool_call') pendingTools.push({ name: item.toolName, args: item.toolArgs })
        }

        printer.assistantMsg(fullText)
        pushHistory({ role: 'assistant', content: fullText })

        if (!pendingTools.length) { setStatus('idle'); return }

        setStatus('tool')
        const next: ChatMessage[] = [...msgs, { role: 'assistant', content: fullText }]

        try {
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
        } finally {
          setCurrentTool(undefined)
        }

        await runLoop(next, depth + 1, goal)
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

  // ─── refactor ─────────────────────────────────────────────────────────────

  const runRefactor = useCallback(async (goal: string) => {
    printer.systemMsg(`refactor: ${goal}`)
    setTaskLabel(`planning: ${goal}`)
    setStatus('thinking')

    // Phase 1 — planning: ask model to list files and describe changes
    const planCtx: ChatMessage[] = [
      { role: 'system', content: systemPromptRef.current },
      {
        role: 'user',
        content: `Refactor goal: ${goal}\n\nList every file that needs to change. For each file output:\nFILE: <path>\nCHANGE: <one sentence describing the edit>\n\nUse list_files and read_file to discover relevant files first. Only list files that genuinely need changes.`,
      },
    ]

    abortRef.current = new AbortController()
    let planText = ''

    await chat({
      provider: config.provider,
      model: currentModelRef.current,
      baseUrl: config.baseUrl,
      messages: planCtx,
      signal: abortRef.current.signal,
      async onDone(text) { planText = text },
      onError(err) { printer.errorMsg(err.message) },
    })

    if (!planText) { setStatus('idle'); setTaskLabel(undefined); return }
    printer.assistantMsg(planText)

    // Parse FILE:/CHANGE: pairs from plan
    const filePlan: Array<{ path: string; change: string }> = []
    const lines = planText.split('\n')
    let lastPath = ''
    for (const line of lines) {
      const fm = line.match(/^FILE:\s*(.+)/)
      const cm = line.match(/^CHANGE:\s*(.+)/)
      if (fm) lastPath = fm[1].trim()
      if (cm && lastPath) { filePlan.push({ path: lastPath, change: cm[1].trim() }); lastPath = '' }
    }

    if (!filePlan.length) {
      printer.systemMsg('no files identified in plan — done')
      setStatus('idle'); setTaskLabel(undefined); return
    }

    printer.systemMsg(`plan: ${filePlan.length} file(s) to change`)

    // Phase 2 — execute via macro/micro queue
    const micro = new MicroQueue()

    // P1: read all files in parallel
    for (const fp of filePlan) {
      const t: MicroTask = { id: `read:${fp.path}`, priority: 1, tool: 'read_file', args: { path: fp.path }, deps: [], status: 'pending' }
      micro.push(t)
    }

    const macro: MacroTask = {
      id: generateId(),
      goal,
      priority: 0,
      microtasks: micro.toArray(),
      status: 'running',
    }
    macroQueueRef.current.enqueue(macro)

    setTaskLabel(`reading ${filePlan.length} file(s)…`)
    const readResults = await executorRef.current.drain(micro, ({ task, result, error }) => {
      if (error) printer.errorMsg(`read failed: ${task.args.path} — ${error}`)
      else printer.systemMsg(`read: ${task.args.path}`)
    })

    // Phase 3 — per-file LLM call with isolated context → patch
    setTaskLabel(`applying changes…`)
    const writeMicro = new MicroQueue()

    for (const fp of filePlan) {
      const readId = `read:${fp.path}`
      const fileContent = readResults.get(readId) ?? ''
      if (!fileContent) { printer.systemMsg(`skip (unreadable): ${fp.path}`); continue }

      setCurrentTool(`edit ${fp.path}`)
      setTaskLabel(`editing: ${fp.path}`)

      // Isolated context per file keeps model focused
      const editCtx = fileEditContext(systemPromptRef.current, goal, fp.path, fileContent, fp.change)
      let editText = ''

      await chat({
        provider: config.provider,
        model: currentModelRef.current,
        baseUrl: config.baseUrl,
        messages: editCtx,
        signal: abortRef.current?.signal,
        async onDone(text) { editText = text },
        onError(err) { printer.errorMsg(`edit LLM error: ${err.message}`) },
      })

      if (!editText) continue
      printer.assistantMsg(editText)

      // Queue write tasks from LLM's tool calls (P2)
      const parser = new StreamParser()
      for (const item of [...parser.feed(editText), ...parser.flush()]) {
        if (item.type === 'tool_call') {
          writeMicro.push({ id: generateId(), priority: 2, tool: item.toolName, args: item.toolArgs, deps: [], status: 'pending' })
        }
      }
    }

    // Execute all writes
    if (writeMicro.size > 0) {
      setTaskLabel(`writing ${writeMicro.size} change(s)…`)
      await executorRef.current.drain(writeMicro, ({ task, result, error }) => {
        if (error) printer.errorMsg(`${task.tool} failed: ${error}`)
        else printer.toolMsg(task.tool, result ?? '')
      })
    }

    macro.status = 'done'
    macroQueueRef.current.dequeue()
    setCurrentTool(undefined)
    setTaskLabel(undefined)
    setStatus('idle')
    printer.systemMsg(`refactor done — ${filePlan.length} file(s) processed`)

    pushHistory({ role: 'user', content: `[refactor] ${goal}` })
    pushHistory({ role: 'assistant', content: planText })
  }, [config])

  // ─── git ───────────────────────────────────────────────────────────────────

  const handleGit = useCallback(async (sub: string) => {
    const git = async (args: string): Promise<string> => {
      try {
        const { stdout, stderr } = await gitRun(`git ${args}`, { timeout: 15_000 })
        return (stdout + stderr).trim()
      } catch (e: any) {
        return e.message ?? String(e)
      }
    }

    // /git  or  /git status
    if (!sub || sub === 'status') {
      const out = await git('status')
      printer.systemMsg(out)
      return
    }

    // /git log [n]
    if (sub === 'log' || sub.startsWith('log ')) {
      const n = parseInt(sub.split(' ')[1] ?? '10', 10) || 10
      const out = await git(`log --oneline --decorate -${Math.min(n, 50)}`)
      printer.systemMsg(out)
      return
    }

    // /git diff [--staged] [file]
    if (sub === 'diff' || sub.startsWith('diff ')) {
      const args = sub.slice(4).trim()
      const out = await git(`diff ${args}`.trim())
      const display = out.length > 6000 ? out.slice(0, 6000) + '\n…[truncated]' : out
      printer.systemMsg(display || '(no diff)')
      return
    }

    // /git review  — inject diff into context, ask model to review
    if (sub === 'review') {
      const diff = await git('diff HEAD')
      const staged = await git('diff --staged')
      const combined = [diff, staged].filter(Boolean).join('\n').trim()
      if (!combined || combined === '(no diff)') {
        printer.systemMsg('no changes to review')
        return
      }
      const truncated = combined.length > 8000 ? combined.slice(0, 8000) + '\n…[truncated]' : combined
      const userMsg = `Review these git changes for bugs, issues, and improvements:\n\n${truncated}`
      printer.userMsg('/git review')
      pushHistory({ role: 'user', content: userMsg })
      await runLoop(buildContext())
      return
    }

    // /git branch
    if (sub === 'branch' || sub.startsWith('branch ')) {
      const args = sub.slice(6).trim()
      const out = await git(`branch ${args}`.trim())
      printer.systemMsg(out || '(done)')
      return
    }

    // /git commit <msg>
    if (sub.startsWith('commit ')) {
      const msg = sub.slice(7).trim()
      if (!msg) { printer.systemMsg('usage: /git commit <message>'); return }
      const status = await git('status --short')
      if (!status || status === '(clean — no changes)') {
        printer.systemMsg('nothing to commit — working tree clean')
        return
      }
      printer.systemMsg(`staging and committing:\n${status}`)
      const stageOut = await git('add -A')
      if (stageOut) printer.systemMsg(stageOut)
      const commitOut = await git(`commit -m ${JSON.stringify(msg)}`)
      printer.systemMsg(commitOut)
      return
    }

    // fallthrough — run arbitrary git subcommand
    const out = await git(sub)
    printer.systemMsg(out || '(done)')
  }, [])

  // ─── submit ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (text: string) => {
    const cmd = text.trim()

    if (cmd === '/model' || cmd.startsWith('/model ')) {
      const name = cmd.slice(6).trim()
      if (!name) { printer.systemMsg(`current model: ${currentModelRef.current}`); return }
      setCurrentModel(name)
      printer.systemMsg(`model → ${name}`)
      return
    }

    if (cmd === '/models') { await openPicker(); return }

    if (cmd === '/new') {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
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

    if (cmd === '/git' || cmd.startsWith('/git ')) {
      const sub = cmd.slice(4).trim()
      await handleGit(sub)
      return
    }

    if (cmd.startsWith('/refactor ') || cmd === '/refactor') {
      const goal = cmd.slice(9).trim()
      if (!goal) { printer.systemMsg('usage: /refactor <goal>'); return }
      await runRefactor(goal)
      return
    }

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
      pushHistory({ role: 'user', content: msg })
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
        pushHistory({ role: 'user', content: msg })
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
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
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
          pushHistory({ role: 'user', content: skill.prompt })
          await runLoop(buildContext())
          return
        }
      }
      printer.systemMsg(`unknown command: /${slashCmd}  —  try /list`)
      return
    }

    const contextPrefix = buildAtContext(text)
    const shouldInjectGit = config.gitContext !== false && looksCodeRelated(text)
    const { prefix: gitPrefix, label: gitLabel } = shouldInjectGit
      ? await buildGitContext(cwd, lastGitStatusRef)
      : { prefix: '', label: '' }
    if (gitLabel) printer.systemMsg(gitLabel)
    printer.userMsg(text)
    pushHistory({ role: 'user', content: gitPrefix + contextPrefix + text })
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
            <Box paddingLeft={2} flexDirection="column">
              <Box>
                {status === 'thinking'
                  ? <><Text color="yellow">{SPARKLE[tick % SPARKLE.length]} </Text><Text color="gray" dimColor italic>{THINKING_PHRASES[Math.floor(tick / 62) % THINKING_PHRASES.length]}</Text></>
                  : <Text color="yellow" dimColor>⚙ running {currentTool ?? 'tool'}…</Text>
                }
              </Box>
              <Box gap={2}>
                <Text color="gray" dimColor>{Math.floor((Date.now() - thinkingStartRef.current) / 1000)}s</Text>
                {taskLabel && <Text color="cyan" dimColor>{taskLabel}</Text>}
              </Box>
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
