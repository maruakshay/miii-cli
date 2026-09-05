import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Text, measureElement, type DOMElement } from 'ink'
import { renderMarkdownStreaming } from './markdown.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import type { ChatMessage, ToolUseDisplay, ToolResultDisplay, PermissionRequest } from './types.js'
import { UserMessage, AssistantMessage } from './Message.js'
import { ToolUseLine } from './ToolBlock.js'
import { PermissionPrompt } from './PermissionPrompt.js'
import { clipTail, clipTailVisual, contentWidth } from './layout.js'
import { setScrollMetrics, useScroll } from './scroll.js'

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
  /** Rendered as the first row of the transcript (the welcome banner). */
  header?: ReactNode
  /** Bumped by /clear and /new; remounts the transcript so measurement restarts. */
  logEpoch?: number
}

// While a turn streams, the in-flight answer is re-parsed on every 100ms flush;
// markdown parsing is O(input), so a long reply would make late flushes lag.
// Clipping the live buffer to a few screenfuls keeps each flush's cost flat —
// the untruncated text renders once the turn commits to a message.
const STREAM_VIEWPORTS = 3

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
  logEpoch = 0,
}: Props) {
  const scroll = useScroll()

  // Measured height of the full transcript. Ink lays the inner box out at its
  // natural height (flexShrink 0) even though the viewport clips it, so this is
  // the real content height — what scrolling has to clamp against.
  const innerRef = useRef<DOMElement | null>(null)
  const viewRef = useRef<DOMElement | null>(null)
  const [contentRows, setContentRows] = useState(0)
  // The viewport takes whatever rows the app's fixed-height root has left over
  // after the input bar and any pickers, so its height is yoga's answer, not a
  // guess — measured here because the scroll math needs it in rows.
  const [viewportRows, setViewportRows] = useState(10)

  const scrolled = !scroll.stick

  useEffect(() => {
    if (innerRef.current) {
      const { height } = measureElement(innerRef.current)
      if (height !== contentRows) setContentRows(height)
    }
    if (viewRef.current) {
      const { height } = measureElement(viewRef.current)
      if (height > 0 && height !== viewportRows) setViewportRows(height)
    }
  })

  // Publish geometry for the wheel/pageup handlers, which run outside the tree.
  useEffect(() => {
    setScrollMetrics(contentRows, viewportRows)
  }, [contentRows, viewportRows])

  const maxTop = Math.max(0, contentRows - viewportRows)
  // A scrolled-up view keeps its row, clamped in case the content shrank since
  // the last measure.
  const top = scroll.stick ? maxTop : Math.min(scroll.top, maxTop)
  const below = maxTop - top
  // Tail-following is done with flex, not the margin: bottom-aligning the inner
  // box is exact on the frame it renders, whereas the margin depends on a height
  // measured one render ago — which during streaming is a row out of date every
  // time new output lands. Scrolled up, the content is frozen, so the measured
  // offset is right and the margin does the work.

  let streamNode: ReactNode = null
  if (streaming && streamingContent) {
    // Clip the RAW buffer first, then parse markdown on just that tail: parsing
    // the whole accumulated answer every flush is what made long replies stutter.
    const budget = viewportRows * STREAM_VIEWPORTS
    const raw = clipTail(streamingContent, budget)
    // Second clip is by VISUAL rows: rendered markdown is drawn in a wrapping box
    // at contentWidth, so one logical line can occupy several terminal rows.
    const width = contentWidth()
    const rendered = clipTailVisual(renderMarkdownStreaming(raw.text), budget, width)
    const clipped = raw.clipped + rendered.clipped
    streamNode = (
      <Box flexDirection="column" marginBottom={1}>
        {clipped > 0 && (
          <Text dimColor>{`↑ ${clipped} more line${clipped === 1 ? '' : 's'} above — streaming…`}</Text>
        )}
        <Box flexDirection="row">
          <Text color="blue">{'● '}</Text>
          <Box width={width}>
            <Text wrap="wrap">{rendered.text}</Text>
          </Box>
        </Box>
      </Box>
    )
  }

  // Every active tool block renders — the viewport clips what doesn't fit and the
  // user can scroll back to the rest, so there's no row budget to keep here.
  const resultById = new Map(activeToolResults?.map((r) => [r.tool_use_id, r]))

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Bottom-aligned while following the tail — which also puts a transcript
          shorter than the viewport just above the input bar, instead of stranding
          it under a screenful of blank rows. */}
      <Box
        ref={viewRef}
        flexDirection="column"
        flexGrow={1}
        minHeight={4}
        overflow="hidden"
        justifyContent={scroll.stick || contentRows <= viewportRows ? 'flex-end' : 'flex-start'}
      >
        {/* Inner box holds the whole transcript at full height; the negative top
            margin slides it under the clipping viewport. This is miii's own
            scrollback — the terminal's is not used, so the wheel belongs to us. */}
        <Box
          key={logEpoch}
          ref={innerRef}
          flexDirection="column"
          flexShrink={0}
          marginTop={scroll.stick ? 0 : -top}
        >
          {header}

          {messages.map((msg, i) => (
            <Box key={`msg-${i}`} marginLeft={1} flexShrink={0}>
              {msg.role === 'user' ? <UserMessage msg={msg} /> : <AssistantMessage msg={msg} />}
            </Box>
          ))}

          <Box flexDirection="column" marginLeft={1} flexShrink={0}>
            {thinking && <ThinkingBlock content={thinkingContent} />}

            {streamNode}

            {activeToolUses?.map((u) => (
              <ToolUseLine key={u.id} use={u} result={resultById.get(u.id)} />
            ))}

            {pendingPermission && <PermissionPrompt req={pendingPermission} cursor={permissionCursor} />}

            {error && (
              <Box flexDirection="row" marginBottom={1}>
                <Text color="red">● </Text>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* Status row for the scroll position. Always one row, blank when following
          the tail — a row that comes and goes re-flows the layout under it, and
          the viewport's height is exactly what that reflow changes. The blank is a
          space, not an empty string: Ink collapses an empty Text to zero rows. */}
      <Box marginLeft={1} flexShrink={0}>
        <Text dimColor>
          {scrolled
            ? `↓ ${below} more row${below === 1 ? '' : 's'} below · scroll down or pagedown to follow`
            : ' '}
        </Text>
      </Box>
    </Box>
  )
}
