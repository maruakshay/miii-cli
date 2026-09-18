/**
 * Minimal MCP client — stdio and streamable-HTTP transports.
 *
 * MCP is how a coding agent reaches everything that is not a file: an issue
 * tracker, a database, a design tool, an internal service. The alternative is a
 * pull request against this repo for every integration anyone wants, which does
 * not scale and should not have to.
 *
 * Deliberately small. miii needs three things from the protocol — handshake,
 * list the tools, call one — and implementing those directly is a few hundred
 * lines with no dependency, versus pulling the SDK and its transitive tree into
 * a CLI whose whole pitch is that it installs in one command. Prompts,
 * resources, sampling and server-initiated requests are not implemented; a
 * server that offers them still works, miii just ignores those capabilities.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { McpServer } from '../settings.js'

/** Protocol revision we speak. Servers negotiate down if they must. */
const PROTOCOL_VERSION = '2024-11-05'

/** Per-request ceiling. A server that hangs must not hang the turn with it. */
const REQUEST_TIMEOUT_MS = 60_000

/** Handshake + tools/list budget. Kept short: this runs on the launch path. */
export const CONNECT_TIMEOUT_MS = 15_000

export interface McpToolSpec {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export interface McpCallResult {
  /** Flattened text of every text block the server returned. */
  text: string
  /** Base64 image blocks, for a vision model. */
  images: string[]
  isError: boolean
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface Transport {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
  notify(method: string, params?: unknown): Promise<void>
  close(): void
}

class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
  }
}

/**
 * Newline-delimited JSON-RPC over a child process's stdio — the transport
 * almost every MCP server ships with, because it needs no ports and no auth.
 */
class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private buffer = ''
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false
  /** Last few stderr lines, so a server that dies has something to say about it. */
  private stderrTail: string[] = []

  constructor(name: string, command: string, args: string[], env: Record<string, string>, cwd?: string) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.setEncoding('utf-8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.setEncoding('utf-8')
    this.child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        this.stderrTail.push(line.trim())
        if (this.stderrTail.length > 5) this.stderrTail.shift()
      }
    })
    const die = (why: string) => {
      this.closed = true
      const detail = this.stderrTail.length ? ` — ${this.stderrTail.join(' / ')}` : ''
      for (const { reject } of this.pending.values()) reject(new RpcError(`MCP server "${name}" ${why}${detail}`))
      this.pending.clear()
    }
    this.child.on('error', (err) => die(`could not start (${err.message})`))
    this.child.on('exit', (code) => die(`exited (code ${code ?? 'signal'})`))
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    // Messages are newline-delimited, but a chunk boundary can land mid-message
    // — keep the tail until its newline arrives.
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: JsonRpcResponse
      try {
        msg = JSON.parse(line) as JsonRpcResponse
      } catch {
        // Servers that log to stdout are common enough that this is a warning
        // condition, not a fatal one. Skip the line and keep reading.
        continue
      }
      if (msg.id === undefined) continue // a notification from the server; nothing to route
      const waiter = this.pending.get(msg.id)
      if (!waiter) continue
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new RpcError(msg.error.message, msg.error.code))
      else waiter.resolve(msg.result)
    }
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError('MCP server is not running'))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n'
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(`MCP request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.child.stdin.write(payload, (err) => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new RpcError(err.message))
      })
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n')
  }

  close(): void {
    this.closed = true
    try { this.child.stdin.end() } catch { /* already gone */ }
    try { this.child.kill() } catch { /* already gone */ }
  }
}

/**
 * Streamable HTTP. One POST per request; the reply is either a JSON body or an
 * SSE stream carrying it. Both shapes are in the wild — the same server can
 * pick either per request — so both are parsed rather than negotiated.
 */
class HttpTransport implements Transport {
  private nextId = 1
  private sessionId: string | null = null

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  private async post(body: unknown, timeoutMs: number): Promise<Response> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Pull the JSON-RPC response for `id` out of an SSE body. Servers interleave
   * progress notifications (no id) with the actual answer, so we read frames
   * until the one we asked for turns up rather than taking the first.
   */
  private static async readSse(res: Response, id: number): Promise<JsonRpcResponse | null> {
    const text = await res.text()
    for (const block of text.split(/\n\n+/)) {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      if (!data) continue
      try {
        const msg = JSON.parse(data) as JsonRpcResponse
        if (msg.id === id) return msg
      } catch { /* not a JSON-RPC frame — skip it */ }
    }
    return null
  }

  async request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++
    let res: Response
    try {
      res = await this.post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, timeoutMs)
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError'
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : err instanceof Error ? err.message : String(err)
      throw new RpcError(`MCP server "${this.name}" unreachable — ${msg}`)
    }
    // The session id is minted on initialize and echoed on every later call.
    const session = res.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    if (!res.ok) {
      throw new RpcError(`MCP server "${this.name}" returned HTTP ${res.status} for ${method}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    const msg = contentType.includes('text/event-stream')
      ? await HttpTransport.readSse(res, id)
      : ((await res.json()) as JsonRpcResponse)
    if (!msg) throw new RpcError(`MCP server "${this.name}" sent no response to ${method}`)
    if (msg.error) throw new RpcError(msg.error.message, msg.error.code)
    return msg.result
  }

  async notify(method: string, params?: unknown): Promise<void> {
    // A notification has no id and nothing to wait for; a server that rejects
    // it outright still leaves the session usable, so failures are swallowed.
    try {
      await this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, 5_000)
    } catch { /* best-effort */ }
  }

  close(): void { /* stateless — nothing to tear down */ }
}

