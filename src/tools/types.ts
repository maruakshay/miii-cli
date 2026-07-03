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
}

/**
 * Side-channel handed to a tool handler at call time (not part of the model's
 * arguments). Carries the turn's AbortSignal so long-running tools (run_bash)
 * can cancel and kill their process tree when the user aborts.
 */
export interface ToolContext {
  signal?: AbortSignal
}

export interface Tool<I = Record<string, unknown>> {
  name: string
  description: string
  input_schema: JsonSchema
  handler: (input: I, ctx?: ToolContext) => Promise<ToolResult> | ToolResult
}
