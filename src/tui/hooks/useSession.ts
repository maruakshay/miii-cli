import { useState, useRef, useEffect } from 'react'
import type { ChatMessage, Config } from '../../types.js'
import { loadSession, saveSession, deleteSession } from '../../sessions.js'
import { getSystemPrompt } from '../../tools/index.js'
import type { Tool } from '../../tools/index.js'
import { getTavilyKey, saveTavilyKey } from '../../tavily/client.js'
import * as printer from '../printer.js'
import { loadLongMemory, saveLongMemory, mergeFacts, formatMemoryBlock } from '../../memory/store.js'
import type { MemoryFact } from '../../memory/store.js'
import { extractFacts } from '../../memory/extractor.js'

const SHORT_MEMORY_SIZE = 40

function buildSystemPrompt(cwd: string, facts: MemoryFact[], extraTools: Tool[] = []): string {
  return getSystemPrompt(`\n- CWD: ${cwd}`, extraTools) + formatMemoryBlock(facts)
}

export function useSession(initialSession: string, cwd: string, config: Config, extraTools: Tool[] = []) {
  const [sessionName, setSessionName] = useState(initialSession)
  const sessionNameRef = useRef(initialSession)
  const historyRef = useRef<ChatMessage[]>([])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstMessageSentRef = useRef(false)
  const longMemoryRef = useRef<MemoryFact[]>([])
  const systemPromptRef = useRef(buildSystemPrompt(cwd, [], extraTools))

  useEffect(() => { sessionNameRef.current = sessionName }, [sessionName])

  useEffect(() => {
    const facts = loadLongMemory(initialSession)
    longMemoryRef.current = facts
    systemPromptRef.current = buildSystemPrompt(cwd, facts, extraTools)
    if (facts.length) printer.systemMsg(`long memory: ${facts.length} facts loaded`)

    const history = loadSession(initialSession)
    historyRef.current = history
    if (history.length) printer.systemMsg(`resumed "${initialSession}" — ${history.length} messages`)

    if (config.tavilyApiKey && !getTavilyKey()) saveTavilyKey(config.tavilyApiKey)
    if (!getTavilyKey()) {
      printer.systemMsg('Tavily API key not set — web search disabled. Run /tavily-key <key> to enable. Get a free key at https://tavily.com')
    }
  }, [])

  function scheduleSave() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveSession(sessionNameRef.current, historyRef.current)
      saveTimerRef.current = null
    }, 2000)
  }

  function pushHistory(msg: ChatMessage) {
    historyRef.current.push(msg)
    if (historyRef.current.length > SHORT_MEMORY_SIZE) {
      const dropped = historyRef.current.splice(0, historyRef.current.length - SHORT_MEMORY_SIZE)
      extractFacts(dropped, config, config.model).then(newFacts => {
        if (!newFacts.length) return
        const updated = mergeFacts(longMemoryRef.current, newFacts)
        longMemoryRef.current = updated
        systemPromptRef.current = buildSystemPrompt(cwd, updated, extraTools)
        saveLongMemory(sessionNameRef.current, updated)
      })
    }
    scheduleSave()
  }

  function renameFromMessage(text: string) {
    if (firstMessageSentRef.current) return
    firstMessageSentRef.current = true
    const slug = text
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 5)
      .join('-')
      .replace(/[^\w-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'chat'
    const oldName = sessionNameRef.current
    sessionNameRef.current = slug
    setSessionName(slug)
    try { deleteSession(oldName) } catch {}
  }

  function buildContext(extra?: ChatMessage): ChatMessage[] {
    const ctx: ChatMessage[] = [{ role: 'system', content: systemPromptRef.current }]
    ctx.push(...historyRef.current)
    if (extra) ctx.push(extra)
    return ctx
  }

  return {
    sessionName, setSessionName, sessionNameRef,
    historyRef, saveTimerRef, systemPromptRef,
    pushHistory, buildContext, renameFromMessage,
  }
}
