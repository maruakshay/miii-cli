import type { Tool } from './types.js'
import type { OllamaTool } from '../llm/types.js'
import { edit_file } from './edit_file.js'
import { read_file } from './read_file.js'
import { write_file } from './write_file.js'
import { run_bash } from './run_bash.js'
import { grep } from './grep.js'
import { glob } from './glob.js'
import { write_todos } from './write_todos.js'
import { exit_plan_mode } from './exit_plan_mode.js'
import type { PermissionMode } from '../permissions/policy.js'

export const TOOLS: Tool[] = [
  edit_file as unknown as Tool,
  read_file as unknown as Tool,
  write_file as unknown as Tool,
  run_bash as unknown as Tool,
  grep as unknown as Tool,
  glob as unknown as Tool,
  write_todos as unknown as Tool,
  exit_plan_mode as unknown as Tool,
]

/**
 * What the agent may reach for while planning: everything that reads, the todo
 * list so it can track its own research, run_bash (the loop narrows it to
 * read-only commands), and the one tool that ends plan mode.
 *
 * Withholding the write tools from the schema is the first line of defence —
 * a tool the model was never offered is one it mostly doesn't invent. The loop
 * enforces the same set mechanically for when it does anyway.
 */
const PLAN_TOOL_NAMES = new Set([
  'read_file', 'grep', 'glob', 'run_bash', 'write_todos', 'exit_plan_mode',
])

/**
 * The tools to advertise for a permission mode. Outside plan mode
 * exit_plan_mode is withheld: offering a model a way to "present a plan" when
 * it is supposed to be doing the work invites it to stall.
 */
export function toolsForMode(mode: PermissionMode): Tool[] {
  if (mode === 'plan') return TOOLS.filter((t) => PLAN_TOOL_NAMES.has(t.name))
  return TOOLS.filter((t) => t.name !== 'exit_plan_mode')
}

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
