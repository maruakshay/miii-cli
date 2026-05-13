import React, { useState, useCallback, useRef, useMemo } from 'react'
import { Box, Text, useStdout } from 'ink'
import { InputArea } from './components/InputArea.js'
import { ModelPicker } from './components/ModelPicker.js'
import { Divider } from './components/StatusBar.js'
import { tools } from '../tools/index.js'
import type { Tool } from '../tools/index.js'
import { readFile } from '../files/ops.js'
import type { SkillLoader } from '../skills/loader.js'
import type { Config, ChatMessage } from '../types.js'
import { generateId } from '../types.js'
import * as printer from './printer.js'
import { toolArgSummary } from './printer.js'
import { loadSession, saveSession, listSessions, deleteSession } from '../sessions.js'
import { MacroQueue, MicroQueue } from '../tasks/queue.js'
import { TaskExecutor } from '../tasks/executor.js'
import type { MacroTask, MicroTask } from '../tasks/types.js'
import { fileEditContext } from '../tasks/compactor.js'
import { StreamParser } from '../parser/stream-parser.js'
import { chat } from '../llm/stream.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import { getTavilyKey, saveTavilyKey } from '../tavily/client.js'
import { getSystemPrompt } from '../tools/index.js'
import { THINKING_PHRASES, SPARKLE } from './thinking.js'
import { buildGitContext, looksCodeRelated } from './git-context.js'
import { useSession } from './hooks/useSession.js'
import { useModelPicker } from './hooks/useModelPicker.js'
import { useRunLoop } from './hooks/useRunLoop.js'
import { runDeepThink } from './deepThink.js'

const gitRun = promisify(exec)

interface Props {
  config: Config
  skills: SkillLoader
  cwd: string
  session: string
  version?: string
}

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

