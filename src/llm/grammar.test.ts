import { describe, it, expect } from 'vitest'
import { buildToolGrammar, RESPOND_ACTION } from './grammar.js'
import type { Tool } from '../tools/types.js'

const fakeTools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        limit: { type: 'number', description: 'Max lines' },
      },
      required: ['path'],
    },
    handler: async () => ({ content: '' }),
  },
  {
    name: 'pick',
    description: 'Pick a mode',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'Mode', enum: ['a', 'b'] },
      },
    },
    handler: async () => ({ content: '' }),
  },
]

type Branch = {
  type: string
  additionalProperties: boolean
  required: string[]
  properties: {
    name: { const: string }
    arguments: {
      type: string
      additionalProperties: boolean
      required?: string[]
      properties: Record<string, { type: string; enum?: string[] }>
    }
  }
}

function branches(): Branch[] {
  return buildToolGrammar(fakeTools).oneOf as Branch[]
}

describe('buildToolGrammar', () => {
  it('emits one branch per tool plus a respond branch', () => {
    const b = branches()
    expect(b).toHaveLength(fakeTools.length + 1)
    expect(b.map((x) => x.properties.name.const)).toEqual(['read_file', 'pick', RESPOND_ACTION])
  })

  it('discriminates only at the root oneOf (no sibling properties)', () => {
    const g = buildToolGrammar(fakeTools) as Record<string, unknown>
    expect(Object.keys(g)).toEqual(['oneOf'])
  })

  it('pins each branch name with const and requires name + arguments', () => {
    for (const br of branches()) {
      expect(br.type).toBe('object')
      expect(br.additionalProperties).toBe(false)
      expect(br.required).toEqual(['name', 'arguments'])
      expect(typeof br.properties.name.const).toBe('string')
    }
  })

  it('locks down args: additionalProperties false on every branch', () => {
    for (const br of branches()) {
      expect(br.properties.arguments.additionalProperties).toBe(false)
    }
  })

  it("carries a tool's required args through", () => {
    const readBranch = branches().find((b) => b.properties.name.const === 'read_file')!
    expect(readBranch.properties.arguments.required).toEqual(['path'])
  })

  it('omits required when the tool declares none', () => {
    const pickBranch = branches().find((b) => b.properties.name.const === 'pick')!
    expect(pickBranch.properties.arguments.required).toBeUndefined()
  })

  it('preserves arg types and enums but strips descriptions', () => {
    const readArgs = branches()
      .find((b) => b.properties.name.const === 'read_file')!
      .properties.arguments.properties
    expect(readArgs.path).toEqual({ type: 'string' })
    expect(readArgs.limit).toEqual({ type: 'number' })

    const pickArgs = branches()
      .find((b) => b.properties.name.const === 'pick')!
      .properties.arguments.properties
    expect(pickArgs.mode).toEqual({ type: 'string', enum: ['a', 'b'] })
  })

  it('respond branch takes a required string message', () => {
    const respond = branches().find((b) => b.properties.name.const === RESPOND_ACTION)!
    expect(respond.properties.arguments.required).toEqual(['message'])
    expect(respond.properties.arguments.properties.message).toEqual({ type: 'string' })
  })
})
