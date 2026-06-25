import { Ollama, type Message, type ChatResponse } from 'ollama'
import { execFileSync } from 'child_process'
import type { ProviderEntry } from '../config.js'
import type { OllamaMessage, OllamaTool, ChatChunk, ChatOptions } from './types.js'

export const PROVIDER_NAME = 'ollama'
export const NOT_INSTALLED =
  'Ollama is not installed. Install it with: npm i -g ollama\nOr download from https://ollama.com/download'
const NOT_RUNNING = 'Ollama is not running. Start it with: ollama serve'

function makeClient(entry: ProviderEntry, signal?: AbortSignal): Ollama {
  const opts: ConstructorParameters<typeof Ollama>[0] = { host: entry.baseUrl }
  if (entry.apiKey) opts.headers = { Authorization: `Bearer ${entry.apiKey}` }
  if (signal) {
    opts.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal })) as typeof fetch
  }
  return new Ollama(opts)
}

const LOCAL_HOST_RE = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/

export function isAvailable(entry: ProviderEntry): boolean {
  // Remote Ollama host — no local binary required; reachability is verified by
  // the actual request (surfaced as NOT_RUNNING). Only the local default needs
  // the CLI installed.
  if (!LOCAL_HOST_RE.test(entry.baseUrl)) return true
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

export async function listModels(entry: ProviderEntry): Promise<string[]> {
  try {
    const { models } = await makeClient(entry).list()
    return models.map((m) => m.name)
  } catch (err) {
    if (isConnectionError(err)) {
      throw new Error(NOT_RUNNING)
    }
    throw err
  }
}

export async function modelContext(entry: ProviderEntry, model: string): Promise<number> {
  try {
    const info = await makeClient(entry).show({ model })
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

/**
 * Parameter count in billions, or null if unknown. Used to auto-gate constrained
 * decoding: small models mangle tool JSON and benefit from a grammar; large ones
 * already emit clean tool_calls and lose nothing by skipping it. Reads `show`
 * metadata (parameter_size string, then general.parameter_count) — metadata only,
 * no generation, so it is cheap.
 */
export async function paramCountB(entry: ProviderEntry, model: string): Promise<number | null> {
  try {
    const info = await makeClient(entry).show({ model })
    const details = info.details as { parameter_size?: string } | undefined
    if (details?.parameter_size) {
      const m = details.parameter_size.match(/([\d.]+)\s*([BM])/i)
      if (m) {
        const n = parseFloat(m[1])
        if (!isNaN(n)) return m[2].toUpperCase() === 'M' ? n / 1000 : n
      }
    }
    const modelInfo = info.model_info as unknown as Record<string, unknown> | undefined
    if (modelInfo) {
      const key = Object.keys(modelInfo).find((k) => k.endsWith('parameter_count'))
      if (key) {
        const val = Number(modelInfo[key])
        if (!isNaN(val) && val > 0) return val / 1e9
      }
    }
    return null
  } catch {
    return null
  }
}

export async function* chat(
  entry: ProviderEntry,
  model: string,
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  opts?: ChatOptions,
): AsyncGenerator<ChatChunk> {
  if (opts?.signal?.aborted) return
  const signal = opts?.signal
  const client = makeClient(entry, signal)
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
    // Constrained decoding and native tool-calling are mutually exclusive: when a
    // grammar is supplied the action comes back as JSON in message.content, so we
    // drop the tools array to avoid the model's tool-call template fighting it.
    const req: Record<string, unknown> = {
      model,
      messages: messages as Message[],
      stream: true,
      think: true,
      keep_alive: opts?.keep_alive ?? '10m',
      options,
    }
    if (opts?.format) req.format = opts.format
    else if (tools) req.tools = tools
    try {
      stream = (await client.chat(
        req as unknown as Parameters<typeof client.chat>[0],
      )) as unknown as AsyncIterable<ChatResponse>
    } catch (err) {
      // Not every model supports the `think` flag; Ollama rejects it with
      // "does not support thinking". Retry once without it so the turn still runs.
      const msg = err instanceof Error ? err.message : String(err)
      if (!signal?.aborted && msg.toLowerCase().includes('does not support thinking')) {
        delete req.think
        stream = (await client.chat(
          req as unknown as Parameters<typeof client.chat>[0],
        )) as unknown as AsyncIterable<ChatResponse>
      } else {
        throw err
      }
    }
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
        done_reason: (chunk as { done_reason?: string }).done_reason,
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
    // Cloud Ollama endpoints sometimes close the stream after emitting all
    // content but without a final `done:true` chunk. The ollama SDK treats that
    // as fatal (AbortableAsyncIterator throws this exact message). We already
    // have the content, so treat it as a clean end-of-turn: synthesize a done
    // chunk (token counts unknown → 0) instead of surfacing a red error.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Did not receive done or success response in stream')) {
      yield { content: '', done: true, prompt_eval_count: 0, eval_count: 0 }
      return
    }
    throw err
  } finally {
    if (opts?.signal) opts.signal.removeEventListener('abort', onAbort)
  }
}
