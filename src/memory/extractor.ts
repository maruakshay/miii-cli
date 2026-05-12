import type { ChatMessage, Config } from '../types.js'
import { chat } from '../llm/stream.js'

const SYSTEM = `You extract memorable facts from conversations for long-term memory. Output ONLY a valid JSON array of concise fact strings.

Extract: user preferences, decisions made, key file paths, functions or variables, code patterns established, constraints, goals.
Skip: trivial exchanges, transient state, tool output noise.
Max 8 facts. Be specific and concrete.

Example output:
["User prefers patch_file over full rewrites","entry point is src/index.ts","decided to use Zod for validation"]`

export function extractFacts(messages: ChatMessage[], config: Config, model: string): Promise<string[]> {
  const lines = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role}: ${m.content.slice(0, 400)}`)
    .join('\n')
  if (!lines.trim()) return Promise.resolve([])

  return new Promise(resolve => {
    chat({
      provider: config.provider,
      model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: lines },
      ],
      onDone(text) {
        try {
          const m = text.match(/\[[\s\S]*?\]/)
          if (!m) { resolve([]); return }
          const arr = JSON.parse(m[0])
          resolve(Array.isArray(arr) ? arr.filter((f): f is string => typeof f === 'string') : [])
        } catch { resolve([]) }
      },
      onError() { resolve([]) },
    })
  })
}
