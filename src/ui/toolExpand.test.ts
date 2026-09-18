import { describe, it, expect, beforeEach } from 'vitest'
import { isToolExpanded, toggleToolExpanded, toggleAllToolExpanded } from './toolExpand.js'
import { registerToolBlock, unregisterToolBlock, setFrameHeight, toolBlockAtRow } from './toolHit.js'
import type { DOMElement } from 'ink'

/** A node at `top` within its parent, `height` rows tall, with no parent above. */
function node(top: number, height: number): DOMElement {
  return {
    parentNode: undefined,
    yogaNode: { getComputedTop: () => top, getComputedHeight: () => height },
  } as unknown as DOMElement
}

describe('toolExpand', () => {
  beforeEach(() => {
    // Two flips clear the overrides and put the baseline back where it was.
    toggleAllToolExpanded()
    toggleAllToolExpanded()
  })

  it('expands only the block that was clicked', () => {
    toggleToolExpanded('a')
    expect(isToolExpanded('a')).toBe(true)
    expect(isToolExpanded('b')).toBe(false)
  })

  it('collapses it again on a second click', () => {
    toggleToolExpanded('a')
    toggleToolExpanded('a')
    expect(isToolExpanded('a')).toBe(false)
  })

  it('ctrl+o moves every block, including ones clicked open first', () => {
    toggleToolExpanded('a')
    toggleAllToolExpanded()
    expect(isToolExpanded('a')).toBe(true)
    expect(isToolExpanded('b')).toBe(true)
    toggleAllToolExpanded()
    expect(isToolExpanded('a')).toBe(false)
    expect(isToolExpanded('b')).toBe(false)
  })
})

describe('toolBlockAtRow', () => {
  beforeEach(() => {
    unregisterToolBlock('a')
    unregisterToolBlock('b')
    setFrameHeight(0)
  })

  it('maps a terminal row onto the block drawn there', () => {
    // 24-row terminal, 23-row frame: frame row 0 is terminal row 1.
    setFrameHeight(23)
    registerToolBlock('a', node(4, 3)) // frame rows 4-6 → terminal rows 5-7
    registerToolBlock('b', node(7, 2)) // frame rows 7-8 → terminal rows 8-9
    expect(toolBlockAtRow(5, 24)).toBe('a')
    expect(toolBlockAtRow(7, 24)).toBe('a')
    expect(toolBlockAtRow(8, 24)).toBe('b')
  })

  it('leaves a click that missed every block alone', () => {
    setFrameHeight(23)
    registerToolBlock('a', node(4, 3))
    expect(toolBlockAtRow(20, 24)).toBeUndefined()
  })

  it('does nothing until the frame has been measured', () => {
    registerToolBlock('a', node(4, 3))
    expect(toolBlockAtRow(5, 24)).toBeUndefined()
  })
})
