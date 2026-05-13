import type { Config } from '../types.js'
import type { Tool } from '../tools/index.js'
import { embed } from './embedder.js'
import { loadIndex } from './store.js'
import { topK } from './search.js'

export function createSearchCodebaseTool(config: Config, cwd: string): Tool {
  return {
    name: 'search_codebase',
    description: 'Semantic search over the indexed codebase. Returns top relevant code snippets. Requires /index build to have been run first.',
    params: '{"query": "string", "k": "number (optional, default 5)"}',
    execute: async ({ query, k = 5 }) => {
      const chunks = loadIndex(cwd)
      if (!chunks.length) return '(no index found — run /index build first)'

      const embedModel = config.embedModel ?? 'nomic-embed-text'
      let queryVec: number[]
      try {
        queryVec = await embed(config.baseUrl, embedModel, String(query))
      } catch (e) {
        return `embed error: ${e}`
      }

      const results = topK(chunks, queryVec, Number(k))
      if (!results.length) return '(no results)'

      return results
        .map((r, i) => `[${i + 1}] ${r.file} (lines ${r.start + 1}–${r.end + 1}, score ${r.score.toFixed(3)})\n${r.text}`)
        .join('\n\n---\n\n')
    },
  }
}
