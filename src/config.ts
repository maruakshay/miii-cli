import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type Effort = 'low' | 'medium' | 'high'

// Wire protocol a provider speaks. 'ollama' = native Ollama API,
// 'openai' = OpenAI-compatible /v1 (LM Studio, OpenAI, Groq, OpenRouter, …),
// 'anthropic' = native Anthropic Messages API (Claude).
export type ProviderType = 'ollama' | 'openai' | 'anthropic'

export interface ProviderEntry {
  type: ProviderType
  baseUrl: string
  /** Key stored on disk. Prefer `apiKeyEnv` — see apiKeyFor(). */
  apiKey?: string
  /**
   * Environment variable to read the key from at request time. Preferred over
   * `apiKey`: the secret stays in the shell profile / secret manager instead of
   * landing in ~/.miii/config.json.
   */
  apiKeyEnv?: string
  /** Path between baseUrl and the endpoint for openai-type providers. */
  apiPath?: string
  /** Fallback context window when the provider can't report one. */
  contextWindow?: number
}

/**
 * The key to authenticate with, or undefined for a keyless local server.
 * An explicit `apiKey` wins; otherwise the named env var is read fresh on every
 * call, so exporting a new key takes effect without editing the config.
 */
export function apiKeyFor(entry: ProviderEntry): string | undefined {
  if (entry.apiKey) return entry.apiKey
  if (entry.apiKeyEnv) return process.env[entry.apiKeyEnv] || undefined
  return undefined
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
  // Upper bound on num_ctx sent to Ollama. Models advertise huge training
  // windows (e.g. 131072); allocating that as KV cache OOMs / slows small
  // machines. We cap the requested window at this value. Raise it if you have
  // the VRAM/RAM. See DEFAULT_NUM_CTX_CAP.
  numCtxCap?: number
  // legacy fields — migrated into `providers` on load
  ollamaHost?: string
  lmstudioHost?: string
}

// Default ceiling on the context window we ask Ollama to allocate. A model's
// advertised max context (context_length) is a training limit, not a
// suggestion — passing it verbatim as num_ctx makes Ollama size its KV cache to
// the full window, which OOMs or falls back to slow CPU offload on laptops. Cap
// the request here; override per-machine with `numCtxCap` in config.json.
export const DEFAULT_NUM_CTX_CAP = 16384

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

// Built-in providers, always present so a fresh install can talk to a local
// backend with no setup. Env vars seed the hosts so existing setups keep
// working; anything written into config.json overrides these. Every other
// backend is opt-in via addProvider() — see src/llm/presets.ts.
function defaultProviders(): Record<string, ProviderEntry> {
  return {
    ollama: {
      type: 'ollama',
      baseUrl: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    },
    lmstudio: {
      type: 'openai',
      baseUrl: process.env.LMSTUDIO_HOST ?? process.env.LLM_HOST ?? 'http://localhost:1234',
      apiKeyEnv: 'LMSTUDIO_API_KEY',
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
    numCtxCap: raw.numCtxCap,
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

// Detect a malformed config so the CLI can warn the user before it silently
// falls back to defaults (which would wipe their model/provider/effort). Returns
// a human-readable message, or null when the file is absent or valid. Must be
// called BEFORE the Ink UI mounts — stderr written under a live TUI frame gets
// scrambled or painted over. See cli.tsx.
export function configError(): string | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return (
      `miii: ignoring unreadable ${CONFIG_PATH} (${msg}).\n` +
      `      Running with defaults. Fix the JSON or delete the file to reset.`
    )
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
    const local =
      entry.type !== 'anthropic' &&
      (entry.type === 'ollama' || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(entry.baseUrl))
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

/**
 * Add or overwrite a named provider and make it active.
 *
 * Writes into the raw (on-disk) providers map, so built-in defaults stay
 * defaults — only what the user actually configured is persisted.
 */
export function addProvider(name: string, entry: ProviderEntry): void {
  const raw = readRawConfig()
  saveConfig({
    ...raw,
    providers: { ...raw.providers, [name]: entry },
    provider: name,
  })
}

/**
 * Forget a provider. Returns false if it isn't user-configured (built-in
 * defaults can't be removed — there'd be nothing left to fall back to).
 * If it was the active provider, selection falls back to the default.
 */
export function removeProvider(name: string): boolean {
  const raw = readRawConfig()
  if (!raw.providers?.[name]) return false
  const providers = { ...raw.providers }
  delete providers[name]
  saveConfig({
    ...raw,
    providers,
    provider: raw.provider === name ? undefined : raw.provider,
  })
  return true
}

// Cache resolved context windows so the next launch can render them immediately.
export function setModelContexts(contexts: Record<string, number>): void {
  const raw = readRawConfig()
  saveConfig({ ...raw, modelContexts: { ...raw.modelContexts, ...contexts } })
}
