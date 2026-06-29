export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUse | ToolResultBlock

export interface MiiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
  /** Base64-encoded images attached to a user message (vision models). */
  images?: string[]
}

export type StopReason = 'end_turn' | 'tool_use'

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-use'; block: ToolUse }
  | { type: 'tool-result'; block: ToolResultBlock }
  | { type: 'permission-denied'; toolName: string; tool_use_id: string }
  | { type: 'turn-end'; stop_reason: StopReason }
  | { type: 'done'; prompt_tokens: number; eval_tokens: number }
  | { type: 'aborted'; prompt_tokens: number; eval_tokens: number; duration_ms: number }
  | { type: 'error'; message: string }
