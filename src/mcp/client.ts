import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import type { Tool } from '../tools/index.js'
import type { MCPServerConfig } from '../types.js'

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

interface MCPToolDef {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, { type?: string; description?: string }>
    required?: string[]
  }
}

function schemaToParams(def: MCPToolDef): string {
  const props = def.inputSchema?.properties ?? {}
  const required = new Set(def.inputSchema?.required ?? [])
  const entries = Object.entries(props).map(([k, v]) => {
    const t = v?.type ?? 'any'
    return `"${k}": "${t}${required.has(k) ? '' : ' (optional)'}"`
  })
  return '{' + entries.join(', ') + '}'
}

export class MCPClient {
  private proc: ChildProcess | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private nextId = 1
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  async connect(cfg: MCPServerConfig): Promise<void> {
    this.proc = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...cfg.env },
    })

    this.proc.stderr?.on('data', () => {})

    const rl = createInterface({ input: this.proc.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(msg.error.message))
            else p.resolve(msg.result)
          }
        }
      } catch {}
    })

    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })

    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'miii', version: '1.0.0' },
    })

    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    )
  }

  async listTools(): Promise<MCPToolDef[]> {
    const result = await this.send('tools/list') as { tools?: MCPToolDef[] }
    return result?.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.send('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>
    }
    return (result?.content ?? [])
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n')
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      let timer: ReturnType<typeof setTimeout>
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      if (!this.proc?.stdin?.writable) { this.pending.delete(id); reject(new Error('MCP process stdin not writable')); return }
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP timeout: ${method}`))
        }
      }, 10_000)
    })
  }

  close(): void {
    this.proc?.kill()
  }
}

export async function loadMCPTools(
  servers: Record<string, MCPServerConfig>,
): Promise<{ tools: Tool[]; clients: MCPClient[] }> {
  const clients: MCPClient[] = []
  const tools: Tool[] = []

  for (const [serverName, cfg] of Object.entries(servers)) {
    const client = new MCPClient(serverName)
    try {
      await client.connect(cfg)
      const defs = await client.listTools()
      clients.push(client)

      for (const def of defs) {
        const toolName = `mcp_${serverName}_${def.name}`.replace(/[^a-zA-Z0-9_]/g, '_')
        tools.push({
          name: toolName,
          description: `[MCP:${serverName}] ${def.description ?? def.name}`,
          params: schemaToParams(def),
          execute: async (args) => client.callTool(def.name, args),
        })
      }
    } catch (err) {
      process.stderr.write(`MCP server "${serverName}" failed to connect: ${err}\n`)
      client.close()
    }
  }

  return { tools, clients }
}
