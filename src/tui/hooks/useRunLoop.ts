import { useState, useRef, useCallback, useEffect } from 'react'
import type { MutableRefObject } from 'react'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import type { Config, ChatMessage, Status } from '../../types.js'
import { chat } from '../../llm/stream.js'
import { tools as staticTools } from '../../tools/index.js'
import type { Tool } from '../../tools/index.js'
import { StreamParser, extractBareToolCall } from '../../parser/stream-parser.js'
import { shouldCompact, compactContext, contextSize } from '../../tasks/compactor.js'
import * as printer from '../printer.js'

const MAX_TOOL_DEPTH = 10
const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file', 'patch_file', 'delete_file'])
const SHOW_RESULT_TOOLS = new Set(['run_tests', 'git_commit'])
const PERMISSION_TOOLS = new Set(['edit_file', 'patch_file', 'delete_file', 'create_file', 'move_file', 'run_command', 'git_commit'])
const CHECKPOINT_TOOLS = new Set(['edit_file', 'patch_file', 'create_file', 'delete_file'])

// Tool result messages that are ephemeral — never worth storing in memory or compact summaries
const EPHEMERAL_PATTERN = /^Tool (read_file|list_files|run_tests) result:|^\[current state of|^\[Context compacted/

export function stripEphemeral(messages: import('../../types.js').ChatMessage[]) {
  return messages.filter(m => m.role !== 'user' || !EPHEMERAL_PATTERN.test(m.content))
}

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
        setCompactRequest({ messageCount: Math.round(contextSize(contextMsgs) / 1000) })
      })
      if (approved) {
        printer.systemMsg('compacting context…')
        const toCompact = stripEphemeral(contextMsgs)
        msgs = await compactContext(toCompact, {
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
      onRetry(attempt, max, delayMs) {
        printer.systemMsg(`retry ${attempt}/${max} — waiting ${Math.round(delayMs / 1000)}s`)
      },

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
                // Guard: for patch_file, verify old text still matches before executing.
                // If stale, inject fresh file content and skip — model will retry.
                if (tc.name === 'patch_file') {
                  const filePath = tc.args.path as string | undefined
                  const oldText  = tc.args.old as string | undefined
                  if (filePath && oldText && existsSync(filePath)) {
                    const current = readFileSync(filePath, 'utf-8')
                    if (!current.includes(oldText)) {
                      printer.errorMsg(`patch stale: old text not found in ${filePath} — injecting fresh content`)
                      next.push({ role: 'user', content: `Tool read_file result:\n${current}` })
                      next.push({ role: 'user', content: `patch_file failed: old text not found in ${filePath}. The file content above is the current state. Retry patch_file with the correct exact text.` })
                      continue
                    }
                  }
                }

                printer.toolCallStart(tc.name, tc.args)
                const result = await tool.execute(tc.args)
                printer.toolResultSummary(tc.name, tc.args, result)
                if (SHOW_RESULT_TOOLS.has(tc.name)) printer.toolMsg(tc.name, result)
                next.push({ role: 'user', content: `Tool ${tc.name} result:\n${result}` })

                // After any file edit, inject fresh file state so next tool sees actual content
                if (FILE_EDIT_TOOLS.has(tc.name)) {
                  const filePath = tc.args.path as string | undefined
                  if (filePath && existsSync(filePath)) {
                    const fresh = readFileSync(filePath, 'utf-8')
                    next.push({ role: 'user', content: `[current state of ${filePath} after edit]\n${fresh}` })
                  }
                }
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

        // For file-edit turns: slim context (system + goal + fresh file states + recent results)
        // For non-edit turns: full next (model needs full conversational context)
        if (didEditFiles) {
          const systemMsg = msgs.find(m => m.role === 'system')
          const goalMsg   = msgs.find(m => m.role === 'user' && !m.content.startsWith('[') && !m.content.startsWith('Tool '))
          const batchStart = msgs.length + 1 // index in next where this batch's messages start
          const batchMsgs  = next.slice(batchStart)
          const slimCtx: ChatMessage[] = [
            ...(systemMsg ? [systemMsg] : []),
            ...(goalMsg   ? [goalMsg]   : []),
            ...batchMsgs,
          ]
          await runLoop(slimCtx, depth + 1, goal)
        } else {
          await runLoop(next, depth + 1, goal)
        }
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
