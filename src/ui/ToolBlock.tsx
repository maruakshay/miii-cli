import { useEffect, useRef, type ReactNode } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { highlight, supportsLanguage } from 'cli-highlight'
import type { ToolUseDisplay, ToolResultDisplay } from './types.js'
import type { DiffLine, FileDiff } from '../diff.js'
import { useToolExpanded } from './toolExpand.js'
import { registerToolBlock, unregisterToolBlock } from './toolHit.js'
import { describeTool, TOOL_LABEL } from './toolLabel.js'
import { countLines, truncate } from './layout.js'
import { renderMarkdown } from './markdown.js'

// Tool output is collapsed to a few lines by default; a click or ctrl+o toggles full view.
const COLLAPSED_LINES = 3
// A diff carries context lines around each change, so it needs a bigger budget
// than a flat output block before collapsing tells the reader nothing.
const COLLAPSED_DIFF_LINES = 12

export { TOOL_LABEL }

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

/**
 * Wraps one tool block and publishes its node, so a click on any of its rows
 * can be traced back to this block and expand only it.
 */
function ToolBlockFrame({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<DOMElement | null>(null)
  useEffect(() => {
    if (ref.current) registerToolBlock(id, ref.current)
    return () => unregisterToolBlock(id)
  }, [id])
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  )
}

/**
 * The one line every tool block leads with: what the call does, in English.
 *
 * "Running the tests" is what a reader skimming the transcript needs; the exact
 * call — Bash(npm test -- --run) — is a detail they want only when something
 * looks wrong, so it appears under the headline once the block is expanded
 * (click anywhere, or ctrl+o).
 */
