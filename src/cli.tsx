#!/usr/bin/env node
import { render } from 'ink'
import { createElement } from 'react'
import { App } from './ui/App.js'
import { DISABLE as MOUSE_OFF } from './ui/mouse.js'
import { cleanupSpill } from './tools/spill.js'
import { setProvider, listProviders, providerEntries, apiKeyFor, configError, type Provider } from './config.js'

// Drop yesterday's spilled tool output before starting. Best-effort.
cleanupSpill()

const args = process.argv.slice(2)
let cmd: string | undefined

// Parse --provider / -p before the main command
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--provider' || args[i] === '-p') && i + 1 < args.length) {
    const p = args[++i] as Provider
    if (listProviders().includes(p)) setProvider(p)
  } else if (!cmd) {
    cmd = args[i]
  }
}

if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  const { createRequire } = await import('module')
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
  console.log(pkg.version)
  process.exit(0)
} else if (cmd === 'update' || cmd === '--update' || cmd === '-u') {
  const { spawnSync } = await import('child_process')
  console.log('Updating miii-agent…')
  const r = spawnSync('npm', ['i', '-g', 'miii-agent@latest'], { stdio: 'inherit', shell: process.platform === 'win32' })
  process.exit(r.status ?? 1)
} else if (cmd === 'provider' || cmd === 'providers') {
  // Manage backends without launching the TUI, so a provider can be added from
  // a setup script or a Dockerfile.
  const { addByName, removeByName, describePresets } = await import('./llm/manage.js')
  const rest = args.slice(args.indexOf(cmd) + 1)
  const [verb, ...verbArgs] = rest
  if (verb === 'add') {
    const res = addByName(verbArgs)
    console[res.ok ? 'log' : 'error'](res.message)
    process.exit(res.ok ? 0 : 1)
  } else if (verb === 'remove' || verb === 'rm') {
    const res = removeByName(verbArgs[0])
    console[res.ok ? 'log' : 'error'](res.message)
    process.exit(res.ok ? 0 : 1)
  } else if (verb === 'list' || verb === undefined) {
    if (verbArgs.includes('--all')) {
      console.log('Providers you can add by name:\n' + describePresets())
    } else {
      const active = listProviders()
      const width = Math.max(...active.map((n) => n.length))
      for (const p of providerEntries()) {
        // A local server's key is optional, so an unset env var there is not a
        // problem worth flagging — only remote providers actually need one.
        const key = apiKeyFor(p.entry)
          ? 'key ✓'
          : p.kind === 'api' && p.entry.apiKeyEnv
            ? `needs $${p.entry.apiKeyEnv}`
            : '—'
        console.log(`  ${p.name.padEnd(width)}  ${p.kind.padEnd(5)}  ${p.entry.baseUrl}  ${key}`)
      }
      console.log('\nAdd one with: miii provider add <name> [apiKey]   (miii provider list --all to see names)')
    }
    process.exit(0)
  } else {
    console.error('usage: miii provider [list [--all] | add <name> [baseUrl] [apiKey] | remove <name>]')
    process.exit(1)
  }
} else if (cmd === 'doctor' || cmd === 'eval') {
  const rest = args.filter((a) => a !== cmd)
  const { runEval } = await import('../eval/run.js')
  process.exit(await runEval(rest))
} else {
  // Warn about a malformed config BEFORE Ink mounts — once the TUI owns the
  // terminal, a raw stderr write gets scrambled or painted over.
  const cfgErr = configError()
  if (cfgErr) console.error(cfgErr)

  // Restore the terminal tab title on any exit path (Ink's unmount cleanup
  // can be skipped on a hard signal).
  // Mouse reporting gets the same treatment: a terminal left in click/wheel
  // tracking mode swallows selection in whatever shell inherits it.
  process.on('exit', () => {
    if (process.stdout.isTTY) process.stdout.write(`\x1b]2;\x07${MOUSE_OFF}`)
  })
  render(createElement(App))
}
