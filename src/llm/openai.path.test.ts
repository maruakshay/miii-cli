import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { listModels } from './openai.js'
import type { ProviderEntry } from '../config.js'

// Endpoint paths differ across OpenAI-compatible servers; this pins down where
// each provider shape actually sends its requests.
let lastUrl = ''
let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUrl = req.url ?? ''
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'm' }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as any).port
})
afterAll(() => server.close())

const base = () => `http://127.0.0.1:${port}`

describe('openai endpoint paths', () => {
  it('defaults to /v1', async () => {
    await listModels({ type: 'openai', baseUrl: base() } as ProviderEntry)
    expect(lastUrl).toBe('/v1/models')
  })

  it('honours an empty apiPath for a baseUrl already at the API root', async () => {
    await listModels({ type: 'openai', baseUrl: `${base()}/v1beta/openai`, apiPath: '' } as ProviderEntry)
    expect(lastUrl).toBe('/v1beta/openai/models')
  })

  it('tolerates a trailing slash', async () => {
    await listModels({ type: 'openai', baseUrl: `${base()}/` } as ProviderEntry)
    expect(lastUrl).toBe('/v1/models')
  })
})
