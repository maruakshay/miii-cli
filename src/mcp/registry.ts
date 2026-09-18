/**
 * MCP servers as miii tools.
 *
 * Every tool a connected server advertises becomes an ordinary entry in the
 * tool registry, named `mcp__<server>__<tool>`. That prefix is not decoration:
 * it namespaces two servers that both call something `search`, it tells the user
 * at the permission prompt where a call is about to go, and it is what a
 * permission rule like `mcp__github__*` matches on.
 *
 * Connection happens once at startup and the tool list is fixed for the session.
 * A server that fails to start is reported and skipped — one bad entry in
 * settings.json must not stop miii from opening.
 */
import { connectServer, type McpConnection, type McpToolSpec } from './client.js'
import { spillIfLarge } from '../tools/spill.js'
import { loadSettings, type McpServer } from '../settings.js'
import type { JsonSchema, PropSpec, Tool } from '../tools/types.js'

/** Prefix that marks a tool as coming from a server rather than from miii. */
export const MCP_PREFIX = 'mcp__'

export interface McpServerStatus {
  name: string
  /** 'stdio' or the URL's scheme — what /mcp shows. */
  transport: string
  connected: boolean
  toolCount: number
  readOnly: boolean
  error?: string
}

let connections: McpConnection[] = []
let tools: Tool[] = []
let status: McpServerStatus[] = []

/** Tool names are identifiers to most providers — keep them to a safe alphabet. */
function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${sanitize(server)}__${sanitize(tool)}`
}

/** Is this a tool a server provided? Used wherever miii's own tools are assumed. */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX)
}

/**
 * Coerce an MCP server's JSON Schema into the narrower shape miii's validator
 * and repair tables expect. Both are permissive about properties they don't
 * recognise, so this is mostly a cast — what matters is that `type` and
 * `required` survive, since those are what a malformed call is checked against.
 */
function toJsonSchema(schema: McpToolSpec['inputSchema']): JsonSchema {
  const properties = (schema?.properties ?? {}) as Record<string, PropSpec>
  return {
    type: 'object',
    properties,
    ...(Array.isArray(schema?.required) ? { required: schema.required } : {}),
  }
}

function toolFor(conn: McpConnection, spec: McpToolSpec): Tool {
  const name = mcpToolName(conn.name, spec.name)
  return {
    name,
    // The server's own description, tagged with where it came from. A model
    // choosing between two similar tools needs to know which system each talks
    // to, and the server author rarely says so in the description.
    description: `[${conn.name}] ${spec.description ?? spec.name}`,
    input_schema: toJsonSchema(spec.inputSchema),
    handler: async (input, ctx) => {
      try {
        const result = await conn.call(spec.name, input as Record<string, unknown>, ctx?.signal)
        return {
          content: spillIfLarge(result.text || '(no output)', `${conn.name} output`),
          ...(result.isError ? { is_error: true } : {}),
          ...(result.images.length ? { images: result.images } : {}),
        }
      } catch (err) {
        return {
          content: `${conn.name} could not run ${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        }
      }
    },
  }
}

function transportLabel(spec: McpServer): string {
  if ('url' in spec) {
    try { return new URL(spec.url).protocol.replace(':', '') } catch { return 'http' }
  }
  return 'stdio'
}

/**
 * Connect every enabled server and register its tools.
 *
 * Servers are dialled in parallel — they are independent processes and a slow
 * one should not hold up the rest — but each is bounded by the client's connect
 * timeout, so the worst case on the launch path is that timeout, not its sum.
 */
export async function initMcp(cwd?: string): Promise<McpServerStatus[]> {
  await closeMcp()
  const servers = Object.entries(loadSettings(cwd).mcpServers ?? {}).filter(
    ([, spec]) => spec && spec.enabled !== false,
  )
  if (servers.length === 0) {
    status = []
    return status
  }

  const settled = await Promise.all(
    servers.map(async ([name, spec]): Promise<{ conn?: McpConnection; status: McpServerStatus }> => {
      const base = { name, transport: transportLabel(spec), readOnly: spec.readOnly === true }
      try {
        const conn = await connectServer(name, spec)
        return { conn, status: { ...base, connected: true, toolCount: conn.tools.length } }
      } catch (err) {
        return {
          status: {
            ...base,
            connected: false,
            toolCount: 0,
            error: err instanceof Error ? err.message : String(err),
          },
        }
      }
    }),
  )

  connections = settled.flatMap((s) => (s.conn ? [s.conn] : []))
  status = settled.map((s) => s.status)
  // A name collision can only happen if two servers sanitize to the same string;
  // first one registered wins, and the loser is dropped rather than shadowing.
  const seen = new Set<string>()
  tools = []
  for (const conn of connections) {
    for (const spec of conn.tools) {
      const tool = toolFor(conn, spec)
      if (seen.has(tool.name)) continue
      seen.add(tool.name)
      tools.push(tool)
    }
  }
  return status
}

/** Every registered MCP tool. Empty until initMcp() has run. */
export function mcpTools(): Tool[] {
  return tools
}

/** Tools from servers declared read-only — the only ones plan mode will offer. */
export function readOnlyMcpToolNames(): Set<string> {
  const names = new Set<string>()
  for (const conn of connections) {
    if (!conn.readOnly) continue
    for (const spec of conn.tools) names.add(mcpToolName(conn.name, spec.name))
  }
  return names
}

/** Per-server connection state, for `/mcp`. */
export function mcpStatus(): McpServerStatus[] {
  return status
}

export async function closeMcp(): Promise<void> {
  for (const conn of connections) {
    try { conn.close() } catch { /* already gone */ }
  }
  connections = []
  tools = []
}
