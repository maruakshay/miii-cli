import { useRef, useState, useCallback, useEffect } from 'react'
import { watch } from 'fs'
import type { FSWatcher } from 'fs'
import { tools as staticTools } from '../../tools/index.js'
import type { ChatMessage } from '../../types.js'
import * as printer from '../printer.js'

const WATCH_DEBOUNCE_MS = 600
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', 'coverage',
  '__pycache__', '.turbo', '.cache', '.parcel-cache', 'out',
])
const WATCH_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cpp|h|hpp|css|scss)$/

function testsFailed(output: string): boolean {
  // Explicit pass with no failures → passing
  if (/\b0 fail/i.test(output)) return false
  if (/\d+ pass/i.test(output) && !/\d+ fail/i.test(output)) return false
  return /\d+ fail|FAIL\b|✕|✗|\bfailing\b|AssertionError/i.test(output)
}

interface WatchDeps {
  runLoop: (msgs: ChatMessage[], depth?: number, goal?: string) => Promise<void>
  buildContext: () => ChatMessage[]
  pushHistory: (msg: ChatMessage) => void
}

export function useWatch(cwd: string, deps: WatchDeps) {
  const [watchActive, setWatchActive] = useState(false)
  const watcherRef = useRef<FSWatcher | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const changedRef = useRef<Set<string>>(new Set())
  const fixRunningRef = useRef(false)
  // Always-fresh deps via ref — watcher callback is set up once
  const depsRef = useRef(deps)
  useEffect(() => { depsRef.current = deps })

  const stopWatch = useCallback(() => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null }
    watcherRef.current?.close()
    watcherRef.current = null
    changedRef.current.clear()
    fixRunningRef.current = false
    setWatchActive(false)
    printer.systemMsg('watch: stopped')
  }, [])

  const startWatch = useCallback(() => {
    if (watcherRef.current) {
      printer.systemMsg('watch: already active — /watch stop to cancel')
      return
    }

    let watcher: FSWatcher
    try {
      watcher = watch(cwd, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const parts = (filename as string).split('/')
        if (parts.some(p => IGNORE_DIRS.has(p) || p.startsWith('.'))) return
        if (!WATCH_EXT.test(filename as string)) return

        changedRef.current.add(filename as string)
        if (debounceRef.current) clearTimeout(debounceRef.current)

        debounceRef.current = setTimeout(async () => {
          debounceRef.current = null
          const changed = [...changedRef.current]
          changedRef.current.clear()

          const testTool = staticTools.find(t => t.name === 'run_tests')
          if (!testTool) return

          const label = changed.length > 3
            ? `${changed.slice(0, 3).join(', ')} +${changed.length - 3} more`
            : changed.join(', ')
          printer.systemMsg(`watch: ${label} — running tests`)

          if (fixRunningRef.current) {
            printer.systemMsg('watch: fix in progress — skipping this cycle')
            return
          }
          fixRunningRef.current = true
          try {
            const result = await testTool.execute({})
            if (!result || result.startsWith('(no ')) return

            if (testsFailed(result)) {
              printer.systemMsg('watch: tests failing — triggering fix')
              const { pushHistory, buildContext, runLoop } = depsRef.current
              const fixMsg =
                `Tests are failing after changes to: ${changed.join(', ')}\n\n` +
                `Test output:\n${result}\n\n` +
                `Read the failing files and fix the issues.`
              pushHistory({ role: 'user', content: fixMsg })
              await runLoop(buildContext(), 0, 'fix failing tests')
            } else {
              printer.systemMsg('watch: tests passing')
            }
          } catch (e) {
            printer.errorMsg(`watch: ${e}`)
          } finally {
            fixRunningRef.current = false
          }
        }, WATCH_DEBOUNCE_MS)
      })
    } catch (e) {
      printer.errorMsg(`watch: failed to start: ${e}`)
      return
    }

    watcher.on('error', (err: Error) => {
      printer.errorMsg(`watch: ${err.message}`)
      stopWatch()
    })

    watcherRef.current = watcher
    setWatchActive(true)
    printer.systemMsg(`watch: active — monitoring ${cwd.replace(process.env.HOME ?? '', '~')}`)
  }, [cwd, stopWatch])

  // Cleanup on unmount
  useEffect(() => () => {
    watcherRef.current?.close()
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  return { watchActive, startWatch, stopWatch }
}
