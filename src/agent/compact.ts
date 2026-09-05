/**
 * Context compaction — summarise the conversation so far and continue.
 *
 * When the window fills up, the alternative to `/clear` is to trade the raw
 * transcript for a recap of it: ask the model to write down what the session
 * was doing, what it learned and what's left, then rebuild history as that
 * recap plus the last verbatim turns. The session keeps going instead of
 * starting over.
 *
 * The rebuilt history is always well-formed for the adapter: the tail can only
 * start at a *real* user turn (one carrying no tool_result blocks), so a
 * tool_use block can never be separated from the tool_result that answers it.
 */
import { chat } from '../llm/client.js'
import type { MiiMessage, ContentBlock } from './types.js'

/** Rough tokens-per-character; good enough for budgeting, never for billing. */
const CHARS_PER_TOKEN = 4

/** How much of the transcript we hand the summariser, in characters. */
const TRANSCRIPT_BUDGET = 16000

/** A single tool result rarely earns more than this in a recap. */
const TOOL_RESULT_BUDGET = 400

/** Share of the context window the preserved tail may occupy. */
const TAIL_SHARE = 0.15

/** Marks the recap in the rebuilt history so a resumed session reads right. */
export const COMPACT_PREAMBLE =
  'The earlier part of this conversation was removed to free up context. ' +
  'Here is a summary of everything that happened before this point — treat it ' +
  'as your own memory of the session and continue from it:\n\n'

