import { exec } from 'child_process'
import { promisify } from 'util'

const gitRun = promisify(exec)

const CODE_PATTERN = /\.(ts|js|tsx|jsx|py|go|rs|java|rb|sh|css|html|json|yaml|yml)\b|function|class|import|export|const|let|var|def |async|await|error|bug|fix|refactor|implement|`[^`]+`/i

export function looksCodeRelated(text: string): boolean {
  return text.length >= 10 && CODE_PATTERN.test(text)
}

export async function buildGitContext(cwd: string, lastStatusRef: { current: string }): Promise<{ prefix: string; label: string }> {
  try {
    const { stdout } = await gitRun('git status --short', { cwd, timeout: 5000 })
    const status = stdout.trim()
    if (!status || status === lastStatusRef.current) return { prefix: '', label: '' }
    lastStatusRef.current = status

    const files = status.split('\n')
      .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter(Boolean)

    const prefix = `[Git: ${files.length} changed file(s)]\n${status}\n\n`
    const label = `git: ${files.length} changed file(s) in context`
    return { prefix, label }
  } catch {
    return { prefix: '', label: '' }
  }
}
