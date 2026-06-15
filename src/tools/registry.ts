import type { Tool } from './types.js'
import type { OllamaTool } from '../llm/types.js'
import { edit_file } from './edit_file.js'
import { read_file } from './read_file.js'
import { write_file } from './write_file.js'
import { run_bash } from './run_bash.js'
import { grep } from './grep.js'
import { glob } from './glob.js'

export const TOOLS: Tool[] = [
  edit_file as unknown as Tool,
  read_file as unknown as Tool,
  write_file as unknown as Tool,
  run_bash as unknown as Tool,
  grep as unknown as Tool,
  glob as unknown as Tool,
]

export function getTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name)
}

export function toOllamaTools(tools: Tool[] = TOOLS): OllamaTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.input_schema.properties,
        required: t.input_schema.required,
      },
    },
  }))
}
