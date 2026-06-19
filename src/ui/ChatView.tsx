import { memo, useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { ThinkingBlock } from './ThinkingBlock.js'
import type { ChatMessage, ToolUseDisplay, ToolResultDisplay, PermissionRequest } from './types.js'
import { EMPTY_STATE_HINTS, EMPTY_STATE_TITLE, } from './constants.js'

// Tool output is collapsed to a few lines by default; ctrl+o toggles full view.
const COLLAPSED_LINES = 3

let globalToolExpanded = false
const toolExpandListeners = new Set<() => void>()

export function toggleToolExpanded() {
  globalToolExpanded = !globalToolExpanded
  toolExpandListeners.forEach((fn) => fn())
}

function useToolExpanded() {
  const [expanded, setExpanded] = useState(globalToolExpanded)
  useEffect(() => {
    const handler = () => setExpanded(globalToolExpanded)
    toolExpandListeners.add(handler)
    return () => { toolExpandListeners.delete(handler) }
  }, [])
  return expanded
}

interface Props {
  messages: ChatMessage[]
  streaming: boolean
  streamingContent: string
  thinking: boolean
  thinkingContent?: string
  error?: string | null
  pendingPermission?: PermissionRequest | null
  permissionCursor?: number
  activeToolUses?: ToolUseDisplay[]
  activeToolResults?: ToolResultDisplay[]
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'
  return String(n)
}

function formatDuration(ms: number): string {
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`
  const m = Math.floor(totalSec / 60)
  const s = Math.round(totalSec - m * 60)
  return `${m}m ${s}s`
}

function countLines(s: string): number {
  if (!s) return 0
  return s.split('\n').length
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
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="yellow">● </Text>
        <Text color="yellow">{label} </Text>
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
        const raw = `${ln.sign} ${ln.text}`
        const content = raw.length > width ? raw.slice(0, width) : raw.padEnd(width)
        return (
          <Box key={i} marginLeft={4}>
            <Text
              wrap="truncate"
              backgroundColor={ln.sign === '+' ? '#13351f' : ln.sign === '-' ? '#3b1414' : undefined}
              dimColor={ln.sign === ' '}
            >
              {content}
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

const TOOL_LABEL: Record<string, string> = {
  write_file: 'Write',
  edit_file: 'Update',
  read_file: 'Read',
  run_bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
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
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={result.is_error ? 'red' : undefined} dimColor={!result.is_error}>
        {'⎿  '}{summarizeResult(result, toolName)}
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

function ToolUseLine({ use, result }: { use: ToolUseDisplay; result?: ToolResultDisplay }) {
  if (use.name === 'write_file' && !result?.is_error) {
    const input = use.input as { path?: string; content?: string }
    const content = input.content ?? ''
    const added = countLines(content)
    const preview = content.split('\n').map((t) => ({ sign: '+' as const, text: t }))
    return <FileEditBlock label="Write" path={input.path ?? ''} added={added} removed={0} previewLines={preview} />
  }
  if (use.name === 'edit_file' && !result?.is_error) {
    const input = use.input as { path?: string; old_str?: string; new_str?: string }
    const oldS = input.old_str ?? ''
    const newS = input.new_str ?? ''
    const added = countLines(newS)
    const removed = countLines(oldS)
    const preview: Array<{ sign: '+' | '-' | ' '; text: string }> = [
      ...oldS.split('\n').map((t) => ({ sign: '-' as const, text: t })),
      ...newS.split('\n').map((t) => ({ sign: '+' as const, text: t })),
    ]
    return <FileEditBlock label="Update" path={input.path ?? ''} added={added} removed={removed} previewLines={preview} />
  }
  const { label, arg } = toolHeader(use)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="yellow">● </Text>
        <Text color="yellow">{label} </Text>
        <Text>(</Text>
        <Text bold>{arg}</Text>
        <Text>)</Text>
      </Box>
      {result && <ToolResultBlock result={result} toolName={use.name} />}
    </Box>
  )
}

const UserMessage = memo(function UserMessage({ msg }: { msg: ChatMessage }) {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color="blue">● </Text>
      <Box flexGrow={1}>
        <Text>{msg.content}</Text>
      </Box>
    </Box>
  )
})

const AssistantMessage = memo(function AssistantMessage({ msg }: { msg: ChatMessage }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {msg.content && (
        <Box flexDirection="row">
          <Text color="white">● </Text>
          <Box flexGrow={1}>
            <Text>{msg.content}</Text>
          </Box>
        </Box>
      )}
      {msg.tool_uses?.map((u) => {
        const r = msg.tool_results?.find((x) => x.tool_use_id === u.id)
        return <ToolUseLine key={u.id} use={u} result={r} />
      })}
      {msg.tokens && (
        <Box marginLeft={2}>
          <Text dimColor>
            {`↳ Completed · ${formatTokens(msg.tokens.prompt_eval + msg.tokens.eval)} tokens`}
            {msg.duration != null ? ` · ${formatDuration(msg.duration)}` : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
})

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  const priority = ['path', 'file_path', 'command', 'pattern', 'query']
  for (const k of priority) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return `${k}: ${v}`
  }
  const first = Object.entries(obj).find(([, v]) => typeof v === 'string') as
    | [string, string]
    | undefined
  if (first) {
    const [k, v] = first
    const trimmed = v.length > 80 ? v.slice(0, 80) + '…' : v
    return `${k}: ${trimmed}`
  }
  return ''
}

function PermissionPrompt({ req, cursor }: { req: PermissionRequest; cursor: number }) {
  const label = TOOL_LABEL[req.toolName] ?? req.toolName
  const options = [
    { label: 'Yes', key: 'yes' },
    { label: "Yes, don't ask again for this", key: 'always' },
    { label: 'No', key: 'no' },
  ]
  const summary = summarizeInput(req.input)
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="blue" paddingX={1}>
      <Text color="blue" bold>Tool use</Text>
      <Box marginTop={1}>
        <Text>
          Allow <Text bold>{label}</Text>?
        </Text>
      </Box>
      {summary && (
        <Box marginLeft={2}>
          <Text dimColor>{summary}</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => (
          <Text key={opt.key} color={i === cursor ? 'blue' : undefined}>
            {i === cursor ? '❯ ' : '  '}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

export function ChatView({
  messages,
  streaming,
  streamingContent,
  thinking,
  thinkingContent,
  error,
  pendingPermission,
  permissionCursor = 0,
  activeToolUses,
  activeToolResults,
}: Props) {
  const empty =
    messages.length === 0 && !streaming && !thinking && !pendingPermission && !error
  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      {empty && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>{EMPTY_STATE_TITLE}</Text>
          {EMPTY_STATE_HINTS.map((h, i) => (
            <Text key={i} dimColor>{'  '}{h}</Text>
          ))}
        </Box>
      )}
      {messages.map((msg, i) =>
        msg.role === 'user' ? (
          <UserMessage key={i} msg={msg} />
        ) : (
          <AssistantMessage key={i} msg={msg} />
        ),
      )}

      {thinking && <ThinkingBlock content={thinkingContent} />}

      {streaming && streamingContent && (
        <Box flexDirection="row" marginBottom={1}>
          <Text color="white">{'● '}</Text>
          <Box flexGrow={1}>
            <Text>{streamingContent}</Text>
          </Box>
        </Box>
      )}

      {activeToolUses?.map((u) => {
        const r = activeToolResults?.find((x) => x.tool_use_id === u.id)
        return <ToolUseLine key={u.id} use={u} result={r} />
      })}

      {pendingPermission && <PermissionPrompt req={pendingPermission} cursor={permissionCursor} />}

      {error && (
        <Box flexDirection="row" marginBottom={1}>
          <Text color="red">● </Text>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  )
}
