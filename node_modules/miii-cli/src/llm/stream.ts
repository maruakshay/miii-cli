import type { ChatMessage } from '../types.js'

export interface StreamConfig {
  provider: 'ollama' | 'openai-compat'
  model: string
  baseUrl: string
  messages: ChatMessage[]
  signal?: AbortSignal
  onToken: (token: string) => void
  onDone: (fullText: string) => void | Promise<void>
  onError: (err: Error) => void
}

export async function stream(cfg: StreamConfig): Promise<void> {
  if (cfg.provider === 'openai-compat') {
    return streamOpenAI(cfg)
  }
  return streamOllama(cfg)
}

async function streamOllama(cfg: StreamConfig): Promise<void> {
  const { model, messages, baseUrl, signal, onToken, onDone, onError } = cfg
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    })
  } catch (err) {
    onError(toError(err))
    return
  }
  if (!res.ok) {
    onError(new Error(`Ollama ${res.status}: ${await res.text()}`))
    return
  }
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let full = ''
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          const tok: string = obj?.message?.content ?? ''
          if (tok) { onToken(tok); full += tok }
          if (obj?.done) { await onDone(full); return }
        } catch {}
      }
    }
    await onDone(full)
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') onError(toError(err))
  } finally {
    reader.releaseLock()
  }
}

async function streamOpenAI(cfg: StreamConfig): Promise<void> {
  const { model, messages, baseUrl, signal, onToken, onDone, onError } = cfg
  let res: Response
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    })
  } catch (err) {
    onError(toError(err))
    return
  }
  if (!res.ok) {
    onError(new Error(`LLM ${res.status}: ${await res.text()}`))
    return
  }
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let full = ''
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.replace(/^data:\s*/, '').trim()
        if (!trimmed || trimmed === '[DONE]') continue
        try {
          const obj = JSON.parse(trimmed)
          const tok: string = obj?.choices?.[0]?.delta?.content ?? ''
          if (tok) { onToken(tok); full += tok }
          if (obj?.choices?.[0]?.finish_reason) { await onDone(full); return }
        } catch {}
      }
    }
    await onDone(full)
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') onError(toError(err))
  } finally {
    reader.releaseLock()
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}
