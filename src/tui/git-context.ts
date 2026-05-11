import { readFile } from '../files/ops.js'
import { resolve } from 'path'
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

    const MAX_TOTAL = 40_000
    const MAX_FILE  = 15_000
    let total = 0
    const parts: string[] = []
    const skipped: string[] = []

    for (const line of status.split('\n')) {
      const code = line.slice(0, 2)
      if (code.includes('D')) continue
      const raw = line.slice(3).trim().replace(/^"|"$/g, '')
      const rel  = raw.includes(' -> ') ? raw.split(' -> ')[1]! : raw
      if (!rel) continue
      try {
        const content = readFile(resolve(cwd, rel))
        if (!content || content.length > MAX_FILE) { skipped.push(rel); continue }
        total += content.length
        if (total > MAX_TOTAL) { skipped.push(rel); continue }
        parts.push(`<file path="${rel}">\n${content}\n</file>`)
      } catch { skipped.push(rel) }
    }

    if (!parts.length && !skipped.length) return { prefix: '', label: '' }
    let prefix = '[Auto-context: git-changed files]\n' + parts.join('\n') + '\n'
    if (skipped.length) prefix += `Files changed but too large to auto-load: ${skipped.join(', ')}\n`
    prefix += '\n'
    const label = `auto-loaded ${parts.length} changed file(s)${skipped.length ? `, skipped ${skipped.length} (too large)` : ''}`
    return { prefix, label }
  } catch {
    return { prefix: '', label: '' }
  }
}
