/**
 * Anthropic (Claude) provider — native Messages API via the official SDK.
 *
 * Mirrors the ollama/openai adapters: same five exports, same ChatChunk stream,
 * so the agent loop never learns which backend it is talking to. The mapping
 * work lives here because Anthropic's shape differs from the OpenAI one in
 * three ways that matter:
 *   - the system prompt is a top-level field, not a message
 *   - tool results are `tool_result` blocks inside a *user* message
 *   - parallel tool calls must come back as one user message, not several
 */
import Anthropic from '@anthropic-ai/sdk'
import { apiKeyFor, type ProviderEntry } from '../config.js'
import type { OllamaMessage, OllamaTool, OllamaToolCall, ChatChunk, ChatOptions } from './types.js'

export const PROVIDER_NAME = 'anthropic'

// Claude's current line-up is 200K–1M; 200K is the safe floor when the Models
// API can't be reached (offline, or a proxy that doesn't serve /v1/models).
const DEFAULT_CONTEXT = 200000

// max_tokens is required by the API and has no default. Whole-file writes in a
// tool call need real room — see the note on EFFORT_OPTIONS in config.ts.
const DEFAULT_MAX_TOKENS = 16384

export function notAvailable(entry: ProviderEntry): string {
  const where = entry.apiKeyEnv ? `$${entry.apiKeyEnv}` : 'the provider config'
  return `I couldn't reach Anthropic at ${entry.baseUrl}. Check your network and that an API key is set in ${where}.`
}

export function noKey(entry: ProviderEntry): string {
  return (
    `No API key for this provider. Set ${entry.apiKeyEnv ?? 'ANTHROPIC_API_KEY'} in your shell, ` +
    `or run: /provider add anthropic <key>`
  )
}

/** Available once a key exists — there's no local server to probe. */
export function isAvailable(entry: ProviderEntry): boolean {
  return Boolean(apiKeyFor(entry))
}

function client(entry: ProviderEntry): Anthropic {
  const apiKey = apiKeyFor(entry)
  if (!apiKey) throw new Error(noKey(entry))
  return new Anthropic({ apiKey, baseURL: entry.baseUrl })
}

function rethrow(entry: ProviderEntry, err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError) {
    throw new Error(`Anthropic rejected the API key. Check ${entry.apiKeyEnv ?? 'your key'} and try again.`)
  }
  if (err instanceof Anthropic.RateLimitError) {
    throw new Error("Anthropic is rate-limiting this key. Wait a moment and try again.")
  }
  if (err instanceof Anthropic.APIConnectionError) {
    throw new Error(notAvailable(entry))
  }
  if (err instanceof Anthropic.APIError) {
    throw new Error(`Anthropic came back with an error (HTTP ${err.status}): ${err.message}`)
  }
  throw err
}

export async function listModels(entry: ProviderEntry): Promise<string[]> {
  try {
    const ids: string[] = []
    for await (const m of client(entry).models.list({ limit: 100 })) ids.push(m.id)
    return ids
  } catch (err) {
    return rethrow(entry, err)
  }
}

export async function modelContext(entry: ProviderEntry, model: string): Promise<number> {
  try {
    // max_input_tokens is the context window. Older deployments omit it.
    const m = await client(entry).models.retrieve(model)
    return (m as { max_input_tokens?: number }).max_input_tokens ?? entry.contextWindow ?? DEFAULT_CONTEXT
  } catch {
    return entry.contextWindow ?? DEFAULT_CONTEXT
  }
}

// Base64 payloads reach us without a MIME type (the ollama wire format carries
// raw strings), so sniff the magic bytes. PNG is the safe default — it's what
// every screenshot tool on macOS and Windows produces.
function mediaType(b64: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}

function userContent(m: OllamaMessage): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = (m.images ?? []).map((data) => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType(data), data },
  }))
  if (m.content) blocks.push({ type: 'text', text: m.content })
  return blocks
}

/**
 * Translate our ollama-shaped history into Anthropic's.
 *
 * System messages are hoisted out (Anthropic takes them top-level), and runs of
 * consecutive tool results are gathered into a single user message: splitting
 * them across messages teaches the model to stop calling tools in parallel.
 */
