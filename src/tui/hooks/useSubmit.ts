import { useCallback, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { Config, ChatMessage, Status } from '../../types.js'
import { readFile, guardPath } from '../../files/ops.js'
import type { SkillLoader } from '../../skills/loader.js'
import { getSystemPrompt } from '../../tools/index.js'
import type { Tool } from '../../tools/index.js'
import { saveConfig } from '../../config.js'
import { loadSession, saveSession, listSessions, deleteSession, deleteAllSessions } from '../../sessions.js'
import { compactContext } from '../../tasks/compactor.js'
import { runDeepThink } from '../deepThink.js'
import { buildGitContext, looksCodeRelated } from '../git-context.js'
import { buildIndex } from '../../index/indexer.js'
import { indexStats, clearIndex } from '../../index/store.js'
import { embed } from '../../index/embedder.js'
import { loadIndex } from '../../index/store.js'
import { topK } from '../../index/search.js'
import * as printer from '../printer.js'

function sanitizeInjected(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '[tool_call block removed]')
}

function buildAtContext(text: string): string {
  const refs = [...text.matchAll(/@([\w./\-]+)/g)]
  if (!refs.length) return ''
  const parts: string[] = []
  for (const m of refs) {
    try {
      const safe = guardPath(m[1])
      const content = readFile(safe)
      if (content) parts.push(`<file path="${m[1]}">\n${sanitizeInjected(content)}\n</file>`)
    } catch {}
  }
  return parts.length ? parts.join('\n\n') + '\n\n' : ''
}

interface SubmitDeps {
  config: Config
  skills: SkillLoader
  cwd: string
  version?: string
  currentModelRef: MutableRefObject<string>
  setCurrentModel: (m: string) => void
  historyRef: MutableRefObject<ChatMessage[]>
  sessionNameRef: MutableRefObject<string>
  saveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  systemPromptRef: MutableRefObject<string>
  abortRef: MutableRefObject<AbortController | null>
  setPlanningMode: (v: boolean) => void
  runLoop: (msgs: ChatMessage[], depth?: number, goal?: string) => Promise<void>
  buildContext: () => ChatMessage[]
  pushHistory: (msg: ChatMessage) => void
  setSessionName: (name: string) => void
  renameFromMessage: (text: string) => void
  setStatus: (s: Status) => void
  setTaskLabel: (l: string | undefined) => void
  setCurrentTool: (t: string | undefined) => void
  runRefactor: (goal: string) => Promise<void>
  handleGit: (sub: string) => Promise<void>
  lastGitStatusRef: MutableRefObject<string>
  mcpTools: Tool[]
  setConfig: (updater: (c: import('../../types.js').Config) => import('../../types.js').Config) => void
  setConfigOpen: (v: boolean) => void
}

