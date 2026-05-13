import { chat } from '../llm/stream.js'
import { tools as staticTools } from '../tools/index.js'
import { StreamParser } from '../parser/stream-parser.js'
import type { Config, ChatMessage } from '../types.js'

const ALLOWED_TOOLS = new Set([
  'read_file', 'list_files', 'web_search', 'web_extract',
  'git_status', 'git_log', 'git_diff',
])

const MAX_DEPTH = 6
const MAX_WEB = 4

export interface DeepThinkResult {
  findings: string
  toolCalls: number
  webCalls: number
}

export async function runDeepThink(
  query: string,
  config: Config,
  model: string,
  signal?: AbortSignal,
  onStep?: (toolName: string) => void,
): Promise<DeepThinkResult> {
  const gatherTools = staticTools.filter(t => ALLOWED_TOOLS.has(t.name))
  const toolDocs = gatherTools.map(t => `- ${t.name}(${t.params}): ${t.description}`).join('\n')

  const sysPrompt = `You are a research agent. Gather information to answer: "${query}"

Available tools (read-only — no file writes, no mutations):
${toolDocs}

Guardrails:
- Max ${MAX_DEPTH} tool calls total
- Max ${MAX_WEB} web calls (web_search + web_extract combined)
- No file edits, no shell commands that modify state
- When you have enough info, output a detailed plain-text research summary
- No markdown formatting in output`

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `Research and gather all relevant information for: ${query}` },
  ]

  let depth = 0
  let webCalls = 0
  let totalCalls = 0
  let findings = ''

  async function gather(msgs: ChatMessage[]): Promise<void> {
    if (depth >= MAX_DEPTH) return
    depth++

    let fullText = ''
    await chat({
      provider: config.provider,
      model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      messages: msgs,
      signal,
      async onDone(text) { fullText = text },
      onError(err) { if (err.name !== 'AbortError') throw err },
    })

    if (!fullText) return

    const pending: Array<{ name: string; args: Record<string, unknown> }> = []
    const parser = new StreamParser()
    for (const item of [...parser.feed(fullText), ...parser.flush()]) {
      if (item.type === 'tool_call') pending.push({ name: item.toolName, args: item.toolArgs })
    }

    if (!pending.length) { findings = fullText; return }

    const next: ChatMessage[] = [...msgs, { role: 'assistant', content: fullText }]

    for (const tc of pending) {
      if (!ALLOWED_TOOLS.has(tc.name)) {
        next.push({ role: 'user', content: `Tool "${tc.name}" not permitted in research phase.` })
        continue
      }

      const isWeb = tc.name === 'web_search' || tc.name === 'web_extract'

      if (isWeb && webCalls >= MAX_WEB) {
        next.push({ role: 'user', content: `Web call limit (${MAX_WEB}) reached. Summarize findings now.` })
        continue
      }

      if (totalCalls >= MAX_DEPTH) {
        next.push({ role: 'user', content: `Tool call limit (${MAX_DEPTH}) reached. Summarize findings now.` })
        continue
      }

      const tool = gatherTools.find(t => t.name === tc.name)
      if (!tool) continue

      onStep?.(tc.name)
      totalCalls++
      if (isWeb) webCalls++

      try {
        const result = await tool.execute(tc.args)
        next.push({ role: 'user', content: `Tool ${tc.name} result:\n${result}` })
      } catch (e) {
        next.push({ role: 'user', content: `Tool ${tc.name} error: ${e}` })
      }
    }

    await gather(next)
  }

  await gather(messages)

  return { findings, toolCalls: totalCalls, webCalls }
}
