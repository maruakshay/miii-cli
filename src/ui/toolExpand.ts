import { useState, useEffect } from 'react'

// Tool output is collapsed to a few lines by default; a click or ctrl+o toggles
// full view.
// Global flag + subscriber set so the input handler can flip every mounted
// tool block at once without threading state through the component tree.
let globalToolExpanded = false
const toolExpandListeners = new Set<() => void>()

export function toggleToolExpanded() {
  globalToolExpanded = !globalToolExpanded
  toolExpandListeners.forEach((fn) => fn())
}

export function useToolExpanded() {
  const [expanded, setExpanded] = useState(globalToolExpanded)
  useEffect(() => {
    const handler = () => setExpanded(globalToolExpanded)
    toolExpandListeners.add(handler)
    return () => { toolExpandListeners.delete(handler) }
  }, [])
  return expanded
}
