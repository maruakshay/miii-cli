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
