import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { request } from 'http'
import { isLoopbackHost, startWeb, type RunningWeb } from './server.js'

/** fetch() won't let a test forge the Host header, so this goes through node:http. */
function call(web: RunningWeb, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: web.port, path, method, headers: { host: `localhost:${web.port}`, ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('isLoopbackHost', () => {
  it('accepts loopback in every spelling a browser sends', () => {
    for (const h of ['localhost:4747', '127.0.0.1:4747', '[::1]:4747', 'localhost']) expect(isLoopbackHost(h)).toBe(true)
  })
  it('refuses anything else, including a rebinding domain', () => {
    for (const h of ['evil.com', 'localhost.evil.com:4747', '192.168.1.5:4747', '', undefined]) expect(isLoopbackHost(h)).toBe(false)
  })
})

describe('miii web server', () => {
  let web: RunningWeb
  beforeAll(async () => {
    web = await startWeb({ port: 0, cwd: mkdtempSync(join(tmpdir(), 'miii-web-')), token: 'test-token' })
  })
  afterAll(async () => { await web.close() })

  it('binds to loopback and prints a link carrying the token in the fragment', () => {
    expect(web.server.address()).toMatchObject({ address: '127.0.0.1' })
    expect(web.url).toMatch(/^http:\/\/localhost:\d+\/#token=test-token$/)
  })

  it('refuses API calls without the token', async () => {
    expect((await call(web, '/api/state')).status).toBe(401)
    expect((await call(web, '/api/state', { 'x-miii-token': 'nope' })).status).toBe(401)
    expect((await call(web, '/api/send', { 'content-type': 'application/json' }, 'POST', '{"text":"rm -rf"}')).status).toBe(401)
  })

  it('refuses a request whose Host is not loopback', async () => {
    const res = await call(web, '/api/state', { host: 'evil.com', 'x-miii-token': 'test-token' })
    expect(res.status).toBe(403)
  })

  it('answers with the session state when the token is right', async () => {
    const res = await call(web, '/api/state', { 'x-miii-token': 'test-token' })
    expect(res.status).toBe(200)
    const hello = JSON.parse(res.body)
    expect(hello.state).toMatchObject({ busy: false, pending: null })
    expect(hello.modes.map((m: { mode: string }) => m.mode)).toEqual(['default', 'plan', 'acceptEdits', 'bypass'])
    expect(hello.commands.some((c: { name: string }) => c.name === '/plan')).toBe(true)
  })

  it('validates what it is sent', async () => {
    const auth = { 'x-miii-token': 'test-token', 'content-type': 'application/json' }
    expect((await call(web, '/api/mode', auth, 'POST', '{"mode":"yolo"}')).status).toBe(400)
    expect((await call(web, '/api/permission', auth, 'POST', '{"id":1,"answer":"maybe"}')).status).toBe(400)
    expect((await call(web, '/api/mode', auth, 'POST', 'not json')).status).toBe(400)
    expect((await call(web, '/api/mode', auth, 'POST', '{"mode":"plan"}')).status).toBe(200)
  })

  it('survives a malformed URL that any page could send it', async () => {
    // No token needed for static paths, so this is reachable from any website.
    const bad = await call(web, '/%E0')
    expect(bad.status).toBeLessThan(500)
    expect((await call(web, '/api/state', { 'x-miii-token': 'test-token' })).status).toBe(200)
  })

  it('never serves files from outside the app build', async () => {
    const res = await call(web, '/..%2f..%2fpackage.json')
    expect(res.body).not.toContain('"miii-agent"')
  })
})
