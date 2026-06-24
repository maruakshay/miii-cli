import type { Tool } from '../tools/types.js'

/**
 * Constrained-decoding grammar for tool use, as an Ollama `format` JSON Schema.
 * Ollama compiles this to a llama.cpp GBNF grammar and enforces it token-by-token,
 * so even weak local models can only emit a well-formed action object.
 *
 * Shape is a discriminated union over `name` (one branch per tool, plus a
 * `respond` finish action). llama.cpp cannot mix `properties` with `oneOf` at the
 * same level, so the discrimination lives at the root `oneOf`; each branch is a
 * standalone object whose `arguments` schema is that tool's exact input schema.
 * `additionalProperties:false` (llama.cpp's default) blocks invented fields and
 * produces a tighter, faster grammar.
 *
 * Every assistant turn is exactly one action:
 *   { "name": "<tool>",  "arguments": { ...that tool's args } }
 *   { "name": "respond", "arguments": { "message": "<final answer>" } }
 */

type JsonSchemaNode = Record<string, unknown>

/** Strip prose-only keys (description) the grammar does not need; keep type/enum. */
function argProperties(
  props: Record<string, { type: string; description?: string; enum?: string[] }>,
): Record<string, JsonSchemaNode> {
  const out: Record<string, JsonSchemaNode> = {}
  for (const [key, spec] of Object.entries(props)) {
    const node: JsonSchemaNode = { type: spec.type }
    if (spec.enum && spec.enum.length) node.enum = spec.enum
    out[key] = node
  }
  return out
}

function toolBranch(tool: Tool): JsonSchemaNode {
  const args: JsonSchemaNode = {
    type: 'object',
    additionalProperties: false,
    properties: argProperties(tool.input_schema.properties),
  }
  if (tool.input_schema.required && tool.input_schema.required.length) {
    args.required = tool.input_schema.required
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'arguments'],
    properties: {
      name: { const: tool.name },
      arguments: args,
    },
  }
}

/** The finish action: lets the model end the turn with a plain-text answer. */
export const RESPOND_ACTION = 'respond'

function respondBranch(): JsonSchemaNode {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'arguments'],
    properties: {
      name: { const: RESPOND_ACTION },
      arguments: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
    },
  }
}

/** Build the `format` schema for the given tools (defaults handled by caller). */
export function buildToolGrammar(tools: Tool[]): JsonSchemaNode {
  return { oneOf: [...tools.map(toolBranch), respondBranch()] }
}
