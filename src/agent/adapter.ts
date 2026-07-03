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
      const om: OllamaMessage = { role: msg.role === 'system' ? 'system' : msg.role, content: msg.content }
      if (msg.role === 'user' && msg.images && msg.images.length > 0) om.images = msg.images
      out.push(om)
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
        // Ollama only honours `images` on user messages, not tool messages — so a
        // tool that returned pixels (read_file on an image) gets a follow-up user
        // message carrying the base64 for the vision model to actually see.
        if (tr.images && tr.images.length > 0) {
          out.push({ role: 'user', content: 'Image content from the previous tool result:', images: tr.images })
        }
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
 *   call:X{key:<|"|>value<|"|>, ...}  (delimiter-wrapped, non-JSON)
 */
export function parseTextToolCalls(
  text: string,
  knownToolNames: string[],
): { calls: RawToolCall[]; cleanedText: string } {
  if (!text) return { calls: [], cleanedText: text }
  const calls: RawToolCall[] = []
  let cleaned = text

  // Custom `call:NAME{...}` syntax that some local models emit instead of JSON.
  // Handled first because its body is not valid JSON and would otherwise leak
  // into the rendered text verbatim.
  const callSyntax = parseCallSyntax(cleaned, knownToolNames)
  if (callSyntax.calls.length > 0) {
    calls.push(...callSyntax.calls)
    cleaned = callSyntax.cleanedText
  }

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

const VAL_DELIM = '<|"|>'

/**
 * Parse the `call:NAME{ key:<|"|>value<|"|>, ... }` syntax. Values are wrapped
 * in the VAL_DELIM sentinel so they may freely contain newlines, braces, quotes
 * and commas — the delimiter, not brace/comma balancing, marks the boundaries.
 * Bare (undelimited) values are tolerated as a fallback: they are read up to the
 * next top-level comma or closing brace and JSON-parsed when possible.
 */
function parseCallSyntax(
  text: string,
  knownToolNames: string[],
): { calls: RawToolCall[]; cleanedText: string } {
  const calls: RawToolCall[] = []
  const headRe = /call:\s*([a-zA-Z_]\w*)\s*\{/g
  let m: RegExpExecArray | null
  let cleaned = ''
  let lastEnd = 0

  while ((m = headRe.exec(text)) !== null) {
    const name = m[1]
    const body = parseCallBody(text, m.index + m[0].length)
    if (!body) continue
    // Skip past the whole body before the next exec, even for unknown tools, so
    // a `call:...{...}` embedded in an unknown call's value isn't rescanned and
    // mistaken for a real call.
    headRe.lastIndex = body.end
    if (!knownToolNames.includes(name)) continue
    calls.push({ function: { name, arguments: body.args } })
    cleaned += text.slice(lastEnd, m.index)
    lastEnd = body.end
  }
  cleaned += text.slice(lastEnd)
  return { calls, cleanedText: cleaned.trim() }
}

function parseCallBody(
  text: string,
  start: number,
): { args: Record<string, unknown>; end: number } | null {
  const args: Record<string, unknown> = {}
  let i = start
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

  while (i < text.length) {
    while (i < text.length && (isWs(text[i]) || text[i] === ',')) i++
    if (i >= text.length) return null
    if (text[i] === '}') return { args, end: i + 1 }

    // key
    const keyStart = i
    while (i < text.length && text[i] !== ':' && text[i] !== '}') i++
    if (i >= text.length || text[i] !== ':') return null
    const key = text.slice(keyStart, i).trim().replace(/^["']|["']$/g, '')
    i++ // skip ':'
    while (i < text.length && isWs(text[i])) i++

    // value
    if (text.startsWith(VAL_DELIM, i)) {
      const vStart = i + VAL_DELIM.length
      const vEnd = text.indexOf(VAL_DELIM, vStart)
      if (vEnd === -1) return null
      args[key] = text.slice(vStart, vEnd)
      i = vEnd + VAL_DELIM.length
    } else {
      const vStart = i
      let depth = 0
      let inStr: string | null = null
      let esc = false
      while (i < text.length) {
        const ch = text[i]
        if (inStr) {
          if (esc) esc = false
          else if (ch === '\\') esc = true
          else if (ch === inStr) inStr = null
        } else if (ch === '"' || ch === "'") inStr = ch
        else if (ch === '{' || ch === '[') depth++
        else if (ch === '}' || ch === ']') {
          if (depth === 0) break
          depth--
        } else if (ch === ',' && depth === 0) break
        i++
      }
      const rawVal = text.slice(vStart, i).trim()
      try {
        args[key] = JSON.parse(rawVal)
      } catch {
        args[key] = rawVal.replace(/^["']|["']$/g, '')
      }
    }
  }
  return null // never hit closing brace
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

/**
 * Heuristic: does this leftover text look like a tool call the model tried to
 * emit as prose but that we failed to parse into a structured call? Used by the
 * agent loop to nudge the model to re-emit via the native interface instead of
 * silently ending the turn with the raw syntax leaked to the user.
 *
 * Conservative on purpose — only fires on strong markers, never on a tool name
 * merely mentioned in prose, so it cannot block a legitimate final answer.
 */
export function looksLikeLeakedToolCall(text: string, knownToolNames: string[]): boolean {
  if (!text) return false
  if (text.includes(VAL_DELIM)) return true
  if (/<\|?tool_call/i.test(text)) return true
  // `call:NAME{` — but only when NAME is an actual tool, so prose like
  // "I'll call: someone {" can't trip the nudge.
  const callMatch = text.match(/\bcall:\s*(\w+)\s*\{/)
  if (callMatch && knownToolNames.includes(callMatch[1])) return true
  // JSON object literal that names a known tool with an args/params field.
  if (/"name"\s*:\s*"([^"]+)"/.test(text) && /"(arguments|parameters|input)"\s*:/.test(text)) {
    const name = text.match(/"name"\s*:\s*"([^"]+)"/)?.[1]
    if (name && knownToolNames.includes(name)) return true
  }
  return false
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
