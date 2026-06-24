import { resolveProvider, type ProviderEntry } from '../config.js'
import type { OllamaMessage, OllamaTool, ChatChunk, ChatOptions } from './types.js'
import * as ollama from './ollama.js'
import * as openai from './openai.js'

function active(): { name: string; entry: ProviderEntry } {
  return resolveProvider()
}

export function providerName(): string {
  return active().name
}

export function activeHost(): string {
  return active().entry.baseUrl
}

export function isAvailable(): boolean {
  const { entry } = active()
  return entry.type === 'ollama' ? ollama.isAvailable(entry) : openai.isAvailable(entry)
}

export function NOT_AVAILABLE(): string {
  const { entry } = active()
  return entry.type === 'ollama' ? ollama.NOT_INSTALLED : openai.notAvailable(entry)
}

export async function listModels(): Promise<string[]> {
  const { entry } = active()
  return entry.type === 'ollama' ? ollama.listModels(entry) : openai.listModels(entry)
}

export async function modelContext(model: string): Promise<number> {
  const { entry } = active()
  return entry.type === 'ollama'
    ? ollama.modelContext(entry, model)
    : openai.modelContext(entry, model)
}

// Per-session memo of model parameter counts. Keyed by host+model so switching
// provider or model never returns a stale value. Cached null is intentional: an
// unknown size should not re-probe `show` every turn.
const paramCountCache = new Map<string, number | null>()

/**
 * Parameter count in billions, or null if unknown / not an Ollama provider.
 * Drives the constrained-decoding auto-gate in the agent loop. Memoized per
 * session — `show` metadata does not change while the process runs.
 */
export async function modelParamCountB(model: string): Promise<number | null> {
  const { entry } = active()
  if (entry.type !== 'ollama') return null
  const key = `${entry.baseUrl}:${model}`
  const cached = paramCountCache.get(key)
  if (cached !== undefined) return cached
  const params = await ollama.paramCountB(entry, model)
  paramCountCache.set(key, params)
  return params
}

export async function* chat(
  model: string,
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  opts?: ChatOptions,
): AsyncGenerator<ChatChunk> {
  const { entry } = active()
  if (entry.type === 'ollama') {
    yield* ollama.chat(entry, model, messages, tools, opts)
  } else {
    yield* openai.chat(entry, model, messages, tools, opts)
  }
}
