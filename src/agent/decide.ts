import { chat } from '../llm/client.js'
import type { DeciderConfig } from '../config.js'
import type { MiiMessage } from './types.js'

/**
 * The decision box: typed judgments the loop can branch on, answered by a small
 * fast model instead of parsed back out of prose.
 *
 * Three rules hold this together, and every one of them exists because a judge
 * that is wrong is worse than no judge at all — it burns turns arguing with a
 * model that was right:
 *
 *  1. Failure is silence. A missing model, a timeout, unparseable output, a
 *     provider error — all return null, which every caller reads as "no
 *     opinion, carry on". Nothing here is ever allowed to end a run.
 *  2. Low confidence is silence too. The caller compares against a threshold
 *     and ignores anything below it. A coin flip must not block the user.
 *  3. Questions are atomic and the state is small. The judge never sees the
 *     conversation — it sees the request, a list of what was actually done, and
 *     the closing message. Composing narrow questions in code is what keeps the
 *     answers worth having.
 */

/** One typed answer. `confidence` is self-reported — see DeciderConfig. */
export interface Judgment {
  value: boolean
  confidence: number
  reason: string
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_THRESHOLD = 0.7
/** Output cap. A judgment is three fields; anything longer is the model rambling. */
const JUDGE_NUM_PREDICT = 256

/**
 * Field order is load-bearing. Grammar-constrained decoding emits required
 * properties in the order they are declared, so `reason` first makes the
 * sentence a short chain of thought that the verdict is then conditioned on.
 * Declared after `value` it can only ever be a rationalisation of a token
 * already emitted — paid for and worthless.
 */
const BOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    value: { type: 'boolean' },
    confidence: { type: 'number' },
  },
  required: ['reason', 'value', 'confidence'],
  additionalProperties: false,
}

const JUDGE_SYSTEM =
  'You are a decision function, not an assistant. You are given a question and some state. ' +
  'Answer with a single JSON object and nothing else, with the keys in this order: ' +
  '{"reason": "<one short sentence>", "value": <true|false>, "confidence": <0..1>}. ' +
  'Write reason first and work the answer out in it, then let value follow from what you wrote. ' +
  'confidence is how sure you are of your own answer — use a low number when the state ' +
  'does not actually tell you. Never explain outside the JSON. Never use markdown.'

/** True when the decider is configured well enough to ask it anything. */
export function deciderEnabled(cfg: DeciderConfig | undefined): cfg is DeciderConfig & { model: string } {
  return !!cfg && cfg.enabled !== false && typeof cfg.model === 'string' && cfg.model.trim() !== ''
}

export function threshold(cfg: DeciderConfig): number {
  const t = cfg.threshold
  return typeof t === 'number' && t >= 0 && t <= 1 ? t : DEFAULT_THRESHOLD
}

/**
 * Ask one yes/no question about one piece of state. Never throws; returns null
 * for every failure mode, which callers must treat as "no opinion".
 */
export async function askBool(
  question: string,
  state: string,
  cfg: DeciderConfig,
  signal?: AbortSignal,
): Promise<Judgment | null> {
  if (!deciderEnabled(cfg)) return null
  if (signal?.aborted) return null

  // Own deadline, composed with the caller's. A judge stuck loading a model
  // must not leave the user staring at a stalled turn with no explanation.
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const onAbort = () => ctl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let text = ''
    for await (const chunk of chat(
      cfg.model,
      [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: `${question}\n\n<state>\n${state}\n</state>` },
      ],
      undefined,
      {
        temperature: 0,
        num_predict: JUDGE_NUM_PREDICT,
        // System One: the judge answers from the state in front of it. Thinking
        // tokens would cost more than the whole judgment is worth, and on a
        // small model they routinely eat the entire output cap before the JSON.
        think: false,
        format: BOOL_SCHEMA,
        signal: ctl.signal,
      },
    )) {
      if (chunk.content) text += chunk.content
    }
    if (ctl.signal.aborted) return null
    return parseJudgment(text)
  } catch {
    // A judge that cannot answer has no opinion. This is not the user's problem
    // to see: the run continues exactly as it would with the gate switched off.
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Pull a Judgment out of whatever the model actually said. The schema is only
 * advisory on some providers (Anthropic ignores `format` entirely), and small
 * models wrap JSON in fences or prose even when told not to — so this hunts for
 * the object rather than trusting the response to be one.
 */
export function parseJudgment(text: string): Judgment | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  // A model that answers the question but botches the type is common enough to
  // be worth meeting halfway: "true"/"yes" for the verdict, a stringified
  // number for the confidence. Anything else is a failed judgment, not a guess.
  const value =
    typeof o.value === 'boolean'
      ? o.value
      : typeof o.value === 'string' && /^(true|yes)$/i.test(o.value.trim())
        ? true
        : typeof o.value === 'string' && /^(false|no)$/i.test(o.value.trim())
          ? false
          : null
  if (value === null) return null

  const n = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence)
  if (!Number.isFinite(n)) return null
  // Some models answer on a 0-100 scale however the prompt is worded.
  const scaled = n > 1 && n <= 100 ? n / 100 : n
  const confidence = Math.min(1, Math.max(0, scaled))

  const reason = typeof o.reason === 'string' ? o.reason.trim() : ''
  return { value, confidence, reason }
}

