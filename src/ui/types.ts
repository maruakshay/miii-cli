import type { FileDiff } from '../diff.js'

export interface ToolUseDisplay {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultDisplay {
  tool_use_id: string
  content: string
  is_error?: boolean
  /** The before/after of a file the tool touched, rendered as a diff block. */
  diff?: FileDiff
}

/** What a finished turn did, shown on its closing line. */
export interface TurnSummary {
  files: Array<{ path: string; added: number; removed: number }>
  /** Outcome of the last test command the turn ran, if it ran one. */
  tests?: 'passed' | 'failed'
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /**
   * The model's reasoning for this turn, committed with it so it stays in the
   * transcript instead of vanishing with the live spinner. Hidden until ctrl+t.
   * Only set for turns streamed in this session — agent history doesn't carry
   * thinking, so a resumed session has none.
   */
  thinking?: string
  tool_uses?: ToolUseDisplay[]
  tool_results?: ToolResultDisplay[]
  tokens?: { prompt_eval: number; eval: number }
  duration?: number
  /** Set on a turn's last message only, alongside `tokens`. */
  summary?: TurnSummary
}

export type PermissionAnswer = 'yes' | 'no' | 'always'

export interface PermissionRequest {
  toolName: string
  input: unknown
  resolve: (answer: PermissionAnswer) => void
}
