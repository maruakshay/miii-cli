/**
 * Syntax highlighting for code blocks and diffs. Only the core plus the
 * languages an agent's output is usually in, so the bundle stays small;
 * anything else renders as plain text.
 *
 * The result goes in via innerHTML. That is safe where raw model HTML is not:
 * highlight.js escapes every character of the source and only adds its own
 * `<span class="hljs-…">` wrappers.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile,
  markdown, php, python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml,
}
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang)

/** Past this, highlighting costs more than it is worth on every streamed token. */
const MAX_CHARS = 20_000

/** Highlighted HTML for `code`, or null when the language is unknown (render it as text). */
export function highlight(code: string, lang: string | undefined): string | null {
  if (!lang || code.length > MAX_CHARS || !hljs.getLanguage(lang)) return null
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

/** The language for a file path, by extension or a well-known name. */
export function languageForPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile'
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile'
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  return ext && hljs.getLanguage(ext) ? ext : undefined
}
