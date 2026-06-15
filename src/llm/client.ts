import { loadConfig } from '../config.js'
import type { OllamaMessage, OllamaTool, ChatChunk, ChatOptions } from './types.js'
import * as ollama from './ollama.js'
import * as lmstudio from './lmstudio.js'

interface LLMProvider {
  isAvailable(): boolean
  listModels(): Promise<string[]>
  modelContext(model: string): Promise<number>
  chat(
    model: string,
    messages: OllamaMessage[],
    tools?: OllamaTool[],
    opts?: ChatOptions,
  ): AsyncGenerator<ChatChunk>
}

const providers: Record<string, LLMProvider> = { ollama, lmstudio }

function current(): LLMProvider {
  const cfg = loadConfig()
  return providers[cfg.provider ?? 'ollama']
}

export function providerName(): string {
  const cfg = loadConfig()
  return cfg.provider ?? 'ollama'
}

export function isAvailable(): boolean {
  return current().isAvailable()
}

export function NOT_AVAILABLE(): string {
  const cfg = loadConfig()
  return cfg.provider === 'lmstudio'
    ? lmstudio.NOT_AVAILABLE
    : ollama.NOT_INSTALLED
}

export async function listModels(): Promise<string[]> {
  return current().listModels()
}

export async function modelContext(model: string): Promise<number> {
  return current().modelContext(model)
}

export async function* chat(
  model: string,
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  opts?: ChatOptions,
): AsyncGenerator<ChatChunk> {
  yield* current().chat(model, messages, tools, opts)
}
