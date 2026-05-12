import { useState, useRef, useCallback, useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { Config, ChatMessage, Status } from '../../types.js'
import { chat } from '../../llm/stream.js'
import { tools } from '../../tools/index.js'
import { StreamParser, extractBareToolCall } from '../../parser/stream-parser.js'
import { shouldCompact, compactContext } from '../../tasks/compactor.js'
import * as printer from '../printer.js'

const MAX_TOOL_DEPTH = 6
const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file', 'patch_file', 'delete_file'])
const SHOW_RESULT_TOOLS = new Set(['run_tests', 'git_commit'])

export function useRunLoop(
  config: Config,
  currentModelRef: MutableRefObject<string>,
  pushHistory: (msg: ChatMessage) => void,
) {
  const [status, setStatus] = useState<Status>('idle')
  const [tick, setTick] = useState(0)
  const [currentTool, setCurrentTool] = useState<string | undefined>()
  const [taskLabel, setTaskLabel] = useState<string | undefined>()
  const abortRef = useRef<AbortController | null>(null)
  const thinkingStartRef = useRef<number>(0)
  const pushHistoryRef = useRef(pushHistory)
  useEffect(() => { pushHistoryRef.current = pushHistory }, [pushHistory])

  useEffect(() => {
    if (status === 'idle') return
    const t = setInterval(() => setTick(n => n + 1), 80)
    return () => clearInterval(t)
  }, [status])

  const runLoop = useCallback(async (contextMsgs: ChatMessage[], depth = 0, goal?: string): Promise<void> => {
    if (depth >= MAX_TOOL_DEPTH) { setStatus('idle'); return }
    setStatus('thinking')
    if (depth === 0) thinkingStartRef.current = Date.now()

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
        const textParts: string[] = []
        const parser = new StreamParser()
        for (const item of [...parser.feed(fullText), ...parser.flush()]) {
          if (item.type === 'tool_call') pendingTools.push({ name: item.toolName, args: item.toolArgs })
          else textParts.push(item.content)
        }
        if (!pendingTools.length) {
          const bare = extractBareToolCall(fullText)
          if (bare) pendingTools.push({ name: bare.name, args: bare.args })
        }

        const displayText = textParts.join('').trim()
        if (displayText) printer.assistantMsg(displayText)
        pushHistoryRef.current({ role: 'assistant', content: fullText })

        if (!pendingTools.length) {
          const hasFencedCode = /```[\w]*\n[\s\S]{50,}?\n```/.test(fullText)
          if (hasFencedCode && depth < MAX_TOOL_DEPTH - 1) {
            const nudge: ChatMessage = {
              role: 'user',
              content: 'You showed code in your response but did not use any file tools. Use edit_file or patch_file to actually write the changes to disk.',
            }
            await runLoop([...msgs, { role: 'assistant', content: fullText }, nudge], depth + 1, goal)
            return
          }
          setStatus('idle')
          return
        }

        setStatus('tool')
        const next: ChatMessage[] = [...msgs, { role: 'assistant', content: fullText }]

        try {
          for (const tc of pendingTools) {
            const tool = tools.find(t => t.name === tc.name)
            setCurrentTool(tc.name)
            if (tool) {
              try {
                printer.toolCallStart(tc.name, tc.args)
                const result = await tool.execute(tc.args)
                if (SHOW_RESULT_TOOLS.has(tc.name)) printer.toolMsg(tc.name, result)
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

        // Auto-run tests after file edits
        const didEditFiles = pendingTools.some(tc => FILE_EDIT_TOOLS.has(tc.name))
        if (didEditFiles) {
          const testTool = tools.find(t => t.name === 'run_tests')
          if (testTool) {
            setCurrentTool('run_tests')
            try {
              printer.toolCallStart('run_tests', {})
              const testResult = await testTool.execute({})
              if (testResult && !testResult.startsWith('(no test script') && !testResult.startsWith('(no package.json')) {
                printer.toolMsg('run_tests', testResult)
                next.push({ role: 'user', content: `Test results after edits:\n${testResult}` })
              }
            } catch (e) {
              const err = `run_tests error: ${e}`
              printer.errorMsg(err)
              next.push({ role: 'user', content: err })
            } finally {
              setCurrentTool(undefined)
            }
          }
        }

        await runLoop(next, depth + 1, goal)
      },

      onError(err) {
        if (err.name !== 'AbortError') printer.errorMsg(err.message)
        setStatus('idle')
      },
    })
  }, [config])

  const handleAbort = useCallback(() => {
    abortRef.current?.abort()
    setStatus('idle')
  }, [])

  return {
    status, setStatus, tick,
    currentTool, setCurrentTool,
    taskLabel, setTaskLabel,
    thinkingStartRef, abortRef,
    runLoop, handleAbort,
  }
}
