import { useState, useEffect } from 'react'

/**
 * toolExpand — which tool blocks are showing their full detail.
 *
 * Two levels, because there are two gestures. Clicking a block is about *that*
 * block, so it records an override for its id; ctrl+o is "show me everything",
 * so it flips a baseline every block follows and drops the per-block overrides
 * — otherwise a block clicked open earlier would read as closed the moment the
 * baseline agreed with it.
 *
 * Module-level store + subscriber set (mirroring scroll.ts) so the input
 * handler can flip a block without threading state through the tree.
 */
let allExpanded = false
const overrides = new Map<string, boolean>()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((fn) => fn())
}

export function isToolExpanded(id?: string): boolean {
  if (id !== undefined) {
    const own = overrides.get(id)
    if (own !== undefined) return own
  }
  return allExpanded
}

/** Toggle one block — what a click on it does. */
export function toggleToolExpanded(id: string): void {
  overrides.set(id, !isToolExpanded(id))
  emit()
}

/** Toggle every block at once — what ctrl+o does. */
export function toggleAllToolExpanded(): void {
  allExpanded = !allExpanded
  overrides.clear()
  emit()
}

export function useToolExpanded(id?: string): boolean {
  const [expanded, setExpanded] = useState(() => isToolExpanded(id))
  useEffect(() => {
    const handler = () => setExpanded(isToolExpanded(id))
    handler()
    listeners.add(handler)
    return () => { listeners.delete(handler) }
  }, [id])
  return expanded
}
