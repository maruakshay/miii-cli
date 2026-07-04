import { Box, Text } from 'ink'
import { highlight, supportsLanguage } from 'cli-highlight'
import type { ToolUseDisplay, ToolResultDisplay } from './types.js'
import { useToolExpanded } from './toolExpand.js'
import { countLines, truncate } from './layout.js'

// Tool output is collapsed to a few lines by default; ctrl+o toggles full view.
const COLLAPSED_LINES = 3

export const TOOL_LABEL: Record<string, string> = {
  write_file: 'Write',
  edit_file: 'Update',
  read_file: 'Read',
  run_bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  write_todos: 'Todos',
}

// hljs language name keyed by file extension; undefined = render plain (no highlight).
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  html: 'xml', xml: 'xml', css: 'css', scss: 'scss', sql: 'sql', md: 'markdown',
}

function langFromPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}

function highlightLine(text: string, lang: string | undefined): string {
  // Guard unknown langs: cli-highlight logs a console warning before throwing,
  // which the catch can't suppress and would spam once per diff line.
  if (!lang || !supportsLanguage(lang)) return text
  try {
    return highlight(text, { language: lang, ignoreIllegals: true })
  } catch {
    return text
  }
}

function FileEditBlock({
  label,
  path,
  added,
  removed,
  previewLines,
}: {
  label: string
  path: string
  added: number
  removed: number
  previewLines: Array<{ sign: '+' | '-' | ' '; text: string }>
}) {
  const expanded = useToolExpanded()
  const shown = expanded ? previewLines : previewLines.slice(0, COLLAPSED_LINES)
  const extra = previewLines.length - shown.length
  const lang = langFromPath(path)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="green">● </Text>
        <Text color="white">{label} </Text>
        <Text>(</Text>
        <Text bold>{path}</Text>
        <Text>)</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>
          {'⎿  '}
          {removed > 0 ? `Added ${added} lines, removed ${removed} lines` : `Added ${added} lines`}
        </Text>
      </Box>
      {shown.map((ln, i) => {
        // left indent is 6 (marginLeft 2 + 4); pad to leave a 20-col right margin
        const width = (process.stdout.columns ?? 80) - 6 - 20
        // sign + space take 2 cols; truncate/pad the code text on plain length,
        // then apply ANSI highlight so column math stays correct.
        const textWidth = Math.max(0, width - 2)
        const plain = ln.text.length > textWidth ? ln.text.slice(0, textWidth) : ln.text.padEnd(textWidth)
        const code = ln.sign === ' ' ? plain : highlightLine(plain, lang)
        return (
          <Box key={i} marginLeft={4}>
            <Text
              wrap="truncate"
              backgroundColor={
                ln.sign === '-'
                  ? '#3b1414'
                  : ln.sign === '+' && label !== 'Write'
                    ? '#13351f'
                    : undefined
              }
              dimColor={ln.sign === ' '}
            >
              {`${ln.sign} `}{code}
            </Text>
          </Box>
        )
      })}
      {extra > 0 && (
        <Box marginLeft={4}>
          <Text dimColor>… {extra} more lines · ctrl+o to expand</Text>
        </Box>
      )}
    </Box>
  )
}

type TodoStatus = 'pending' | 'in_progress' | 'completed'
type TodoItem = { content: string; status: TodoStatus }

