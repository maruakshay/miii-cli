import { memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

export function CopyButton({ text, className, label }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground', className)}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200) })
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  )
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code({ className, children }) {
    const lang = /language-([\w-]+)/.exec(className ?? '')?.[1]
    const text = String(children ?? '')
    // Inline code has no language and no newline; fenced code has at least one.
    if (!lang && !text.includes('\n')) return <code>{children}</code>
    return (
      <div className="not-prose my-3 overflow-hidden rounded-lg border bg-code">
        <div className="flex items-center justify-between border-b px-3 py-1 text-xs text-muted-foreground">
          <span className="font-mono">{lang ?? 'text'}</span>
          <CopyButton text={text.replace(/\n$/, '')} label="Copy" />
        </div>
        <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed"><code>{text.replace(/\n$/, '')}</code></pre>
      </div>
    )
  },
  a: ({ href, children }) => {
    // Model output is untrusted: only ordinary links become clickable.
    const safe = href && /^(https?:|mailto:|#)/i.test(href)
    return safe ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>
  },
  img: ({ alt }) => <span className="text-muted-foreground">[image{alt ? `: ${alt}` : ''}]</span>,
}

/** react-markdown renders no raw HTML, which is what keeps model output from scripting the page. */
export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={cn('prose-miii', streaming && 'is-streaming', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  )
})