export function useSubmit(deps: SubmitDeps) {
  const depsRef = useRef(deps)
  depsRef.current = deps

  const handleSubmit = useCallback(async (text: string) => {
    const {
      config, skills, cwd, version, currentModelRef, setCurrentModel,
      historyRef, sessionNameRef, saveTimerRef, systemPromptRef, abortRef,
      setPlanningMode, runLoop, buildContext, pushHistory,
      setSessionName, renameFromMessage,
      setStatus, setTaskLabel, setCurrentTool,
      runRefactor, handleGit, lastGitStatusRef, mcpTools, setConfig, setConfigOpen,
    } = depsRef.current

    const cmd = text.trim()

    if (cmd === '?') {
      printer.systemMsg(
        'shortcuts:\n' +
        '  enter          send message\n' +
        '  ctrl+j         insert newline\n' +
        '  ↑ / ↓          history navigate\n' +
        '  ctrl+a / ctrl+e  line start / end\n' +
        '  ctrl+w         delete word back\n' +
        '  ctrl+k         kill to line end\n' +
        '  ctrl+u         clear line\n' +
        '  ctrl+← / →     jump word\n' +
        '  @filename      inject file into context\n' +
        '  /cmd           open command palette\n' +
        '  esc            abort / clear input\n' +
        '  ctrl+c         abort / exit'
      )
      return
    }

    if (cmd === '/version') {
      printer.systemMsg(`miii v${version ?? 'unknown'}`)
      return
    }

    if (cmd === '/skills' || cmd.startsWith('/skills ')) {
      const sub = cmd.slice(7).trim()
      if (!sub || sub === 'list') {
        const pkgs = skills.listNpmSkills()
        printer.systemMsg(pkgs.length ? `installed npm skills:\n${pkgs.map(p => `  ${p}`).join('\n')}` : 'no npm skills installed — try /skills install <name>')
        return
      }
      if (sub.startsWith('install ')) {
        const pkg = sub.slice(8).trim()
        if (!pkg) { printer.systemMsg('usage: /skills install <name>  (e.g. /skills install git-summary)'); return }
        printer.systemMsg(`installing miii-skill-${pkg}…`)
        try { printer.systemMsg(await skills.installSkill(pkg)) } catch (e) { printer.errorMsg(String(e)) }
        return
      }
      if (sub.startsWith('uninstall ')) {
        const pkg = sub.slice(10).trim()
        if (!pkg) { printer.systemMsg('usage: /skills uninstall <name>'); return }
        try { printer.systemMsg(await skills.uninstallSkill(pkg)) } catch (e) { printer.errorMsg(String(e)) }
        return
      }
      printer.systemMsg('usage: /skills install <name> | /skills uninstall <name> | /skills list')
      return
    }

    if (cmd === '/config' || cmd.startsWith('/config ')) {
      const sub = cmd.slice(7).trim()

      if (!sub) {
        setConfigOpen(true)
        return
      }

      if (sub.startsWith('provider ')) {
        const val = sub.slice(9).trim() as typeof config.provider
        const valid = ['ollama', 'anthropic', 'openai-compat']
        if (!valid.includes(val)) { printer.systemMsg(`valid providers: ${valid.join(', ')}`); return }
        setConfig(c => ({ ...c, provider: val }))
        saveConfig({ provider: val })
        printer.systemMsg(`provider → ${val}`)
        return
      }

      if (sub.startsWith('model ')) {
        const val = sub.slice(6).trim()
        if (!val) { printer.systemMsg('usage: /config model <name>'); return }
        setConfig(c => ({ ...c, model: val }))
        saveConfig({ model: val })
        setCurrentModel(val)
        currentModelRef.current = val
        printer.systemMsg(`model → ${val}`)
        return
      }

      if (sub.startsWith('key ')) {
        const val = sub.slice(4).trim()
        if (!val) { printer.systemMsg('usage: /config key <api-key>'); return }
        setConfig(c => ({ ...c, apiKey: val }))
        saveConfig({ apiKey: val })
        printer.systemMsg(`apiKey → ${val.slice(0, 8)}…`)
        return
      }

      if (sub.startsWith('url ')) {
        const val = sub.slice(4).trim()
        if (!val) { printer.systemMsg('usage: /config url <base-url>'); return }
        setConfig(c => ({ ...c, baseUrl: val }))
        saveConfig({ baseUrl: val })
        printer.systemMsg(`baseUrl → ${val}`)
        return
      }

      printer.systemMsg('usage: /config [provider|model|key|url] <value>')
      return
    }

    if (cmd === '/model' || cmd.startsWith('/model ')) {
      const name = cmd.slice(6).trim()
      if (!name) { printer.systemMsg(`current model: ${currentModelRef.current}`); return }
      setCurrentModel(name)
      currentModelRef.current = name
      printer.systemMsg(`model → ${name}`)
      return
    }

    if (cmd === '/compact') {
      const full = buildContext()
      if (full.length <= 2) { printer.systemMsg('nothing to compact'); return }
      printer.systemMsg(`compacting ${full.length} messages…`)
      setStatus('thinking')
      try {
        const compacted = await compactContext(full, {
          provider: config.provider,
          model: currentModelRef.current,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
        }, undefined)
        historyRef.current = compacted.filter(m => m.role !== 'system')
        saveSession(sessionNameRef.current, historyRef.current)
        printer.systemMsg(`compacted: ${full.length} → ${compacted.length} messages`)
      } catch (e) {
        printer.errorMsg(`compact failed: ${e}`)
      } finally {
        setStatus('idle')
      }
      return
    }

    if (cmd === '/new') {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
      saveSession(sessionNameRef.current, historyRef.current)
      const newName = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      historyRef.current = []
      setSessionName(newName)
      setPlanningMode(false)
      systemPromptRef.current = getSystemPrompt(`\n- CWD: ${cwd}`, mcpTools)
      printer.systemMsg(`new session → ${newName}`)
      return
    }

    if (cmd === '/clear') {
      historyRef.current = []
      saveSession(sessionNameRef.current, [])
      setPlanningMode(false)
      systemPromptRef.current = getSystemPrompt(`\n- CWD: ${cwd}`, mcpTools)
      printer.systemMsg('chat cleared')
      return
    }

    if (cmd === '/exit') { process.exit(0) }

    if (cmd === '/git' || cmd.startsWith('/git ')) {
      await handleGit(cmd.slice(4).trim())
      return
    }

    if (cmd.startsWith('/refactor ') || cmd === '/refactor') {
      const goal = cmd.slice(9).trim()
      if (!goal) { printer.systemMsg('usage: /refactor <goal>'); return }
      await runRefactor(goal)
      return
    }

    if (cmd.startsWith('/think ') || cmd === '/think') {
      const query = cmd.slice(6).trim()
      if (!query) { printer.systemMsg('usage: /think <query>'); return }
      printer.userMsg(`/think ${query}`)
      setStatus('thinking')
      setTaskLabel(`gathering: ${query}`)
      abortRef.current = new AbortController()
      try {
        const result = await runDeepThink(
          query, config, currentModelRef.current, abortRef.current.signal,
          (toolName) => setCurrentTool(`gather:${toolName}`),
        )
        setCurrentTool(undefined)
        printer.systemMsg(`gathered: ${result.toolCalls} tool call(s), ${result.webCalls} web call(s)`)
        if (result.findings) {
          pushHistory({ role: 'user', content: `/think ${query}` })
          pushHistory({ role: 'assistant', content: result.findings })
          pushHistory({ role: 'user', content: `Based on your research above, give a complete answer to: ${query}` })
          await runLoop(buildContext(), 0, query)
        } else {
          printer.systemMsg('nothing gathered — try rephrasing')
          setStatus('idle')
        }
      } catch (e) {
        printer.errorMsg(`deep think failed: ${e}`)
        setStatus('idle')
      } finally {
        setCurrentTool(undefined)
        setTaskLabel(undefined)
      }
      return
    }

    if (cmd === '/plan' || cmd.startsWith('/plan ')) {
      const topic = cmd.slice(5).trim()
      setPlanningMode(true)
      systemPromptRef.current = getSystemPrompt(
        `\n- CWD: ${cwd}\n- MODE: Planning assistant. Help the user plan step by step. Ask clarifying questions. Suggest concrete next steps. Use plain text only — no markdown, no headers, no bold, no bullets with asterisks, no backtick blocks. Use numbered lists and plain indentation for structure.`,
        mcpTools
      )
      const msg = topic ? `I want to plan: ${topic}` : 'I want to start planning. Help me think through my goals step by step.'
      printer.userMsg(msg)
      pushHistory({ role: 'user', content: msg })
      await runLoop(buildContext())
      return
    }

    if (cmd === '/plan:done') {
      setPlanningMode(false)
      systemPromptRef.current = getSystemPrompt(`\n- CWD: ${cwd}`, mcpTools)
      printer.systemMsg('planning mode off')
      return
    }

    if (cmd.startsWith('/plan:')) {
      const subCmd = cmd.slice(6)
      const subPrompts: Record<string, string> = {
        next:      'What are the next concrete steps I should take?',
        breakdown: 'Can you break this down into specific subtasks?',
        review:    'Please review and critique our plan so far. What are we missing?',
      }
      const msg = subPrompts[subCmd]
      if (msg) {
        printer.userMsg(msg)
        pushHistory({ role: 'user', content: msg })
        await runLoop(buildContext())
        return
      }
    }

    if (cmd === '/sessions') {
      const sessions = listSessions()
      if (!sessions.length) { printer.systemMsg('no saved sessions'); return }
      printer.systemMsg(sessions.map(s =>
        `${s.name === sessionNameRef.current ? '▶ ' : '  '}${s.name}  (${s.messageCount} msgs)`
      ).join('\n'))
      return
    }

    if (cmd.startsWith('/session')) {
      const arg = cmd.slice(8).trim()
      if (!arg) { printer.systemMsg(`current: ${sessionNameRef.current}`); return }

      if (arg.startsWith('delete ')) {
        const target = arg.slice(7).trim()
        if (!target) { printer.systemMsg('usage: /session delete <name|all>'); return }
        if (target === 'all') {
          const count = deleteAllSessions(sessionNameRef.current)
          printer.systemMsg(`deleted ${count} session(s) — kept active: ${sessionNameRef.current}`)
          return
        }
        if (target === sessionNameRef.current) { printer.systemMsg('cannot delete active session — switch first'); return }
        try { deleteSession(target); printer.systemMsg(`deleted: ${target}`) }
        catch (e) { printer.errorMsg(`delete failed: ${String(e)}`) }
        return
      }

      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
      saveSession(sessionNameRef.current, historyRef.current)
      historyRef.current = loadSession(arg)
      setSessionName(arg)
      printer.systemMsg(`session → ${arg}  (${historyRef.current.length} messages)`)
      return
    }

    if (cmd === '/index' || cmd.startsWith('/index ')) {
      const sub = cmd.slice(6).trim()

      if (!sub || sub === 'status') {
        const stats = indexStats(cwd)
        if (!stats) { printer.systemMsg('no index — run /index build'); return }
        const age = Math.round((Date.now() - stats.mtime) / 60000)
        printer.systemMsg(`index: ${stats.count} chunks, ${stats.sizeKb} KB, built ${age < 2 ? 'just now' : `${age}m ago`}`)
        return
      }

      if (sub === 'build') {
        const embedModel = config.embedModel ?? 'nomic-embed-text'
        printer.systemMsg(`building index with ${embedModel}…`)
        setStatus('thinking')
        setTaskLabel('indexing codebase…')
        try {
          const result = await buildIndex(config, cwd, ({ file, done, total }) => {
            setTaskLabel(`indexing ${done + 1}/${total}: ${file}`)
          })
          printer.systemMsg(`index built: ${result.indexed} chunks across ${result.files} files${result.skipped ? `, ${result.skipped} embed errors` : ''}`)
        } catch (e) {
          printer.errorMsg(`index build failed: ${e}`)
        } finally {
          setStatus('idle')
          setTaskLabel(undefined)
        }
        return
      }

      if (sub === 'clear') {
        clearIndex(cwd)
        printer.systemMsg('index cleared')
        return
      }

      if (sub.startsWith('search ')) {
        const query = sub.slice(7).trim()
        if (!query) { printer.systemMsg('usage: /index search <query>'); return }
        const chunks = loadIndex(cwd)
        if (!chunks.length) { printer.systemMsg('no index — run /index build'); return }
        const embedModel = config.embedModel ?? 'nomic-embed-text'
        try {
          const queryVec = await embed(config.baseUrl, embedModel, query)
          const results = topK(chunks, queryVec, 5)
          printer.systemMsg(results.map((r, i) =>
            `[${i + 1}] ${r.file} lines ${r.start + 1}–${r.end + 1} (score ${r.score.toFixed(3)})`
          ).join('\n'))
        } catch (e) {
          printer.errorMsg(`search failed: ${e}`)
        }
        return
      }

      printer.systemMsg('usage: /index build | /index status | /index search <query> | /index clear')
      return
    }

    if (text.startsWith('/')) {
      const [slashCmd, ...rest] = text.slice(1).split(' ')
      const skill = skills.get(slashCmd)
      if (skill) {
        if (skill.name === 'list') {
          printer.systemMsg(skills.list().map(s =>
            `/${s.ns === 'default' ? '' : s.ns + ':'}${s.name}  — ${s.description}`
          ).join('\n'))
          return
        }
        if (skill.execute) {
          const ctx = {
            messages: historyRef.current.map(m => ({ role: m.role, content: m.content })),
            appendMessage: (_role: string, content: string) => printer.systemMsg(content),
            setSystemPrompt: (p: string) => { systemPromptRef.current = p },
            getSystemPrompt: () => systemPromptRef.current,
          }
          const result = await skill.execute(rest.join(' '), ctx)
          if (result) printer.systemMsg(result)
          return
        }
        if (skill.prompt) {
          printer.userMsg(skill.prompt)
          pushHistory({ role: 'user', content: skill.prompt })
          await runLoop(buildContext())
          return
        }
      }
      printer.systemMsg(`unknown command: /${slashCmd}  —  try /list`)
      return
    }

    renameFromMessage(text)
    const contextPrefix = buildAtContext(text)
    const shouldInjectGit = config.gitContext !== false && looksCodeRelated(text)
    const { prefix: gitPrefix, label: gitLabel } = shouldInjectGit
      ? await buildGitContext(cwd, lastGitStatusRef)
      : { prefix: '', label: '' }
    if (gitLabel) printer.systemMsg(gitLabel)
    printer.userMsg(text)
    pushHistory({ role: 'user', content: gitPrefix + contextPrefix + text })
    await runLoop(buildContext())
  }, [])

  return { handleSubmit }
}
