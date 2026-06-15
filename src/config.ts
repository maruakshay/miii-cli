import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type Effort = 'low' | 'medium' | 'high'

export type Provider = 'ollama' | 'lmstudio'

export interface Config {
  model?: string
  provider?: Provider
  ollamaHost?: string
  lmstudioHost?: string
  effort?: Effort
}

export const EFFORT_OPTIONS: Record<Effort, { temperature: number; num_predict: number }> = {
  low:    { temperature: 0.2, num_predict: 1024 },
  medium: { temperature: 0.7, num_predict: 2048 },
  high:   { temperature: 1.0, num_predict: -1 },
}

const CONFIG_DIR = join(homedir(), '.miii')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Config
  } catch {
    return {}
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

export function setModel(model: string): void {
  saveConfig({ ...loadConfig(), model })
}

export function setEffort(effort: Effort): void {
  saveConfig({ ...loadConfig(), effort })
}

export function setProvider(provider: Provider): void {
  saveConfig({ ...loadConfig(), provider })
}
