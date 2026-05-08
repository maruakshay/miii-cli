import type { ChatMessage } from '../types.js'

export interface ChatConfig {
  provider: 'ollama' | 'openai-compat'
  model: string
  baseUrl: string
  apiKey?: string
  messages: ChatMessage[]
  signal?: AbortSignal
  onDone: (fullText: string) => void | Promise<void>
  onError: (err: Error) => void
}

export async function chat(cfg: ChatConfig): Promise<void> {
  if (cfg.provider === 'openai-compat') return chatOpenAI(cfg)
  return chatOllama(cfg)
}

async function chatOllama(cfg: ChatConfig): Promise<void> {
  const { model, messages, baseUrl, signal, onDone, onError } = cfg
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal,
    })
    if (!res.ok) { onError(new Error(`Ollama ${res.status}: ${await res.text()}`)); return }
    const obj = await res.json()
    await onDone(obj?.message?.content ?? '')
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') onError(toError(err))
  }
}

async function chatOpenAI(cfg: ChatConfig): Promise<void> {
  const { model, messages, baseUrl, apiKey, signal, onDone, onError } = cfg
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? 'local'}` },
      body: JSON.stringify({ model, messages }),
      signal,
    })
    if (!res.ok) { onError(new Error(`LLM ${res.status}: ${await res.text()}`)); return }
    const obj = await res.json()
    await onDone(obj?.choices?.[0]?.message?.content ?? '')
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') onError(toError(err))
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}
