import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Config } from './types.js'

const defaults: Config = {
  model: 'llama3.2',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
}

const ALLOWED_KEYS = new Set<keyof Config>(['model', 'provider', 'baseUrl', 'systemPrompt', 'apiKey', 'gitContext', 'tavilyApiKey', 'embedModel'])

const PROJECT_CONFIG = join(process.cwd(), '.miii.json')
const GLOBAL_CONFIG  = join(homedir(), '.config', 'miii', 'config.json')

export function saveConfig(config: Partial<Config>): void {
  mkdirSync(join(homedir(), '.config', 'miii'), { recursive: true })
  const existing = existsSync(GLOBAL_CONFIG)
    ? (() => { try { return JSON.parse(readFileSync(GLOBAL_CONFIG, 'utf-8')) } catch { return {} } })()
    : {}
  const merged = { ...existing }
  for (const key of ALLOWED_KEYS) {
    if (key in config) (merged as Record<string, unknown>)[key] = (config as Record<string, unknown>)[key]
  }
  writeFileSync(GLOBAL_CONFIG, JSON.stringify(merged, null, 2), { mode: 0o600 })
}

export function loadConfig(): Config {
  const candidates = [PROJECT_CONFIG, GLOBAL_CONFIG]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw: Record<string, unknown> = JSON.parse(readFileSync(p, 'utf-8'))
        if (p === PROJECT_CONFIG && ('apiKey' in raw || 'tavilyApiKey' in raw)) {
          process.stderr.write('Warning: API keys found in .miii.json — add .miii.json to .gitignore to avoid committing secrets\n')
        }
        const safe: Partial<Config> = {}
        for (const key of ALLOWED_KEYS) {
          if (key in raw) (safe as Record<string, unknown>)[key] = raw[key]
        }
        return { ...defaults, ...safe }
      } catch {
        process.stderr.write(`Warning: could not parse config at ${p} — using defaults\n`)
      }
    }
  }
  return { ...defaults }
}
