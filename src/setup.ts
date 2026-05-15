import { createInterface } from 'readline'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Config } from './types.js'

const GLOBAL_CONFIG = join(homedir(), '.config', 'miii', 'config.json')

const R      = '\x1b[0m'
const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'
const CYAN   = '\x1b[96m'
const GREEN  = '\x1b[92m'
const GRAY   = '\x1b[90m'
const YELLOW = '\x1b[93m'
const PURPLE = '\x1b[95m'
const WHITE  = '\x1b[97m'

const b  = (s: string) => `${BOLD}${s}${R}`
const cy = (s: string) => `${CYAN}${s}${R}`
const gr = (s: string) => `${GRAY}${s}${R}`
const gn = (s: string) => `${GREEN}${s}${R}`
const yw = (s: string) => `${YELLOW}${s}${R}`
const wh = (s: string) => `${WHITE}${s}${R}`
const dim = (s: string) => `${DIM}${s}${R}`

const PROVIDERS = [
  { key: 'ollama',        label: 'Ollama',         desc: 'local · free · air-gapped' },
  { key: 'anthropic',     label: 'Anthropic',      desc: 'Claude API (cloud)'         },
  { key: 'openai-compat', label: 'OpenAI / Custom', desc: 'OpenAI or compatible endpoint' },
]

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  'ollama':        ['qwen2.5-coder:7b', 'llama3.2', 'deepseek-r1:7b', 'codellama:13b'],
  'anthropic':     ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
  'openai-compat': ['gpt-4o', 'gpt-4o-mini', 'o1-mini'],
}

const w = process.stdout.write.bind(process.stdout)
const ln = (s = '') => w(s + '\n')

function divider() {
  ln(gr('  ' + '─'.repeat(46)))
}

export function needsSetup(): boolean {
  return !existsSync(GLOBAL_CONFIG)
}

export async function runSetup(): Promise<Config> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, ans => resolve(ans.trim())))

  // ── Header ────────────────────────────────────────────────────────────────
  ln()
  ln(`  ${PURPLE}${BOLD}●  ●${R}`)
  ln(`  ${PURPLE}${BOLD}╲●╱${R}   ${b(wh('Miii'))}  ${gr('first-time setup')}`)
  ln()

  // ── Provider ──────────────────────────────────────────────────────────────
  ln(yw(b('  Provider')))
  divider()
  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i]
    ln(`  ${cy(b(String(i + 1)))}  ${wh(p.label.padEnd(16))}  ${gr(dim(p.desc))}`)
  }
  ln()

  let providerKey = 'ollama'
  while (true) {
    const raw = await ask(`  ${cy('›')} ${gr('[1–3]: ')}`)
    const choice = raw || '1'
    const idx = parseInt(choice, 10) - 1
    if (idx >= 0 && idx < PROVIDERS.length) {
      providerKey = PROVIDERS[idx].key
      w(`  ${gn('✓')} ${wh(PROVIDERS[idx].label)}\n`)
      break
    }
    ln(gr('  enter 1, 2, or 3'))
  }
  ln()

  // ── Credentials / URL ─────────────────────────────────────────────────────
  let apiKey: string | undefined
  let baseUrl = 'http://localhost:11434'

  if (providerKey === 'anthropic') {
    ln(yw(b('  API Key')))
    divider()
    ln(gr('  console.anthropic.com → API Keys'))
    ln()
    while (true) {
      const raw = await ask(`  ${cy('›')} sk-ant-...: `)
      if (raw.startsWith('sk-ant-') || raw.startsWith('sk-')) {
        apiKey = raw
        ln(`  ${gn('✓')} key saved`)
        break
      }
      ln(gr('  key should start with sk-ant-'))
    }
    baseUrl = 'https://api.anthropic.com'
    ln()
  }

  if (providerKey === 'openai-compat') {
    ln(yw(b('  Endpoint')))
    divider()
    const rawUrl = await ask(`  ${cy('›')} Base URL ${gr('[https://api.openai.com]')}: `)
    baseUrl = rawUrl || 'https://api.openai.com'
    ln()
    const rawKey = await ask(`  ${cy('›')} API key ${gr('(optional)')}: `)
    if (rawKey) {
      apiKey = rawKey
      ln(`  ${gn('✓')} key saved`)
    } else {
      ln(`  ${gr('─')} no key set`)
    }
    ln()
  }

  if (providerKey === 'ollama') {
    // Try default URL silently; only ask if unreachable
    try {
      await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    } catch {
      ln(yw(b('  Ollama URL')))
      divider()
      ln(gr('  Could not reach http://localhost:11434'))
      ln()
      const rawUrl = await ask(`  ${cy('›')} URL ${gr('[http://localhost:11434]')}: `)
      baseUrl = rawUrl || 'http://localhost:11434'
      ln(`  ${gn('✓')} ${baseUrl}`)
      ln()
    }
  }

  // ── Model ─────────────────────────────────────────────────────────────────
  ln(yw(b('  Model')))
  divider()

  let suggestions = MODEL_SUGGESTIONS[providerKey] ?? []

  if (providerKey === 'ollama') {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const data = await res.json() as { models?: Array<{ name: string }> }
        const pulled = (data.models ?? []).map(m => m.name).filter(Boolean)
        if (pulled.length) suggestions = pulled
      }
    } catch {}

    if (!suggestions.length) {
      ln(gr('  No models found — enter name manually (e.g. qwen2.5-coder:7b)'))
      ln()
      const rawModel = await ask(`  ${cy('›')} model name: `)
      const model = rawModel || 'qwen2.5-coder:7b'
      ln(`  ${gn('✓')} ${model}`)
      ln()
      rl.close()
      return saveConfig({ provider: 'ollama', model, baseUrl, apiKey })
    }
  }

  for (let i = 0; i < suggestions.length; i++) {
    ln(`  ${cy(b(String(i + 1).padStart(2)))}  ${suggestions[i]}`)
  }
  ln()

  const defaultModel = suggestions[0] ?? 'llama3.2'
  let model = defaultModel
  while (true) {
    const raw = await ask(`  ${cy('›')} ${gr(`[1–${suggestions.length} or name]: `)}`)
    if (!raw) break
    const idx = parseInt(raw, 10) - 1
    if (idx >= 0 && idx < suggestions.length) {
      model = suggestions[idx]
      break
    }
    if (raw.length > 0) {
      model = raw
      break
    }
  }
  ln(`  ${gn('✓')} ${model}`)
  ln()

  rl.close()
  return saveConfig({ provider: providerKey as Config['provider'], model, baseUrl, apiKey })
}

function saveConfig(cfg: Omit<Config, 'apiKey'> & { apiKey?: string }): Config {
  const config: Config = { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl }
  if (cfg.apiKey) config.apiKey = cfg.apiKey

  mkdirSync(join(homedir(), '.config', 'miii'), { recursive: true })
  writeFileSync(GLOBAL_CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 })

  const w = process.stdout.write.bind(process.stdout)
  const gr = (s: string) => `\x1b[90m${s}\x1b[0m`
  const gn = (s: string) => `\x1b[92m${s}\x1b[0m`
  w(`  ${gn('✓')} config saved  ${gr(GLOBAL_CONFIG)}\n\n`)

  return config
}
