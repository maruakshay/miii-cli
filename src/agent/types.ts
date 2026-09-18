import type { FileDiff } from '../diff.js'
import type { PermissionMode } from '../permissions/policy.js'

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
  /** Base64 images produced by the tool; surfaced to the model as a user message. */
  images?: string[]
  /** File change to render. Display-only; the provider adapters ignore it. */
  diff?: FileDiff
}

export type ContentBlock = TextBlock | ToolUse | ToolResultBlock

export interface MiiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
  /** Base64-encoded images attached to a user message (vision models). */
  images?: string[]
}

export type StopReason = 'end_turn' | 'tool_use'

/**
 * What the harness had to fix about one tool call before it could run — a name
 * resolved, keys renamed onto declared fields, values coerced, an envelope
 * peeled. Emitted as telemetry rather than acted on: the repair tables in
 * normalize.ts are guesswork until something counts which of them actually fire,
 * for which model, on which tool.
 */
export interface ToolRepair {
  tool_use_id: string
  name: string
  repairs: string[]
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-use'; block: ToolUse }
  | { type: 'tool-result'; block: ToolResultBlock }
  /** A malformed call was repaired before it ran. Pure telemetry — see ToolRepair. */
  | ({ type: 'tool-repair' } & ToolRepair)
  | { type: 'permission-denied'; toolName: string; tool_use_id: string }
  /**
   * A configured hook had something to say to the USER — it failed, or it
   * refused a call. Never routed to the model: the model gets the refusal as a
   * tool_result, and a broken hook is not its problem to solve.
   */
  | { type: 'hook-notice'; message: string }
  /**
   * The permission mode changed mid-run — the user approved a plan. The UI
   * mirrors it so the indicator and the next turn agree with the loop.
   */
  | { type: 'mode-change'; mode: PermissionMode }
  | { type: 'turn-end'; stop_reason: StopReason }
  | { type: 'done'; prompt_tokens: number; eval_tokens: number }
  | { type: 'aborted'; prompt_tokens: number; eval_tokens: number; duration_ms: number }
  | { type: 'error'; message: string }
