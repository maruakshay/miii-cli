#!/usr/bin/env node
import { render } from 'ink'
import { createElement } from 'react'
import { App } from './ui/App.js'
import { cleanupSpill } from './tools/spill.js'
import { setProvider, type Provider } from './config.js'

// Drop yesterday's spilled tool output before starting. Best-effort.
cleanupSpill()

const args = process.argv.slice(2)
let cmd: string | undefined

// Parse --provider / -p before the main command
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--provider' || args[i] === '-p') && i + 1 < args.length) {
    const p = args[++i] as Provider
    if (p === 'ollama' || p === 'lmstudio') setProvider(p)
  } else if (!cmd) {
    cmd = args[i]
  }
}

if (cmd === 'update' || cmd === '--update' || cmd === '-u') {
  const { spawnSync } = await import('child_process')
  console.log('Updating miii-agent…')
  const r = spawnSync('npm', ['i', '-g', 'miii-agent@latest'], { stdio: 'inherit', shell: process.platform === 'win32' })
  process.exit(r.status ?? 1)
} else if (cmd === 'doctor' || cmd === 'eval') {
  const rest = args.filter((a) => a !== cmd)
  const { runEval } = await import('../eval/run.js')
  process.exit(await runEval(rest))
} else {
  render(createElement(App))
}
