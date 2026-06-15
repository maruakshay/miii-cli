import type { OllamaMessage, OllamaTool, OllamaToolCall, ChatChunk, ChatOptions } from './types.js'

export const PROVIDER_NAME = 'lmstudio'
export const NOT_AVAILABLE =
  'LM Studio is not running. Make sure the local inference server is running (Settings > Local Inference Server).'
export const NOT_INSTALLED = NOT_AVAILABLE

const DEFAULT_HOST = 'http://localhost:1234'
const DEFAULT_CONTEXT = 4096

function host(): string {
  return process.env.LMSTUDIO_HOST ?? process.env.LLM_HOST ?? DEFAULT_HOST
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = process.env.LMSTUDIO_API_KEY
  if (key) h['Authorization'] = `Bearer ${key}`
  return h
}

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('connect')
}

export function isAvailable(): boolean {
  return true
}

export async function listModels(): Promise<string[]> {
  try {
    const res = await fetch(`${host()}/v1/models`, {
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch {}
      throw new Error(`LM Studio error (HTTP ${res.status}): ${detail || res.statusText}`)
    }
    const body = await res.json() as { data: Array<{ id: string }> }
    return body.data.map((m) => m.id)
  } catch (err) {
    if (isConnectionError(err)) {
      throw new Error(NOT_AVAILABLE)
    }
    throw err
  }
}

export async function modelContext(_model: string): Promise<number> {
  return DEFAULT_CONTEXT
}

function toLMStudioMessages(msgs: OllamaMessage[]): unknown[] {
  return msgs.map((m) => {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
          },
        })),
      }
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id ?? '',
      }
    }
    return { role: m.role, content: m.content }
  })
}

function toLMStudioTools(tools?: OllamaTool[]): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }))
}

function parseSSELine(line: string): unknown | null {
  if (!line.startsWith('data: ')) return null
  const data = line.slice(6).trim()
  if (data === '[DONE]') return null
  try {
    return JSON.parse(data) as unknown
  } catch {
    return null
  }
}

export async function* chat(
  model: string,
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  opts?: ChatOptions,
): AsyncGenerator<ChatChunk> {
  if (opts?.signal?.aborted) return

  const lmMessages = toLMStudioMessages(messages)
  const lmTools = toLMStudioTools(tools)

  const body: Record<string, unknown> = {
    model,
    messages: lmMessages,
    stream: true,
    temperature: opts?.temperature ?? 0.2,
  }
  if (lmTools) body.tools = lmTools
  if (opts?.num_predict && opts.num_predict > 0) body.max_tokens = opts.num_predict

  const toolCallAccum: Map<number, {
    id?: string
    type?: string
    name?: string
    args: string
  }> = new Map()

  const TIMEOUT_MS = 180000
  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
  const combinedSignal = opts?.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : (opts?.signal ?? timeoutSignal)

  try {
    const res = await fetch(`${host()}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: combinedSignal,
    })

    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch {}
      if (res.status === 404) {
        throw new Error(`Model "${model}" not found in LM Studio. Make sure it's loaded.`)
      }
      throw new Error(`LM Studio error (HTTP ${res.status}): ${detail || res.statusText}`)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      readLoop: while (true) {
        const { done: readerDone, value } = await reader.read()
        if (readerDone || opts?.signal?.aborted) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const parsed = parseSSELine(line) as Record<string, unknown> | null
          if (!parsed) continue

          const choices = parsed.choices as Array<{
            delta: Record<string, unknown>
            finish_reason?: string | null
          }> | undefined
          if (!choices || choices.length === 0) continue

          const delta = choices[0].delta ?? {}
          const finishReason = choices[0].finish_reason

          if (delta.content) {
            yield { content: delta.content as string, done: false }
          }

          const deltaToolCalls = delta.tool_calls as Array<{
            index: number
            id?: string
            type?: string
            function?: { name?: string; arguments?: string }
          }> | undefined
          if (deltaToolCalls) {
            for (const tc of deltaToolCalls) {
              const idx = tc.index
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { args: '' })
              }
              const acc = toolCallAccum.get(idx)!
              if (tc.id) acc.id = tc.id
              if (tc.type) acc.type = tc.type
              if (tc.function) {
                if (tc.function.name) acc.name = tc.function.name
                if (tc.function.arguments) acc.args += tc.function.arguments
              }
            }
          }

          if (finishReason) {
            break readLoop
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  } catch (err) {
    if (opts?.signal?.aborted) {
      yield { content: '', done: true, prompt_eval_count: 0, eval_count: 0 }
      return
    }
    if (isConnectionError(err)) {
      throw new Error(NOT_AVAILABLE)
    }
    if (timeoutSignal.aborted && !opts?.signal?.aborted) {
      throw new Error(`LM Studio request timed out after ${TIMEOUT_MS / 1000}s. The model may still be loading or thinking.`)
    }
    throw err
  }

  if (opts?.signal?.aborted) {
    yield { content: '', done: true, prompt_eval_count: 0, eval_count: 0 }
    return
  }

  const toolCalls: OllamaToolCall[] = []
  for (const [, acc] of toolCallAccum) {
    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = JSON.parse(acc.args) as Record<string, unknown>
    } catch {
      parsedArgs = { _raw: acc.args }
    }
    toolCalls.push({
      id: acc.id,
      function: {
        name: acc.name ?? '',
        arguments: parsedArgs,
      },
    })
  }

  yield {
    content: '',
    done: true,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  }
}
