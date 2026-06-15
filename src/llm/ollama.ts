import { Ollama, type Message, type Tool, type ChatResponse } from 'ollama'
import { execFileSync } from 'child_process'
import type { OllamaMessage, OllamaTool, ChatChunk, ChatOptions } from './types.js'

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
})

export const PROVIDER_NAME = 'ollama'
export const NOT_INSTALLED =
  'Ollama is not installed. Install it with: npm i -g ollama\nOr download from https://ollama.com/download'
const NOT_RUNNING = 'Ollama is not running. Start it with: ollama serve'

export function isAvailable(): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(cmd, ['ollama'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HARMONY_RE = /<\|?\/?(?:channel|message|start|end|return|constrain|assistant|user|system|developer|tool|tool_call|tool_response|final|analysis|commentary)\|?>/gi
const CHANNEL_LABEL_RE = /^(?:analysis|commentary|final)\s*(?=\w)/i

function stripHarmony<T extends string | undefined>(s: T): T {
  if (s == null) return s
  let out = (s as string).replace(HARMONY_RE, '')
  out = out.replace(CHANNEL_LABEL_RE, '')
  return out as T
}

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('connect')
}

export async function listModels(): Promise<string[]> {
  try {
    const { models } = await ollama.list()
    return models.map((m) => m.name)
  } catch (err) {
    if (isConnectionError(err)) {
      throw new Error(NOT_RUNNING)
    }
    throw err
  }
}

export async function modelContext(model: string): Promise<number> {
  try {
    const info = await ollama.show({ model })
    const modelInfo = info.model_info as unknown as Record<string, unknown> | undefined
    if (modelInfo) {
      const ctxKey = Object.keys(modelInfo).find((k) => k.includes('context_length'))
      if (ctxKey) {
        const val = Number(modelInfo[ctxKey])
        if (!isNaN(val) && val > 0) return val
      }
    }
    return 2048
  } catch (err) {
    if (isConnectionError(err)) {
      throw new Error(NOT_RUNNING)
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('unknown model')) {
      throw new Error(`Model "${model}" not found. Run: ollama pull ${model}`)
    }
    throw err
  }
}

export async function* chat(
  model: string,
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  opts?: ChatOptions,
): AsyncGenerator<ChatChunk> {
  if (opts?.signal?.aborted) return
  const signal = opts?.signal
  const client = signal
    ? new Ollama({
        host: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal })) as typeof fetch,
      })
    : ollama
  let stream: AsyncIterable<ChatResponse>
  const onAbort = () => { try { client.abort() } catch {} }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const numPredict = opts?.num_predict
    const options: Record<string, number> = {
      temperature: opts?.temperature ?? 0.2,
      num_ctx: opts?.num_ctx ?? 8192,
    }
    if (numPredict !== undefined && numPredict > 0) options.num_predict = numPredict
    stream = await client.chat({
      model,
      messages: messages as Message[],
      tools: tools as Tool[] | undefined,
      stream: true,
      think: true,
      keep_alive: opts?.keep_alive ?? '10m',
      options,
    } as unknown as Parameters<typeof ollama.chat>[0]) as unknown as AsyncIterable<ChatResponse>
  } catch (err) {
    if (signal?.aborted) return
    if (isConnectionError(err)) {
      throw new Error(NOT_RUNNING)
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('unknown model')) {
      throw new Error(`Model "${model}" not found. Run: ollama pull ${model}`)
    }
    throw err
  }
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) break
      yield {
        content: stripHarmony(chunk.message.content),
        thinking: stripHarmony((chunk.message as { thinking?: string }).thinking),
        done: chunk.done,
        tool_calls: chunk.message.tool_calls as ChatChunk['tool_calls'],
        prompt_eval_count: chunk.prompt_eval_count,
        eval_count: chunk.eval_count,
      }
      if (opts?.signal?.aborted) break
    }
  } catch (err) {
    if (opts?.signal?.aborted) return
    if (isConnectionError(err)) {
      throw new Error(NOT_RUNNING)
    }
    throw err
  } finally {
    if (opts?.signal) opts.signal.removeEventListener('abort', onAbort)
  }
}