/** The canned acknowledgement that keeps the rebuilt history alternating. */
const COMPACT_ACK =
  'Understood — I have the summary of our work so far and will continue from there.'

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Estimated prompt tokens for a whole history (text only — images excluded). */
export function estimateHistoryTokens(history: MiiMessage[]): number {
  let chars = 0
  for (const m of history) chars += flatten(m).length
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`
}

/** Flatten one message to the plain-text line(s) the summariser sees. */
function flatten(m: MiiMessage): string {
  const blocks: ContentBlock[] = Array.isArray(m.content)
    ? m.content
    : [{ type: 'text', text: m.content }]
  const lines: string[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text.trim()) lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${b.text.trim()}`)
    } else if (b.type === 'tool_use') {
      lines.push(`Assistant called ${b.name}(${truncate(JSON.stringify(b.input ?? {}), 200)})`)
    } else if (b.type === 'tool_result') {
      const tag = b.is_error ? 'Tool error' : 'Tool result'
      lines.push(`${tag}: ${truncate(b.content ?? '', TOOL_RESULT_BUDGET)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render history for the summariser, capped at `budget` characters. The opening
 * of a session carries the task and the closing carries the current state, so a
 * transcript that doesn't fit keeps a quarter of the head and the rest of the
 * tail, with the drop marked in between.
 */
function renderTranscript(history: MiiMessage[], budget = TRANSCRIPT_BUDGET): string {
  const full = history.map(flatten).filter(Boolean).join('\n')
  if (full.length <= budget) return full
  const head = Math.floor(budget * 0.25)
  const tail = budget - head
  return `${full.slice(0, head)}\n\n[… ${full.length - budget} characters of the middle omitted …]\n\n${full.slice(-tail)}`
}

/**
 * A message is a "real" user turn if it's the person typing, not the harness
 * feeding tool output back. Only these are safe places to cut history: cutting
 * anywhere else can orphan a tool_use from its tool_result.
 */
function isUserTurn(m: MiiMessage): boolean {
  if (m.role !== 'user') return false
  if (typeof m.content === 'string') return true
  return !m.content.some((b) => b.type === 'tool_result')
}

/**
 * Index of the earliest real user turn whose tail fits in `tokenBudget`, or -1
 * when nothing qualifies (the last exchange alone is already too big to keep).
 *
 * The search stops at the midpoint of the history: compaction that preserved
 * everything would summarise an empty transcript and free nothing, so at least
 * half the conversation always gets folded into the recap.
 */
function tailStart(history: MiiMessage[], tokenBudget: number): number {
  const earliest = Math.max(1, Math.floor(history.length / 2))
  let best = -1
  for (let i = history.length - 1; i >= earliest; i--) {
    if (!isUserTurn(history[i])) continue
    if (estimateHistoryTokens(history.slice(i)) > tokenBudget) break
    best = i
  }
  return best
}

function buildPrompt(transcript: string, instructions?: string): string {
  const focus = instructions?.trim()
    ? `\n\nThe user asked you to focus the summary on: ${instructions.trim()}`
    : ''
  return (
    'You are compacting a coding session so it can continue in a fresh context ' +
    'window. Write a summary that a competent engineer could pick the work up ' +
    'from with no other information. Use these sections, in order, as markdown ' +
    'headings:\n\n' +
    '## Goal — what the user asked for, in their terms.\n' +
    '## What happened — the work done so far, in order.\n' +
    '## Files touched — paths, each with what changed and why.\n' +
    '## Key facts — commands, APIs, conventions, constraints and decisions ' +
    'discovered along the way that would be expensive to rediscover.\n' +
    '## Current state — what is working, what is broken, what was just tried.\n' +
    '## Next steps — the immediate remaining work.\n\n' +
    'Be specific: exact paths, function names, commands and error text beat ' +
    'summary prose. Omit a section only if it would be empty. Do not address ' +
    'the user, do not add a preamble, and do not offer to help — output only ' +
    `the summary.${focus}\n\n` +
    `Here is the session transcript:\n\n${transcript}`
  )
}

export interface CompactOptions {
  /** Extra steer for the summary, from `/compact <instructions>`. */
  instructions?: string
  /** Context window in tokens; sizes both the request and the preserved tail. */
  num_ctx?: number
  signal?: AbortSignal
}

export interface CompactResult {
  /** The recap the model wrote. */
  summary: string
  /** Rebuilt history: recap, acknowledgement, then the preserved tail. */
  history: MiiMessage[]
  /** How many messages were folded into the recap. */
  droppedMessages: number
  /** How many trailing messages survived verbatim. */
  keptMessages: number
  beforeTokens: number
  afterTokens: number
}

/**
 * Summarise `history` and rebuild it around the summary. Throws if the model
 * returns nothing usable — the caller keeps the original history in that case,
 * since a lost transcript is worse than a full one.
 */
export async function compactHistory(
  model: string,
  history: MiiMessage[],
  opts: CompactOptions = {},
): Promise<CompactResult> {
  if (!history.length) throw new Error('nothing to compact')

  const cut = opts.num_ctx ? tailStart(history, Math.floor(opts.num_ctx * TAIL_SHARE)) : -1
  // Everything before the cut is what the summary has to stand in for; the tail
  // survives verbatim, so summarising it again would just duplicate it.
  const folded = cut === -1 ? history : history.slice(0, cut)
  const tail = cut === -1 ? [] : history.slice(cut)

  let out = ''
  for await (const chunk of chat(
    model,
    [{ role: 'user', content: buildPrompt(renderTranscript(folded), opts.instructions) }],
    undefined,
    // No thinking: reasoning models otherwise spend the whole budget on hidden
    // tokens and emit an empty summary — the same trap the titler hit.
    { temperature: 0.2, num_predict: 1500, think: false, num_ctx: opts.num_ctx, signal: opts.signal },
  )) {
    if (chunk.content) out += chunk.content
  }

  const summary = out.trim()
  if (summary.length < 40) throw new Error('the model returned an empty summary')

  const rebuilt: MiiMessage[] = [
    { role: 'user', content: COMPACT_PREAMBLE + summary },
    { role: 'assistant', content: COMPACT_ACK },
    ...tail,
  ]

  return {
    summary,
    history: rebuilt,
    droppedMessages: folded.length,
    keptMessages: tail.length,
    beforeTokens: estimateHistoryTokens(history),
    afterTokens: estimateHistoryTokens(rebuilt),
  }
}
