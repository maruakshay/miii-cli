/**
 * The web UI's agent runtime — what useAgentRunner is to the TUI, without React.
 *
 * One of these lives for the whole `miii web` process and owns the running
 * session: its history, the display transcript, the permission prompt waiting
 * on an answer, the mode. Browsers are views onto it. Every change is pushed to
 * each connected tab as an event, and a tab that connects late (or reloads
 * mid-turn) gets the whole state in one `hello` and carries on from there.
 *
 * The transcript is kept here rather than rebuilt in the browser from raw agent
 * events, so there is exactly one place that knows how a turn becomes messages.
 * The browser upserts messages by id and renders them; it never interprets the
 * agent's event stream itself.
 */
import { runAgent } from '../agent/loop.js'
import { HookBus } from '../hooks/bus.js'
import { checkpointPreToolHook, snapshotForTurn, listCheckpoints, restoreTo, clearCheckpoints } from '../session/checkpoint.js'
import { compactHistory, estimateHistoryTokens } from '../agent/compact.js'
import {
  persistSession, setSessionTitle, summarizeConversation, newSessionId,
  listSessions, loadSession, deleteSession, toDisplayMessages, type SessionMeta,
} from '../session/store.js'
import {
  loadConfig, setModel, setEffort, setProvider, setModelContexts, providerEntries, resolveProvider,
  type Effort,
} from '../config.js'
import { listModels, modelContext, isAvailable, NOT_AVAILABLE } from '../llm/client.js'
import { MODE_HINT, MODE_LABEL, PERMISSION_MODES, subjectFor, widestPattern, type PermissionMode } from '../permissions/policy.js'
import { defaultPermissionMode } from '../settings.js'
import { describeTool } from '../ui/toolLabel.js'
import { expandCommand, findCustomCommand, customCommands, invalidateCustomCommands } from '../commands/custom.js'
import { COMMANDS } from '../ui/constants.js'
import { INIT_PROMPT, reviewPrompt, contextReport, costReport, mcpReport, agentsReport, settingsReport } from '../ui/reports.js'
import { mcpStatus } from '../mcp/registry.js'
import type { FileDiff } from '../diff.js'
import type { MiiMessage } from '../agent/types.js'

/** Live updates to a streaming message are batched to this interval. */
const FLUSH_MS = 60
/**
 * Tool output shown in the browser is capped. The model saw all of it; a person
 * skimming a transcript does not need a 2 MB `npm ls` pushed down a socket on
 * every repaint.
 */
const MAX_RESULT_CHARS = 20_000

export interface WebTool {
  id: string
  name: string
  input: Record<string, unknown>
  /** "Running the tests" — the sentence the transcript leads with. */
  label: string
  /** `Bash(npm test)` — the exact call, shown when the row is opened. */
  technical: string
  result?: { content: string; is_error?: boolean; diff?: FileDiff }
}

export interface WebMessage {
  id: number
  /** `notice` is miii talking, not the model: a mode change, a report, a hook warning. */
  role: 'user' | 'assistant' | 'notice'
  content: string
  thinking?: string
  tools?: WebTool[]
  /** Images attached to a user message — the count, not the bytes. */
  images?: number
  /** On a user message: the history index it starts at — what `rewind` takes to drop back to before it. */
  turn?: number
  /** Still streaming. */
  live?: boolean
  tokens?: { prompt: number; eval: number }
  duration?: number
}

export interface PendingPermission {
  id: number
  toolName: string
  input: unknown
  label: string
  /** The glob an "always" answer would persist, so the button can name it. */
  rule: string
  plan?: string
}

export interface WebState {
  cwd: string
  sessionId: string
  title: string
  busy: boolean
  status?: string
  mode: PermissionMode
  model?: string
  provider: string
  effort: Effort
  ctx: number | null
  usedTokens: number
  totals: { input: number; output: number; turns: number; ms: number }
  queued: string[]
  pending: PendingPermission | null
  error: string | null
}

export type WebEvent =
  | { type: 'state'; state: WebState }
  | { type: 'message'; message: WebMessage }
  | { type: 'messages'; messages: WebMessage[] }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'toast'; text: string }

