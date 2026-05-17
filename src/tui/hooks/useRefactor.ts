import { useCallback, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { Config, ChatMessage, Status } from '../../types.js'
import { generateId } from '../../types.js'
import { chat } from '../../llm/stream.js'
import { MicroQueue, MacroQueue } from '../../tasks/queue.js'
import { TaskExecutor } from '../../tasks/executor.js'
import { fileEditContext } from '../../tasks/compactor.js'
import { StreamParser } from '../../parser/stream-parser.js'
import { tools } from '../../tools/index.js'
import type { MacroTask, MicroTask } from '../../tasks/types.js'
import * as printer from '../printer.js'

interface RefactorDeps {
  config: Config
  currentModelRef: MutableRefObject<string>
  systemPromptRef: MutableRefObject<string>
  abortRef: MutableRefObject<AbortController | null>
  macroQueueRef: MutableRefObject<MacroQueue>
  executorRef: MutableRefObject<TaskExecutor>
  setStatus: (s: Status) => void
  setTaskLabel: (l: string | undefined) => void
  setCurrentTool: (t: string | undefined) => void
  pushHistory: (msg: ChatMessage) => void
}

export function useRefactor(deps: RefactorDeps) {
  const depsRef = useRef(deps)
  depsRef.current = deps

  const runRefactor = useCallback(async (goal: string) => {
    const {
      config, currentModelRef, systemPromptRef, abortRef,
      macroQueueRef, executorRef,
      setStatus, setTaskLabel, setCurrentTool, pushHistory,
    } = depsRef.current

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

    const controller = new AbortController()
    abortRef.current = controller
    let planText = ''

    await chat({
      provider: config.provider,
      model: currentModelRef.current,
      baseUrl: config.baseUrl,
      messages: planCtx,
      signal: controller.signal,
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
        signal: controller.signal,
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
  }, [])

  return { runRefactor }
}
