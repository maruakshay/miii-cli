import { render } from 'ink'
import React from 'react'
import minimist from 'minimist'
import { createRequire } from 'module'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { loadConfig } from './config.js'
import { SkillLoader } from './skills/loader.js'
import { InputBar } from './tui/InputBar.js'
import { welcome } from './tui/printer.js'
import { ensureOllama } from './llm/ollama.js'

const require = createRequire(import.meta.url)

const UPDATE_CACHE = join(homedir(), '.config', 'miii', 'update-check.json')
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6h

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

function isLinkedInstall(): boolean {
  try {
    const bin = execSync('which miii', { encoding: 'utf-8' }).trim()
    const resolved = execSync(`readlink "${bin}"`, { encoding: 'utf-8' }).trim()
    return resolved.includes('node_modules') && !resolved.includes('npm/lib')
  } catch { return false }
}

async function checkLatestVersion(current: string, force = false): Promise<string | undefined> {
  if (!force) {
    try {
      if (existsSync(UPDATE_CACHE)) {
        const cache = JSON.parse(readFileSync(UPDATE_CACHE, 'utf-8')) as { ts: number; latest: string; localVersion?: string }
        const cacheValid = Date.now() - cache.ts < CHECK_INTERVAL_MS && cache.localVersion === current
        if (cacheValid) {
          return semverGt(cache.latest, current) ? cache.latest : undefined
        }
      }
    } catch {}
  }

  try {
    const res = await fetch('https://registry.npmjs.org/miii-cli/latest', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return undefined
    const data = await res.json() as { version: string }
    const latest = data.version
    if (!latest) return undefined
    // Cache result
    mkdirSync(join(homedir(), '.config', 'miii'), { recursive: true })
    writeFileSync(UPDATE_CACHE, JSON.stringify({ ts: Date.now(), latest, localVersion: current }))
    return semverGt(latest, current) ? latest : undefined
  } catch {}
  return undefined
}

export async function lazyInit(): Promise<void> {
  const argv = minimist(process.argv.slice(2), {
    string: ['model', 'url', 'provider', 'session'],
    boolean: ['update'],
    alias: { m: 'model', u: 'url', p: 'provider', s: 'session' },
  })

  const config = loadConfig()
  if (argv.model) config.model = argv.model
  if (argv.url) config.baseUrl = argv.url
  if (argv.provider) config.provider = argv.provider as typeof config.provider

  const pkg = require('../package.json') as { version: string }
  const currentVersion: string = pkg.version

  if (config.provider === 'ollama') {
    await ensureOllama(config.baseUrl)
  }

  const skills = new SkillLoader()

  // Run version check + skill load in parallel — don't block startup
  const linked = isLinkedInstall()
  const [, updateAvailable] = await Promise.all([
    skills.loadAll(),
    checkLatestVersion(currentVersion, !!argv.update),
  ])

  // Print welcome banner to scrollback BEFORE Ink starts
  welcome(config.provider, config.model, process.cwd(), currentVersion, updateAvailable, linked)

  const sessionName = (argv.session as string) || `s-${Date.now()}`

  const { waitUntilExit } = render(
    React.createElement(InputBar, { config, skills, cwd: process.cwd(), session: sessionName, version: currentVersion }),
    { exitOnCtrlC: false }
  )

  await waitUntilExit()
}
