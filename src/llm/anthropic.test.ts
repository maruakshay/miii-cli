import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { chat, listModels } from './anthropic.js'
import type { ProviderEntry } from '../config.js'
import type { ChatChunk, OllamaMessage } from './types.js'

// Requests the mock server saw, so each test can assert on the wire body the
// adapter actually built rather than on an in-memory intermediate.
let lastBody: any
let server: Server
let entry: ProviderEntry

function sse(events: unknown[]): string {
  return events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

// A complete Messages stream: some thinking, some text, one tool call.
const STREAM = sse([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading it now.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
])

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      lastBody = raw ? JSON.parse(raw) : undefined
      if (req.url?.includes('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }], has_more: false }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(STREAM)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  entry = { type: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test' }
})

afterAll(() => server.close())

async function collect(messages: OllamaMessage[], tools?: any): Promise<ChatChunk[]> {
  const out: ChatChunk[] = []
  for await (const c of chat(entry, 'claude-opus-5', messages, tools)) out.push(c)
  return out
}

describe('anthropic adapter', () => {
  it('lists models', async () => {
    expect(await listModels(entry)).toEqual(['claude-opus-5', 'claude-sonnet-5'])
  })

  it('streams thinking, text and an assembled tool call', async () => {
    const chunks = await collect([{ role: 'user', content: 'read a.ts' }])
    expect(chunks.filter((c) => c.thinking).map((c) => c.thinking)).toEqual(['weighing it'])
    expect(chunks.map((c) => c.content).join('')).toBe('Reading it now.')

    const done = chunks.at(-1)!
    expect(done.done).toBe(true)
    expect(done.tool_calls).toEqual([
      { id: 'toolu_9', function: { name: 'read_file', arguments: { path: 'a.ts' } } },
    ])
    expect(done.prompt_eval_count).toBe(11)
    expect(done.eval_count).toBe(42)
  })

  it('hoists system messages out of the history', async () => {
    await collect([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ])
    expect(lastBody.system).toBe('be brief')
    expect(lastBody.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('folds consecutive tool results into one user message', async () => {
    await collect([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', function: { name: 'grep', arguments: { q: 'x' } } },
          { id: 'b', function: { name: 'glob', arguments: { p: '*' } } },
        ],
      },
      { role: 'tool', content: 'hit', tool_call_id: 'a' },
      { role: 'tool', content: 'miss', tool_call_id: 'b' },
    ])
    // Parallel calls must come back as a single user turn, else the model
    // learns to stop batching them.
    const results = lastBody.messages.at(-1)
    expect(results.role).toBe('user')
    expect(results.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'hit' },
      { type: 'tool_result', tool_use_id: 'b', content: 'miss' },
    ])
    expect(lastBody.messages[1].content).toEqual([
      { type: 'tool_use', id: 'a', name: 'grep', input: { q: 'x' } },
      { type: 'tool_use', id: 'b', name: 'glob', input: { p: '*' } },
    ])
  })

  it('sends tools and adaptive thinking, and no sampling params', async () => {
    await collect([{ role: 'user', content: 'hi' }], [
      { type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } } },
    ])
    expect(lastBody.tools).toEqual([{ name: 'grep', description: 'search', input_schema: { type: 'object', properties: {} } }])
    expect(lastBody.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    // Current Claude models reject temperature alongside thinking.
    expect(lastBody.temperature).toBeUndefined()
    expect(lastBody.max_tokens).toBeGreaterThan(0)
  })

  it('attaches images as base64 blocks', async () => {
    await collect([{ role: 'user', content: 'what is this', images: ['/9j/abc'] }])
    expect(lastBody.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/abc' },
    })
  })

  it('reports a missing key without reaching the network', async () => {
    await expect(
      collect.call(null, [{ role: 'user', content: 'hi' }]),
    ).resolves.toBeTruthy()
    const keyless: ProviderEntry = { type: 'anthropic', baseUrl: entry.baseUrl }
    await expect(async () => {
      for await (const _ of chat(keyless, 'claude-opus-5', [{ role: 'user', content: 'hi' }])) void _
    }).rejects.toThrow(/No API key/)
  })
})