// ---- stop gate -----------------------------------------------------------

const MAX_REQUEST_CHARS = 600
const MAX_FINAL_CHARS = 900
/** Most recent actions only. The early ones rarely decide whether it's finished. */
const MAX_TRAIL = 30
const MAX_ARG_CHARS = 60

const STOP_QUESTION =
  'Has every part of the user\'s request actually been carried out? ' +
  'Answer false if some requested change was never made, if the assistant only described ' +
  'or planned the work instead of doing it, or if it said it would verify something and ' +
  'then did not. Answer true if the work is done, if the request was only a question, or ' +
  'if the assistant is correctly reporting that it is blocked. ' +
  'In "reason", name the specific thing still missing, addressed to the assistant.'

/**
 * What the run actually did, read back out of the history rather than tracked
 * alongside it — one source of truth, and it cannot drift from what the model
 * was told. Each line is `tool(arg) ok|failed`, oldest first.
 */
export function toolTrail(history: MiiMessage[]): string[] {
  const names = new Map<string, string>()
  const lines: string[] = []
  for (const m of history) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        names.set(b.id, `${b.name}(${briefArg(b.input)})`)
      } else if (b.type === 'tool_result') {
        const label = names.get(b.tool_use_id)
        if (label) lines.push(`${label} ${b.is_error ? 'failed' : 'ok'}`)
      }
    }
  }
  return lines.slice(-MAX_TRAIL)
}

/** The one argument that identifies a call to a human reader. */
function briefArg(input: Record<string, unknown>): string {
  for (const key of ['path', 'command', 'pattern', 'file_path', 'prompt']) {
    const v = input[key]
    if (typeof v === 'string' && v) return clip(v.replace(/\s+/g, ' '), MAX_ARG_CHARS)
  }
  return ''
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

export interface StopGateInput {
  userText: string
  /** The assistant's closing message — the "I'm done" being checked. */
  finalText: string
  history: MiiMessage[]
  cfg: DeciderConfig
  signal?: AbortSignal
}

/**
 * The completion gate. Returns what is still missing — the nudge to send the
 * model back to work — or null to let the turn end.
 *
 * Null covers three different things on purpose: the judge says it's finished,
 * the judge isn't sure enough to say otherwise, and the judge couldn't answer.
 * All three mean the same thing to the loop, and collapsing them here keeps the
 * caller from having to decide which flavour of doubt justifies another turn.
 */
export async function stopGate(input: StopGateInput): Promise<string | null> {
  const { cfg } = input
  if (!deciderEnabled(cfg)) return null

  const trail = toolTrail(input.history)
  const state = [
    `The user asked:\n${clip(input.userText.trim(), MAX_REQUEST_CHARS)}`,
    trail.length
      ? `The assistant then did, in order:\n${trail.map((l) => `- ${l}`).join('\n')}`
      : 'The assistant did not use any tools.',
    `The assistant's closing message was:\n${clip(input.finalText.trim(), MAX_FINAL_CHARS)}`,
  ].join('\n\n')

  const j = await askBool(STOP_QUESTION, state, cfg, input.signal)
  if (!j) return null
  if (j.value) return null
  if (j.confidence < threshold(cfg)) return null
  return j.reason || 'part of the request has not been carried out yet'
}
