import type { OllamaMessage } from '../llm/types.js'
import type { MiiMessage, ContentBlock, ToolUse, ToolResultBlock } from './types.js'

export function mintToolUseId(): string {
  const rand = Math.random().toString(36).slice(2, 14)
  return `toolu_${rand}`
}

/**
 * Translate Anthropic-shaped history into Ollama messages.
 * Ordering rule: each tool_result block becomes its own `role:'tool'` message,
 * emitted immediately after the assistant message that produced the tool_use,
 * preserving the same order as the tool_use blocks. No interleaving.
 */
export function toOllamaMessages(history: MiiMessage[], system: string): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: system }]

  for (const msg of history) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role === 'system' ? 'system' : msg.role, content: msg.content })
      continue
    }

    if (msg.role === 'assistant') {
      const text = msg.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text).join('')
      const tool_uses = msg.content.filter((b): b is ToolUse => b.type === 'tool_use')
      const ollamaMsg: OllamaMessage = { role: 'assistant', content: text }
      if (tool_uses.length > 0) {
        ollamaMsg.tool_calls = tool_uses.map((u) => ({
          id: u.id,
          function: { name: u.name, arguments: u.input },
        }))
      }
      out.push(ollamaMsg)
      continue
    }

    if (msg.role === 'user') {
      const tool_results = msg.content.filter((b): b is ToolResultBlock => b.type === 'tool_result')
      const texts = msg.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      for (const tr of tool_results) {
        out.push({ role: 'tool', content: tr.content, tool_call_id: tr.tool_use_id })
      }
      if (texts.length > 0) {
        out.push({ role: 'user', content: texts.map((t) => t.text).join('') })
      }
    }
  }

  return out
}

type RawToolCall = { function: { name: string; arguments: Record<string, unknown> } }

/**
 * Some local Ollama models (small qwen/llama variants) do not emit structured
 * tool_calls; instead they print a JSON object as plain text. Extract those
 * here so the agent loop can still drive the tool. Recognised shapes:
 *   {"name": "X", "arguments": {...}}
 *   {"name": "X", "parameters": {...}}
 *   <tool_call>{...}</tool_call>      (qwen)
 *   ```json {...} ```                  (fenced)
 */
export function parseTextToolCalls(
  text: string,
  knownToolNames: string[],
): { calls: RawToolCall[]; cleanedText: string } {
  if (!text) return { calls: [], cleanedText: text }
  const calls: RawToolCall[] = []
  let cleaned = text

  const tagRe = /<\|?tool_call\|?>\s*([\s\S]*?)\s*<\|?\/?tool_call\|?>/g
  cleaned = cleaned.replace(tagRe, (_m, body: string) => {
    const c = tryParse(body, knownToolNames)
    if (c) calls.push(c)
    return ''
  })

  const fenceRe = /```(?:json|tool_call)?\s*([\s\S]*?)```/g
  cleaned = cleaned.replace(fenceRe, (_m, body: string) => {
    const c = tryParse(body, knownToolNames)
    if (c) { calls.push(c); return '' }
    return _m
  })

  if (calls.length === 0) {
    const candidate = extractFirstJsonObject(cleaned)
    if (candidate) {
      const c = tryParse(candidate.json, knownToolNames)
      if (c) {
        calls.push(c)
        cleaned = (cleaned.slice(0, candidate.start) + cleaned.slice(candidate.end)).trim()
      }
    }
  }

  return { calls, cleanedText: cleaned.trim() }
}

function tryParse(raw: string, knownToolNames: string[]): RawToolCall | null {
  const s = raw.trim()
  if (!s.startsWith('{')) return null
  try {
    const obj = JSON.parse(s) as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : undefined
    const args = (obj.arguments ?? obj.parameters ?? obj.input ?? {}) as Record<string, unknown>
    if (!name || !knownToolNames.includes(name)) return null
    return { function: { name, arguments: args } }
  } catch {
    return null
  }
}

function extractFirstJsonObject(s: string): { json: string; start: number; end: number } | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { json: s.slice(start, i + 1), start, end: i + 1 }
    }
  }
  return null
}

export type GrammarAction =
  | { kind: 'respond'; message: string }
  | { kind: 'tool'; name: string; arguments: Record<string, unknown> }

/**
 * Parse a grammar-constrained action object from assistant content. The decoder
 * guarantees one well-formed JSON object of the shape
 *   { "name": "<tool|respond>", "arguments": { ... } }
 * but we stay defensive: tolerate leading/trailing slop and unknown names.
 */
export function parseGrammarAction(
  content: string,
  knownToolNames: string[],
): GrammarAction | null {
  if (!content) return null
  let raw = content.trim()
  if (!raw.startsWith('{')) {
    const found = extractFirstJsonObject(raw)
    if (!found) return null
    raw = found.json
  }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    const found = extractFirstJsonObject(raw)
    if (!found) return null
    try {
      obj = JSON.parse(found.json) as Record<string, unknown>
    } catch {
      return null
    }
  }
  const name = typeof obj.name === 'string' ? obj.name : undefined
  const args = (obj.arguments ?? {}) as Record<string, unknown>
  if (!name) return null
  if (name === 'respond') {
    const message = typeof args.message === 'string' ? args.message : ''
    return { kind: 'respond', message }
  }
  if (!knownToolNames.includes(name)) return null
  return { kind: 'tool', name, arguments: args }
}

/**
 * Incrementally decode the `message` of a `respond` action from a partial
 * content buffer, so the final answer can stream live instead of appearing all
 * at once when the JSON closes. Returns null until the buffer reveals this is a
 * `respond` action and the message string has begun; otherwise the decoded text
 * so far plus whether the closing quote has been seen.
 *
 * Pure and idempotent: the loop re-runs it on the growing buffer each chunk and
 * emits only the newly-decoded tail. It stops before any incomplete trailing
 * escape (e.g. a `\` or half-written `\uXXXX`) so a partial token never produces
 * a wrong character.
 */
export function streamRespondMessage(text: string): { message: string; complete: boolean } | null {
  if (!/"name"\s*:\s*"respond"/.test(text)) return null
  const m = text.match(/"message"\s*:\s*"/)
  if (!m || m.index == null) return null
  const start = m.index + m[0].length
  const escapes: Record<string, string> = {
    n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/',
  }
  let out = ''
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') return { message: out, complete: true }
    if (ch === '\\') {
      const nx = text[i + 1]
      if (nx === undefined) break // incomplete escape — wait for more
      if (nx === 'u') {
        const hex = text.slice(i + 2, i + 6)
        if (hex.length < 4) break // incomplete \uXXXX — wait
        out += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      out += escapes[nx] ?? nx
      i += 2
      continue
    }
    out += ch
    i++
  }
  return { message: out, complete: false }
}

export function blocksFromOllama(
  text: string,
  tool_calls: RawToolCall[] | undefined,
  knownToolNames: string[] = [],
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  let finalText = text
  let finalCalls: RawToolCall[] = tool_calls ?? []

  if (finalCalls.length === 0 && knownToolNames.length > 0) {
    const parsed = parseTextToolCalls(text, knownToolNames)
    if (parsed.calls.length > 0) {
      finalCalls = parsed.calls
      finalText = parsed.cleanedText
    }
  }

  if (finalText) blocks.push({ type: 'text', text: finalText })
  for (const tc of finalCalls) {
    blocks.push({
      type: 'tool_use',
      id: mintToolUseId(),
      name: tc.function.name,
      input: tc.function.arguments ?? {},
    })
  }
  return blocks
}