function ToolHeader({ use }: { use: ToolUseDisplay }) {
  const expanded = useToolExpanded(use.id)
  const { text, technical } = describeTool(use.name, use.input)
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">● </Text>
        <Text color="white">{text}</Text>
      </Box>
      {expanded && (
        <Box marginLeft={2}>
          <Text dimColor>{technical}</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * A file change, rendered the way a reviewer reads one: a line-number gutter,
 * unchanged context around each hunk, removed lines on red and added lines on
 * green. The tool computes the real before/after diff (src/diff.ts) — the UI
 * only paints it, so a one-word change shows as one line, not as the whole
 * block deleted and re-added.
 */
function DiffBlock({ use, label, diff }: { use: ToolUseDisplay; label: string; diff: FileDiff }) {
  const expanded = useToolExpanded(use.id)
  const lang = langFromPath(diff.path)

  // Flatten hunks into rows, with a marker for each stretch of skipped lines.
  type Row = { gap: true } | { gap: false; line: DiffLine }
  const rows: Row[] = []
  diff.hunks.forEach((h, i) => {
    if (i > 0) rows.push({ gap: true })
    for (const line of h.lines) rows.push({ gap: false, line })
  })

  const shown = expanded ? rows : rows.slice(0, COLLAPSED_DIFF_LINES)
  const extra = rows.filter((r) => !r.gap).length - shown.filter((r) => !r.gap).length

  // Gutter width from the largest number in the whole diff, not just the
  // visible slice, so expanding doesn't shift every row sideways.
  const maxNo = rows.reduce((m, r) => {
    if (r.gap) return m
    return Math.max(m, r.line.newNo ?? 0, r.line.oldNo ?? 0)
  }, 0)
  const numWidth = Math.max(2, String(maxNo).length)

  // left indent is 6 (marginLeft 2 + 4); leave a right margin so the painted
  // background doesn't run into the terminal edge.
  const width = Math.max(20, (process.stdout.columns ?? 80) - 6 - 20)
  const textWidth = Math.max(0, width - numWidth - 2)

  const verb = label === 'Write' ? 'Wrote' : 'Updated'
  const counts = `+${diff.added}${diff.removed > 0 ? ` −${diff.removed}` : ''}`

  return (
    <Box flexDirection="column" marginLeft={2}>
      <ToolHeader use={use} />
      <Box marginLeft={2}>
        <Text dimColor>
          {'⎿  '}
          {diff.hunks.length === 0 ? `${verb} ${diff.path} (no changes)` : `${verb} ${diff.path} (${counts})`}
        </Text>
      </Box>
      {shown.map((row, i) => {
        if (row.gap) {
          return (
            <Box key={i} marginLeft={4}>
              <Text dimColor>{'⋮'.padStart(numWidth)}</Text>
            </Box>
          )
        }
        const { sign, oldNo, newNo, text } = row.line
        // A removed line is numbered in the OLD file, everything else in the new.
        const no = sign === '-' ? oldNo : newNo
        const gutter = String(no ?? '').padStart(numWidth)
        // Truncate/pad on plain text so the painted rectangle stays rectangular,
        // then colour it — ANSI escapes would break the column arithmetic.
        const plain = text.length > textWidth ? text.slice(0, textWidth) : text.padEnd(textWidth)
        const code = sign === ' ' ? plain : highlightLine(plain, lang)
        return (
          <Box key={i} marginLeft={4}>
            <Text
              wrap="truncate"
              backgroundColor={sign === '-' ? '#3b1414' : sign === '+' ? '#13351f' : undefined}
              dimColor={sign === ' '}
            >
              {gutter}{sign === ' ' ? '  ' : ` ${sign}`}{code}
            </Text>
          </Box>
        )
      })}
      {extra > 0 && (
        <Box marginLeft={4}>
          <Text dimColor>… {extra} more lines · click or ctrl+o to expand</Text>
        </Box>
      )}
      {diff.truncated ? (
        <Box marginLeft={4}>
          <Text dimColor>… {diff.truncated} further changed lines not shown</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * The diff before the tool has run — built from old_str/new_str alone, so it
 * has no line numbers and no context. Shown while the call is in flight, and
 * for transcripts written before tools carried a diff.
 */
function FileEditBlock({
  use,
  label,
  path,
  added,
  removed,
  previewLines,
}: {
  use: ToolUseDisplay
  label: string
  path: string
  added: number
  removed: number
  previewLines: Array<{ sign: '+' | '-' | ' '; text: string }>
}) {
  const expanded = useToolExpanded(use.id)
  const shown = expanded ? previewLines : previewLines.slice(0, COLLAPSED_LINES)
  const extra = previewLines.length - shown.length
  const lang = langFromPath(path)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <ToolHeader use={use} />
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
          <Text dimColor>… {extra} more lines · click or ctrl+o to expand</Text>
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
        <Text color="white">Updating the task list </Text>
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

function ToolResultBlock({ id, result, toolName }: { id: string; result: ToolResultDisplay; toolName: string }) {
  const expanded = useToolExpanded(id)
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
          <Text dimColor>… {extra} more lines · click or ctrl+o to expand</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * The proposed plan, rendered in full.
 *
 * Every other tool block collapses, because the user is skimming what the agent
 * did. This one is the thing they are being asked to approve, so it never
 * truncates and never hides behind ctrl+o — a plan you have to expand to read
 * is a plan you approve without reading.
 */
function PlanBlock({ plan, result }: { plan: string; result?: ToolResultDisplay }) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text color="cyan" bold>Proposed plan</Text>
        <Box marginTop={1}>
          <Text>{renderMarkdown(plan.trim())}</Text>
        </Box>
      </Box>
      {result && (
        <Text color={result.is_error ? 'yellow' : 'green'}>
          {'⎿  '}{result.is_error ? 'kept planning' : 'approved — starting work'}
        </Text>
      )}
    </Box>
  )
}

export function ToolUseLine({ use, result }: { use: ToolUseDisplay; result?: ToolResultDisplay }) {
  return (
    <ToolBlockFrame id={use.id}>
      <ToolUseBody use={use} result={result} />
    </ToolBlockFrame>
  )
}

function ToolUseBody({ use, result }: { use: ToolUseDisplay; result?: ToolResultDisplay }) {
  if (use.name === 'exit_plan_mode') {
    const plan = (use.input as { plan?: string }).plan
    if (typeof plan === 'string' && plan.trim()) return <PlanBlock plan={plan} result={result} />
  }
  if (use.name === 'write_todos' && !result?.is_error) {
    const todos = (use.input as { todos?: TodoItem[] }).todos
    if (Array.isArray(todos) && todos.length > 0) return <TodoBlock todos={todos} />
  }
  if ((use.name === 'write_file' || use.name === 'edit_file') && result?.diff && !result.is_error) {
    return <DiffBlock use={use} label={use.name === 'write_file' ? 'Write' : 'Update'} diff={result.diff} />
  }
  if (use.name === 'write_file' && !result?.is_error) {
    const input = use.input as { path?: string; content?: string }
    const content = input.content ?? ''
    const added = countLines(content)
    const preview = content.split('\n').map((t) => ({ sign: '+' as const, text: t }))
    return <FileEditBlock use={use} label="Write" path={input.path ?? ''} added={added} removed={0} previewLines={preview} />
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
    return <FileEditBlock use={use} label="Update" path={input.path ?? ''} added={added} removed={removed} previewLines={preview} />
  }
  return (
    <Box flexDirection="column" marginLeft={2}>
      <ToolHeader use={use} />
      {result && <ToolResultBlock id={use.id} result={result} toolName={use.name} />}
    </Box>
  )
}
