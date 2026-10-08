import { memo } from 'react'
import { Box, Text } from 'ink'
import { renderMarkdown } from './markdown.js'
import type { ChatMessage } from './types.js'
import { ToolUseList } from './ToolBlock.js'
import { isHiddenTool } from './mergeSteps.js'
import { formatTokens, formatDuration, contentWidth, padLines, userTextWidth } from './layout.js'
import { useTerminalWidth } from './hooks/useTerminalWidth.js'
import { useThinkingVisible, CHALK } from './ThinkingBlock.js'
import { summaryParts } from './turnSummary.js'
import { C } from './theme.js'

/**
 * An echoed user message is drawn as a card: a coloured rule down the left edge
 * and a filled body, so a turn reads as one object even when it wraps over
 * several rows — the rule is what carries continuity down the block, and it's
 * what keeps a wrapped message from looking like two.
 *
 * Colours come from the pale palette in theme.ts.
 */
const USER_BG = C.panel
const USER_ACCENT = C.blue
const USER_RULE = '\u258c'

/**
 * The assistant gutter, shared with the streaming frame in ChatView. Both must
 * be the SAME visible width: the live answer and the committed message occupy
 * the same column, and a gutter that changes width at commit re-wraps every row
 * of the reply on that one frame — a whole-block twitch at the end of each turn.
 * Two columns, matching the offset contentWidth() reserves.
 */
export const ASST_ACCENT = C.white
export const ASST_RULE = '\u25cf '

export const UserMessage = memo(function UserMessage({ msg }: { msg: ChatMessage }) {
  // Read through the hook, not process.stdout: this component is memoised, so a
  // resize would otherwise leave the block padded to the old width.
  const cols = useTerminalWidth()
  // Trailing blank lines would render as empty shaded rows hanging off the end
  // of the card, so the content is trimmed to its last real line first.
  const lines = padLines(msg.content.replace(/\s+$/, ''), userTextWidth(cols))
  return (
    // Transcript blocks carry their spacing ABOVE them, so the newest one ends
    // flush and the gap before the input bar is the status row's to give — the
    // row that keeps the bar pinned to the bottom of the terminal (App).
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => (
        <Box key={i} flexDirection="row">
          <Text color={USER_ACCENT}>{USER_RULE}</Text>
          <Text backgroundColor={USER_BG}>{` ${line} `}</Text>
        </Box>
      ))}
    </Box>
  )
})

export const AssistantMessage = memo(function AssistantMessage({ msg }: { msg: ChatMessage }) {
  // Subscribing here is what lets ctrl+t reveal thoughts on turns that are long
  // finished — they live in the transcript, not in the live frame. The
  // subscription also defeats the memo on toggle, which is the point.
  const showThoughts = useThinkingVisible()
  const thoughts = msg.thinking?.trim()
  const tools = msg.tool_uses?.some((u) => !isHiddenTool(u.name))
  // A step with nothing to draw (only hidden tool calls, or thoughts while
  // they're hidden) would still carry its top margin — a stray blank row.
  if (!(showThoughts && thoughts) && !msg.content && !tools && !msg.tokens) return null

  return (
    // One step of a turn is a list of items — thought, text, each tool block —
    // one blank row apart. Every step of the turn lands under the last with the
    // same spacing, so the whole turn reads as a single running list rather than
    // a stack of separate cards. The turn summary sits outside the gap, directly
    // under the last item: it's a footnote to the turn, not another entry.
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" rowGap={1}>
        {showThoughts && thoughts && (
          <Box flexDirection="row">
            <Text color={CHALK}>{'✻ '}</Text>
            <Box width={contentWidth()}>
              <Text dimColor italic wrap="wrap">{thoughts}</Text>
            </Box>
          </Box>
        )}
        {msg.content && (
          <Box flexDirection="row">
            <Text color={ASST_ACCENT}>{ASST_RULE}</Text>
            <Box width={contentWidth()}>
              <Text wrap="wrap">{renderMarkdown(msg.content)}</Text>
            </Box>
          </Box>
        )}
        {msg.tool_uses && msg.tool_uses.length > 0 && (
          <ToolUseList uses={msg.tool_uses} results={msg.tool_results} />
        )}
      </Box>
      {msg.tokens && (
        // One Text with nested runs, not sibling Texts: siblings are flex
        // items, and each would wrap in its own column on a narrow terminal.
        <Box width={contentWidth() + 2}>
          <Text dimColor wrap="wrap">
            {'↳ '}
            {summaryParts(
              msg.summary,
              // Zero means the provider didn't report usage, not that it was free.
              msg.tokens.prompt_eval + msg.tokens.eval > 0 ? formatTokens(msg.tokens.prompt_eval + msg.tokens.eval) : undefined,
              msg.duration != null ? formatDuration(msg.duration) : undefined,
            ).map((p, i) => (
              <Text key={i} color={p.tone === 'good' ? C.green : p.tone === 'bad' ? C.red : undefined} dimColor={!p.tone}>
                {i > 0 ? ' · ' : ''}{p.text}
              </Text>
            ))}
          </Text>
        </Box>
      )}
    </Box>
  )
})