// Live task checklist rendered like a kanban board: every item shows its column
// (done / in progress / todo) so the user can see progress at a glance. The list
// lives in the tool's input, redrawn in full on each call.
function TodoBlock({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  const doing = todos.filter((t) => t.status === 'in_progress').length
  const glyph: Record<TodoStatus, string> = { completed: '✔', in_progress: '▶', pending: '○' }
  const color: Record<TodoStatus, string> = { completed: 'green', in_progress: 'yellow', pending: 'gray' }
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="green">● </Text>
        <Text color="white">Todos </Text>
        <Text dimColor>
          ({done}/{todos.length} done{doing > 0 ? `, ${doing} in progress` : ''})
        </Text>
      </Box>
      {todos.map((t, i) => (
        <Box key={i} marginLeft={4}>
          <Text color={color[t.status]}>{glyph[t.status]} </Text>
          <Text
            color={t.status === 'in_progress' ? 'yellow' : undefined}
            dimColor={t.status !== 'in_progress'}
            strikethrough={t.status === 'completed'}
            bold={t.status === 'in_progress'}
          >
            {t.content}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function toolHeader(use: ToolUseDisplay): { label: string; arg: string } {
  const label = TOOL_LABEL[use.name] ?? use.name
  const input = (use.input ?? {}) as Record<string, unknown>
  let arg = ''
  switch (use.name) {
    case 'write_file':
    case 'edit_file':
    case 'read_file':
      arg = String(input.path ?? input.file_path ?? '')
      break
    case 'run_bash': {
      const cmd = String(input.command ?? '').replace(/\s+/g, ' ')
      arg = truncate(cmd, 120)
      break
    }
    case 'glob':
    case 'grep':
      arg = truncate(String(input.pattern ?? ''), 120)
      break
    default: {
      arg = truncate(JSON.stringify(input), 80)
    }
  }
  return { label, arg }
}

function summarizeResult(res: ToolResultDisplay, toolName?: string): string {
  const content = res.content ?? ''
  const lines = content.split('\n')
  if (!res.is_error) {
    if (toolName === 'read_file') {
      const total = lines.length
      return `Read ${total} line${total === 1 ? '' : 's'}`
    }
    if (toolName === 'grep') {
      if (content === 'No matches.') return 'No matches'
      const n = lines.filter(Boolean).length
      return `${n} match${n === 1 ? '' : 'es'}`
    }
    if (toolName === 'glob') {
      if (content === 'No files matched.') return 'No files'
      const n = lines.filter(Boolean).length
      return `${n} file${n === 1 ? '' : 's'}`
    }
  }
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? ''
  const extra = lines.length - 1
  const head = firstNonEmpty.length > 100 ? firstNonEmpty.slice(0, 97) + '...' : firstNonEmpty
  return extra > 0 ? `${head} (+${extra} lines)` : head
}

function ToolResultBlock({ result, toolName }: { result: ToolResultDisplay; toolName: string }) {
  const expanded = useToolExpanded()
  const content = result.content ?? ''
  const lines = content.split('\n')
  const showMulti =
    (toolName === 'run_bash' || toolName === 'grep' || toolName === 'glob' || result.is_error) &&
    lines.length > 1
  if (!showMulti) {
    return (
      <Box marginLeft={2}>
        <Text color={result.is_error ? 'red' : undefined} dimColor={!result.is_error}>
          {'⎿  '}{summarizeResult(result, toolName)}
        </Text>
      </Box>
    )
  }
  const MAX_LINE_WIDTH = 200
  const visible = expanded ? lines : lines.slice(0, COLLAPSED_LINES)
  const shown = visible.map((l) => truncate(l, MAX_LINE_WIDTH))
  const extra = lines.length - shown.length
  // grep/glob summarize to a count; for bash/errors the summary echoes the first
  // content line, which the body below also prints — so use a count header instead.
  const header =
    toolName === 'grep' || toolName === 'glob'
      ? summarizeResult(result, toolName)
      : `${lines.length} line${lines.length === 1 ? '' : 's'}`
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={result.is_error ? 'red' : undefined} dimColor={!result.is_error}>
        {'⎿  '}{header}
      </Text>
      {shown.map((ln, i) => (
        <Box key={i} marginLeft={4}>
          <Text color={result.is_error ? 'red' : undefined} dimColor>{ln || ' '}</Text>
        </Box>
      ))}
      {extra > 0 && (
        <Box marginLeft={4}>
          <Text dimColor>… {extra} more lines · ctrl+o to expand</Text>
        </Box>
      )}
    </Box>
  )
}

export function ToolUseLine({ use, result }: { use: ToolUseDisplay; result?: ToolResultDisplay }) {
  if (use.name === 'write_todos' && !result?.is_error) {
    const todos = (use.input as { todos?: TodoItem[] }).todos
    if (Array.isArray(todos) && todos.length > 0) return <TodoBlock todos={todos} />
  }
  if (use.name === 'write_file' && !result?.is_error) {
    const input = use.input as { path?: string; content?: string }
    const content = input.content ?? ''
    const added = countLines(content)
    const preview = content.split('\n').map((t) => ({ sign: '+' as const, text: t }))
    return <FileEditBlock label="Write" path={input.path ?? ''} added={added} removed={0} previewLines={preview} />
  }
  if (use.name === 'edit_file' && !result?.is_error) {
    const input = use.input as {
      path?: string
      old_str?: string
      new_str?: string
      edits?: Array<{ old_str?: string; new_str?: string }>
    }
    // Batch mode carries an edits[]; single mode carries old_str/new_str. Fold
    // both into one -/+ preview so the diff block renders either shape.
    const pairs =
      Array.isArray(input.edits) && input.edits.length > 0
        ? input.edits.map((e) => ({ oldS: e.old_str ?? '', newS: e.new_str ?? '' }))
        : [{ oldS: input.old_str ?? '', newS: input.new_str ?? '' }]
    let added = 0
    let removed = 0
    const preview: Array<{ sign: '+' | '-' | ' '; text: string }> = []
    for (const { oldS, newS } of pairs) {
      added += countLines(newS)
      removed += countLines(oldS)
      preview.push(...oldS.split('\n').map((t) => ({ sign: '-' as const, text: t })))
      preview.push(...newS.split('\n').map((t) => ({ sign: '+' as const, text: t })))
    }
    return <FileEditBlock label="Update" path={input.path ?? ''} added={added} removed={removed} previewLines={preview} />
  }
  const { label, arg } = toolHeader(use)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="green">● </Text>
        <Text color="white">{label} </Text>
        <Text>(</Text>
        <Text bold>{arg}</Text>
        <Text>)</Text>
      </Box>
      {result && <ToolResultBlock result={result} toolName={use.name} />}
    </Box>
  )
}
