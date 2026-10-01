import { useState } from 'react'
import { ChevronRight, CircleCheck, CircleX, Loader2, ListTodo, Circle, CircleDot } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DiffView } from '@/components/Diff'
import { Markdown } from '@/components/Markdown'
import type { WebTool } from '@/lib/types'
import { cn } from '@/lib/utils'

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

function Todos({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ListTodo className="size-3.5" /> Tasks · {done}/{todos.length}
      </div>
      <ul className="space-y-1 text-sm">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2">
            {t.status === 'completed' ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
              : t.status === 'in_progress' ? <CircleDot className="mt-0.5 size-4 shrink-0 text-primary" />
              : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through', t.status === 'in_progress' && 'font-medium')}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Plan({ plan }: { plan: string }) {
  return (
    <div className="rounded-xl border border-plan/50 bg-card px-5 py-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-plan">Proposed plan</div>
      <Markdown text={plan} />
    </div>
  )
}

/** The part of a call's input worth showing when it is opened. */
function inputPreview(tool: WebTool): string | null {
  const i = tool.input
  if (typeof i.command === 'string') return `$ ${i.command}`
  if (tool.name === 'write_file' && typeof i.content === 'string') return null // the diff says it better
  if (tool.name === 'edit_file' || tool.name === 'read_file') return null
  const keys = Object.keys(i)
  return keys.length ? JSON.stringify(i, null, 2) : null
}

export function ToolCall({ tool }: { tool: WebTool }) {
  const [open, setOpen] = useState(false)

  if (tool.name === 'write_todos' && Array.isArray(tool.input.todos)) return <Todos todos={tool.input.todos as Todo[]} />
  if (tool.name === 'exit_plan_mode' && typeof tool.input.plan === 'string') return <Plan plan={tool.input.plan} />

  const r = tool.result
  const pending = !r
  const preview = inputPreview(tool)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
      <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-accent/50">
        {pending ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          : r.is_error ? <CircleX className="size-4 shrink-0 text-destructive" />
          : <CircleCheck className="size-4 shrink-0 text-success" />}
        <span className="min-w-0 flex-1 truncate">{tool.label}</span>
        {r?.diff && (
          <span className="shrink-0 font-mono text-xs">
            <span className="text-diff-add-fg">+{r.diff.added}</span>{' '}
            <span className="text-diff-del-fg">−{r.diff.removed}</span>
          </span>
        )}
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t px-3 py-2.5">
        <div className="break-all font-mono text-xs text-muted-foreground">{tool.technical}</div>
        {preview && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code px-3 py-2 font-mono text-xs">{preview}</pre>}
        {r?.diff ? <DiffView diff={r.diff} />
          : r ? (
            <pre className={cn('max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code px-3 py-2 font-mono text-xs', r.is_error && 'text-destructive')}>
              {r.content || '(no output)'}
            </pre>
          ) : <div className="text-xs text-muted-foreground">Running…</div>}
      </CollapsibleContent>
    </Collapsible>
  )
}
