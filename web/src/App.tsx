import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, KeyRound, Menu, Moon, Sun, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Composer } from '@/components/Composer'
import { MessageView } from '@/components/MessageView'
import { PermissionCard } from '@/components/PermissionCard'
import { Sidebar } from '@/components/Sidebar'
import { useMiii } from '@/hooks/useMiii'
import { get, post, token } from '@/lib/api'
import type { Answer, Checkpoint, WebMessage, WebState } from '@/lib/types'
import { cn } from '@/lib/utils'

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem('miii-theme')
      if (saved) return saved === 'dark'
    } catch { /* storage blocked */ }
    return matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try { localStorage.setItem('miii-theme', dark ? 'dark' : 'light') } catch { /* storage blocked */ }
  }, [dark])
  return [dark, () => setDark((d) => !d)] as const
}

function Elapsed({ busy }: { busy: boolean }) {
  const [start] = useState(() => Date.now())
  const [, tick] = useState(0)
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [busy])
  return <span className="font-mono text-xs text-muted-foreground/70">{Math.floor((Date.now() - start) / 1000)}s</span>
}

function Meter({ state }: { state: WebState }) {
  if (!state.usedTokens) return null
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const pct = state.ctx ? Math.min(100, Math.round((state.usedTokens / state.ctx) * 100)) : null
  return (
    <span className="hidden items-center gap-2 font-mono text-xs text-muted-foreground sm:flex" title="Context window used">
      {pct !== null && (
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <span className={cn('block h-full rounded-full bg-primary', pct > 85 && 'bg-destructive')} style={{ width: `${pct}%` }} />
        </span>
      )}
      {k(state.usedTokens)}{state.ctx ? ` / ${k(state.ctx)}` : ''}
    </span>
  )
}

const STARTERS = [
  { cmd: '/init', text: 'Write a MIII.md for this repo' },
  { cmd: '/review', text: 'Review my uncommitted changes' },
  { cmd: '/plan', text: 'Plan before touching anything' },
]

function Welcome({ cwd, onPick }: { cwd: string; onPick: (text: string) => void }) {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
  return (
    <div className="mx-auto mt-[14vh] max-w-xl text-center">
      <div className="mb-4 font-mono text-sm text-primary">&gt;_ miii</div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">What are we building?</h1>
      <p className="mb-7 text-muted-foreground">
        miii can read, edit and run code in <span className="rounded bg-code px-1.5 py-0.5 font-mono text-sm text-foreground">{name}</span>
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {STARTERS.map((s) => (
          <Button key={s.cmd} variant="outline" size="sm" className="rounded-full" onClick={() => onPick(s.cmd)}>
            <span className="font-mono text-muted-foreground">{s.cmd}</span> {s.text}
          </Button>
        ))}
      </div>
    </div>
  )
}

