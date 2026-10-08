import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'http'
import { chat, usageOf } from './openai.js'
import type { ProviderEntry } from '../config.js'
import type { ChatChunk } from './types.js'

// Each OpenAI-compatible server reports token usage its own way, if at all.
// These pin down that the counts reach the done chunk for every shape.
type Handler = (body: Record<string, unknown>, res: ServerResponse) => void
let handler: Handler
let bodies: Record<string, unknown>[] = []
let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      bodies.push(body)
      handler(body, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as any).port
})
afterAll(() => server.close())

const sse = (res: ServerResponse, chunks: unknown[], end = true) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const c of chunks) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`)
  if (end) res.end()
}
const text = (s: string, finish: string | null = null) => ({ choices: [{ delta: { content: s }, finish_reason: finish }] })

async function run(baseUrl = `http://127.0.0.1:${port}`): Promise<ChatChunk> {
  bodies = []
  let last: ChatChunk | undefined
  for await (const c of chat({ type: 'openai', baseUrl } as ProviderEntry, 'm', [{ role: 'user', content: 'hi' }])) last = c
  return last!
}

describe('openai usage', () => {
  it('asks for usage and reads the trailing usage chunk after finish_reason', async () => {
    handler = (_b, res) => sse(res, [
      text('hi', 'stop'),
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      '[DONE]',
    ])
    const done = await run()
    expect(bodies[0].stream_options).toEqual({ include_usage: true })
    expect(done).toMatchObject({ done: true, prompt_eval_count: 12, eval_count: 3 })
  })

  it('reads usage sent alongside finish_reason', async () => {
    handler = (_b, res) => sse(res, [{ ...text('hi', 'stop'), usage: { prompt_tokens: 5, completion_tokens: 1 } }], false)
    // Stream left open: usage already in hand, so it must not wait for more.
    const done = await run()
    expect(done).toMatchObject({ prompt_eval_count: 5, eval_count: 1 })
  })

  it('reports zero, without hanging, when a server never sends usage or closes', async () => {
    handler = (_b, res) => sse(res, [text('hi', 'stop')], false)
    const t = Date.now()
    const done = await run()
    expect(done).toMatchObject({ prompt_eval_count: 0, eval_count: 0 })
    expect(Date.now() - t).toBeLessThan(3000)
  })

  it('drops stream_options for a server that rejects it', async () => {
    handler = (b, res) => {
      if (b.stream_options) {
        res.writeHead(400).end('{"error":"Unrecognized request argument: stream_options"}')
        return
      }
      sse(res, [text('ok', 'stop'), '[DONE]'])
    }
    const done = await run(`http://127.0.0.1:${port}/strict`)
    expect(done.done).toBe(true)
    expect(bodies.map((b) => !!b.stream_options)).toEqual([true, false])
    // Remembered: the next turn goes straight without it.
    await run(`http://127.0.0.1:${port}/strict`)
    expect(bodies.map((b) => !!b.stream_options)).toEqual([false])
  })
})

describe('usageOf', () => {
  it('reads Groq x_groq.usage and llama.cpp timings', () => {
    expect(usageOf({ x_groq: { usage: { prompt_tokens: 7, completion_tokens: 2 } } })).toEqual({ prompt: 7, eval: 2 })
    expect(usageOf({ timings: { prompt_n: 4, cache_n: 6, predicted_n: 9 } })).toEqual({ prompt: 10, eval: 9 })
    expect(usageOf({ usage: null })).toBeNull()
  })
})
