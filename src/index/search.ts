import type { Chunk } from './store.js'

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a))
}

export function cosineSim(a: number[], b: number[]): number {
  const d = norm(a) * norm(b)
  return d === 0 ? 0 : dot(a, b) / d
}

export interface SearchResult extends Chunk {
  score: number
}

export function topK(chunks: Chunk[], queryVec: number[], k: number): SearchResult[] {
  return chunks
    .map(c => ({ ...c, score: cosineSim(c.vec, queryVec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}
