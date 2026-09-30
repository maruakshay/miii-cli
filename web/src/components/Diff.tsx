import type { FileDiff } from '@/lib/types'
import { cn } from '@/lib/utils'

export function DiffView({ diff }: { diff: FileDiff }) {
  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border bg-code font-mono text-[12.5px] leading-normal">
      <div className="sticky top-0 flex gap-3 border-b bg-code px-3 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">{diff.path}</span>
        <span className="ml-auto text-diff-add-fg">+{diff.added}</span>
        <span className="text-diff-del-fg">−{diff.removed}</span>
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {diff.hunks.map((h, hi) => [
            hi > 0 && (
              <tr key={`gap-${hi}`}>
                <td colSpan={3} className="bg-muted/60 text-center text-muted-foreground">⋯</td>
              </tr>
            ),
            ...h.lines.map((l, li) => (
              <tr
                key={`${hi}-${li}`}
                className={cn(l.sign === '+' && 'bg-diff-add text-diff-add-fg', l.sign === '-' && 'bg-diff-del text-diff-del-fg')}
              >
                <td className="w-px select-none px-2 text-right align-top text-muted-foreground/70">{l.sign === '+' ? '' : l.oldNo}</td>
                <td className="w-px select-none px-2 text-right align-top text-muted-foreground/70">{l.sign === '-' ? '' : l.newNo}</td>
                <td className="whitespace-pre px-2"><span className="select-none opacity-60">{l.sign === ' ' ? ' ' : l.sign}</span> {l.text}</td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
      {diff.truncated ? <div className="border-t px-3 py-1 text-xs text-muted-foreground">{diff.truncated} more lines not shown</div> : null}
    </div>
  )
}
