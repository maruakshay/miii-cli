import { Box, Text } from 'ink'
import type { PermissionRequest } from './types.js'
import { TOOL_LABEL } from './ToolBlock.js'

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  const priority = ['path', 'file_path', 'command', 'pattern', 'query']
  for (const k of priority) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) {
      return `${k}: ${v.length > 120 ? v.slice(0, 120) + '…' : v}`
    }
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

export function PermissionPrompt({ req, cursor }: { req: PermissionRequest; cursor: number }) {
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
          <Text wrap="truncate" dimColor>{summary}</Text>
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
