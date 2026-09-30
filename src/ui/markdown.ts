import { Marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import { highlight, supportsLanguage } from 'cli-highlight'
import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import { contentWidth } from './layout.js'

// Near-monochrome, like Claude Code: prose is one off-white, and structure
// comes from weight, italics and underline rather than hue. Inline code is the
// single accent, so paths and identifiers still stand out without a rainbow.
const body = chalk.hex('#c4c9cf') // off-white
const bright = chalk.hex('#e5e7eb') // a step brighter, for headings
const theme = {
  heading: bright.bold,
  firstHeading: bright.bold,
  strong: body.bold,
  em: body.italic,
  del: chalk.hex('#6b7280').strikethrough, // dim gray
  codespan: chalk.hex('#9ab8de'), // dusty blue — the one accent
  link: body.underline,
  href: body.underline,
  blockquote: chalk.hex('#8a9aa8').italic, // slate
  listitem: body,
  paragraph: body,
  hr: chalk.hex('#4b5563'), // faint rule
}

// Render markdown to ANSI for the terminal. Used for committed assistant
// messages only — streaming text stays raw until the turn finishes, since
// partial markdown (unclosed fences / emphasis) renders badly mid-stream.

// Fenced code blocks are syntax-highlighted via cli-highlight (already a dep,
// same engine ChatView uses for diffs).
function highlightCode(code: string, lang?: string): string {
  // Skip unknown languages: cli-highlight logs a noisy "Could not find the
  // language" warning to the console *before* throwing, and the catch can't
  // suppress that. Models fence plans/pseudo-langs (```plan), so guard first.
  if (!lang || !supportsLanguage(lang)) return code
  try {
    return highlight(code, { language: lang, ignoreIllegals: true })
  } catch {
    return code
  }
}

// A fresh Marked instance keeps the terminal extension scoped to this module.
const md = new Marked()
md.use(
  markedTerminal({
    // Drop the literal `#` prefix on headings; render them styled instead.
    showSectionPrefix: false,
    // marked-terminal calls this for ``` blocks; fall back to plain on unknown lang.
    code: (code: string, lang?: string) => highlightCode(code, lang),
    ...theme,
  }) as Parameters<typeof md.use>[0],
)

// marked-terminal's own list renderer numbers items by regex over the rendered
// body, so a nested list steals numbers from its parent ("1. … 2. nested"), a
// loose list gets a blank row between every item, and each level indents a
// full tab. Lists are drawn here instead: tight, `•`/`1.` markers, two columns
// per level, and wrapped to the content column with a hanging indent — left to
// Ink, a wrapped item's second row would fall back to column 0.
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
const unescape = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)

interface ListItemToken { task?: boolean; checked?: boolean; tokens: Token[] }
interface ListToken { type: 'list'; ordered: boolean; start: number | ''; items: ListItemToken[] }
type Token = { type: string; tokens?: Token[]; text?: string; raw?: string }
type Parser = { parse(tokens: Token[]): string; parseInline(tokens: Token[]): string }

function renderList(parser: Parser, list: ListToken, width: number): string {
  const start = typeof list.start === 'number' ? list.start : 1
  const markers = list.items.map((item, i) => {
    const m = list.ordered ? `${start + i}.` : '•'
    return item.task ? `${m} ${item.checked ? '☑' : '☐'}` : m
  })
  const markerWidth = Math.max(...markers.map((m) => m.length)) + 1
  const inner = Math.max(10, width - markerWidth)
  const pad = ' '.repeat(markerWidth)
  return list.items
    .map((item, i) => {
      const parts: string[] = []
      for (const t of item.tokens) {
        if (t.type === 'list') parts.push(renderList(parser, t as unknown as ListToken, inner))
        else if (t.type === 'text' || t.type === 'paragraph') {
          const text = theme.listitem(unescape(t.tokens ? parser.parseInline(t.tokens) : (t.text ?? '')))
          parts.push(wrapAnsi(text, inner, { hard: true }))
        } else if (t.type !== 'space' && t.type !== 'checkbox') parts.push(parser.parse([t]).replace(/\n+$/, ''))
      }
      const lines = parts.join('\n').split('\n')
      return lines.map((l, j) => (j === 0 ? markers[i].padEnd(markerWidth) : pad) + l).join('\n')
    })
    .join('\n')
}

md.use({
  extensions: [
    {
      name: 'list',
      renderer(this: { parser: Parser }, token) {
        return renderList(this.parser, token as unknown as ListToken, contentWidth()) + '\n\n'
      },
    },
  ],
})

export function renderMarkdown(content: string): string {
  try {
    // parse() returns a string in sync mode (no async extensions registered).
    const out = md.parse(content, { async: false }) as string
    // marked-terminal appends a trailing newline; trim so Ink spacing stays tight.
    return fitToWidth(out.replace(/\n+$/, ''), contentWidth())
  } catch {
    return content
  }
}

// Wrap here rather than leaving it to Ink: Ink wraps without trimming, so a row
// broken at a space starts with that space, and an indented line (a blockquote,
// a code block) loses its indent on every row after the first. Each over-long
// line is wrapped inside its own indent instead.
function fitToWidth(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => {
      if (stringWidth(line) <= width) return line
      const indent = /^ */.exec(line)![0]
      const body = wrapAnsi(line.slice(indent.length), Math.max(10, width - indent.length), { hard: true })
      return body.split('\n').map((row) => indent + row).join('\n')
    })
    .join('\n')
}

// Just-in-time render for the live streaming buffer. The text is mid-stream and
// may end inside an unterminated construct. Unclosed inline emphasis (`**`, `*`,
// `_`) marked treats as literal text and self-corrects once the closer arrives,
// so no handling needed. An unclosed ``` fence is the one ugly case — it would
// render the entire tail as one code block — so temporarily close it before parse.
export function renderMarkdownStreaming(content: string): string {
  const fences = (content.match(/^```/gm) ?? []).length
  const balanced = fences % 2 === 1 ? content + '\n```' : content
  return renderMarkdown(balanced)
}