export interface Hello {
  state: WebState
  messages: WebMessage[]
  sessions: SessionMeta[]
  commands: Array<{ name: string; description: string }>
  modes: Array<{ mode: PermissionMode; label: string; hint: string }>
}

type Answer = 'yes' | 'no' | 'always'

function clip(s: string): string {
  return s.length > MAX_RESULT_CHARS
    ? `${s.slice(0, MAX_RESULT_CHARS)}\n… ${s.length - MAX_RESULT_CHARS} more characters not shown`
    : s
}

function webTool(id: string, name: string, input: Record<string, unknown>): WebTool {
  const d = describeTool(name, input)
  return { id, name, input, label: d.text, technical: d.technical }
}

/** Resumed history → web messages. Thinking and timings are not stored, so they are absent. */
export function historyToWeb(history: MiiMessage[], nextId: () => number): WebMessage[] {
  // toDisplayMessages keeps exactly the user entries that carry text, in order,
  // so their history indices line up with its user messages one for one.
  const turns = history.flatMap((m, i) => (m.role === 'user' && userText(m).trim() ? [i] : []))
  let u = 0
  return toDisplayMessages(history).map((m) => {
    if (m.role === 'user') return { id: nextId(), role: m.role, content: m.content, ...(turns[u] !== undefined ? { turn: turns[u++] } : {}) }
    const results = new Map((m.tool_results ?? []).map((r) => [r.tool_use_id, r]))
    const tools = m.tool_uses?.map((u) => {
      const t = webTool(u.id, u.name, u.input)
      const r = results.get(u.id)
      if (r) t.result = { content: clip(r.content), is_error: r.is_error, diff: r.diff }
      return t
    })
    return { id: nextId(), role: m.role, content: m.content, ...(tools?.length ? { tools } : {}) }
  })
}

