/**
 * Pale UI palette. Terminal named colors (green, cyan, …) render saturated on
 * most themes, so components use these muted hex tones instead — they sit in
 * the same family as the markdown styles in markdown.ts.
 */
export const C = {
  green: '#9cc5a1',   // sage
  cyan: '#9ac6c9',    // sea glass
  blue: '#9ab8de',    // dusty blue
  yellow: '#e0cf9f',  // butter
  red: '#d9a0a0',     // rose clay
  magenta: '#c4aed4', // lavender
  white: '#d4d7dc',   // off-white
  gray: '#6b7280',    // slate gray
  panel: '#343840',   // soft dark fill behind user messages
} as const
