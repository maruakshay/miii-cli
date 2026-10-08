import { useState } from 'react'
import { Brain, ChevronRight, ImageIcon, Undo2 } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CopyButton, Markdown } from '@/components/Markdown'
import { ToolCall } from '@/components/ToolCall'
import type { WebMessage } from '@/lib/types'
import { cn, fmtDuration } from '@/lib/utils'

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <Brain className={cn('size-4', live && 'animate-pulse')} />
        {live ? 'Thinking…' : 'Thought process'}
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap border-l-2 pl-3 text-sm text-muted-foreground">{text}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function MessageView({ m, onRewind }: { m: WebMessage; onRewind?: (m: WebMessage) => void }) {
  if (m.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-xl rounded-l-sm border-l-[3px] border-user-rule bg-secondary px-4 py-2.5 whitespace-pre-wrap break-words">
          {m.content}
          {m.images ? (
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <ImageIcon className="size-3.5" /> {m.images} image{m.images > 1 ? 's' : ''}
            </div>
          ) : null}
        </div>
        {onRewind && m.turn !== undefined && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyButton text={m.content} label="Copy" />
            <button
              type="button"
              onClick={() => onRewind(m)}
              title="Undo this message and everything after it, including file changes"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Undo2 className="size-3.5" /> Rewind to here
            </button>
          </div>
        )}
      </div>
    )
  }
  if (m.role === 'notice') {
    return (
      <div className="rounded-r-lg border-l-[3px] border-primary bg-primary/5 px-4 py-2 text-sm">
        <Markdown text={m.content} />
      </div>
    )
  }
  const hasText = m.content.trim().length > 0
  return (
    <div className="group flex min-w-0 flex-col gap-2.5">
      {m.thinking && <Thinking text={m.thinking} live={m.live && !hasText && !m.tools?.length} />}
      {m.tools?.length ? <div className="flex flex-col gap-1.5">{m.tools.map((t) => <ToolCall key={t.id} tool={t} />)}</div> : null}
      {(hasText || (m.live && !m.thinking && !m.tools?.length)) && <Markdown text={m.content} streaming={m.live} />}
      {!m.live && (m.tokens || m.duration) && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {hasText && <CopyButton text={m.content} label="Copy" className="-ml-1.5" />}
          {/* Zero means the provider didn't report usage, not that it was free. */}
          {m.tokens && m.tokens.prompt + m.tokens.eval > 0 ? <span>{fmtTokens(m.tokens.prompt + m.tokens.eval)} tokens</span> : null}
          {m.duration ? <span>{fmtDuration(m.duration, true)}</span> : null}
        </div>
      )}
    </div>
  )
}