/** A connected server: its tool list, and the way to call one. */
export class McpConnection {
  constructor(
    readonly name: string,
    readonly tools: McpToolSpec[],
    private readonly transport: Transport,
    readonly readOnly: boolean,
  ) {}

  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    if (signal?.aborted) throw new Error('cancelled')
    const result = (await this.transport.request('tools/call', { name: tool, arguments: args })) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
      isError?: boolean
    }
    const texts: string[] = []
    const images: string[] = []
    for (const block of result?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'image' && typeof block.data === 'string') images.push(block.data)
      else if (block.type === 'resource') texts.push(JSON.stringify(block))
    }
    return {
      text: texts.join('\n'),
      images,
      isError: result?.isError === true,
    }
  }

  close(): void {
    this.transport.close()
  }
}

/** Expand `${VAR}` in a settings string from the environment. */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '')
}

/**
 * Handshake with one configured server and read its tool list.
 *
 * Throws on failure rather than returning a half-built connection: a server
 * that cannot be reached must not contribute a tool the model will then call
 * into the void. The caller reports which server failed and carries on without
 * it — one broken MCP entry should never stop miii from starting.
 */
export async function connectServer(name: string, spec: McpServer): Promise<McpConnection> {
  let transport: Transport
  if ('url' in spec) {
    const headers = Object.fromEntries(
      Object.entries(spec.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]),
    )
    transport = new HttpTransport(name, expandEnv(spec.url), headers)
  } else {
    const env = Object.fromEntries(
      Object.entries(spec.env ?? {}).map(([k, v]) => [k, expandEnv(v)]),
    )
    transport = new StdioTransport(
      name,
      expandEnv(spec.command),
      (spec.args ?? []).map(expandEnv),
      env,
      spec.cwd,
    )
  }

  try {
    await transport.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'miii', version: '1' },
      },
      CONNECT_TIMEOUT_MS,
    )
    await transport.notify('notifications/initialized')
    const listed = (await transport.request('tools/list', {}, CONNECT_TIMEOUT_MS)) as {
      tools?: McpToolSpec[]
    }
    const tools = (listed?.tools ?? []).filter((t) => t && typeof t.name === 'string')
    return new McpConnection(name, tools, transport, spec.readOnly === true)
  } catch (err) {
    transport.close()
    throw err instanceof Error ? err : new Error(String(err))
  }
}
