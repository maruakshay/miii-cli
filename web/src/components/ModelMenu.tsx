import { useState } from 'react'
import { ChevronDown, Cpu, Loader2 } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { get, post } from '@/lib/api'
import type { Effort, ProviderInfo, WebState } from '@/lib/types'

export function ModelMenu({ state, onError }: { state: WebState; onError: (msg: string) => void }) {
  const [models, setModels] = useState<string[] | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setModels(null)
    setError(null)
    void get<{ models: string[]; error?: string }>('models').then((r) => { setModels(r.models); setError(r.error ?? null) }).catch((e) => setError(String(e.message)))
    void get<{ providers: ProviderInfo[] }>('providers').then((r) => setProviders(r.providers)).catch(() => {})
  }
  const act = (p: Promise<void>) => p.catch((e: Error) => onError(e.message))

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-[38vw] text-muted-foreground sm:max-w-[240px]">
          <Cpu />
          <span className="truncate">{state.model ?? 'Choose a model'}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-80">
        <DropdownMenuLabel>Model · {state.provider}</DropdownMenuLabel>
        {models === null && !error && <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading models…</div>}
        {error && <div className="px-2 py-2 text-sm text-destructive whitespace-pre-wrap">{error}</div>}
        {models && models.length === 0 && !error && <div className="px-2 py-2 text-sm text-muted-foreground">No models on this provider.</div>}
        {models && models.length > 0 && (
          <DropdownMenuRadioGroup value={state.model ?? ''} onValueChange={(model) => act(post('model', { model }))}>
            <div className="max-h-64 overflow-y-auto">
              {models.map((m) => <DropdownMenuRadioItem key={m} value={m} className="font-mono text-xs">{m}</DropdownMenuRadioItem>)}
            </div>
          </DropdownMenuRadioGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Effort</DropdownMenuLabel>
        <div className="flex gap-1 px-1 pb-1">
          {(['low', 'medium', 'high'] as Effort[]).map((e) => (
            <Button key={e} size="sm" variant={state.effort === e ? 'inverted' : 'outline'} className="h-7 flex-1 capitalize"
              onClick={() => act(post('effort', { effort: e }))}>{e}</Button>
          ))}
        </div>
        {providers.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Provider: {state.provider}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                <DropdownMenuRadioGroup value={state.provider} onValueChange={(name) => act(post('provider', { name }).then(load))}>
                  {providers.map((p) => (
                    <DropdownMenuRadioItem key={p.name} value={p.name} onSelect={(e) => e.preventDefault()}>
                      <div className="min-w-0">
                        <div>{p.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{p.baseUrl}</div>
                      </div>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
