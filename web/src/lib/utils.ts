import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

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
