import { execa } from 'execa'
import { spillIfLarge } from './spill.js'
import type { Tool } from './types.js'

interface Input {
  command: string
  timeout_ms?: number
}

/**
 * Kill the whole process tree rooted at `pid`, not just the direct child.
 * execa's built-in timeout only SIGTERMs the shell we spawned — a `bash -c`
 * that forked a build/test process leaves that grandchild running. On POSIX we
 * spawn detached (child is its own process-group leader) so a negative-pid kill
 * takes out the group; on Windows we shell out to taskkill /T.
 */
function killTree(pid: number | undefined, isWin: boolean): void {
  if (!pid) return
  try {
    if (isWin) {
      execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    /* process already gone — nothing to kill */
  }
}

export const run_bash: Tool<Input> = {
  name: 'run_bash',
  description: 'Execute a shell command (bash on Unix, cmd on Windows). Returns stdout+stderr. Non-interactive only.',
  input_schema: {
    type: 'object',
    properties: {
      command:    { type: 'string', description: 'Shell command to run' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000). Raise it for long builds/test suites.' },
    },
    required: ['command'],
  },
  handler: async ({ command, timeout_ms }, ctx) => {
    const isWin = process.platform === 'win32'
    const shell = isWin ? 'cmd' : 'bash'
    const shellArgs = isWin ? ['/c', command] : ['-c', command]
    const timeout = timeout_ms ?? 120000

    // Own timeout + tree-kill instead of execa's `timeout` so a forked grandchild
    // process can't outlive the call. `all:true` interleaves stdout/stderr in the
    // real order they were written (the old filter+join lost that ordering).
    const child = execa(shell, shellArgs, {
      reject: false,
      all: true,
      detached: !isWin, // POSIX: new process group so killTree(-pid) hits the whole tree
    })

    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid, isWin)
    }, timeout)
    const onAbort = () => {
      aborted = true
      killTree(child.pid, isWin)
    }
    ctx?.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const { all, exitCode } = await child
      const out = all ?? ''
      const is_error = aborted || timedOut || exitCode !== 0
      const note = timedOut
        ? `\n[Timed out after ${timeout}ms, so I stopped the command and everything it started. Raise timeout_ms for long builds or test suites.]`
        : aborted
          ? `\n[Cancelled — I stopped the command and everything it started.]`
          : ''
      const body = out || (is_error ? `(no output)` : '')
      const content = `${spillIfLarge(body, 'command output')}\n[exit ${exitCode ?? 'killed'}]${note}`
      return { content, is_error }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    } finally {
      clearTimeout(timer)
      ctx?.signal?.removeEventListener('abort', onAbort)
    }
  },
}
