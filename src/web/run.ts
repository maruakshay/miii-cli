/**
 * `miii web` — start the browser UI for the project in the current directory.
 *
 *   miii web                 opens http://localhost:4747 in your browser
 *   miii web --port 8080     a fixed port (fails rather than moving if it's taken)
 *   miii web --no-open       just print the link (a remote box over an SSH tunnel)
 *   miii web -c              pick up the most recent session
 */
import { spawn } from 'child_process'
import { configError } from '../config.js'
import { loadSettings, settingsProblems } from '../settings.js'
import { initMcp, closeMcp } from '../mcp/registry.js'
import { startWeb, clientDir } from './server.js'

function openBrowser(url: string) {
  const [cmd, ...args] =
    process.platform === 'darwin' ? ['open', url]
      : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch { /* no browser to open — the link is printed either way */ }
}

export async function runWeb(argv: string[]): Promise<number> {
  const portIdx = argv.indexOf('--port')
  let port: number | undefined
  if (portIdx !== -1) {
    port = Number(argv[portIdx + 1])
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error('miii: --port needs a number between 0 and 65535')
      return 2
    }
  }
  const resumeIdx = argv.indexOf('--resume')
  const resumeId = resumeIdx !== -1 ? argv[resumeIdx + 1] : undefined
  const continueLast = argv.includes('--continue') || argv.includes('-c')

  const cfgErr = configError()
  if (cfgErr) console.error(cfgErr)
  loadSettings()
  for (const problem of settingsProblems()) console.error(`miii: ignoring ${problem.path} (${problem.message})`)
  if (!clientDir()) console.error('miii: the web app is not built — run `npm run build` (the page will say so too)')

  const mcp = await initMcp(process.cwd())
  for (const server of mcp) {
    if (!server.connected) console.error(`miii: MCP server "${server.name}" unavailable — ${server.error}`)
  }

  let web
  try {
    web = await startWeb({
      ...(port !== undefined ? { port } : {}),
      ...(resumeId ? { resumeId } : {}),
      ...(continueLast ? { continueLast } : {}),
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    console.error(e.code === 'EADDRINUSE' ? `miii: port ${port} is already in use — try another --port` : `miii: ${e.message}`)
    await closeMcp()
    return 1
  }

  console.log(`\n  miii is running at ${web.url}\n`)
  console.log(`  project  ${process.cwd()}`)
  console.log('  only this machine can reach it; the link carries the key — don\'t share it')
  console.log('  ctrl+c to stop\n')
  if (!argv.includes('--no-open')) openBrowser(web.url)

  return new Promise<number>((resolve) => {
    let stopping = false
    const shutdown = async () => {
      if (stopping) return
      stopping = true
      await web.close()
      await closeMcp()
      resolve(0)
    }
    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())
    // Started by `npm run dev:web`: Vite holds our stdin open, and it closing
    // means Vite is gone — however it went, including a kill that skips its cleanup.
    if (process.env.MIII_WEB_EXIT_WITH_PARENT) {
      process.stdin.on('close', () => void shutdown())
      process.stdin.on('end', () => void shutdown())
      process.stdin.resume()
    }
  })
}
