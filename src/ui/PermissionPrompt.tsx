import { Box, Text } from 'ink'
import type { PermissionRequest } from './types.js'
import { TOOL_LABEL } from './ToolBlock.js'
import { subjectFor, widestPattern } from '../permissions/policy.js'

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

/**
 * Approving a plan, not a tool call.
 *
 * The plan itself is already on screen above (ToolBlock renders it in full), so
 * this asks the one question left. "Yes, and stop asking about edits" is the
 * honest second option: someone who has just read a whole plan and approved it
 * does not want to re-approve each file it named.
 */
function PlanApproval({ cursor }: { cursor: number }) {
  const options = [
    'Yes — start working',
    "Yes, and don't ask about file edits from here",
    'No — keep planning, I want changes',
  ]
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>Ready to start?</Text>
      <Box marginTop={1}>
        <Text dimColor>The plan above is what will happen. Nothing has been changed yet.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((label, i) => (
          <Text key={label} color={i === cursor ? 'cyan' : undefined}>
            {i === cursor ? '❯ ' : '  '}
            {i + 1}. {label}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

export function PermissionPrompt({ req, cursor }: { req: PermissionRequest; cursor: number }) {
  if (req.toolName === 'exit_plan_mode') return <PlanApproval cursor={cursor} />
  const label = TOOL_LABEL[req.toolName] ?? req.toolName
  // The widest glob an "always" choice would persist. Showing it makes the blast
  // radius explicit — e.g. "npm run *" auto-allows every npm script, while a
  // destructive or compound command persists exact so it can't blanket-authorize
  // the whole program.
  const rule = widestPattern(req.toolName, subjectFor(req.toolName, req.input))
  const options = [
    { label: 'Yes', key: 'yes' },
    {
      // Naming the scope matters: the rule goes in the project's own
      // .miii/permissions.json, so "don't ask again" means here, not everywhere.
      label: rule ? `Yes, don't ask again for ${rule} (this project)` : "Yes, don't ask again in this project",
      key: 'always',
    },
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