export function App() {
  const [toast, setToast] = useState<string | null>(null)
  const showToast = useCallback((text: string) => {
    setToast(text)
    setTimeout(() => setToast((t) => (t === text ? null : t)), 3500)
  }, [])
  const { ready, state, messages, sessions, commands, modes, connected, unauthorized } = useMiii(showToast)
  const [dark, toggleTheme] = useTheme()
  const [sideOpen, setSideOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const clearDraft = useCallback(() => setDraft(null), [])

  // Follow the transcript while you're at the bottom; leave it alone once you scroll up to read.
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [away, setAway] = useState(false)
  const toBottom = useCallback((smooth = false) => {
    pinned.current = true
    setAway(false)
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, state?.pending, state?.status])
  // A different chat starts at its latest message.
  useEffect(() => toBottom(), [state?.sessionId, toBottom])
  // Sending is a request to see the reply, wherever you were scrolled.
  const onSent = useCallback(() => toBottom(), [toBottom])

  const rewind = useCallback(async (m: WebMessage) => {
    if (m.turn === undefined) return
    try {
      const { checkpoints } = await get<{ checkpoints: Checkpoint[] }>('checkpoints')
      const files = [...new Set(checkpoints.filter((c) => c.turn >= m.turn!).flatMap((c) => c.files))]
      const shown = files.slice(0, 8).map((f) => `  • ${f}`).join('\n') + (files.length > 8 ? `\n  … and ${files.length - 8} more` : '')
      const ok = confirm(
        'Rewind to before this message?\n\nThe conversation from here on is dropped' +
        (files.length ? `, and ${files.length} file${files.length > 1 ? 's go' : ' goes'} back to how ${files.length > 1 ? 'they were' : 'it was'}:\n${shown}` : '. No files were changed after it.'),
      )
      if (!ok) return
      await post('rewind', { turn: m.turn })
      // As in the terminal: the message comes back to the composer to edit and resend.
      setDraft(m.content)
    } catch (e) {
      showToast((e as Error).message)
    }
  }, [showToast])

  useEffect(() => {
    document.title = state?.title ? `${state.title} · miii` : 'miii'
  }, [state?.title])

  // esc stops the turn, as in the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state?.busy && !document.querySelector('[data-radix-popper-content-wrapper]')) void post('stop')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state?.busy])

  if (!token || unauthorized) {
    return (
      <div className="grid h-full place-items-center p-4">
        <div className="max-w-md text-center">
          <KeyRound className="mx-auto mb-4 size-10 text-primary" />
          <h1 className="mb-2 text-xl font-semibold">Open the link from your terminal</h1>
          <p className="text-muted-foreground">
            This page needs the link <code className="rounded bg-code px-1 font-mono text-sm">miii web</code> printed when it started — it carries the key that lets this tab drive your agent.
          </p>
        </div>
      </div>
    )
  }
  if (!ready || !state) {
    return <div className="grid h-full place-items-center text-muted-foreground">Connecting to miii…</div>
  }

  const answer = (a: Answer) => state.pending && void post('permission', { id: state.pending.id, answer: a }).catch((e: Error) => showToast(e.message))
  const last = messages[messages.length - 1]
  const showStatus = state.busy && !state.pending && !(last?.live && last.content && state.status === 'Writing…')

  return (
    <TooltipProvider>
      <div className="flex h-full overflow-hidden">
        <aside className={cn(
          'fixed inset-y-0 left-0 z-40 w-72 shrink-0 border-r border-sidebar-border transition-transform md:static md:translate-x-0',
          sideOpen ? 'translate-x-0' : '-translate-x-full',
        )}>
          <Sidebar sessions={sessions} activeId={state.sessionId} cwd={state.cwd} busy={state.busy} onPick={() => setSideOpen(false)} onError={showToast} />
        </aside>
        {sideOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSideOpen(false)} />}

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-13 shrink-0 items-center gap-2 px-4">
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setSideOpen(true)} aria-label="Open sidebar"><Menu /></Button>
            <div className="min-w-0 flex-1 truncate font-medium">{state.title || (messages.length ? 'Untitled chat' : '')}</div>
            {!connected && <span className="flex items-center gap-1 text-xs text-destructive"><WifiOff className="size-3.5" /> reconnecting</span>}
            <Meter state={state} />
            <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
          </header>

          <div
            ref={scroller}
            className="flex-1 overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              setAway(!pinned.current)
            }}
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-4 pb-10 sm:px-6">
              {messages.length === 0
                ? <Welcome cwd={state.cwd} onPick={setDraft} />
                : messages.map((m, i) => (
                    <div key={m.id} className={cn(m.role === 'assistant' && messages[i - 1]?.role === 'assistant' && '-mt-3.5')}>
                      <MessageView m={m} onRewind={state.busy ? undefined : rewind} />
                    </div>
                  ))}
            </div>
          </div>

          <div className="relative shrink-0 px-4 pb-3 sm:px-6">
            {away && (
              <Button
                variant="outline"
                size="icon-sm"
                className="absolute -top-11 left-1/2 z-10 -translate-x-1/2 rounded-full bg-background shadow-md"
                onClick={() => toBottom(true)}
                aria-label="Jump to latest"
              >
                <ArrowDown />
              </Button>
            )}
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {showStatus && (
                <div className="flex items-center gap-2.5 px-1 text-sm text-muted-foreground">
                  <span className="size-3.5 animate-spin rounded-full border-2 border-muted border-t-warning" />
                  <span className="truncate">{state.status ?? 'Working…'}</span>
                  <Elapsed key={messages.filter((m) => m.role === 'user').length} busy={state.busy} />
                  <span className="ml-auto hidden text-xs sm:inline">esc to stop</span>
                </div>
              )}
              {state.error && !state.busy && <div className="px-1 text-sm whitespace-pre-wrap text-destructive">{state.error}</div>}
              {state.pending && <PermissionCard key={state.pending.id} p={state.pending} onAnswer={answer} />}
              {state.queued.length > 0 && (
                <div className="rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground">
                  <span className="font-medium">Queued:</span> {state.queued.join(' · ')}
                </div>
              )}
              {!state.model && (
                <div className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2 text-sm">Pick a model from the menu below to get started.</div>
              )}
              <Composer state={state} commands={commands} modes={modes} draft={draft} onDraftUsed={clearDraft} onSent={onSent} onError={showToast} />
              <div className="hidden text-center text-[11px] text-muted-foreground/80 sm:block">
                ⏎ send · ⇧⏎ newline · esc stop · ⇧⇥ mode · / commands · miii can make mistakes — review what it changes
              </div>
            </div>
          </div>
        </main>
      </div>
      {toast && (
        <div className="fixed bottom-32 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg bg-foreground px-4 py-2 text-sm text-background shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
          {toast}
        </div>
      )}
    </TooltipProvider>
  )
}
