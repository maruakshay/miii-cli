import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type Effort = 'low' | 'medium' | 'high'

// Wire protocol a provider speaks. 'ollama' = native Ollama API,
// 'openai' = OpenAI-compatible /v1 (LM Studio, OpenAI, Groq, OpenRouter, …).
export type ProviderType = 'ollama' | 'openai'

export interface ProviderEntry {
  type: ProviderType
  baseUrl: string
  apiKey?: string
}

// Selected provider is referenced by name into the `providers` map.
export type Provider = string

export interface Config {
  model?: string
  provider?: Provider
  effort?: Effort
  providers?: Record<string, ProviderEntry>
  // Last-known context window per model. Seeds the header on first render so it
  // shows a real value instead of "— ctx" while the live `show` request loads.
  modelContexts?: Record<string, number>
  // When true (default), a detected newer release is installed in the background
  // on launch. Set false to keep the manual `miii update` flow only.
  autoUpdate?: boolean
  // legacy fields — migrated into `providers` on load
  ollamaHost?: string
  lmstudioHost?: string
}

// num_predict caps the output tokens per turn. It must be large enough to hold a
// full file written inline in a tool call — at 1k/2k whole-file writes (an HTML
// page, a component) get truncated mid-`content`, leaving the tool args
// incomplete so the call never validates and the model retries forever.
export const EFFORT_OPTIONS: Record<Effort, { temperature: number; num_predict: number }> = {
  low:    { temperature: 0.2, num_predict: 8192 },
  medium: { temperature: 0.7, num_predict: 16384 },
  high:   { temperature: 1.0, num_predict: -1 },
}

const CONFIG_DIR = join(homedir(), '.miii')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

// Built-in providers. Env vars seed the defaults so existing setups keep working;
// anything written into config.json overrides these.
function defaultProviders(): Record<string, ProviderEntry> {
  return {
    ollama: {
      type: 'ollama',
      baseUrl: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    },
    lmstudio: {
      type: 'openai',
      baseUrl: process.env.LMSTUDIO_HOST ?? process.env.LLM_HOST ?? 'http://localhost:1234',
      ...(process.env.LMSTUDIO_API_KEY ? { apiKey: process.env.LMSTUDIO_API_KEY } : {}),
    },
  }
}

function migrate(raw: Config): Config {
  const providers = { ...defaultProviders(), ...(raw.providers ?? {}) }
  // Fold legacy host fields into the matching default provider.
  if (raw.ollamaHost) providers.ollama = { ...providers.ollama, baseUrl: raw.ollamaHost }
  if (raw.lmstudioHost) providers.lmstudio = { ...providers.lmstudio, baseUrl: raw.lmstudioHost }
  return {
    model: raw.model,
    provider: raw.provider,
    effort: raw.effort,
    providers,
    modelContexts: raw.modelContexts,
    autoUpdate: raw.autoUpdate,
  }
}

// Background auto-update is on unless the user explicitly disabled it.
export function autoUpdateEnabled(cfg: Config = loadConfig()): boolean {
  return cfg.autoUpdate !== false
}

export function setAutoUpdate(enabled: boolean): void {
  saveConfig({ ...readRawConfig(), autoUpdate: enabled })
}

// Exactly what's on disk — no defaults, no env, no migration. Used by setters so
// we never persist env-seeded secrets (e.g. LMSTUDIO_API_KEY) or freeze defaults.
function readRawConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Config
  } catch {
    return {}
  }
}

// Resolved config: on-disk values with built-in/env defaults merged in. Use for
// reads at runtime; never write the result back to disk.
export function loadConfig(): Config {
  return migrate(readRawConfig())
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

// Never empty — falls back to built-ins if config has no usable providers.
function providersOf(cfg: Config): Record<string, ProviderEntry> {
  return cfg.providers && Object.keys(cfg.providers).length ? cfg.providers : defaultProviders()
}

// Resolve the active provider entry, falling back to ollama / the first defined.
export function resolveProvider(cfg: Config = loadConfig()): { name: string; entry: ProviderEntry } {
  const providers = providersOf(cfg)
  const name =
    cfg.provider && providers[cfg.provider]
      ? cfg.provider
      : providers.ollama
        ? 'ollama'
        : Object.keys(providers)[0]
  return { name, entry: providers[name] }
}

export function listProviders(cfg: Config = loadConfig()): string[] {
  return Object.keys(providersOf(cfg))
}

export interface NamedProvider {
  name: string
  entry: ProviderEntry
  /** 'local' for ollama / localhost endpoints, 'api' for remote endpoints. */
  kind: 'local' | 'api'
}

export function providerEntries(cfg: Config = loadConfig()): NamedProvider[] {
  const providers = providersOf(cfg)
  return Object.entries(providers).map(([name, entry]) => {
    const local = entry.type === 'ollama' || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(entry.baseUrl)
    return { name, entry, kind: local ? 'local' : 'api' }
  })
}

export function setModel(model: string): void {
  saveConfig({ ...readRawConfig(), model })
}

export function setEffort(effort: Effort): void {
  saveConfig({ ...readRawConfig(), effort })
}

export function setProvider(provider: Provider): void {
  saveConfig({ ...readRawConfig(), provider })
}

// Cache resolved context windows so the next launch can render them immediately.
export function setModelContexts(contexts: Record<string, number>): void {
  const raw = readRawConfig()
  saveConfig({ ...raw, modelContexts: { ...raw.modelContexts, ...contexts } })
}
