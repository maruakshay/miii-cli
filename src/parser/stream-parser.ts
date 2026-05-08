import { appendFileSync } from 'fs'

export interface ParsedText { type: 'text'; content: string }
export interface ParsedTool { type: 'tool_call'; content: string; toolName: string; toolArgs: Record<string, unknown> }
export type ParsedItem = ParsedText | ParsedTool

const OPEN = '<tool_call>'
const CLOSE = '</tool_call>'
const CTAG_OPEN = '<content>'
const CTAG_CLOSE = '</content>'
const OLD_OPEN = '<old>'
const OLD_CLOSE = '</old>'
const NEW_OPEN = '<new>'
const NEW_CLOSE = '</new>'
const DEBUG_LOG = '/tmp/miii-debug.log'

function dbg(msg: string) {
  try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

// Fix literal newlines/tabs inside JSON string values — common LLM output mistake
function sanitizeJson(s: string): string {
  let result = ''
  let inString = false
  let escaped = false
  for (const ch of s) {
    if (escaped) {
      result += ch
      escaped = false
    } else if (ch === '\\' && inString) {
      result += ch
      escaped = true
    } else if (ch === '"') {
      result += ch
      inString = !inString
    } else if (inString && ch === '\n') {
      result += '\\n'
    } else if (inString && ch === '\r') {
      result += '\\r'
    } else if (inString && ch === '\t') {
      result += '\\t'
    } else {
      result += ch
    }
  }
  return result
}

function parseToolJson(s: string): { name: string; args?: Record<string, unknown> } {
  try { return JSON.parse(s) }
  catch { return JSON.parse(sanitizeJson(s)) }
}

// Find end of a JSON object starting at `from`, correctly tracking strings
function findJsonEnd(text: string, from: number): number {
  let depth = 0, inStr = false, escaped = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && inStr) { escaped = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

// For file-writing tools: content field may have unescaped chars — extract with lastIndexOf heuristic
function extractFileToolArgs(text: string, toolName: string): Record<string, unknown> | null {
  if (!text.includes(`"${toolName}"`)) return null
  const args: Record<string, string> = {}

  const pathM = text.match(/"path"\s*:\s*"([^"]*)"/)
  if (pathM) args.path = pathM[1]

  // content is always the last string field — find its opening quote, take to last " before final }}
  const ctIdx = text.indexOf('"content"')
  if (ctIdx !== -1) {
    const colon = text.indexOf(':', ctIdx)
    const openQ = text.indexOf('"', colon + 1)
    const lastBrace = text.lastIndexOf('}')
    const closeQ = text.lastIndexOf('"', lastBrace - 1)
    if (openQ !== -1 && closeQ > openQ) {
      const raw = text.slice(openQ + 1, closeQ)
      args.content = raw
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }

  // For patch_file: extract old/new fields
  const oldM = text.match(/"old"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*\})/)
  if (oldM) args.old = oldM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
  const newM = text.match(/"new"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*\})/)
  if (newM) args.new = newM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')

  return Object.keys(args).length > 0 ? args : null
}

// Extract a bare tool-call JSON from arbitrary text (LLM skipped <tool_call> wrapper)
export function extractBareToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  // First try standard JSON parsing
  let pos = 0
  while (true) {
    const start = text.indexOf('{"name"', pos)
    if (start === -1) break
    const end = findJsonEnd(text, start)
    if (end === -1) break
    try {
      const obj = parseToolJson(text.slice(start, end + 1))
      if (typeof obj.name === 'string') return { name: obj.name, args: (obj.args ?? {}) as Record<string, unknown> }
    } catch {}
    pos = start + 1
  }

  // Fallback: content-aware extraction for file-writing tools (immune to unescaped chars)
  for (const name of ['edit_file', 'create_file', 'patch_file']) {
    const args = extractFileToolArgs(text, name)
    if (args) return { name, args }
  }

  return null
}

export class StreamParser {
  private buf = ''
  private inTool = false

  feed(token: string): ParsedItem[] {
    this.buf += token
    const out: ParsedItem[] = []

    while (true) {
      if (this.inTool) {
        const end = this.buf.indexOf(CLOSE)
        if (end === -1) break
        const raw = this.buf.slice(0, end).trim()
        this.buf = this.buf.slice(end + CLOSE.length)
        this.inTool = false
        try {
          dbg(`raw block (${raw.length} chars): ${raw.slice(0, 300)}`)
          // Extract named content blocks so file content never needs JSON escaping
          const extraArgs: Record<string, string> = {}
          let jsonPart = raw

          function extractBlock(open: string, close: string, key: string): void {
            const s = raw.indexOf(open), e = raw.indexOf(close)
            if (s === -1 || e === -1 || e <= s) return
            let val = raw.slice(s + open.length, e)
            if (val.startsWith('\n')) val = val.slice(1)
            if (val.endsWith('\n')) val = val.slice(0, -1)
            extraArgs[key] = val
            // shrink jsonPart to before the first block
            const blockStart = raw.indexOf(open)
            if (blockStart < jsonPart.length) jsonPart = raw.slice(0, blockStart).trim()
          }

          extractBlock(CTAG_OPEN, CTAG_CLOSE, 'content')
          extractBlock(OLD_OPEN, OLD_CLOSE, 'old')
          extractBlock(NEW_OPEN, NEW_CLOSE, 'new')

          const obj = parseToolJson(jsonPart)
          obj.args = { ...(obj.args ?? {}), ...extraArgs }
          dbg(`parsed ok: name=${obj.name} args_keys=${Object.keys(obj.args).join(',')}`)
          out.push({ type: 'tool_call', content: raw, toolName: obj.name, toolArgs: obj.args })
        } catch (e) {
          dbg(`parse FAILED: ${e} | raw: ${raw.slice(0, 300)}`)
          out.push({ type: 'text', content: `${OPEN}${raw}${CLOSE}` })
        }
      } else {
        const start = this.buf.indexOf(OPEN)
        if (start === -1) {
          const safe = this.buf.length > OPEN.length ? this.buf.slice(0, -OPEN.length) : ''
          if (safe) { out.push({ type: 'text', content: safe }); this.buf = this.buf.slice(safe.length) }
          break
        }
        if (start > 0) {
          out.push({ type: 'text', content: this.buf.slice(0, start) })
          this.buf = this.buf.slice(start)
        }
        this.buf = this.buf.slice(OPEN.length)
        this.inTool = true
      }
    }
    return out
  }

  flush(): ParsedItem[] {
    const out: ParsedItem[] = []
    if (this.buf.trim()) out.push({ type: 'text', content: this.buf })
    this.buf = ''
    this.inTool = false
    return out
  }
}
