export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  tool_call_id?: string
  images?: string[]
}

export interface OllamaToolCall {
  id?: string
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export interface ChatChunk {
  content: string
  thinking?: string
  done: boolean
  // Why generation stopped, on the final (done) chunk. 'length' means the output
  // hit the num_predict cap and was cut off — any inline tool args are partial.
  done_reason?: string
  tool_calls?: OllamaToolCall[]
  prompt_eval_count?: number
  eval_count?: number
}

export interface ChatOptions {
  temperature?: number
  num_predict?: number
  num_ctx?: number
  keep_alive?: string
  signal?: AbortSignal
}
