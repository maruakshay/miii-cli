import { useEffect, useRef } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Answer, PendingPermission } from '@/lib/types'
import { cn } from '@/lib/utils'

function preview(p: PendingPermission): string | null {
  const i = (p.input ?? {}) as Record<string, unknown>
  if (typeof i.command === 'string') return `$ ${i.command}`
  if (p.toolName === 'edit_file') {
    const edits = Array.isArray(i.edits) ? (i.edits as Array<Record<string, unknown>>) : [i]
    return edits
      .map((e) => {
        const minus = String(e.old_str ?? '').split('\n').map((l) => `- ${l}`).join('\n')
        const plus = String(e.new_str ?? '').split('\n').map((l) => `+ ${l}`).join('\n')
        return `${minus}\n${plus}`
      })
      .join('\n⋯\n')
  }
  if (p.toolName === 'write_file' && typeof i.content === 'string') {
    const lines = i.content.split('\n')
    return lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n… ${lines.length - 40} more lines` : '')
  }
  const keys = Object.keys(i)
  return keys.length ? JSON.stringify(i, null, 2) : null
}

function Line({ text }: { text: string }) {
  if (text.startsWith('+ ')) return <div className="bg-diff-add text-diff-add-fg">{text}</div>
  if (text.startsWith('- ')) return <div className="bg-diff-del text-diff-del-fg">{text}</div>
  return <div>{text}</div>
}

export function PermissionCard({ p, onAnswer }: { p: PendingPermission; onAnswer: (a: Answer) => void }) {
  const plan = p.toolName === 'exit_plan_mode'
  const options: Array<{ answer: Answer; label: string; primary?: boolean }> = plan
    ? [
        { answer: 'yes', label: 'Yes, start working', primary: true },
        { answer: 'always', label: 'Yes, and auto-accept edits' },
        { answer: 'no', label: 'No, keep planning' },
      ]
    : [
        { answer: 'yes', label: 'Allow once', primary: true },
        { answer: 'always', label: p.rule ? `Always allow ${p.rule}` : 'Always allow here' },
        { answer: 'no', label: 'Deny' },
      ]

  // 1 / 2 / 3 answer from the keyboard, as in the terminal — but never from a
  // text field, even an empty one: "1. rename the…" typed into the composer
  // must not approve the first option. The card takes focus when it appears so
  // the keys work, unless you were in the middle of writing something.
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null
    const typing = (el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT') && el.value
    if (!typing) card.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return
      const n = Number(e.key)
      if (n >= 1 && n <= 3 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onAnswer(options[n - 1].answer) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const body = plan ? null : preview(p)
  const diffy = p.toolName === 'edit_file'
  return (
    <div
      ref={card}
      tabIndex={-1}
      role="alertdialog"
      aria-label={plan ? 'Approve the plan' : `${p.label}?`}
      className={cn('flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-lg outline-none animate-in fade-in-0 slide-in-from-bottom-2', plan ? 'border-plan/60' : 'border-primary/50')}
    >
      <div className="flex items-start gap-3">
        <ShieldQuestion className={cn('mt-0.5 size-5 shrink-0', plan ? 'text-plan' : 'text-primary')} />
        <div className="min-w-0">
          <div className="font-medium">{plan ? 'Ready to start?' : `${p.label}?`}</div>
          <div className="text-sm text-muted-foreground">
            {plan ? 'The plan is above. Nothing has changed yet — approving lets miii carry it out.' : 'miii wants to do this in your project.'}
          </div>
        </div>
      </div>
      {body && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code px-3 py-2 font-mono text-xs">
          {diffy ? body.split('\n').map((l, i) => <Line key={i} text={l} />) : body}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((o, i) => (
          <Button key={o.answer} size="sm" variant={o.primary ? 'inverted' : 'outline'} onClick={() => onAnswer(o.answer)} className="max-w-full">
            <span className="truncate">{o.label}</span>
            <kbd className="text-[10px] opacity-60">{i + 1}</kbd>
          </Button>
        ))}
      </div>
    </div>
  )
}
