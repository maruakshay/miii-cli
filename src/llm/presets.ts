/**
 * Known provider presets.
 *
 * A preset is everything needed to talk to a hosted backend except the key:
 * the wire protocol, the base URL, and the environment variable people already
 * export for it. That's what lets `/provider add openai` work with nothing but
 * a name — the endpoint is looked up here, and the key comes from the env var
 * (or is passed once and written to ~/.miii/config.json).
 *
 * Anything not listed is still reachable: `/provider add <name> <baseUrl>` adds
 * an OpenAI-compatible endpoint by hand. Presets are a shortcut, not a gate.
 */
import type { ProviderType } from '../config.js'

export interface Preset {
  /** Wire protocol to speak. */
  type: ProviderType
  baseUrl: string
  /**
   * Path segment between baseUrl and the endpoint, for OpenAI-compatible
   * servers that don't sit at `/v1`. Defaults to `/v1`; `''` means the baseUrl
   * already points at the API root.
   */
  apiPath?: string
  /** Env var holding the key, read at request time so it never has to hit disk. */
  apiKeyEnv?: string
  /** Shown in the picker and by `miii provider list --all`. */
  label: string
  /** Fallback context window when the provider has no way to report one. */
  contextWindow?: number
  /** Suggested default model, offered when the provider is first selected. */
  defaultModel?: string
}

export const PRESETS: Record<string, Preset> = {
  ollama: {
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    label: 'Ollama (local)',
  },
  lmstudio: {
    type: 'openai',
    baseUrl: 'http://localhost:1234',
    apiKeyEnv: 'LMSTUDIO_API_KEY',
    label: 'LM Studio (local)',
  },
  llamacpp: {
    type: 'openai',
    baseUrl: 'http://localhost:8080',
    label: 'llama.cpp server (local)',
  },
  vllm: {
    type: 'openai',
    baseUrl: 'http://localhost:8000',
    label: 'vLLM (local)',
  },
  anthropic: {
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    label: 'Anthropic (Claude)',
    contextWindow: 200000,
    defaultModel: 'claude-opus-5',
  },
  openai: {
    type: 'openai',
    baseUrl: 'https://api.openai.com',
    apiKeyEnv: 'OPENAI_API_KEY',
    label: 'OpenAI',
    contextWindow: 128000,
  },
  groq: {
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai',
    apiKeyEnv: 'GROQ_API_KEY',
    label: 'Groq',
    contextWindow: 131072,
  },
  openrouter: {
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    contextWindow: 131072,
  },
  deepseek: {
    type: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    contextWindow: 65536,
  },
  mistral: {
    type: 'openai',
    baseUrl: 'https://api.mistral.ai',
    apiKeyEnv: 'MISTRAL_API_KEY',
    label: 'Mistral',
    contextWindow: 131072,
  },
  together: {
    type: 'openai',
    baseUrl: 'https://api.together.xyz',
    apiKeyEnv: 'TOGETHER_API_KEY',
    label: 'Together AI',
    contextWindow: 131072,
  },
  cerebras: {
    type: 'openai',
    baseUrl: 'https://api.cerebras.ai',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    label: 'Cerebras',
    contextWindow: 65536,
  },
  xai: {
    type: 'openai',
    baseUrl: 'https://api.x.ai',
    apiKeyEnv: 'XAI_API_KEY',
    label: 'xAI (Grok)',
    contextWindow: 131072,
  },
  gemini: {
    type: 'openai',
    // Google exposes an OpenAI-compatible surface; our client appends /v1/…,
    // so point at the openai/ prefix and let the shared adapter do the rest.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiPath: '',
    apiKeyEnv: 'GEMINI_API_KEY',
    label: 'Google Gemini',
    contextWindow: 1048576,
  },
}

export function presetFor(name: string): Preset | undefined {
  return PRESETS[name.toLowerCase()]
}

export function presetNames(): string[] {
  return Object.keys(PRESETS)
}
