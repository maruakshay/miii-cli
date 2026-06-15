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
