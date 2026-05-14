import { readFileSync, existsSync } from 'fs'
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
      } catch {}
    }
  }
  return { ...defaults }
}
