import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('..', import.meta.url))
const apiPort = Number(process.env.MIII_WEB_PORT ?? 4747)
// Resolved from this repo, not the project the agent runs in — that has no tsx.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href

/**
 * `npm run dev:web` in one step: start the agent server from source alongside
 * Vite, then print a single link — Vite's origin with the server's token — so
 * there is no second terminal to forget and no token to copy across.
 *
 * The agent works on MIII_PROJECT, else the directory npm was run from
 * (`npm --prefix ~/miii-cli run dev:web` from inside a project does the right
 * thing). Set MIII_WEB_EXTERNAL=1 to use a `miii web` you started yourself.
 */
function miiiServer(): Plugin {
  let child: ChildProcess | null = null
  return {
    name: 'miii-server',
    apply: 'serve',
    configureServer(server) {
      if (process.env.MIII_WEB_EXTERNAL) return
      const project = process.env.MIII_PROJECT ?? process.env.INIT_CWD ?? repo
      child = spawn(
        process.execPath,
        ['--import', tsx, `${repo}src/cli.tsx`, 'web', '--no-open', '--port', String(apiPort)],
        // stdin stays open for as long as Vite lives; the server exits when it closes.
        { cwd: project, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MIII_WEB_EXIT_WITH_PARENT: '1' } },
      )
      const log = server.config.logger
      child.stdout!.on('data', (buf: Buffer) => {
        const token = /#token=([\w-]+)/.exec(buf.toString())?.[1]
        if (!token) return
        const port = server.config.server.port ?? 5173
        log.info(`\n  miii agent ready · project ${project}`)
        log.info(`  ➜  open http://localhost:${port}/#token=${token}\n`)
      })
      child.stderr!.on('data', (buf: Buffer) => log.warn(`[miii] ${buf.toString().trimEnd()}`))
      child.on('exit', (code) => {
        if (code) log.error(`[miii] agent server exited (${code}) — see above. If port ${apiPort} is taken: MIII_WEB_PORT=4800 npm run dev:web`)
        child = null
      })
      const stop = () => child?.kill()
      server.httpServer?.on('close', stop)
      process.once('exit', stop)
    },
  }
}

// `npm run build` writes the app to dist/web, where `miii web` serves it from.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss(), miiiServer()],
  resolve: { alias: { '@': `${here}src` } },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}` } },
  },
})