function userText(m: MiiMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

export class WebAgent {
  readonly cwd: string
  private listeners = new Set<(ev: WebEvent) => void>()
  private seq = 0
  private nextId = () => ++this.seq

  private sessionId: string
  private history: MiiMessage[] = []
  private messages: WebMessage[] = []
  private title = ''
  private titled = new Set<string>()

  private mode: PermissionMode
  private busy = false
  private status?: string
  private error: string | null = null
  private ctx: number | null = null
  private usedTokens = 0
  private totals = { input: 0, output: 0, turns: 0, ms: 0 }
  private queue: Array<{ text: string; images?: string[] }> = []
  private pending: (PendingPermission & { resolve: (a: Answer) => void }) | null = null
  private abort: AbortController | null = null
  private hooks: HookBus

  constructor(cwd: string, opts: { resumeId?: string; continueLast?: boolean } = {}) {
    this.cwd = cwd
    this.mode = defaultPermissionMode(cwd) ?? 'default'
    const resume = opts.resumeId ?? (opts.continueLast ? listSessions()[0]?.id : undefined)
    this.sessionId = resume ?? newSessionId()
    this.hooks = this.makeHooks()
    if (resume) this.loadInto(resume)
    const model = loadConfig().model
    if (model) void this.ensureContext(model)
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  subscribe(fn: (ev: WebEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(ev: WebEvent) {
    for (const fn of this.listeners) {
      try { fn(ev) } catch { /* a dead socket is the server's to clean up */ }
    }
  }

  private makeHooks(): HookBus {
    const bus = new HookBus({ id: this.sessionId, cwd: this.cwd })
    bus.onPreTool((use) => checkpointPreToolHook(use, this.cwd))
    return bus
  }

  state(): WebState {
    const cfg = loadConfig()
    const p = this.pending
    return {
      cwd: this.cwd,
      sessionId: this.sessionId,
      title: this.title,
      busy: this.busy,
      ...(this.status ? { status: this.status } : {}),
      mode: this.mode,
      ...(cfg.model ? { model: cfg.model } : {}),
      provider: resolveProvider(cfg).name,
      effort: cfg.effort ?? 'medium',
      ctx: this.ctx,
      usedTokens: this.usedTokens,
      totals: this.totals,
      queued: this.queue.map((q) => q.text),
      pending: p ? { id: p.id, toolName: p.toolName, input: p.input, label: p.label, rule: p.rule, ...(p.plan ? { plan: p.plan } : {}) } : null,
      error: this.error,
    }
  }

  hello(): Hello {
    const builtin = COMMANDS.filter((c) => WEB_COMMANDS.has(c.name))
    const taken = new Set(builtin.map((c) => c.name))
    const custom = customCommands(this.cwd)
      .filter((c) => !taken.has(c.name))
      .map((c) => ({ name: c.name, description: c.description }))
    return {
      state: this.state(),
      messages: this.messages,
      sessions: listSessions(),
      commands: [...builtin.map((c) => ({ name: c.name, description: c.description })), ...custom],
      modes: PERMISSION_MODES.map((mode) => ({ mode, label: MODE_LABEL[mode], hint: MODE_HINT[mode] })),
    }
  }

  private pushState() { this.emit({ type: 'state', state: this.state() }) }

  private add(msg: Omit<WebMessage, 'id'>): WebMessage {
    const m = { id: this.nextId(), ...msg }
    this.messages.push(m)
    this.emit({ type: 'message', message: m })
    return m
  }

  private notice(content: string) { this.add({ role: 'notice', content }) }

  private toast(text: string) { this.emit({ type: 'toast', text }) }

  private resetView(messages: WebMessage[]) {
    this.messages = messages
    this.emit({ type: 'messages', messages })
  }

  private loadInto(id: string) {
    this.sessionId = id
    this.history = loadSession(id)
    this.title = listSessions().find((s) => s.id === id)?.title ?? ''
    this.titled.add(id)
    this.usedTokens = estimateHistoryTokens(this.history)
    this.messages = historyToWeb(this.history, this.nextId)
  }

  // ── models and backends ───────────────────────────────────────────────────

  /** `listed: false` means the provider has no /models — the list is a suggestion and any typed name goes. */
  async models(): Promise<{ models: string[]; listed: boolean; error?: string }> {
    try {
      const { models, listed } = await listModels()
      // Without a list, the configured model is the one we know works.
      const current = loadConfig().model
      return { models: !listed && current && !models.includes(current) ? [current, ...models] : models, listed }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { models: [], listed: false, error: isAvailable() ? msg : NOT_AVAILABLE() }
    }
  }

  providers() {
    const active = resolveProvider().name
    return providerEntries().map((p) => ({ name: p.name, kind: p.kind, baseUrl: p.entry.baseUrl, active: p.name === active }))
  }

  private async ensureContext(model: string) {
    const known = loadConfig().modelContexts?.[model]
    if (known != null) { this.ctx = known; return }
    try {
      const ctx = await modelContext(model)
      setModelContexts({ [model]: ctx })
      if (loadConfig().model === model) { this.ctx = ctx; this.pushState() }
    } catch { /* cosmetic — the meter just shows no ceiling */ }
  }

  chooseModel(model: string) {
    setModel(model)
    this.ctx = null
    void this.ensureContext(model)
    this.pushState()
  }

  chooseProvider(name: string): boolean {
    if (!providerEntries().some((p) => p.name === name)) return false
    setProvider(name)
    this.ctx = null
    this.pushState()
    return true
  }

  chooseEffort(effort: Effort) {
    setEffort(effort)
    this.pushState()
  }

  setMode(mode: PermissionMode) {
    if (!PERMISSION_MODES.includes(mode)) return
    this.mode = mode
    this.pushState()
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  private guardIdle(what: string): boolean {
    if (!this.busy) return true
    this.toast(`stop the current turn before you ${what}`)
    return false
  }

  newSession() {
    if (!this.guardIdle('start a new chat')) return
    this.sessionId = newSessionId()
    this.history = []
    this.title = ''
    this.usedTokens = 0
    this.totals = { input: 0, output: 0, turns: 0, ms: 0 }
    this.error = null
    this.hooks = this.makeHooks()
    this.resetView([])
    this.pushState()
  }

  resume(id: string) {
    if (!this.guardIdle('switch chats')) return
    if (!listSessions().some((s) => s.id === id)) { this.toast('that session no longer exists'); return }
    this.loadInto(id)
    this.error = null
    this.hooks = this.makeHooks()
    void this.hooks.fireSessionStart('resume')
    this.emit({ type: 'messages', messages: this.messages })
    this.pushState()
  }

  removeSession(id: string) {
    if (id === this.sessionId && !this.guardIdle('delete this chat')) return
    deleteSession(id)
    clearCheckpoints(id, this.cwd)
    if (id === this.sessionId) this.newSession()
    this.emit({ type: 'sessions', sessions: listSessions() })
  }

  // ── permissions ───────────────────────────────────────────────────────────

  private ask = (toolName: string, input: unknown): Promise<Answer> =>
    new Promise((resolve) => {
      const inp = (input ?? {}) as Record<string, unknown>
      this.pending = {
        id: this.nextId(),
        toolName,
        input,
        label: describeTool(toolName, inp).text,
        rule: toolName === 'exit_plan_mode' ? '' : widestPattern(toolName, subjectFor(toolName, input)),
        ...(toolName === 'exit_plan_mode' && typeof inp.plan === 'string' ? { plan: inp.plan } : {}),
        resolve,
      }
      this.status = toolName === 'exit_plan_mode' ? 'Waiting for you to approve the plan' : 'Waiting for your approval'
      this.pushState()
    })

  answer(id: number, answer: Answer) {
    const p = this.pending
    if (!p || p.id !== id) return
    this.pending = null
    this.status = 'Thinking…'
    p.resolve(answer)
    this.pushState()
  }

  // ── running a turn ────────────────────────────────────────────────────────

  stop() {
    // A turn parked on a prompt never sees the abort; answer it first.
    if (this.pending) this.answer(this.pending.id, 'no')
    this.abort?.abort()
  }

  /** Text typed in the composer — a slash command, or a message for the model. */
  async submit(text: string, images?: string[]) {
    const trimmed = text.trim()
    if (trimmed.startsWith('/') && !images?.length) {
      const handled = await this.command(trimmed)
      if (handled) return
    }
    if (!trimmed && !images?.length) return
    await this.send(trimmed, images)
  }

  async send(text: string, images?: string[]) {
    const model = loadConfig().model
    if (!model) { this.toast('pick a model first'); return }
    if (this.busy) {
      this.queue.push({ text, ...(images?.length ? { images } : {}) })
      this.pushState()
      return
    }
    this.busy = true
    this.status = 'Thinking…'
    this.error = null
    this.add({ role: 'user', content: text, turn: this.history.length, ...(images?.length ? { images: images.length } : {}) })
    this.pushState()

    const started = Date.now()
    const controller = new AbortController()
    this.abort = controller

    // The message streaming right now. A tool round commits it and opens the next.
    let live: WebMessage | null = null
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const open = (): WebMessage => {
      if (!live) {
        live = { id: this.nextId(), role: 'assistant', content: '', live: true }
        this.messages.push(live)
      }
      return live
    }
    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      if (live) this.emit({ type: 'message', message: live })
    }
    const soon = () => { if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS) }
    const commit = (tokens?: { prompt: number; eval: number }) => {
      if (!live) return
      const m: WebMessage = live
      delete m.live
      if (tokens) { m.tokens = tokens; m.duration = Date.now() - started }
      flush()
      live = null
    }

    snapshotForTurn(this.sessionId, this.history.length)

    const takeSteering = () => {
      const taken = this.queue.filter((q) => !q.images?.length)
      if (!taken.length) return []
      this.queue = this.queue.filter((q) => q.images?.length)
      this.pushState()
      return taken.map((q) => q.text)
    }

    let tokens = { prompt: 0, eval: 0 }
    try {
      const gen = runAgent({
        model,
        cwd: this.cwd,
        history: this.history,
        userText: text,
        ...(images?.length ? { images } : {}),
        permissions: { ask: this.ask },
        mode: this.mode,
        hooks: this.hooks,
        signal: controller.signal,
        ...(this.ctx ? { num_ctx: this.ctx } : {}),
        takeSteering,
      })
      for (;;) {
        const step = await gen.next()
        if (step.done) { this.history = step.value; break }
        const ev = step.value
        switch (ev.type) {
          case 'text-delta':
            open().content += ev.text
            if (this.status !== 'Writing…') { this.status = 'Writing…'; this.pushState() }
            soon()
            break
          case 'thinking-delta': {
            const m = open()
            m.thinking = (m.thinking ?? '') + ev.text
            soon()
            break
          }
          case 'tool-use': {
            const m = open()
            const t = webTool(ev.block.id, ev.block.name, ev.block.input)
            m.tools = [...(m.tools ?? []), t]
            this.status = `${t.label}…`
            flush()
            this.pushState()
            break
          }
          case 'tool-result': {
            const t = live ? (live as WebMessage).tools?.find((x) => x.id === ev.block.tool_use_id) : undefined
            if (t) {
              t.result = { content: clip(ev.block.content), is_error: ev.block.is_error, ...(ev.block.diff ? { diff: ev.block.diff } : {}) }
              flush()
            }
            break
          }
          case 'turn-end':
            if (ev.stop_reason === 'tool_use') { commit(); this.status = 'Thinking…'; this.pushState() }
            break
          case 'mode-change':
            commit()
            this.mode = ev.mode
            this.notice(`**Plan approved** — ${MODE_LABEL[ev.mode]}: ${MODE_HINT[ev.mode]}`)
            this.pushState()
            break
          case 'steer':
            commit()
            this.add({ role: 'user', content: ev.text })
            break
          case 'hook-notice':
            this.notice(`⚠ ${ev.message}`)
            break
          case 'judge-notice':
            this.notice(ev.message)
            break
          case 'done':
            tokens = { prompt: ev.prompt_tokens, eval: ev.eval_tokens }
            this.usedTokens = ev.prompt_tokens + ev.eval_tokens
            this.totals = {
              input: this.totals.input + ev.prompt_tokens,
              output: this.totals.output + ev.eval_tokens,
              turns: this.totals.turns + 1,
              ms: this.totals.ms + (Date.now() - started),
            }
            break
          case 'aborted':
            tokens = { prompt: ev.prompt_tokens, eval: ev.eval_tokens }
            this.error = `Stopped · ${(ev.duration_ms / 1000).toFixed(1)}s`
            break
          case 'error':
            this.error = ev.message
            break
        }
      }
    } catch (err) {
      this.error = controller.signal.aborted
        ? `Stopped · ${((Date.now() - started) / 1000).toFixed(1)}s`
        : err instanceof Error ? err.message : String(err)
    }
    commit(tokens)

    this.abort = null
    this.busy = false
    this.status = undefined
    this.persist(model)
    this.pushState()

    // Typed after the last tool round, so the model never saw it — it is the next turn.
    if (!controller.signal.aborted && this.queue.length) {
      const next = this.queue
      this.queue = []
      const imgs = next.flatMap((q) => q.images ?? [])
      void this.send(next.map((q) => q.text).join('\n\n'), imgs.length ? imgs : undefined)
    } else if (controller.signal.aborted && this.queue.length) {
      this.queue = []
      this.pushState()
    }
  }

  private persist(model: string) {
    if (!this.history.length) return
    persistSession(this.sessionId, this.history)
    this.emit({ type: 'sessions', sessions: listSessions() })
    const id = this.sessionId
    if (this.titled.has(id) || !this.history.some((m) => m.role === 'assistant')) return
    this.titled.add(id)
    const snapshot = this.history
    void (async () => {
      try {
        const title = await summarizeConversation(model, snapshot)
        setSessionTitle(id, title)
        if (id === this.sessionId) { this.title = title; this.pushState() }
        this.emit({ type: 'sessions', sessions: listSessions() })
      } catch { /* best-effort */ }
    })()
  }

  async compact(instructions?: string) {
    const model = loadConfig().model
    if (!model || !this.guardIdle('compact')) return
    if (!this.history.length) { this.toast('nothing to compact yet — the conversation is empty'); return }
    this.busy = true
    this.status = 'Compacting context…'
    this.error = null
    this.pushState()
    const controller = new AbortController()
    this.abort = controller
    try {
      const res = await compactHistory(model, this.history, {
        ...(instructions ? { instructions } : {}),
        ...(this.ctx ? { num_ctx: this.ctx } : {}),
        signal: controller.signal,
      })
      this.history = res.history
      this.usedTokens = estimateHistoryTokens(res.history)
      persistSession(this.sessionId, this.history)
      // The indices user messages carried point into the old history; nothing before this is rewindable now.
      this.resetView(this.messages.map(({ turn: _, ...m }) => m))
      const kept = res.keptMessages ? `, last ${res.keptMessages} kept verbatim` : ''
      this.notice(
        `**Context compacted** — ${res.droppedMessages} messages summarised${kept}. ` +
        `~${res.beforeTokens} → ~${res.afterTokens} tokens.\n\n${res.summary}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.error = controller.signal.aborted ? 'Compaction cancelled — context unchanged' : `Compaction failed: ${msg}`
    } finally {
      this.abort = null
      this.busy = false
      this.status = undefined
      this.pushState()
    }
  }

  checkpoints() {
    return listCheckpoints(this.sessionId, this.cwd)
  }

  /** Put files back as they were before `turn`, and the conversation with them. */
  rewind(turn: number) {
    if (!this.guardIdle('rewind')) return
    // Any user message is a place to come back to; checkpoints only decide which files move.
    if (!Number.isInteger(turn) || this.history[turn]?.role !== 'user') { this.toast(`no turn ${turn} to rewind to`); return }
    const result = restoreTo(this.sessionId, turn, this.cwd)
    this.history = this.history.slice(0, turn)
    this.usedTokens = estimateHistoryTokens(this.history)
    if (this.history.length) persistSession(this.sessionId, this.history)
    this.resetView(historyToWeb(this.history, this.nextId))
    const parts = [
      result.restored.length ? `${result.restored.length} file(s) restored` : '',
      result.removed.length ? `${result.removed.length} removed` : '',
      result.failed.length ? `${result.failed.length} failed` : '',
    ].filter(Boolean)
    this.notice(`**Rewound** to turn ${turn} — ${parts.join(', ') || 'no files to change'}`)
    this.pushState()
  }

  // ── slash commands ────────────────────────────────────────────────────────

  /** Returns false for text that only looks like a command, so it goes to the model. */
  private async command(line: string): Promise<boolean> {
    const [head, ...rest] = line.split(/\s+/)
    const arg = rest.join(' ')
    switch (head) {
      case '/new':
      case '/clear':
        this.newSession()
        return true
      case '/plan':
        this.setMode(this.mode === 'plan' ? 'default' : 'plan')
        this.toast(`${MODE_LABEL[this.mode]} — ${MODE_HINT[this.mode]}`)
        return true
      case '/compact':
        await this.compact(arg || undefined)
        return true
      case '/init':
        await this.send(INIT_PROMPT)
        return true
      case '/review':
        await this.send(reviewPrompt(arg))
        return true
      case '/rewind': {
        const points = this.checkpoints()
        if (!points.length) { this.toast('nothing to rewind — no files have been changed this session'); return true }
        if (!arg) {
          const lines = points.map((p) => {
            const shown = p.files.slice(0, 3).join(', ')
            const more = p.files.length > 3 ? ` +${p.files.length - 3} more` : ''
            return `- \`${p.turn}\` · ${new Date(p.ts).toLocaleTimeString()} · ${shown}${more}`
          })
          this.notice(`**Checkpoints**\n\n${lines.join('\n')}\n\n\`/rewind <n>\` restores the files as they were before that point and drops the conversation back to it. \`/rewind last\` takes the most recent.`)
          return true
        }
        this.rewind(arg === 'last' ? points[points.length - 1].turn : Number(arg))
        return true
      }
      case '/context':
        this.notice(contextReport(this.history, this.mode, this.ctx, this.cwd))
        return true
      case '/cost': {
        const p = providerEntries().find((e) => e.name === resolveProvider().name)
        this.notice(costReport(this.totals, loadConfig().model, p?.name ?? 'unknown', p?.kind === 'local'))
        return true
      }
      case '/mcp':
        this.notice(mcpReport(mcpStatus()))
        return true
      case '/agents':
        this.notice(agentsReport(this.cwd))
        return true
      case '/settings':
        this.notice(`**Settings**\n\n${settingsReport(this.cwd)}`)
        return true
    }
    invalidateCustomCommands()
    const custom = findCustomCommand(head, this.cwd)
    if (custom) {
      await this.send(expandCommand(custom.body, arg))
      return true
    }
    return false
  }
}

/** The TUI commands that mean something in a browser. /vim, /copy and friends do not. */
const WEB_COMMANDS = new Set([
  '/plan', '/init', '/review', '/new', '/clear', '/rewind', '/compact',
  '/context', '/cost', '/mcp', '/agents', '/settings',
])
