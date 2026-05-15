import { useState, useRef, useCallback, useEffect } from 'react'
import type { MutableRefObject } from 'react'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import type { Config, ChatMessage, Status } from '../../types.js'
import { chat } from '../../llm/stream.js'
import { tools as staticTools } from '../../tools/index.js'
import type { Tool } from '../../tools/index.js'
import { StreamParser, extractBareToolCall } from '../../parser/stream-parser.js'
import { shouldCompact, compactContext } from '../../tasks/compactor.js'
import * as printer from '../printer.js'

const MAX_TOOL_DEPTH = 6
const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file', 'patch_file', 'delete_file'])
const SHOW_RESULT_TOOLS = new Set(['run_tests', 'git_commit'])
const PERMISSION_TOOLS = new Set(['edit_file', 'patch_file', 'delete_file', 'create_file', 'move_file', 'run_command', 'git_commit'])
const CHECKPOINT_TOOLS = new Set(['edit_file', 'patch_file', 'create_file', 'delete_file'])

export interface PermissionRequest {
  toolName: string
  args: Record<string, unknown>
}

export interface CompactRequest {
  messageCount: number
}

export function useRunLoop(
  config: Config,
  currentModelRef: MutableRefObject<string>,
  pushHistory: (msg: ChatMessage) => void,
  extraTools: Tool[] = [],
  abortRef: MutableRefObject<AbortController | null>,
) {
  const [status, setStatus] = useState<Status>('idle')
  const [tick, setTick] = useState(0)
  const [currentTool, setCurrentTool] = useState<string | undefined>()
  const [taskLabel, setTaskLabel] = useState<string | undefined>()
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const permissionResolveRef = useRef<((result: 'yes' | 'session' | 'no') => void) | null>(null)
  const [compactRequest, setCompactRequest] = useState<CompactRequest | null>(null)
  const compactResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const checkpointRef = useRef<Map<string, string | null>>(new Map())
  const sessionApprovedRef = useRef<Set<string>>(new Set())
  const thinkingStartRef = useRef<number>(0)
  const extraToolsRef = useRef(extraTools)
  extraToolsRef.current = extraTools
  const pushHistoryRef = useRef(pushHistory)
  useEffect(() => { pushHistoryRef.current = pushHistory }, [pushHistory])

  const resolvePermission = useCallback((result: 'yes' | 'session' | 'no') => {
    permissionResolveRef.current?.(result)
    permissionResolveRef.current = null
    setPermissionRequest(null)
  }, [])

  const resolveCompact = useCallback((approved: boolean) => {
    compactResolveRef.current?.(approved)
    compactResolveRef.current = null
    setCompactRequest(null)
  }, [])

  useEffect(() => {
    if (status === 'idle') return
    const t = setInterval(() => setTick(n => n + 1), 80)
    return () => clearInterval(t)
  }, [status])

  const runLoop = useCallback(async (contextMsgs: ChatMessage[], depth = 0, goal?: string): Promise<void> => {
    if (depth >= MAX_TOOL_DEPTH) { abortRef.current = null; setStatus('idle'); return }
    setStatus('thinking')
    if (depth === 0) {
      thinkingStartRef.current = Date.now()
      checkpointRef.current.clear()
    }

    let msgs = contextMsgs
    if (shouldCompact(contextMsgs)) {
      const approved = await new Promise<boolean>(resolve => {
        compactResolveRef.current = resolve
        setCompactRequest({ messageCount: contextMsgs.length })
      })
      if (approved) {
        printer.systemMsg('compacting context…')
        msgs = await compactContext(contextMsgs, {
          provider: config.provider,
          model: currentModelRef.current,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
        }, goal)
        printer.systemMsg(`compacted: ${contextMsgs.length} → ${msgs.length} messages`)
      } else {
        printer.systemMsg('keeping full context — responses may be slower')
      }
    }
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

        if (pendingTools.length) printer.planSummary(pendingTools)

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
            const allTools = [...staticTools, ...extraToolsRef.current]
            const tool = allTools.find(t => t.name === tc.name)
            setCurrentTool(tc.name)

            if (PERMISSION_TOOLS.has(tc.name)) {
              const sessionKey = tc.name
              let decision: 'yes' | 'session' | 'no'
              if (sessionApprovedRef.current.has(sessionKey)) {
                decision = 'yes'
              } else {
                decision = await new Promise<'yes' | 'session' | 'no'>(resolve => {
                  permissionResolveRef.current = resolve
                  setPermissionRequest({ toolName: tc.name, args: tc.args })
                })
              }
              if (decision === 'session') sessionApprovedRef.current.add(sessionKey)
              if (decision === 'no') {
                printer.systemMsg(`denied: ${tc.name}`)
                next.push({ role: 'user', content: `Tool ${tc.name} was denied by the user` })
                break
              }

              // Checkpoint: store pre-execution file state
              if (CHECKPOINT_TOOLS.has(tc.name)) {
                const path = tc.args.path as string | undefined
                if (path && !checkpointRef.current.has(path)) {
                  try {
                    checkpointRef.current.set(path, readFileSync(path, 'utf-8'))
                  } catch {
                    checkpointRef.current.set(path, null)
                  }
                }
              }
            }

            if (tool) {
              try {
                printer.toolCallStart(tc.name, tc.args)
                const result = await tool.execute(tc.args)
                printer.toolResultSummary(tc.name, tc.args, result)
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
          const testTool = staticTools.find(t => t.name === 'run_tests')
          if (testTool) {
            setCurrentTool('run_tests')
            try {
              printer.toolCallStart('run_tests', {})
              const testResult = await testTool.execute({})
              if (testResult && !testResult.startsWith('(no test script') && !testResult.startsWith('(no package.json')) {
                printer.toolResultSummary('run_tests', {}, testResult)
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
    sessionApprovedRef.current.clear()
    if (permissionResolveRef.current) {
      permissionResolveRef.current('no')
      permissionResolveRef.current = null
      setPermissionRequest(null)
    }
    if (compactResolveRef.current) {
      compactResolveRef.current(false)
      compactResolveRef.current = null
      setCompactRequest(null)
    }
    // Restore checkpointed files
    if (checkpointRef.current.size > 0) {
      let restored = 0
      for (const [path, content] of checkpointRef.current) {
        try {
          if (content === null) {
            if (existsSync(path)) unlinkSync(path)
          } else {
            writeFileSync(path, content, 'utf-8')
          }
          restored++
        } catch {}
      }
      checkpointRef.current.clear()
      if (restored > 0) printer.systemMsg(`restored ${restored} file(s) to pre-session state`)
    }
    setStatus('idle')
  }, [])

  return {
    status, setStatus, tick,
    currentTool, setCurrentTool,
    taskLabel, setTaskLabel,
    thinkingStartRef,
    runLoop, handleAbort,
    permissionRequest, resolvePermission,
    compactRequest, resolveCompact,
  }
}
