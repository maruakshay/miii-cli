import { memo } from 'react'
import { Box, Text } from 'ink'
import { renderMarkdown } from './markdown.js'
import type { ChatMessage } from './types.js'
import { ToolUseLine } from './ToolBlock.js'
import { formatTokens, formatDuration, contentWidth, padLines, userTextWidth } from './layout.js'
import { useTerminalWidth } from './hooks/useTerminalWidth.js'
import { useThinkingVisible, CHALK } from './ThinkingBlock.js'

/**
 * An echoed user message is drawn as a card: a coloured rule down the left edge
 * and a filled body, so a turn reads as one object even when it wraps over
 * several rows — the rule is what carries continuity down the block, and it's
 * what keeps a wrapped message from looking like two.
 *
 * Colours are named rather than hex so they track the terminal's own palette
 * instead of fighting a light or dark theme.
 */
const USER_BG = 'gray'
const USER_ACCENT = 'blue'
const USER_RULE = '\u258c'

export const UserMessage = memo(function UserMessage({ msg }: { msg: ChatMessage }) {
  // Read through the hook, not process.stdout: this component is memoised, so a
  // resize would otherwise leave the block padded to the old width.
  const cols = useTerminalWidth()
  // Trailing blank lines would render as empty shaded rows hanging off the end
  // of the card, so the content is trimmed to its last real line first.
  const lines = padLines(msg.content.replace(/\s+$/, ''), userTextWidth(cols))
  return (
    <Box flexDirection="column" marginBottom={1}>
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
  return (
    <Box flexDirection="column" marginBottom={1}>
      {showThoughts && thoughts && (
        <Box flexDirection="row" marginBottom={1}>
          <Text color={CHALK}>{'✻ '}</Text>
          <Box width={contentWidth()}>
            <Text dimColor italic wrap="wrap">{thoughts}</Text>
          </Box>
        </Box>
      )}
      {msg.content && (
        <Box flexDirection="row">
          <Text color="blue">● </Text>
          <Box width={contentWidth()}>
            <Text wrap="wrap">{renderMarkdown(msg.content)}</Text>
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