export function InputBar({ config, skills, cwd, session, version }: Props) {
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 80

  const phraseSeq = useMemo(() =>
    Array.from({ length: 100 }, () => Math.floor(Math.random() * THINKING_PHRASES.length))
  , [])

  const [planningMode, setPlanningMode] = useState(false)
  const macroQueueRef = useRef(new MacroQueue())
  const executorRef = useRef(new TaskExecutor(tools))
  const lastGitStatusRef = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)

  const {
    setSessionName, sessionNameRef,
    historyRef, saveTimerRef, systemPromptRef,
    pushHistory, buildContext, renameFromMessage,
  } = useSession(session, cwd, config)

  const {
    currentModel, setCurrentModel, currentModelRef,
    pickerOpen, setPickerOpen,
    pickerModels, pickerLoading, pickerError, pullState,
    openPicker, handleModelSelect, handleModelPull,
  } = useModelPicker(config)

  const deepThinkTool = useMemo<Tool>(() => ({
    name: 'deep_think',
    description: 'Research tool: gather info from files and web before answering.',
    params: '{"query": "string", "needs_web": "boolean (optional)"}',
    execute: async ({ query }) => {
      const result = await runDeepThink(
        String(query),
        config,
        currentModelRef.current,
        abortRef.current?.signal,
      )
      return `Research complete (${result.toolCalls} tool calls, ${result.webCalls} web):\n\n${result.findings}`
    },
  }), [config])

  const allTools = useMemo<Tool[]>(() => [...tools, deepThinkTool], [deepThinkTool])

  const {
    status, setStatus, tick,
    currentTool, setCurrentTool,
    taskLabel, setTaskLabel,
    thinkingStartRef,
    runLoop, handleAbort,
    permissionRequest, resolvePermission,
  } = useRunLoop(config, currentModelRef, pushHistory, allTools, abortRef)

  // ─── refactor ─────────────────────────────────────────────────────────────

  const runRefactor = useCallback(async (goal: string) => {
    printer.systemMsg(`refactor: ${goal}`)
    setTaskLabel(`planning: ${goal}`)
    setStatus('thinking')

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

    const micro = new MicroQueue()
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
    const readResults = await executorRef.current.drain(micro, ({ task, error }) => {
      if (error) printer.errorMsg(`read failed: ${task.args.path} — ${error}`)
      else printer.systemMsg(`read: ${task.args.path}`)
    })

    setTaskLabel(`applying changes…`)
    const writeMicro = new MicroQueue()

    for (const fp of filePlan) {
      const readId = `read:${fp.path}`
      const fileContent = readResults.get(readId) ?? ''
      if (!fileContent) { printer.systemMsg(`skip (unreadable): ${fp.path}`); continue }

      setCurrentTool(`edit ${fp.path}`)
      setTaskLabel(`editing: ${fp.path}`)

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

      const parser = new StreamParser()
      for (const item of [...parser.feed(editText), ...parser.flush()]) {
        if (item.type === 'tool_call') {
          writeMicro.push({ id: generateId(), priority: 2, tool: item.toolName, args: item.toolArgs, deps: [], status: 'pending' })
        }
      }
    }

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

    if (!sub || sub === 'status') { printer.systemMsg(await git('status')); return }

    if (sub === 'log' || sub.startsWith('log ')) {
      const n = parseInt(sub.split(' ')[1] ?? '10', 10) || 10
      printer.systemMsg(await git(`log --oneline --decorate -${Math.min(n, 50)}`))
      return
    }

    if (sub === 'diff' || sub.startsWith('diff ')) {
      const args = sub.slice(4).trim()
      const out = await git(`diff ${args}`.trim())
      printer.systemMsg(out.length > 6000 ? out.slice(0, 6000) + '\n…[truncated]' : out || '(no diff)')
      return
    }

    if (sub === 'review') {
      const diff = await git('diff HEAD')
      const staged = await git('diff --staged')
      const combined = [diff, staged].filter(Boolean).join('\n').trim()
      if (!combined || combined === '(no diff)') { printer.systemMsg('no changes to review'); return }
      const truncated = combined.length > 8000 ? combined.slice(0, 8000) + '\n…[truncated]' : combined
      const userMsg = `Review these git changes for bugs, issues, and improvements:\n\n${truncated}`
      printer.userMsg('/git review')
      pushHistory({ role: 'user', content: userMsg })
      await runLoop(buildContext())
      return
    }

    if (sub === 'branch' || sub.startsWith('branch ')) {
      printer.systemMsg(await git(`branch ${sub.slice(6).trim()}`.trim()) || '(done)')
      return
    }

    if (sub.startsWith('commit ')) {
      const msg = sub.slice(7).trim()
      if (!msg) { printer.systemMsg('usage: /git commit <message>'); return }
      const gitStatus = await git('status --short')
      if (!gitStatus || gitStatus === '(clean — no changes)') {
        printer.systemMsg('nothing to commit — working tree clean')
        return
      }
      printer.systemMsg(`staging and committing:\n${gitStatus}`)
      const stageOut = await git('add -A')
      if (stageOut) printer.systemMsg(stageOut)
      printer.systemMsg(await git(`commit -m ${JSON.stringify(msg)}`))
      return
    }

    printer.systemMsg(await git(sub) || '(done)')
  }, [])

  // ─── submit ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (text: string) => {
    const cmd = text.trim()

    if (cmd === '/version') {
      printer.systemMsg(`miii v${version ?? 'unknown'}`)
      return
    }

    if (cmd === '/tavily-key' || cmd.startsWith('/tavily-key ')) {
      const key = cmd.slice(11).trim()
      if (!key) {
        const existing = getTavilyKey()
        printer.systemMsg(existing ? 'Tavily key set (use /tavily-key <key> to update)' : 'No Tavily key set. Usage: /tavily-key tvly-...')
        return
      }
      if (!key.startsWith('tvly-')) { printer.systemMsg('Key should start with tvly-. Get yours at https://tavily.com'); return }
      saveTavilyKey(key)
      printer.systemMsg('Tavily API key saved to ~/.config/miii/tavily.key (mode 600)')
      return
    }

    if (cmd === '/skills' || cmd.startsWith('/skills ')) {
      const sub = cmd.slice(7).trim()
      if (!sub || sub === 'list') {
        const pkgs = skills.listNpmSkills()
        printer.systemMsg(pkgs.length ? `installed npm skills:\n${pkgs.map(p => `  ${p}`).join('\n')}` : 'no npm skills installed — try /skills install <name>')
        return
      }
      if (sub.startsWith('install ')) {
        const pkg = sub.slice(8).trim()
        if (!pkg) { printer.systemMsg('usage: /skills install <name>  (e.g. /skills install git-summary)'); return }
        printer.systemMsg(`installing miii-skill-${pkg}…`)
        try { printer.systemMsg(await skills.installSkill(pkg)) } catch (e) { printer.errorMsg(String(e)) }
        return
      }
      if (sub.startsWith('uninstall ')) {
        const pkg = sub.slice(10).trim()
        if (!pkg) { printer.systemMsg('usage: /skills uninstall <name>'); return }
        try { printer.systemMsg(await skills.uninstallSkill(pkg)) } catch (e) { printer.errorMsg(String(e)) }
        return
      }
      printer.systemMsg('usage: /skills install <name> | /skills uninstall <name> | /skills list')
      return
    }

    if (cmd === '/model' || cmd.startsWith('/model ')) {
      const name = cmd.slice(6).trim()
      if (!name) { printer.systemMsg(`current model: ${currentModelRef.current}`); return }
      setCurrentModel(name)
      currentModelRef.current = name
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
      await handleGit(cmd.slice(4).trim())
      return
    }

    if (cmd.startsWith('/refactor ') || cmd === '/refactor') {
      const goal = cmd.slice(9).trim()
      if (!goal) { printer.systemMsg('usage: /refactor <goal>'); return }
      await runRefactor(goal)
      return
    }

    if (cmd.startsWith('/think ') || cmd === '/think') {
      const query = cmd.slice(6).trim()
      if (!query) { printer.systemMsg('usage: /think <query>'); return }
      printer.userMsg(`/think ${query}`)
      setStatus('thinking')
      setTaskLabel(`gathering: ${query}`)
      abortRef.current = new AbortController()
      try {
        const result = await runDeepThink(
          query, config, currentModelRef.current, abortRef.current.signal,
          (toolName) => setCurrentTool(`gather:${toolName}`),
        )
        setCurrentTool(undefined)
        printer.systemMsg(`gathered: ${result.toolCalls} tool call(s), ${result.webCalls} web call(s)`)
        if (result.findings) {
          pushHistory({ role: 'user', content: `/think ${query}` })
          pushHistory({ role: 'assistant', content: result.findings })
          pushHistory({ role: 'user', content: `Based on your research above, give a complete answer to: ${query}` })
          await runLoop(buildContext(), 0, query)
        } else {
          printer.systemMsg('nothing gathered — try rephrasing')
          setStatus('idle')
        }
      } catch (e) {
        printer.errorMsg(`deep think failed: ${e}`)
        setStatus('idle')
      } finally {
        setCurrentTool(undefined)
        setTaskLabel(undefined)
      }
      return
    }

    if (cmd === '/plan' || cmd.startsWith('/plan ')) {
      const topic = cmd.slice(5).trim()
      setPlanningMode(true)
      systemPromptRef.current = getSystemPrompt(
        `\n- CWD: ${cwd}\n- MODE: Planning assistant. Help the user plan step by step. Ask clarifying questions. Suggest concrete next steps. Use plain text only — no markdown, no headers, no bold, no bullets with asterisks, no backtick blocks. Use numbered lists and plain indentation for structure.`
      )
      const msg = topic ? `I want to plan: ${topic}` : 'I want to start planning. Help me think through my goals step by step.'
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
      if (!arg) { printer.systemMsg(`current: ${sessionNameRef.current}`); return }

      if (arg.startsWith('delete ')) {
        const target = arg.slice(7).trim()
        if (!target) { printer.systemMsg('usage: /session delete <name>'); return }
        if (target === sessionNameRef.current) { printer.systemMsg('cannot delete active session — switch first'); return }
        try { deleteSession(target); printer.systemMsg(`deleted: ${target}`) }
        catch (e) { printer.errorMsg(`delete failed: ${String(e)}`) }
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

    renameFromMessage(text)
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
            onClose={() => { setPickerOpen(false); }}
          />
          <Divider cols={cols} />
        </>
      ) : permissionRequest ? (
        <>
          <Box flexDirection="column" paddingX={1} paddingY={0}>
            <Box gap={1}>
              <Text color="yellow">⚠</Text>
              <Text color="white" bold>{permissionRequest.toolName}</Text>
              <Text color="gray">{toolArgSummary(permissionRequest.args)}</Text>
            </Box>
          </Box>
          <Divider cols={cols} />
        </>
      ) : (status === 'thinking' || status === 'tool') ? (
        <>
          <Box flexDirection="column" paddingX={1}>
            <Box flexDirection="column">
              <Box>
                {status === 'thinking'
                  ? <><Text color="yellow">{SPARKLE[tick % SPARKLE.length]} </Text><Text color="gray" dimColor italic>{THINKING_PHRASES[phraseSeq[Math.floor(tick / 62) % phraseSeq.length]]}</Text></>
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
        permissionRequest={permissionRequest}
        onPermissionResponse={resolvePermission}
        onSubmit={handleSubmit}
        onAbort={handleAbort}
      />
    </Box>
  )
}
