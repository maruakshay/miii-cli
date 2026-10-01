import { FolderOpen, MessageSquare, SquarePen, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { post } from '@/lib/api'
import type { SessionMeta } from '@/lib/types'
import { cn } from '@/lib/utils'

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function Sidebar({
  sessions, activeId, cwd, busy, onPick, onError,
}: {
  sessions: SessionMeta[]
  activeId: string
  cwd: string
  busy: boolean
  onPick: () => void
  onError: (msg: string) => void
}) {
  const act = (p: Promise<void>) => { p.catch((e: Error) => onError(e.message)); onPick() }
  const parts = cwd.replace(/^\/(Users|home)\/[^/]+/, '~').split(/[\\/]/)
  const home = parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : parts.join('/')
  return (
    <div className="flex h-full flex-col gap-1 bg-sidebar p-3 text-sidebar-foreground">
      <div className="px-2 pt-1 pb-3">
        <span className="font-mono text-base font-semibold tracking-tight"><span className="text-primary">&gt;_</span> miii</span>
      </div>
      <Button variant="outline" className="justify-start" onClick={() => act(post('session/new'))} disabled={busy}>
        <SquarePen /> New chat
      </Button>
      <div className="px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground">Recent</div>
      <nav className="-mx-1 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1">
        {sessions.length === 0 && <div className="px-2 py-1 text-sm text-muted-foreground">No chats yet</div>}
        {sessions.map((s) => (
          <div key={s.id} className={cn('group flex items-center rounded-lg hover:bg-sidebar-accent', s.id === activeId && 'bg-sidebar-accent')}>
            <button
              type="button"
              disabled={busy && s.id !== activeId}
              onClick={() => s.id !== activeId && act(post('session/resume', { id: s.id }))}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm disabled:opacity-50"
              title={s.title}
            >
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{s.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground group-hover:hidden">{ago(s.updatedAt)}</span>
            </button>
            <button
              type="button"
              aria-label="Delete chat"
              onClick={() => { if (confirm(`Delete “${s.title}”?`)) act(post('session/delete', { id: s.id })) }}
              className="mr-1 hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </nav>
      <div className="flex items-center gap-2 border-t px-2 pt-3 text-xs text-muted-foreground" title={cwd}>
        <FolderOpen className="size-3.5 shrink-0" />
        <span className="truncate font-mono">{home}</span>
      </div>
    </div>
  )
}
