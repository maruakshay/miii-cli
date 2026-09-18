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
import { task } from './task.js'
import { mcpTools, readOnlyMcpToolNames } from '../mcp/registry.js'
import type { PermissionMode } from '../permissions/policy.js'

/** miii's own tools. MCP servers contribute the rest at runtime — see allTools(). */
export const TOOLS: Tool[] = [
  edit_file as unknown as Tool,
  read_file as unknown as Tool,
  write_file as unknown as Tool,
  run_bash as unknown as Tool,
  grep as unknown as Tool,
  glob as unknown as Tool,
  write_todos as unknown as Tool,
  task as unknown as Tool,
  exit_plan_mode as unknown as Tool,
]

/**
 * Everything callable right now: the built-ins plus whatever the connected MCP
 * servers advertise. A function rather than a constant because servers connect
 * after this module loads, and anything that caches the array at import time
 * would see only the built-ins forever.
 */
export function allTools(): Tool[] {
  return [...TOOLS, ...mcpTools()]
}

/**
 * What the agent may reach for while planning: everything that reads, the todo
 * list so it can track its own research, run_bash (the loop narrows it to
 * read-only commands), subagents (which inherit the mode), and the one tool
 * that ends plan mode.
 *
 * Withholding the write tools from the schema is the first line of defence —
 * a tool the model was never offered is one it mostly doesn't invent. The loop
 * enforces the same set mechanically for when it does anyway.
 */
const PLAN_TOOL_NAMES = new Set([
  'read_file', 'grep', 'glob', 'run_bash', 'write_todos', 'task', 'exit_plan_mode',
])

/**
 * The tools to advertise for a permission mode. Outside plan mode
 * exit_plan_mode is withheld: offering a model a way to "present a plan" when
 * it is supposed to be doing the work invites it to stall.
 *
 * An MCP tool is offered in plan mode only when its server declared itself
 * read-only. miii cannot tell whether a server's `create_issue` writes
 * something, so the safe default is to withhold it and let the settings file
 * say otherwise.
 */
export function toolsForMode(mode: PermissionMode): Tool[] {
  if (mode === 'plan') {
    const readOnlyMcp = readOnlyMcpToolNames()
    return allTools().filter((t) => PLAN_TOOL_NAMES.has(t.name) || readOnlyMcp.has(t.name))
  }
  return allTools().filter((t) => t.name !== 'exit_plan_mode')
}

export function getTool(name: string): Tool | undefined {
  return allTools().find((t) => t.name === name)
}

export function toOllamaTools(tools: Tool[] = allTools()): OllamaTool[] {
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
