import { useState, useRef, useCallback, useEffect } from 'react'
import type { MutableRefObject } from 'react'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
const runCmd = promisify(exec)
import type { Config, ChatMessage, Status } from '../../types.js'
import { chat } from '../../llm/stream.js'
import { tools as staticTools } from '../../tools/index.js'
import type { Tool } from '../../tools/index.js'
import { StreamParser, extractBareToolCall } from '../../parser/stream-parser.js'
import { shouldCompact, compactContext, contextSize } from '../../tasks/compactor.js'
import * as printer from '../printer.js'

const MAX_TOOL_DEPTH = 10
const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file', 'update_file', 'delete_file'])
const SHOW_RESULT_TOOLS = new Set(['run_tests', 'git_commit'])
const PERMISSION_TOOLS = new Set(['edit_file', 'update_file', 'delete_file', 'create_file', 'move_file', 'run_command', 'git_commit'])
const CHECKPOINT_TOOLS = new Set(['edit_file', 'update_file', 'create_file', 'delete_file'])
const PARALLEL_SAFE    = new Set(['read_file', 'list_files', 'git_status', 'git_log', 'git_diff', 'web_search', 'web_extract'])

// Tool result messages that are ephemeral — never worth storing in memory or compact summaries
const EPHEMERAL_PATTERN = /^Tool (read_file|list_files|run_tests) result:|^\[current state of|^\[Context compacted|^\[file updated:/

export function stripEphemeral(messages: import('../../types.js').ChatMessage[]) {
  return messages.filter(m => m.role !== 'user' || !EPHEMERAL_PATTERN.test(m.content))
}

export interface PermissionRequest {
  toolName: string
  args: Record<string, unknown>
}


export function useRunLoop(
  config: Config,
  currentModelRef: MutableRefObject<string>,
  pushHistory: (msg: ChatMessage) => void,
  extraTools: Tool[] = [],
  abortRef: MutableRefObject<AbortController | null>,
  replaceHistory?: (msgs: ChatMessage[]) => void,
) {
  const [status, setStatus] = useState<Status>('idle')
  const [tick, setTick] = useState(0)
  const [currentTool, setCurrentTool] = useState<string | undefined>()
  const [taskLabel, setTaskLabel] = useState<string | undefined>()
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const permissionResolveRef = useRef<((result: 'yes' | 'session' | 'no') => void) | null>(null)
  const checkpointRef = useRef<Map<string, string | null>>(new Map())
  const autoBranchedRef = useRef<string | null>(null)
  const sessionApprovedRef = useRef<Set<string>>(new Set())
  const thinkingStartRef = useRef<number>(0)
  const extraToolsRef = useRef(extraTools)
  extraToolsRef.current = extraTools
  const pushHistoryRef = useRef(pushHistory)
  const replaceHistoryRef = useRef(replaceHistory)
  useEffect(() => { pushHistoryRef.current = pushHistory }, [pushHistory])
  useEffect(() => { replaceHistoryRef.current = replaceHistory }, [replaceHistory])

  const resolvePermission = useCallback((result: 'yes' | 'session' | 'no') => {
    permissionResolveRef.current?.(result)
    permissionResolveRef.current = null
    setPermissionRequest(null)
  }, [])


  useEffect(() => {
    if (status === 'idle') return
    const t = setInterval(() => setTick(n => n + 1), 80)
    return () => clearInterval(t)
  }, [status])

  const runLoop = useCallback(async (contextMsgs: ChatMessage[], depth = 0, goal?: string, options?: { noTools?: boolean }): Promise<void> => {
    if (depth >= MAX_TOOL_DEPTH) { abortRef.current = null; setStatus('idle'); return }
    setStatus('thinking')
    if (depth === 0) {
      thinkingStartRef.current = Date.now()
      checkpointRef.current.clear()
      autoBranchedRef.current = null
    }

    abortRef.current = new AbortController()
    let msgs = contextMsgs
    if (shouldCompact(contextMsgs)) {
      printer.systemMsg('compacting context…')
      const toCompact = stripEphemeral(contextMsgs)
      msgs = await compactContext(toCompact, {
        provider: config.provider,
        model: currentModelRef.current,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      }, goal, abortRef.current.signal)
      if (abortRef.current.signal.aborted) { setStatus('idle'); return }
      printer.systemMsg(`compacted: ${contextMsgs.length} → ${msgs.length} messages`)
      replaceHistoryRef.current?.(msgs.filter(m => m.role !== 'system'))
    }
    let didStream = false

    await chat({
      provider: config.provider,
      model: currentModelRef.current,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      messages: msgs,
      tools: config.provider !== 'ollama' && !(options?.noTools && depth === 0) ? [...staticTools, ...extraToolsRef.current] : undefined,
      toolChoice: (options?.noTools && depth === 0) ? 'none' : undefined,
      signal: abortRef.current.signal,
      onChunk: config.streaming ? (chunk) => {
        if (!didStream) { printer.streamStart(); didStream = true }
        printer.streamChunk(chunk)
      } : undefined,
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

        if (didStream) printer.streamEnd()
        const displayText = textParts.join('').trim()
        if (displayText && !didStream) printer.assistantMsg(displayText)
        pushHistoryRef.current({ role: 'assistant', content: fullText })

        if (pendingTools.length) printer.planSummary(pendingTools)

        if (!pendingTools.length) {
          const hasFencedCode = /```[\w]*\n[\s\S]{50,}?\n```/.test(fullText)
          if (hasFencedCode && depth < MAX_TOOL_DEPTH - 1) {
            const nudge: ChatMessage = {
              role: 'user',
              content: 'You showed code in your response but did not use any file tools. Use edit_file or update_file to actually write the changes to disk.',
            }
            await runLoop([...msgs, { role: 'assistant', content: fullText }, nudge], depth + 1, goal)
            return
          }
          if (autoBranchedRef.current) printer.systemMsg(`branch: ${autoBranchedRef.current}  (git checkout main when done)`)
          printer.systemMsg(`done in ${printer.formatElapsed(Date.now() - thinkingStartRef.current)}`)
          setStatus('idle')
          return
        }

        setStatus('tool')
        const next: ChatMessage[] = [...msgs, { role: 'assistant', content: fullText }]
        let actualEditsDone = false
        const allParallelSafe = pendingTools.every(tc => PARALLEL_SAFE.has(tc.name))

        if (allParallelSafe && pendingTools.length > 1) {
          try {
            setCurrentTool(pendingTools[0].name)
            const allTools = [...staticTools, ...extraToolsRef.current]
            const settled = await Promise.allSettled(
              pendingTools.map(async tc => {
                const tool = allTools.find(t => t.name === tc.name)
                printer.toolCallStart(tc.name, tc.args)
                if (!tool) throw new Error(`unknown tool: ${tc.name}`)
                const result = await tool.execute(tc.args)
                printer.toolResultSummary(tc.name, tc.args, result)
                if (SHOW_RESULT_TOOLS.has(tc.name)) printer.toolMsg(tc.name, result)
                return { tc, result }
              })
            )
            for (const r of settled) {
              if (r.status === 'fulfilled') {
                next.push({ role: 'user', content: `Tool ${r.value.tc.name} result:\n${r.value.result}` })
                if (FILE_EDIT_TOOLS.has(r.value.tc.name)) actualEditsDone = true
              } else {
                const err = `Tool error: ${r.reason}`
                printer.errorMsg(err)
                next.push({ role: 'user', content: err })
              }
            }
          } finally {
            setCurrentTool(undefined)
          }
        } else {
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
                const remaining = pendingTools.slice(pendingTools.indexOf(tc) + 1).map(t => t.name)
                const skippedNote = remaining.length ? ` The following tools were also skipped: ${remaining.join(', ')}.` : ''
                next.push({ role: 'user', content: `Tool ${tc.name} was denied by the user.${skippedNote} Do not retry these tools unless the user explicitly asks.` })
                break
              }

              // Checkpoint: store pre-execution file state + auto-branch on first edit
              if (CHECKPOINT_TOOLS.has(tc.name)) {
                const path = tc.args.path as string | undefined
                if (path && !checkpointRef.current.has(path)) {
                  try {
                    checkpointRef.current.set(path, readFileSync(path, 'utf-8'))
                  } catch {
                    checkpointRef.current.set(path, null)
                  }
                }
                if (!autoBranchedRef.current) {
                  try {
                    const { stdout } = await runCmd('git rev-parse --abbrev-ref HEAD', { timeout: 3000 })
                    const branch = stdout.trim()
                    if (branch === 'main' || branch === 'master') {
                      const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
                      const newBranch = `miii/task-${ts}`
                      await runCmd(`git checkout -b ${newBranch}`, { timeout: 5000 })
                      autoBranchedRef.current = newBranch
                      printer.systemMsg(`auto-branched: ${newBranch}`)
                    }
                  } catch {}
                }
              }
            }

            if (tool) {
              try {
                // Guard: for update_file, verify old text still matches before executing.
                // If stale, inject fresh file content and skip — model will retry.
                if (tc.name === 'update_file') {
                  const filePath = tc.args.path as string | undefined
                  const oldText  = tc.args.old as string | undefined
                  if (filePath && oldText && existsSync(filePath)) {
                    const norm = (s: string) => s.replace(/\r\n/g, '\n')
                    const current = readFileSync(filePath, 'utf-8')
                    const occurrences = norm(current).split(norm(oldText)).length - 1
                    if (occurrences === 0) {
                      printer.errorMsg(`patch stale: old text not found in ${filePath} — injecting fresh content`)
                      next.push({ role: 'user', content: `Tool read_file result:\n${current}` })
                      next.push({ role: 'user', content: `update_file failed: the <old> text you used does not exist in ${filePath}. The CURRENT file content is shown above. Re-read it carefully, find the exact text you want to replace, and retry update_file using text that exactly matches what is in the file now.` })
                      continue
                    }
                    if (occurrences > 1) {
                      printer.errorMsg(`patch ambiguous: old text matches ${occurrences} locations in ${filePath} — injecting fresh content`)
                      next.push({ role: 'user', content: `Tool read_file result:\n${current}` })
                      next.push({ role: 'user', content: `update_file failed: the <old> text matches ${occurrences} locations in ${filePath}. Add more surrounding lines to the <old> block to make it unique, then retry.` })
                      continue
                    }
                  }
                }

                printer.toolCallStart(tc.name, tc.args)
                const result = await tool.execute(tc.args)
                printer.toolResultSummary(tc.name, tc.args, result)
                if (SHOW_RESULT_TOOLS.has(tc.name)) printer.toolMsg(tc.name, result)
                next.push({ role: 'user', content: `Tool ${tc.name} result:\n${result}` })

                if (FILE_EDIT_TOOLS.has(tc.name)) {
                  actualEditsDone = true
                  const filePath = tc.args.path as string | undefined
                  if (filePath && existsSync(filePath)) {
                    const lineCount = readFileSync(filePath, 'utf-8').split('\n').length
                    next.push({ role: 'user', content: `[file updated: ${filePath} — ${lineCount} lines]` })
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
        } // end sequential else

        // For file-edit turns: slim context (system + goal + fresh file states + recent results)
        // For non-edit turns: full next (model needs full conversational context)
        const didEditFiles = actualEditsDone
        if (didEditFiles) {
          const systemMsg = msgs.find(m => m.role === 'system')
          const goalMsg   = msgs.find(m => m.role === 'user' && !m.content.startsWith('[') && !m.content.startsWith('Tool '))
                         ?? (goal ? { role: 'user' as const, content: goal } : undefined)
          // If no recoverable goal, skip slimming — model needs full context to make sense of situation
          if (!goalMsg) {
            await runLoop(next, depth + 1, goal)
          } else {
            const batchStart = msgs.length // include assistant message so model sees its own tool call on retry
            const batchMsgs  = next.slice(batchStart)
            const slimCtx: ChatMessage[] = [
              ...(systemMsg ? [systemMsg] : []),
              goalMsg,
              ...batchMsgs,
            ]
            await runLoop(slimCtx, depth + 1, goal)
          }
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
    if (autoBranchedRef.current) {
      printer.systemMsg(`task branch preserved: ${autoBranchedRef.current}`)
      autoBranchedRef.current = null
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
  }
}
