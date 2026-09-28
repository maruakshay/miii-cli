import { useState, useEffect } from 'react'

// Muted chalk tone — soft off-white, quiet against the dim hint next to it.
export const CHALK = '#c9c7c0'

let globalThinkingVisible = false
const listeners = new Set<() => void>()

export function toggleThinkingVisible() {
  globalThinkingVisible = !globalThinkingVisible
  listeners.forEach((fn) => fn())
}

export function useThinkingVisible() {
  const [visible, setVisible] = useState(globalThinkingVisible)

  useEffect(() => {
    const handler = () => setVisible(globalThinkingVisible)
    listeners.add(handler)
    return () => { listeners.delete(handler) }
  }, [])

  return visible
}
