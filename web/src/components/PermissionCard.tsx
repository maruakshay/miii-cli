import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ShieldQuestion } from 'lucide-react'
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

/** "Yes, and don't ask again for `npm run *`, `cargo build *` in this project". */
function RememberLabel({ rules }: { rules: string[] }) {
  if (!rules.length) return <>Yes, and don't ask again in this project</>
  const shown = rules.slice(0, 3)
  return (
    <>
      Yes, and don't ask again for{' '}
      {shown.map((r, i) => (
        <span key={r}>
          {i > 0 && ', '}
          <code className="rounded bg-code px-1 py-0.5 font-mono text-xs break-all">{r}</code>
        </span>
      ))}
      {rules.length > 3 && ` +${rules.length - 3} more`} in this project
    </>
  )
}

function Line({ text }: { text: string }) {
  if (text.startsWith('+ ')) return <div className="bg-diff-add text-diff-add-fg">{text}</div>
  if (text.startsWith('- ')) return <div className="bg-diff-del text-diff-del-fg">{text}</div>
  return <div>{text}</div>
}

export function PermissionCard({ p, onAnswer }: { p: PendingPermission; onAnswer: (a: Answer) => void }) {
  const plan = p.toolName === 'exit_plan_mode'
  // Same three answers, in the same words, as the terminal prompt.
  const options: Array<{ answer: Answer; label: ReactNode }> = plan
    ? [
        { answer: 'yes', label: 'Yes, start working' },
        { answer: 'always', label: "Yes, and don't ask about file edits from here" },
        { answer: 'no', label: 'No, keep planning' },
      ]
    : [
        { answer: 'yes', label: 'Yes' },
        { answer: 'always', label: <RememberLabel rules={p.rules} /> },
        { answer: 'no', label: 'No' },
      ]

  // 1 / 2 / 3 answer from the keyboard, as in the terminal — but never from a
  // text field, even an empty one: "1. rename the…" typed into the composer
  // must not approve the first option. The card takes focus when it appears so
  // the keys work, unless you were in the middle of writing something.
  const card = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState(0)
  useEffect(() => {
    const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null
    const typing = (el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT') && el.value
    if (!typing) card.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= 3) { e.preventDefault(); onAnswer(options[n - 1].answer); return }
      // Arrows and Enter only while the card has focus, so they never steal the page's.
      if (!card.current?.contains(el)) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onAnswer(options[cursor].answer)
      }
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
      <div role="listbox" aria-label="Answer" className="flex flex-col gap-1">
        {options.map((o, i) => (
          <button
            key={o.answer}
            type="button"
            role="option"
            aria-selected={i === cursor}
            onMouseEnter={() => setCursor(i)}
            onClick={() => onAnswer(o.answer)}
            className={cn(
              'flex items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
              i === cursor ? (plan ? 'bg-plan/10 text-foreground' : 'bg-primary/10 text-foreground') : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className={cn('w-3 shrink-0 font-mono', i === cursor ? (plan ? 'text-plan' : 'text-primary') : 'opacity-0')}>❯</span>
            <span className="shrink-0 font-mono text-xs leading-5 opacity-60">{i + 1}.</span>
            <span className="min-w-0 leading-5">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
