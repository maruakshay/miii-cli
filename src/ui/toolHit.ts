import type { DOMElement } from 'ink'

/**
 * toolHit — which tool block a mouse click landed on.
 *
 * A click reports a terminal row, and the block it belongs to is whichever one
 * occupies that row. Each mounted tool block publishes its own rectangle here
 * after every layout; the click handler, which runs outside the tree, looks the
 * row up.
 *
 * Coordinates are rows of Ink's frame, counted from its top. Ink draws the
 * frame in place at the bottom of the terminal and follows it with a newline
 * for the cursor, so the frame's last row is the second-to-last terminal row
 * and frame row 0 sits at terminal row `rows - frameHeight`. That offset is the
 * only bridge between the two coordinate systems, and it needs the measured
 * frame height — published by App.
 */
const blocks = new Map<string, DOMElement>()
let frameHeight = 0

/** Published by App after each measure of its root box. */
export function setFrameHeight(height: number): void {
  frameHeight = height
}

/**
 * Blocks register their NODE, not their measured rectangle: a block doesn't
 * re-render when the transcript scrolls under it, so a rectangle cached at
 * render time goes stale the first time the wheel moves. Yoga's numbers are
 * read at click time instead, when they are current by definition.
 */
export function registerToolBlock(id: string, node: DOMElement): void {
  blocks.set(id, node)
}

export function unregisterToolBlock(id: string): void {
  blocks.delete(id)
}

/**
 * Absolute top of a node within Ink's frame: yoga gives each node its offset
 * inside its parent, so the walk up the tree sums them. Margins are part of
 * that offset, which is what makes this work while the transcript is scrolled
 * — ChatView slides it with a negative marginTop.
 */
export function frameTop(node: DOMElement): number {
  let top = 0
  let cur: DOMElement | undefined = node
  while (cur) {
    top += cur.yogaNode?.getComputedTop() ?? 0
    cur = cur.parentNode
  }
  return top
}

/**
 * The block drawn at 1-based terminal row `row`, or undefined for a click that
 * missed every block (the input bar, a reply, blank space) — which is left
 * alone rather than made to toggle something the user wasn't pointing at.
 */
export function toolBlockAtRow(row: number, terminalRows: number): string | undefined {
  if (frameHeight <= 0) return undefined
  const y = row - (terminalRows - frameHeight)
  for (const [id, node] of blocks) {
    const height = node.yogaNode?.getComputedHeight() ?? 0
    const top = frameTop(node)
    if (height > 0 && y >= top && y < top + height) return id
  }
  return undefined
}
