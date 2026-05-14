import { useCallback, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { ChatMessage } from '../../types.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as printer from '../printer.js'

const runFile = promisify(execFile)

interface GitDeps {
  pushHistory: (msg: ChatMessage) => void
  buildContext: () => ChatMessage[]
  runLoop: (msgs: ChatMessage[], depth?: number, goal?: string) => Promise<void>
}

export function useGit(deps: GitDeps) {
  const depsRef = useRef(deps)
  depsRef.current = deps

  const handleGit = useCallback(async (sub: string) => {
    const { pushHistory, buildContext, runLoop } = depsRef.current

    const git = async (...args: string[]): Promise<string> => {
      try {
        const { stdout, stderr } = await runFile('git', args, { timeout: 15_000 })
        return (stdout + stderr).trim()
      } catch (e: any) {
        return e.message ?? String(e)
      }
    }

    if (!sub || sub === 'status') { printer.systemMsg(await git('status')); return }

    if (sub === 'log' || sub.startsWith('log ')) {
      const n = parseInt(sub.split(' ')[1] ?? '10', 10) || 10
      printer.systemMsg(await git('log', '--oneline', '--decorate', `-${Math.min(n, 50)}`))
      return
    }

    if (sub === 'diff' || sub.startsWith('diff ')) {
      const extra = sub.slice(4).trim()
      const args = ['diff', ...extra.split(/\s+/).filter(Boolean)]
      const out = await git(...args)
      printer.systemMsg(out.length > 6000 ? out.slice(0, 6000) + '\n…[truncated]' : out || '(no diff)')
      return
    }

    if (sub === 'review') {
      const diff = await git('diff', 'HEAD')
      const staged = await git('diff', '--staged')
      const combined = [diff, staged].filter(Boolean).join('\n').trim()
      if (!combined || combined === '(no diff)') { printer.systemMsg('no changes to review'); return }
      const truncated = combined.length > 8000 ? combined.slice(0, 8000) + '\n…[truncated]' : combined
      const userMsg = `Review these git changes for bugs, issues, and improvements:\n\n${truncated}`
      printer.userMsg('/git review')
      pushHistory({ role: 'user', content: userMsg })
      await runLoop(buildContext())
      return
    }

    if (sub === 'branch' || sub.startsWith('branch ')) {
      const extra = sub.slice(6).trim()
      printer.systemMsg(await git('branch', ...extra.split(/\s+/).filter(Boolean)) || '(done)')
      return
    }

    if (sub.startsWith('commit ')) {
      const msg = sub.slice(7).trim()
      if (!msg) { printer.systemMsg('usage: /git commit <message>'); return }
      const gitStatus = await git('status', '--short')
      if (!gitStatus || gitStatus === '(clean — no changes)') {
        printer.systemMsg('nothing to commit — working tree clean')
        return
      }
      printer.systemMsg(`staging and committing:\n${gitStatus}`)
      const stageOut = await git('add', '-A')
      if (stageOut) printer.systemMsg(stageOut)
      printer.systemMsg(await git('commit', '-m', msg))
      return
    }

    // Catch-all: split on whitespace and run via execFile (no shell expansion)
    const parts = sub.split(/\s+/).filter(Boolean)
    if (!parts.length) { printer.systemMsg('usage: /git <subcommand>'); return }
    printer.systemMsg(await git(...parts) || '(done)')
  }, [])

  return { handleGit }
}
