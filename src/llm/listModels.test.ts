import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import * as openai from './openai.js'
import * as anthropic from './anthropic.js'
import { ModelsUnsupportedError } from './types.js'
import type { ProviderEntry } from '../config.js'

// Not every backend serves a model list. A 404/405/501 there means "type the
// name", not "provider down" — the adapters have to tell the two apart.
let status = 404
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'nope' } }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(() => server.close())

describe('listModels on a provider without /models', () => {
  for (const s of [404, 405, 501]) {
    it(`openai: HTTP ${s} is unsupported, not an error`, async () => {
      status = s
      await expect(openai.listModels({ type: 'openai', baseUrl: base } as ProviderEntry))
        .rejects.toBeInstanceOf(ModelsUnsupportedError)
    })
  }

  it('openai: other failures still surface as errors', async () => {
    status = 500
    const err = await openai.listModels({ type: 'openai', baseUrl: base } as ProviderEntry).catch((e) => e)
    expect(err).not.toBeInstanceOf(ModelsUnsupportedError)
    expect(String(err)).toContain('HTTP 500')
  })

  it('anthropic: 404 is unsupported', async () => {
    status = 404
    const entry = { type: 'anthropic', baseUrl: base, apiKey: 'sk-test' } as ProviderEntry
    await expect(anthropic.listModels(entry)).rejects.toBeInstanceOf(ModelsUnsupportedError)
  })
})
