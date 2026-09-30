import { useState } from 'react'
import { Brain, ChevronRight, ImageIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CopyButton, Markdown } from '@/components/Markdown'
import { ToolCall } from '@/components/ToolCall'
import type { WebMessage } from '@/lib/types'
import { cn } from '@/lib/utils'

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

export function MessageView({ m }: { m: WebMessage }) {
  if (m.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 whitespace-pre-wrap break-words">
        {m.content}
        {m.images ? (
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <ImageIcon className="size-3.5" /> {m.images} image{m.images > 1 ? 's' : ''}
          </div>
        ) : null}
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
      {!m.live && m.tokens && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {hasText && <CopyButton text={m.content} label="Copy" className="-ml-1.5" />}
          <span>{fmtTokens(m.tokens.prompt + m.tokens.eval)} tokens</span>
          {m.duration ? <span>{(m.duration / 1000).toFixed(1)}s</span> : null}
        </div>
      )}
    </div>
  )
}
