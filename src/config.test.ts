import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let home: string
let realHome: string | undefined

// CONFIG_PATH is resolved from homedir() at import time, so HOME must point at
// the temp dir before config.ts loads — hence a fresh module per test.
async function loadWith(raw: unknown) {
  mkdirSync(join(home, '.miii'), { recursive: true })
  writeFileSync(join(home, '.miii', 'config.json'), JSON.stringify(raw))
  vi.resetModules()
  const { loadConfig } = await import('./config.js')
  return loadConfig()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'miii-home-'))
  realHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
})

describe('loadConfig', () => {
  it('keeps decider, so the stop gate can actually be turned on', async () => {
    const cfg = await loadWith({ decider: { model: 'qwen3:0.6b' } })
    expect(cfg.decider).toEqual({ model: 'qwen3:0.6b' })
  })

  it('keeps maxTurns', async () => {
    const cfg = await loadWith({ maxTurns: 40 })
    expect(cfg.maxTurns).toBe(40)
  })
})
