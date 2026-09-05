import { Box, Text } from 'ink'
import { readdirSync } from 'fs'
import { join, relative } from 'path'

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.miii'])
const MAX_RESULTS = 10
const MAX_SCAN = 2000
const CACHE_TTL_MS = 2000

let cache: { cwd: string; files: string[]; at: number } | null = null

export function invalidateFileCache(): void {
  cache = null
}

function listFiles(cwd: string): string[] {
  if (cache && cache.cwd === cwd && Date.now() - cache.at < CACHE_TTL_MS) return cache.files
  const out: string[] = []
  const stack: string[] = [cwd]
  while (stack.length && out.length < MAX_SCAN) {
    const dir = stack.pop()!
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) out.push(relative(cwd, full))
      if (out.length >= MAX_SCAN) break
    }
  }
  cache = { cwd, files: out, at: Date.now() }
  return out
}

export function parseMention(input: string): { query: string; start: number } | null {
  const m = input.match(/(?:^|\s)@([^\s]*)$/)
  if (!m) return null
  return { query: m[1], start: input.length - m[1].length - 1 }
}

export function searchFiles(cwd: string, query: string): string[] {
  const files = listFiles(cwd)
  const q = query.toLowerCase()
  if (!q) return files.slice(0, MAX_RESULTS)
  const scored: Array<[number, string]> = []
  for (const f of files) {
    const lf = f.toLowerCase()
    const idx = lf.indexOf(q)
    if (idx === -1) continue
    const base = lf.split('/').pop() ?? lf
    const baseIdx = base.indexOf(q)
    const score = baseIdx === 0 ? 0 : baseIdx > -1 ? 1 : 2 + idx
    scored.push([score, f])
    if (scored.length > 500) break
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length)
  return scored.slice(0, MAX_RESULTS).map(([, f]) => f)
}

interface Props {
  matches: string[]
  cursor: number
}

export function FilePicker({ matches, cursor }: Props) {
  if (matches.length === 0) return null
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      marginX={1}
      marginBottom={0}
      paddingX={1}
    >
      {matches.map((f, i) => {
        const active = i === cursor
        return (
          <Box key={f}>
            <Text bold={active} color={active ? 'blue' : undefined} dimColor={!active}>
              {active ? '❯ ' : '  '}{f}
            </Text>
          </Box>
        )
      })}
      <Box marginTop={0}>
        <Text dimColor>↑↓ navigate   tab insert   esc dismiss</Text>
      </Box>
    </Box>
  )
}
