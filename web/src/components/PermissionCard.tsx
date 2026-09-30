import { useEffect } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/Markdown'
import type { Answer, PendingPermission } from '@/lib/types'

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

  // 1 / 2 / 3 answer from the keyboard, as in the terminal — unless you're typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLTextAreaElement | null
      if (el?.tagName === 'TEXTAREA' && el.value) return
      const n = Number(e.key)
      if (n >= 1 && n <= 3 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onAnswer(options[n - 1].answer) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const body = plan ? null : preview(p)
  const diffy = p.toolName === 'edit_file'
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-primary/50 bg-card p-4 shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
      <div className="flex items-start gap-3">
        <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <div className="font-medium">{plan ? 'Ready to start?' : `${p.label}?`}</div>
          <div className="text-sm text-muted-foreground">
            {plan ? 'Nothing has changed yet — approving lets miii carry out this plan.' : 'miii wants to do this in your project.'}
          </div>
        </div>
      </div>
      {plan && p.plan && <div className="max-h-[40vh] overflow-y-auto rounded-lg border px-4 py-3"><Markdown text={p.plan} /></div>}
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
