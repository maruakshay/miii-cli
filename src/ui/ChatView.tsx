import { type ReactNode } from 'react'
import { Box, Text, Static } from 'ink'
import { renderMarkdownStreaming } from './markdown.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import type { ChatMessage, ToolUseDisplay, ToolResultDisplay, PermissionRequest } from './types.js'
import { EMPTY_STATE_HINTS, EMPTY_STATE_TITLE } from './constants.js'
import { UserMessage, AssistantMessage } from './Message.js'
import { ToolUseLine } from './ToolBlock.js'
import { PermissionPrompt } from './PermissionPrompt.js'
import { clipTail, liveFrameRows, contentWidth, estimateToolRows } from './layout.js'

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
  // Rendered once as the first line of the static scrollback log (e.g. the
  // welcome banner). Omitted by pre-ready error views so no banner prints.
  header?: ReactNode
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
  header,
}: Props) {
  const empty =
    messages.length === 0 && !streaming && !thinking && !pendingPermission && !error

  // Static log = finished, immutable scrollback. Ink's <Static> writes each item
  // to stdout exactly once and never repaints it, so streaming flushes (which
  // touch only the live frame below) can't trigger a full-history redraw — the
  // root cause of the flicker. Order: header banner, then committed messages.
  type LogItem = { key: string; node: ReactNode }
  const log: LogItem[] = []
  if (header) log.push({ key: 'header', node: header })
  messages.forEach((msg, i) => {
    log.push({
      key: `msg-${i}`,
      node: msg.role === 'user' ? <UserMessage msg={msg} /> : <AssistantMessage msg={msg} />,
    })
  })

  // Live-frame row budget. Streaming text is clipped to it; the active tool
  // blocks then get whatever rows remain. Keeping the whole live frame inside
  // the terminal avoids Ink's full-screen clear path — the source of the flicker
  // seen when a tool result lands and pushes the frame past the terminal height.
  const liveBudget = liveFrameRows()

  let streamNode: ReactNode = null
  let streamRows = 0
  if (streaming && streamingContent) {
    const { text, clipped } = clipTail(renderMarkdownStreaming(streamingContent), liveBudget)
    streamRows = text.split('\n').length + (clipped > 0 ? 1 : 0)
    streamNode = (
      <Box flexDirection="column" marginBottom={1}>
        {clipped > 0 && (
          <Text dimColor>{`↑ ${clipped} more line${clipped === 1 ? '' : 's'} above — streaming…`}</Text>
        )}
        <Box flexDirection="row">
          <Text color="blue">{'● '}</Text>
          <Box width={contentWidth()}>
            <Text wrap="wrap">{text}</Text>
          </Box>
        </Box>
      </Box>
    )
  }

  // Render active tool blocks from the most recent backwards, keeping only those
  // that fit the remaining budget. Older ones reappear in scrollback once the
  // turn commits to <Static>.
  let toolNode: ReactNode = null
  if (activeToolUses?.length) {
    const remaining = Math.max(4, liveBudget - streamRows)
    // Pair each use with its result once; both the budget pass and the render
    // below need it, so resolving here avoids a second find() per kept tool.
    const resultById = new Map(activeToolResults?.map((r) => [r.tool_use_id, r]))
    const kept: Array<{ u: ToolUseDisplay; r?: ToolResultDisplay }> = []
    let rows = 0
    for (let i = activeToolUses.length - 1; i >= 0; i--) {
      const u = activeToolUses[i]
      const r = resultById.get(u.id)
      const h = estimateToolRows(u, r)
      if (rows + h > remaining && kept.length) break
      rows += h
      kept.unshift({ u, r })
    }
    const hidden = activeToolUses.length - kept.length
    toolNode = (
      <>
        {hidden > 0 && (
          <Text dimColor>{`↑ ${hidden} earlier tool call${hidden === 1 ? '' : 's'} above`}</Text>
        )}
        {kept.map(({ u, r }) => (
          <ToolUseLine key={u.id} use={u} result={r} />
        ))}
      </>
    )
  }

  return (
    <>
      <Static items={log}>
        {(item) =>
          item.key === 'header' ? (
            <Box key={item.key}>{item.node}</Box>
          ) : (
            <Box key={item.key} marginLeft={1}>{item.node}</Box>
          )
        }
      </Static>

      {/* Live frame — repaints freely; holds only the in-flight turn. */}
      <Box flexDirection="column" marginLeft={1} marginBottom={1}>
        {empty && (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>{EMPTY_STATE_TITLE}</Text>
            {EMPTY_STATE_HINTS.map((h, i) => (
              <Text key={i} dimColor>{'  '}{h}</Text>
            ))}
          </Box>
        )}

        {thinking && <ThinkingBlock content={thinkingContent} />}

        {streamNode}

        {toolNode}

        {pendingPermission && <PermissionPrompt req={pendingPermission} cursor={permissionCursor} />}

        {error && (
          <Box flexDirection="row" marginBottom={1}>
            <Text color="red">● </Text>
            <Text color="red">{error}</Text>
          </Box>
        )}
      </Box>
    </>
  )
}
