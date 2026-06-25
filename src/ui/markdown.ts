import { Marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import { highlight, supportsLanguage } from 'cli-highlight'
import chalk from 'chalk'

// Muted, low-glare palette — soft pastels over saturated brights so long
// messages stay easy on the eyes in a dark terminal. Tuned for legibility,
// not punch: desaturated blues/greens/mauves, dim grays for chrome.
const theme = {
  heading: chalk.hex('#7fa8d4').bold, // dusty blue
  firstHeading: chalk.hex('#9ab8de').bold, // slightly lighter for h1
  strong: chalk.hex('#d6c9a8').bold, // warm sand
  em: chalk.hex('#b59ec4').italic, // soft mauve
  del: chalk.hex('#6b7280').strikethrough, // dim gray
  codespan: chalk.hex('#c8a98a'), // muted clay
  link: chalk.hex('#83b3a6').underline, // sage teal
  href: chalk.hex('#83b3a6').underline,
  blockquote: chalk.hex('#8a9aa8').italic, // slate
  listitem: chalk.hex('#c4c9cf'), // off-white
  paragraph: chalk.hex('#c4c9cf'), // off-white body text
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

export function renderMarkdown(content: string): string {
  try {
    // parse() returns a string in sync mode (no async extensions registered).
    const out = md.parse(content, { async: false }) as string
    // marked-terminal appends a trailing newline; trim so Ink spacing stays tight.
    return out.replace(/\n+$/, '')
  } catch {
    return content
  }
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
