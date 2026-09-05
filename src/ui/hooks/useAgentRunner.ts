/**
 * useAgentRunner — drives the agent loop for a single user turn.
 *
 * Owns all streaming state (thinking, streaming, tool activity) and
 * exposes `sendMessage` + `askPermission` to the caller.
 */
import { useState, useRef } from 'react'
import { runAgent } from '../../agent/loop.js'
import { compactHistory, estimateHistoryTokens } from '../../agent/compact.js'
import type { ChatMessage, PermissionRequest, PermissionAnswer, ToolUseDisplay, ToolResultDisplay } from '../types.js'
import type { MiiMessage } from '../../agent/types.js'
import { tailLine } from '../layout.js'

// How often (ms) we flush streaming text to React state — avoids a re-render per token.
const FLUSH_MS = 100

export function useAgentRunner(model: string | undefined, activeCtx: number | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [thinking, setThinking] = useState(false)
  const [thinkingTail, setThinkingTail] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [processingLabel, setProcessingLabel] = useState<string | undefined>(undefined)
  const [agentHistory, setAgentHistory] = useState<MiiMessage[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [permissionCursor, setPermissionCursor] = useState(0)
  const [activeToolUses, setActiveToolUses] = useState<ToolUseDisplay[]>([])
  const [activeToolResults, setActiveToolResults] = useState<ToolResultDisplay[]>([])
  /**
   * Prompt+eval tokens the model reported for the last turn — i.e. how full the
   * context is right now. Kept as state rather than derived from the transcript
   * so compaction can correct it immediately; a stale reading there would have
   * the auto-compact trigger fire again the moment it finished.
   */
  const [usedTokens, setUsedTokens] = useState(0)
  const [compacting, setCompacting] = useState(false)

  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const pendingPermissionRef = useRef<PermissionRequest | null>(null)

  /** Prompt the UI for a permission decision and await the user's choice. */
  function askPermission(toolName: string, input: unknown): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      const req: PermissionRequest = { toolName, input, resolve }
      pendingPermissionRef.current = req
      setPermissionCursor(0)
      setPendingPermission(req)
    })
  }

  /** Resolve the currently pending permission prompt. */
  function resolvePermission(cursor: number) {
    const req = pendingPermissionRef.current
    if (!req) return
    const answers: PermissionAnswer[] = ['yes', 'always', 'no']
    pendingPermissionRef.current = null
    setPendingPermission(null)
    req.resolve(answers[cursor])
  }

  /**
   * Answer a pending prompt with 'no' without the user picking an option — used
   * when they cancel the whole turn instead. Aborting the run alone would leave
   * this promise unsettled, and the agent loop parks on it forever: the turn
   * never finishes, `busy` never clears, and the input stays locked.
   */
  function cancelPermission() {
    const req = pendingPermissionRef.current
    if (!req) return
    pendingPermissionRef.current = null
    setPendingPermission(null)
    req.resolve('no')
  }

  async function sendMessage(text: string, images?: string[]) {
    if (busyRef.current || !model) return
    busyRef.current = true
    setBusy(true)
    setProcessingLabel('crunching…')
    setError(null)

    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setThinking(true)

    let accumulated = ''
    let thinkingAcc = ''
    let firstToken = true
    setThinkingTail('')

    // Throttled setters — batch token-level deltas into periodic React updates.
    let streamFlushAt = 0
    let thinkFlushAt = 0
    const flushStream = (force = false) => {
      const now = Date.now()
      if (force || now - streamFlushAt >= FLUSH_MS) {
        streamFlushAt = now
        setStreamingContent(accumulated)
      }
    }
    const flushThink = (force = false) => {
      const now = Date.now()
      if (force || now - thinkFlushAt >= FLUSH_MS) {
        thinkFlushAt = now
        setThinkingTail(tailLine(thinkingAcc))
      }
    }

    let turnUses: ToolUseDisplay[] = []
    let turnResults: ToolResultDisplay[] = []
    const startTime = Date.now()

    /** Commit accumulated text + tool activity as a finished assistant message. */
    const flushTurn = (final: { prompt: number; eval: number } | null) => {
      const msg: ChatMessage = {
        role: 'assistant',
        content: accumulated,
        thinking: thinkingAcc.trim() ? thinkingAcc : undefined,
        tool_uses: turnUses.length ? turnUses : undefined,
        tool_results: turnResults.length ? turnResults : undefined,
      }
      if (final) {
        msg.tokens = { prompt_eval: final.prompt, eval: final.eval }
        msg.duration = Date.now() - startTime
      }
      setMessages((prev) => [...prev, msg])
      accumulated = ''
      thinkingAcc = ''
      turnUses = []
      turnResults = []
      setStreamingContent('')
      setThinkingTail('')
      setActiveToolUses([])
      setActiveToolResults([])
    }

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const gen = runAgent({
        model,
        cwd: process.cwd(),
        history: agentHistory,
        userText: text,
        images,
        permissions: { ask: askPermission },
        signal: controller.signal,
        num_ctx: activeCtx ?? undefined,
      })

      let finalTokens = { prompt: 0, eval: 0 }
      let result: IteratorResult<typeof gen extends AsyncGenerator<infer E, any> ? E : never, MiiMessage[]>
      // eslint-disable-next-line no-constant-condition
      while (true) {
        result = (await gen.next()) as typeof result
        if (result.done) { setAgentHistory(result.value); break }

        const ev = result.value
        switch (ev.type) {
          case 'text-delta': {
            if (firstToken) { firstToken = false; setStreaming(true) }
            setThinking(false)
            setProcessingLabel('responding…')
            accumulated += ev.text
            flushStream()
            break
          }
          case 'thinking-delta': {
            thinkingAcc += ev.text
            setThinking(true)
            setProcessingLabel('crunching…')
            flushThink()
            break
          }
          case 'tool-use': {
            turnUses.push({ id: ev.block.id, name: ev.block.name, input: ev.block.input })
            setActiveToolUses([...turnUses])
            setProcessingLabel(`running ${ev.block.name}…`)
            break
          }
          case 'tool-result': {
            turnResults.push({
              tool_use_id: ev.block.tool_use_id,
              content: ev.block.content,
              is_error: ev.block.is_error,
            })
            setActiveToolResults([...turnResults])
            setProcessingLabel('crunching…')
            break
          }
          case 'turn-end': {
            flushStream(true)
            flushThink(true)
            if (ev.stop_reason === 'tool_use') {
              // Tool turn: clearing `streaming` and committing the turn happen in
              // the same synchronous tick, so React batches them into one repaint.
              setStreaming(false)
              flushTurn(null)
              setThinking(true)
              firstToken = true
            }
            // Final turn (non-tool stop): DON'T drop `streaming` here. The commit
            // (flushTurn with real tokens) can't run until the later 'done' event
            // lands, and an `await` sits between. Clearing `streaming` now would
            // paint one frame with the live stream gone but the message not yet
            // committed to the transcript — a blank flash, then a reprint. Leaving `streaming`
            // true keeps the rendered tail on screen until the post-loop
            // setStreaming(false)+flushTurn batch swaps it in atomically.
            break
          }
          case 'done': {
            finalTokens = { prompt: ev.prompt_tokens, eval: ev.eval_tokens }
            setUsedTokens(ev.prompt_tokens + ev.eval_tokens)
            break
          }
          case 'aborted': {
            finalTokens = { prompt: ev.prompt_tokens, eval: ev.eval_tokens }
            setUsedTokens(ev.prompt_tokens + ev.eval_tokens)
            setStreaming(false)
            setThinking(false)
            flushTurn(finalTokens)
            setError(`Aborted · ${ev.prompt_tokens + ev.eval_tokens} tokens · ${(ev.duration_ms / 1000).toFixed(1)}s`)
            break
          }
          case 'error': {
            setError(ev.message)
            break
          }
        }
      }

      setStreaming(false)
      setThinking(false)
      if (accumulated || turnUses.length || turnResults.length) flushTurn(finalTokens)
    } catch (err) {
      const aborted = controller.signal.aborted
      const msg = err instanceof Error ? err.message : String(err)
      setThinking(false)
      setStreaming(false)
      if (accumulated || turnUses.length || turnResults.length) flushTurn(null)
      setError(aborted ? `Aborted · ${((Date.now() - startTime) / 1000).toFixed(1)}s` : msg)
    }

    abortRef.current = null
    busyRef.current = false
    setBusy(false)
    setProcessingLabel(undefined)
  }

  /**
   * Fold the conversation into a summary and keep going — the alternative to
   * /clear when the window fills up. The visible transcript is left alone (it's
   * the user's record of the session); what shrinks is the history the model is
   * sent, so the summary lands in the transcript as its own entry.
   *
   * Resolves false when it couldn't run or the model failed to summarise; the
   * original history is untouched in that case, since a full context is a far
   * better problem than a lost one.
   */
  async function compact(instructions?: string): Promise<boolean> {
    if (busyRef.current || !model) return false
    if (!agentHistory.length) {
      setError('nothing to compact yet — the conversation is empty')
      return false
    }
    busyRef.current = true
    setBusy(true)
    setCompacting(true)
    setProcessingLabel('compacting context…')
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await compactHistory(model, agentHistory, {
        instructions,
        num_ctx: activeCtx ?? undefined,
        signal: controller.signal,
      })
      setAgentHistory(res.history)
      setUsedTokens(estimateHistoryTokens(res.history))
      const kept = res.keptMessages ? `, last ${res.keptMessages} kept verbatim` : ''
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            `⧉ **context compacted** — ${res.droppedMessages} messages summarised${kept}. ` +
            `~${res.beforeTokens} → ~${res.afterTokens} tokens.\n\n${res.summary}`,
        },
      ])
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(controller.signal.aborted ? 'Compaction cancelled — context unchanged' : `Compaction failed: ${msg}`)
      return false
    } finally {
      abortRef.current = null
      busyRef.current = false
      setBusy(false)
      setCompacting(false)
      setProcessingLabel(undefined)
    }
  }

  return {
    // state
    messages, setMessages,
    thinking,
    thinkingTail, setThinkingTail,
    streaming,
    streamingContent, setStreamingContent,
    error, setError,
    busy,
    processingLabel,
    agentHistory, setAgentHistory,
    pendingPermission,
    permissionCursor, setPermissionCursor,
    activeToolUses, setActiveToolUses,
    activeToolResults, setActiveToolResults,
    usedTokens, setUsedTokens,
    compacting,
    // refs (for keyboard handler)
    busyRef,
    abortRef,
    pendingPermissionRef,
    // actions
    sendMessage,
    resolvePermission,
    cancelPermission,
    compact,
  }
}
