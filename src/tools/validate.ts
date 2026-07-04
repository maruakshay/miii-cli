import { z, type ZodTypeAny } from 'zod'
import type { JsonSchema } from './types.js'

/** Map a JsonSchema property type to a Zod schema. Unknown types stay permissive. */
function propSchema(spec: { type: string; enum?: string[] }): ZodTypeAny {
  if (spec.enum && spec.enum.length) return z.enum(spec.enum as [string, ...string[]])
  switch (spec.type) {
    case 'string': return z.string()
    case 'number': return z.number()
    case 'integer': return z.number().int()
    case 'boolean': return z.boolean()
    case 'array': return z.array(z.unknown())
    case 'object': return z.record(z.unknown())
    default: return z.unknown()
  }
}

/** Build a Zod object schema from a tool's declared input_schema. */
function toZod(schema: JsonSchema): ZodTypeAny {
  const required = new Set(schema.required ?? [])
  const shape: Record<string, ZodTypeAny> = {}
  for (const [key, spec] of Object.entries(schema.properties)) {
    // Enforce type only on required fields — that's where a missing or
    // wrong-typed arg reaches fs/exec and crashes. Optional fields stay
    // permissive (some tools accept loose/dual types, e.g. grep flags).
    shape[key] = required.has(key) ? propSchema(spec) : z.unknown().optional()
  }
  // Allow unknown extra keys — models often add stray fields; only enforce
  // declared types + required presence.
  return z.object(shape).passthrough()
}

/** Placeholder value for a property, by declared type — used in example shapes. */
function exampleValue(spec: { type: string; enum?: string[] }): unknown {
  if (spec.enum && spec.enum.length) return spec.enum[0]
  switch (spec.type) {
    case 'number':
    case 'integer': return 0
    case 'boolean': return false
    case 'array': return []
    case 'object': return {}
    default: return '...'
  }
}

/**
 * A minimal valid-shape example for a schema, built from its required fields.
 * Weak local models repeat the same malformed call when handed a bare error;
 * showing the exact shape they must emit lets them self-correct next turn.
 */
export function exampleInput(schema: JsonSchema): string {
  const required = schema.required ?? []
  const obj: Record<string, unknown> = {}
  for (const key of required) {
    const spec = schema.properties[key]
    if (spec) obj[key] = exampleValue(spec)
  }
  return JSON.stringify(obj)
}

/**
 * Validate a tool call's input against its declared input_schema.
 * Returns null on success, or a human-readable error string on failure.
 */
export function validateInput(schema: JsonSchema, input: unknown): string | null {
  const result = toZod(schema).safeParse(input ?? {})
  if (result.success) return null
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  return `Some arguments didn't look right: ${issues}`
}
