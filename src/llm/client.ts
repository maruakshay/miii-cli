import { resolveProvider, type ProviderEntry } from '../config.js'
import type { OllamaMessage, OllamaTool, ChatChunk, ChatOptions } from './types.js'
import * as ollama from './ollama.js'
import * as openai from './openai.js'
import * as anthropic from './anthropic.js'

// One adapter per wire protocol. Adding a backend that speaks an existing
// protocol needs no code at all — just a preset (src/llm/presets.ts) or a
// `/provider add`. Only a genuinely new protocol lands a module here.
const ADAPTERS = { ollama, openai, anthropic } as const

function active(): { name: string; entry: ProviderEntry } {
  return resolveProvider()
}

function adapterFor(entry: ProviderEntry) {
  return ADAPTERS[entry.type]
}

export function providerName(): string {
  return active().name
}

export function activeHost(): string {
  return active().entry.baseUrl
}

export function isAvailable(): boolean {
  const { entry } = active()
  return adapterFor(entry).isAvailable(entry)
}

export function NOT_AVAILABLE(): string {
  const { entry } = active()
  if (entry.type === 'ollama') return ollama.NOT_INSTALLED
  if (entry.type === 'anthropic') {
    return anthropic.isAvailable(entry) ? anthropic.notAvailable(entry) : anthropic.noKey(entry)
  }
  return openai.notAvailable(entry)
}

export async function listModels(): Promise<string[]> {
  const { entry } = active()
  return adapterFor(entry).listModels(entry)
}

export async function modelContext(model: string): Promise<number> {
  const { entry } = active()
  return adapterFor(entry).modelContext(entry, model)
}

export async function* chat(
  model: string,
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  opts?: ChatOptions,
): AsyncGenerator<ChatChunk> {
  const { entry } = active()
  yield* adapterFor(entry).chat(entry, model, messages, tools, opts)
}
