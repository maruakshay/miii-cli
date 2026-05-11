import { useState, useRef, useEffect } from 'react'
import type { ChatMessage, Config } from '../../types.js'
import { loadSession, saveSession } from '../../sessions.js'
import { getSystemPrompt } from '../../tools/index.js'
import { getTavilyKey, saveTavilyKey } from '../../tavily/client.js'
import * as printer from '../printer.js'

export function useSession(initialSession: string, cwd: string, config: Config) {
  const [sessionName, setSessionName] = useState(initialSession)
  const sessionNameRef = useRef(initialSession)
  const historyRef = useRef<ChatMessage[]>([])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const systemPromptRef = useRef(getSystemPrompt(`\n- CWD: ${cwd}`))

  useEffect(() => { sessionNameRef.current = sessionName }, [sessionName])

  useEffect(() => {
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
    if (historyRef.current.length > 100) historyRef.current.splice(0, historyRef.current.length - 100)
    scheduleSave()
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
    pushHistory, buildContext,
  }
}
