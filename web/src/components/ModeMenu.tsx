import { ChevronDown, ClipboardList, FilePen, ShieldCheck, ShieldOff } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import type { ModeInfo, PermissionMode } from '@/lib/types'
import { cn } from '@/lib/utils'

const ICON = { default: ShieldCheck, plan: ClipboardList, acceptEdits: FilePen, bypass: ShieldOff } as const
const TONE: Record<PermissionMode, string> = {
  default: 'text-muted-foreground',
  plan: 'text-sky-600 dark:text-sky-400',
  acceptEdits: 'text-violet-600 dark:text-violet-400',
  bypass: 'text-destructive',
}

export function ModeMenu({ mode, modes, onChange }: { mode: PermissionMode; modes: ModeInfo[]; onChange: (m: PermissionMode) => void }) {
  const Icon = ICON[mode]
  const current = modes.find((m) => m.mode === mode)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn('capitalize', TONE[mode])} title="Permission mode (shift+tab)">
          <Icon /> <span className="hidden sm:inline">{current?.label ?? mode}</span> <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80">
        {modes.map((m) => {
          const I = ICON[m.mode]
          return (
            <DropdownMenuItem key={m.mode} onSelect={() => onChange(m.mode)} className={cn('items-start', m.mode === mode && 'bg-accent')}>
              <I className={cn('mt-0.5', TONE[m.mode])} />
              <div>
                <div className="capitalize">{m.label}</div>
                <div className="text-xs text-muted-foreground">{m.hint}</div>
              </div>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
