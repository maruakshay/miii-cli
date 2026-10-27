import type { FileDiff } from '../diff.js'
import type { PermissionContext, PermissionMode } from '../permissions/policy.js'
import type { HookBus } from '../hooks/bus.js'

/** A single property spec in a tool's JSON schema. */
export interface PropSpec {
  type: string
  description?: string
  enum?: string[]
  /** For type:'array' — the shape of each element (enables array-of-object params). */
  items?: {
    type: string
    properties?: Record<string, PropSpec>
    required?: string[]
  }
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, PropSpec>
  required?: string[]
}

export interface ToolResult {
  content: string
  is_error?: boolean
  /** Base64-encoded images the tool wants shown to a vision model (e.g. read_file on a PNG). */
  images?: string[]
  /**
   * What this call changed on disk, for the renderer. Display-only — it never
   * reaches the model (providers copy `content`/`images` and nothing else).
   */
  diff?: FileDiff
}

/**
 * Everything a nested agent loop needs to run: the model, where it runs, who
 * approves its calls. Only the `task` tool uses this — it is the one tool whose
 * job is to start another agent, and passing the run environment through the
 * tool context is what lets it do that without importing the UI's state.
 */
export interface RunContext {
  model: string
  cwd: string
  permissions: PermissionContext
  mode: PermissionMode
  hooks?: HookBus
  num_ctx?: number
}

/**
 * Side-channel handed to a tool handler at call time (not part of the model's
 * arguments). Carries the turn's AbortSignal so long-running tools (run_bash)
 * can cancel and kill their process tree when the user aborts.
 */
export interface ToolContext {
  signal?: AbortSignal
  /** Present only inside a real agent run — absent in unit tests and eval. */
  run?: RunContext
}

export interface Tool<I = Record<string, unknown>> {
  name: string
  description: string
  input_schema: JsonSchema
  handler: (input: I, ctx?: ToolContext) => Promise<ToolResult> | ToolResult
}
