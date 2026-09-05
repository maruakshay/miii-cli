import { useEffect, useState } from 'react'
import { useStdout } from 'ink'

/**
 * Terminal width in columns, tracked across resizes.
 *
 * A component that sizes itself by reading `process.stdout.columns` at render
 * time goes stale behind React.memo: a resize changes no props, so the memo
 * holds the previous frame at the old width. Subscribing here re-renders the
 * component off its own state instead, without threading a width prop down.
 */
export function useTerminalWidth(): number {
  const { stdout } = useStdout()
  const [cols, setCols] = useState(stdout?.columns ?? 80)
  useEffect(() => {
    const onResize = () => setCols(stdout?.columns ?? 80)
    stdout?.on('resize', onResize)
    return () => {
      stdout?.off('resize', onResize)
    }
  }, [stdout])
  return cols
}
