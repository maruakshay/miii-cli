/**
 * copy — turn the transcript into text for the clipboard.
 *
 * The rendered transcript is Ink's, not the terminal's: it lives in miii's own
 * viewport, is repainted on every frame, and the mouse drag that would select
 * it is taken by mouse reporting. So instead of fighting for the selection,
 * `/copy` (and ctrl+y) lift the underlying text straight out of the message
 * log, which also means the copy is clean — no wrapping, no gutters, no
 * truncated tool output.
 */
import type { ChatMessage } from './types.js'

export type CopyTarget = 'last' | 'all' | 'code' | 'tool'

const TARGETS: Record<string, CopyTarget> = {
  '': 'last',
  last: 'last',
  reply: 'last',
  all: 'all',
  chat: 'all',
  code: 'code',
  tool: 'tool',
  output: 'tool',
}

/** Parse the `/copy` argument; null for anything we don't recognise. */
export function parseCopyTarget(arg: string): CopyTarget | null {
  return TARGETS[arg.trim().toLowerCase()] ?? null
}

/** Human name for a target, for notices. */
export function describeTarget(target: CopyTarget): string {
  return target === 'last'
    ? 'last reply'
    : target === 'all'
      ? 'conversation'
      : target === 'code'
        ? 'last code block'
        : 'last tool output'
}

/**
 * Fenced code blocks in a markdown string, in order. The info string (```ts) is
 * dropped — what gets pasted is the code, not the fence.
 */
export function codeBlocks(markdown: string): string[] {
  const out: string[] = []
  const re = /```[^\n]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const body = m[1].replace(/\n$/, '')
    if (body.trim()) out.push(body)
  }
  return out
}

/** The whole conversation as plain text, speakers labelled. */
function wholeConversation(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const body = m.content.trim()
    if (body) parts.push(`${m.role === 'user' ? '>' : 'miii:'} ${body}`)
    for (const r of m.tool_results ?? []) {
      if (r.content.trim()) parts.push(`[${r.is_error ? 'error' : 'tool output'}]\n${r.content.trim()}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * The text `target` refers to, or null when there isn't any — an empty
 * transcript, a reply with no code in it, a session with no tool output yet.
 */
export function collectCopyText(messages: ChatMessage[], target: CopyTarget): string | null {
  if (target === 'all') return wholeConversation(messages) || null

  if (target === 'tool') {
    for (let i = messages.length - 1; i >= 0; i--) {
      const results = messages[i].tool_results
      if (!results?.length) continue
      // The last result of the last turn that ran tools — the one on screen.
      const text = results[results.length - 1].content.trim()
      if (text) return text
    }
    return null
  }

  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())
  if (!lastReply) return null

  if (target === 'code') {
    const blocks = codeBlocks(lastReply.content)
    return blocks.length ? blocks[blocks.length - 1] : null
  }

  return lastReply.content.trim()
}

/** "3 lines" / "1 line" — the unit a notice quotes back after a copy. */
export function describeSize(text: string): string {
  const lines = text.split('\n').length
  return `${lines} line${lines === 1 ? '' : 's'}`
}
