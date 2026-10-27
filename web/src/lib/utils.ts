import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { TurnSummary, WebMessage } from './types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 4.2s under a minute, then 1m 05s — matches the terminal UI. */
export function fmtDuration(ms: number, precise = false) {
  const sec = ms / 1000
  if (sec < 60) return precise ? `${sec.toFixed(1)}s` : `${Math.floor(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec - m * 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/**
 * What the whole session has changed so far: each file once, lines summed.
 * Same arithmetic as sessionTally in src/ui/turnSummary.ts.
 */
export function sessionTally(summaries: Array<TurnSummary | undefined>) {
  const files = new Set<string>()
  let added = 0
  let removed = 0
  for (const s of summaries) {
    for (const f of s?.files ?? []) {
      files.add(f.path)
      added += f.added
      removed += f.removed
    }
  }
  return { files: files.size, added, removed }
}