function toAnthropic(msgs: OllamaMessage[]): {
  system: string
  messages: Anthropic.MessageParam[]
} {
  const system: string[] = []
  const messages: Anthropic.MessageParam[] = []
  let pendingResults: Anthropic.ToolResultBlockParam[] = []

  const flush = () => {
    if (pendingResults.length === 0) return
    messages.push({ role: 'user', content: pendingResults })
    pendingResults = []
  }

  for (const m of msgs) {
    if (m.role === 'system') {
      flush()
      if (m.content) system.push(m.content)
      continue
    }

    if (m.role === 'tool') {
      pendingResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: m.content,
      })
      continue
    }

    flush()

    if (m.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          // Anthropic matches results to calls by id, so a call that reached us
          // without one (an ollama-native turn replayed here) gets a stable
          // stand-in rather than an empty string.
          id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 12)}`,
          name: tc.function.name,
          input: tc.function.arguments,
        })
      }
      // An empty assistant turn is rejected; skip it rather than send a blank.
      if (content.length > 0) messages.push({ role: 'assistant', content })
      continue
    }

    const content = userContent(m)
    if (content.length > 0) messages.push({ role: 'user', content })
  }

  flush()
  return { system: system.join('\n\n'), messages }
}

function toAnthropicTools(tools?: OllamaTool[]): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }))
}

const EPHEMERAL = { type: 'ephemeral' as const }

/**
 * Mark the cache breakpoints on an outgoing request.
 *
 * Anthropic caches by prefix, and renders in the order tools → system →
 * messages, so two breakpoints cover an agent loop:
 *
 *   1. the end of the system prompt — covers the tool list and the system text,
 *      both of which hold still for a whole run (buildSystemPrompt has no
 *      timestamps, and the tool list is built in a fixed order)
 *   2. the end of the last message — so the *next* turn, whose prefix is this
 *      entire conversation, reads it back instead of paying for it again
 *
 * That second one is what matters: the agent resends the whole transcript every
 * turn, so without it the bill grows quadratically with the length of a session.
 *
 * Caching is silent when it doesn't apply — a prefix under the model's minimum
 * (512–4096 tokens) simply isn't cached, with no error.
 */
function withCacheBreakpoints(
  system: string,
  msgs: Anthropic.MessageParam[],
  tools?: Anthropic.Tool[],
): {
  system?: Anthropic.TextBlockParam[]
  messages: Anthropic.MessageParam[]
  tools?: Anthropic.Tool[]
} {
  // With no system text there is nothing to hang breakpoint 1 on, so it moves
  // to the last tool — the other half of the same stable prefix.
  const cachedTools =
    !system && tools?.length
      ? tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t))
      : tools

  const out = msgs.slice()
  const last = out.at(-1)
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    const content = last.content.slice()
    const tail = content.at(-1)!
    // Thinking blocks can't carry cache_control; every other block type can.
    if (tail.type !== 'thinking' && tail.type !== 'redacted_thinking') {
      content[content.length - 1] = { ...tail, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam
      out[out.length - 1] = { ...last, content }
    }
  }

  return {
    ...(system ? { system: [{ type: 'text', text: system, cache_control: EPHEMERAL }] } : {}),
    messages: out,
    ...(cachedTools ? { tools: cachedTools } : {}),
  }
}

export async function* chat(
  entry: ProviderEntry,
  model: string,
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  opts?: ChatOptions,
): AsyncGenerator<ChatChunk> {
  if (opts?.signal?.aborted) return

  const { system, messages: msgs } = toAnthropic(messages)
  const cached = withCacheBreakpoints(system, msgs, toAnthropicTools(tools))

  // num_predict of -1 means "no cap" in the ollama vocabulary; Anthropic needs
  // a real number, so that maps to our default rather than a literal -1.
  const maxTokens =
    opts?.num_predict && opts.num_predict > 0 ? opts.num_predict : DEFAULT_MAX_TOKENS

  // Tool-call ids and partial JSON arrive as separate events; assemble them by
  // content-block index and emit the finished calls on the done chunk.
  const toolAccum = new Map<number, { id: string; name: string; args: string }>()
  let stopReason: string | null = null
  let inputTokens = 0
  let outputTokens = 0

  try {
    const stream = client(entry).messages.stream(
      {
        model,
        max_tokens: maxTokens,
        ...cached,
        // Adaptive thinking is the current-generation shape; `display:
        // 'summarized'` is opt-in, and without it the ThinkingBlock would sit
        // empty through every pause. Temperature is deliberately not sent —
        // current Claude models reject sampling params alongside thinking.
        ...(opts?.think === false ? {} : { thinking: { type: 'adaptive', display: 'summarized' } }),
      },
      { signal: opts?.signal },
    )

    for await (const event of stream) {
      if (opts?.signal?.aborted) break

      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            toolAccum.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              args: '',
            })
          }
          break

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { content: event.delta.text, done: false }
          } else if (event.delta.type === 'thinking_delta') {
            yield { content: '', thinking: event.delta.thinking, done: false }
          } else if (event.delta.type === 'input_json_delta') {
            const acc = toolAccum.get(event.index)
            if (acc) acc.args += event.delta.partial_json
          }
          break

        case 'message_start': {
          // input_tokens counts only what wasn't served from cache. The context
          // meter wants the real prompt size, so add the cached halves back —
          // otherwise the reading collapses the moment caching starts working.
          const u = event.message.usage
          inputTokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0)
          break
        }

        case 'message_delta':
          stopReason = event.delta.stop_reason ?? stopReason
          outputTokens = event.usage.output_tokens ?? outputTokens
          break
      }
    }
  } catch (err) {
    if (opts?.signal?.aborted) {
      yield { content: '', done: true, prompt_eval_count: 0, eval_count: 0 }
      return
    }
    return rethrow(entry, err)
  }

  if (opts?.signal?.aborted) {
    yield { content: '', done: true, prompt_eval_count: 0, eval_count: 0 }
    return
  }

  const toolCalls: OllamaToolCall[] = []
  for (const [, acc] of toolAccum) {
    let args: Record<string, unknown> = {}
    try {
      // An empty string is what a no-argument tool streams; JSON.parse would
      // throw on it, and `{}` is the right reading.
      args = acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {}
    } catch {
      args = { _raw: acc.args }
    }
    toolCalls.push({ id: acc.id, function: { name: acc.name, arguments: args } })
  }

  yield {
    content: '',
    done: true,
    // The loop detects truncation by the ollama spelling 'length'; Anthropic
    // calls the same condition 'max_tokens'.
    done_reason: stopReason === 'max_tokens' ? 'length' : stopReason ?? undefined,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    prompt_eval_count: inputTokens,
    eval_count: outputTokens,
  }
}
