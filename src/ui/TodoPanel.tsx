import { memo } from 'react'
import { Box, Text } from 'ink'
import { todoWindow, type Todo } from './todos.js'
import { C } from './theme.js'

const BAR = 10

/**
 * The agent's task list, pinned above the input while there is work on it —
 * the plan it is following, what's done, and what's next. The list never
 * enters the transcript (it's redrawn on every update, which would be noise
 * there); here it updates in place, and each task ticks over as it lands.
 */
export const TodoPanel = memo(function TodoPanel({ todos, maxRows }: { todos: Todo[]; maxRows: number }) {
  const done = todos.filter((t) => t.status === 'completed').length
  const filled = Math.round((done / todos.length) * BAR)
  const { items, above, below } = todoWindow(todos, maxRows)

  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      <Text>
        <Text bold>Tasks </Text>
        <Text dimColor>{`${done}/${todos.length} `}</Text>
        <Text color={C.green}>{'━'.repeat(filled)}</Text>
        <Text color={C.gray}>{'─'.repeat(BAR - filled)}</Text>
      </Text>
      {above > 0 && <Text dimColor>{`  ⋮ ${above} done`}</Text>}
      {items.map((t, i) => (
        <Text key={i + above} wrap="truncate">
          {t.status === 'completed' ? (
            <>
              <Text color={C.green}>{'  ✔ '}</Text>
              <Text dimColor strikethrough>{t.content}</Text>
            </>
          ) : t.status === 'in_progress' ? (
            <>
              <Text color={C.yellow}>{'  ▸ '}</Text>
              <Text bold>{t.content}</Text>
            </>
          ) : (
            <Text dimColor>{`  ○ ${t.content}`}</Text>
          )}
        </Text>
      ))}
      {below > 0 && <Text dimColor>{`  ⋮ ${below} more`}</Text>}
    </Box>
  )
})
