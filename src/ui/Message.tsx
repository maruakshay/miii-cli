import { memo } from 'react'
import { Box, Text } from 'ink'
import { renderMarkdown } from './markdown.js'
import type { ChatMessage } from './types.js'
import { ToolUseLine } from './ToolBlock.js'
import { formatTokens, formatDuration, contentWidth } from './layout.js'

export const UserMessage = memo(function UserMessage({ msg }: { msg: ChatMessage }) {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color="gray">❯ </Text>
      <Box flexGrow={1}>
        <Text>{msg.content}</Text>
      </Box>
    </Box>
  )
})

export const AssistantMessage = memo(function AssistantMessage({ msg }: { msg: ChatMessage }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
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
