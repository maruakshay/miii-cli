import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Paperclip, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ModeMenu } from '@/components/ModeMenu'
import { ModelMenu } from '@/components/ModelMenu'
import { post } from '@/lib/api'
import type { Command, ModeInfo, PermissionMode, WebState } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Attachment { name: string; url: string; base64: string }

function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      resolve({ name: file.name, url, base64: url.slice(url.indexOf(',') + 1) })
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function Composer({
  state, commands, modes, draft, onDraftUsed, onSent, onError,
}: {
  state: WebState
  commands: Command[]
  modes: ModeInfo[]
  draft: string | null
  onDraftUsed: () => void
  onSent: () => void
  onError: (msg: string) => void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [sel, setSel] = useState(0)
  const [drag, setDrag] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { ref.current?.focus() }, [state.sessionId])
  useEffect(() => {
    if (draft === null) return
    setText(draft)
    onDraftUsed()
    ref.current?.focus()
  }, [draft, onDraftUsed])

  // The palette shows while the first word is still being typed.
  const matches = useMemo(() => {
    if (!text.startsWith('/') || /\s/.test(text)) return []
    return commands.filter((c) => c.name.startsWith(text.toLowerCase()))
  }, [text, commands])
  useEffect(() => setSel(0), [matches.length])

  const act = (p: Promise<void>) => p.catch((e: Error) => onError(e.message))
  const setMode = (mode: PermissionMode) => act(post('mode', { mode }))

  const submit = () => {
    const t = text.trim()
    if (!t && !images.length) return
    act(post('send', { text: t, images: images.map((i) => i.base64) }))
    setText('')
    setImages([])
    onSent()
  }

  const addFiles = async (files: FileList | File[]) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    const read = await Promise.all(imgs.map(readImage))
    setImages((prev) => [...prev, ...read])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return }
      if (e.key === 'Tab') { e.preventDefault(); setText(`${matches[sel].name} `); return }
      if (e.key === 'Enter' && !e.shiftKey && text !== matches[sel].name) { e.preventDefault(); setText(`${matches[sel].name} `); return }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      const order = modes.map((m) => m.mode)
      setMode(order[(order.indexOf(state.mode) + 1) % order.length])
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }

  const canSend = !!(text.trim() || images.length)
  return (
    <div className="relative">
      {matches.length > 0 && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg" role="listbox">
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              onMouseEnter={() => setSel(i)}
              onClick={() => { setText(`${c.name} `); ref.current?.focus() }}
              className={cn('flex w-full items-baseline gap-3 rounded-lg px-3 py-1.5 text-left text-sm', i === sel && 'bg-accent')}
            >
              <span className="shrink-0 font-mono text-foreground">{c.name}</span>
              <span className="truncate text-muted-foreground">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); submit() }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files) }}
        className={cn(
          'flex flex-col gap-2 rounded-2xl border bg-card px-4 pt-3 pb-2 shadow-sm transition-colors focus-within:border-foreground/25',
          drag && 'border-dashed border-primary',
        )}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative size-14 overflow-hidden rounded-lg border">
                <img src={img.url} alt={img.name} className="size-full object-cover" />
                <button type="button" aria-label="Remove image" onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                  className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-black/60 text-white">
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files) } }}
          placeholder={state.busy ? 'Add a message — miii reads it at its next step' : 'Describe a task, or type / for commands'}
          className="field-sizing-content max-h-60 min-h-6 resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="-ml-2 flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => fileRef.current?.click()} aria-label="Attach image">
                  <Paperclip />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach an image (or paste one)</TooltipContent>
            </Tooltip>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = '' }} />
            <ModeMenu mode={state.mode} modes={modes} onChange={setMode} />
          </div>
          <div className="flex min-w-0 items-center justify-end gap-1">
            <ModelMenu state={state} onError={onError} />
            {state.busy && !canSend ? (
              <Button type="button" size="icon-sm" variant="inverted" onClick={() => act(post('stop'))} aria-label="Stop">
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button type="submit" size="icon-sm" disabled={!canSend} aria-label="Send">
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
