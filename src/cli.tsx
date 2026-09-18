#!/usr/bin/env node
import { render } from 'ink'
import { createElement } from 'react'
import { App, type AppProps } from './ui/App.js'
import { DISABLE as MOUSE_OFF } from './ui/mouse.js'
import { cleanupSpill } from './tools/spill.js'
import { setProvider, listProviders, providerEntries, apiKeyFor, configError, type Provider } from './config.js'
import { parseHeadlessArgs, readStdin, runHeadless } from './headless.js'
import { settingsProblems, loadSettings } from './settings.js'

// Drop yesterday's spilled tool output before starting. Best-effort.
cleanupSpill()

const args = process.argv.slice(2)

const HELP = `miii — local AI coding agent

Usage
  miii                          start the interactive session
  miii -p "<prompt>"            run one turn and print the answer
  cat file | miii -p "<task>"   the piped text is prepended to the prompt

Session
  -c, --continue                resume the most recent session
      --resume <id>             resume a specific session

Headless (-p)
      --output-format <fmt>     text (default) | json | stream-json
      --permission-mode <mode>  default | plan | acceptEdits | bypass
      --dangerously-skip-permissions
      --allowed-tools a,b,c     restrict the agent to these tools
      --max-turns <n>           stop after n tool-use turns
      --model <name>            override the configured model

Everywhere
      --provider <name>         use a configured backend for this run
  -v, --version                 print the version
      --help                    this text

Subcommands
  miii doctor                   grade your installed models on real tasks
  miii provider [list|add|remove]
  miii update                   install the latest release
`

/**
 * `--provider` is read before anything dispatches, because every path below —
 * headless, the TUI, `doctor` — needs the backend already selected. `-P` is the
 * short form; `-p` belongs to --print, which is what a script reaches for far
 * more often than a one-off backend switch.
 */
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--provider' || args[i] === '-P') && i + 1 < args.length) {
    const p = args[i + 1] as Provider
    if (listProviders().includes(p)) setProvider(p)
  }
}

/** The first bare word that isn't the value of a flag — the subcommand, if any. */
function firstCommand(argv: string[]): string | undefined {
  const takesValue = new Set(['--provider', '-P', '--model', '--resume', '--output-format', '--permission-mode', '--max-turns', '--allowed-tools', '--allowedTools'])
  for (let i = 0; i < argv.length; i++) {
    if (takesValue.has(argv[i])) { i++; continue }
    if (argv[i].startsWith('-')) continue
    return argv[i]
  }
  return undefined
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

const cmd = firstCommand(args)

if (cmd === 'version' || args.includes('--version') || args.includes('-v')) {
  const { createRequire } = await import('module')
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
  console.log(pkg.version)
  process.exit(0)
} else if (cmd === 'update' || args.includes('--update') || args.includes('-u')) {
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
  const headless = parseHeadlessArgs(args)
  if (headless.error) {
    console.error(`miii: ${headless.error}`)
    process.exit(2)
  }

  if (headless.options) {
    // Piped input becomes context above the prompt rather than replacing it, so
    // `git diff | miii -p "review this"` has both the diff and the instruction.
    // With no prompt flag argument at all, the piped text IS the prompt.
    const piped = (await readStdin()).trim()
    const opts = headless.options
    const prompt = piped
      ? opts.prompt
        ? `${opts.prompt}\n\n<stdin>\n${piped}\n</stdin>`
        : piped
      : opts.prompt
    if (!prompt.trim()) {
      console.error('miii: -p needs a prompt, as an argument or on stdin')
      process.exit(2)
    }
    process.exit(await runHeadless({ ...opts, prompt }))
  }

  // Warn about a malformed config BEFORE Ink mounts — once the TUI owns the
  // terminal, a raw stderr write gets scrambled or painted over.
  const cfgErr = configError()
  if (cfgErr) console.error(cfgErr)
  loadSettings()
  for (const problem of settingsProblems()) {
    console.error(`miii: ignoring ${problem.path} (${problem.message})`)
  }

  const resumeIdx = args.indexOf('--resume')
  const resumeId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined
  const continueLast = args.includes('--continue') || args.includes('-c')

  // Restore the terminal tab title on any exit path (Ink's unmount cleanup
  // can be skipped on a hard signal).
  // Mouse reporting gets the same treatment: a terminal left in click/wheel
  // tracking mode swallows selection in whatever shell inherits it.
  process.on('exit', () => {
    if (process.stdout.isTTY) process.stdout.write(`\x1b]2;\x07${MOUSE_OFF}`)
  })
  render(createElement(App, { resumeId, continueLast } satisfies AppProps))
}
