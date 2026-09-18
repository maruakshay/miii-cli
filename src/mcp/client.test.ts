import { describe, it, expect } from 'vitest'
import { connectServer } from './client.js'
import { mcpToolName, isMcpTool } from './registry.js'

/**
 * A minimal MCP server as a one-liner, so the transport is tested against a real
 * child process speaking real newline-delimited JSON-RPC rather than a mock that
 * agrees with whatever the client happens to do.
 */
const SERVER = `
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    let result
    if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {} }
    else if (msg.method === 'tools/list') result = { tools: [
      { name: 'echo', description: 'Echoes back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'boom', description: 'Always fails' },
    ] }
    else if (msg.method === 'tools/call') {
      result = msg.params.name === 'boom'
        ? { content: [{ type: 'text', text: 'it broke' }], isError: true }
        : { content: [{ type: 'text', text: 'you said: ' + msg.params.arguments.text }] }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  }
})
`

describe('tool naming', () => {
  it('namespaces a server tool', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
  })
  it('replaces characters that are not identifier-safe', () => {
    expect(mcpToolName('my server', 'do.thing')).toBe('mcp__my_server__do_thing')
  })
  it('recognises its own names', () => {
    expect(isMcpTool('mcp__github__create_issue')).toBe(true)
    expect(isMcpTool('read_file')).toBe(false)
  })
})

describe('stdio transport', () => {
  it('handshakes and lists the server tools', async () => {
    const conn = await connectServer('fixture', { command: process.execPath, args: ['-e', SERVER] })
    try {
      expect(conn.tools.map((t) => t.name)).toEqual(['echo', 'boom'])
      expect(conn.tools[0].inputSchema?.required).toEqual(['text'])
    } finally {
      conn.close()
    }
  })

  it('calls a tool and flattens its text blocks', async () => {
    const conn = await connectServer('fixture', { command: process.execPath, args: ['-e', SERVER] })
    try {
      const result = await conn.call('echo', { text: 'hello' })
      expect(result.text).toBe('you said: hello')
      expect(result.isError).toBe(false)
    } finally {
      conn.close()
    }
  })

  it('surfaces a tool-level error rather than throwing', async () => {
    const conn = await connectServer('fixture', { command: process.execPath, args: ['-e', SERVER] })
    try {
      const result = await conn.call('boom', {})
      expect(result.isError).toBe(true)
      expect(result.text).toBe('it broke')
    } finally {
      conn.close()
    }
  })

  it('fails loudly when the server cannot start', async () => {
    await expect(
      connectServer('missing', { command: 'definitely-not-a-real-binary-xyz' }),
    ).rejects.toThrow()
  })

  it('fails when the process exits without speaking the protocol', async () => {
    await expect(
      connectServer('quitter', { command: process.execPath, args: ['-e', 'process.exit(1)'] }),
    ).rejects.toThrow(/quitter/)
  })
})
