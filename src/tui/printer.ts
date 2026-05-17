// ANSI-formatted stdout output — goes into terminal scrollback

import { writeFileSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

let _inkWrite: ((data: string) => void) | null = null

export function setInkInstance(inkWrite: (data: string) => void) {
  _inkWrite = inkWrite
}

function write(s: string): void {
  if (_inkWrite) {
    _inkWrite(s)
  } else {
    process.stdout.write(s)
  }
}

const R = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

function bold(s: string) { return `${BOLD}${s}${R}` }
function dim(s: string) { return `${DIM}${s}${R}` }
function col(code: number, s: string) { return `\x1b[${code}m${s}${R}` }

const blue   = (s: string) => col(94, s)
const green  = (s: string) => col(92, s)
const cyan   = (s: string) => col(96, s)
const gray   = (s: string) => col(90, s)
const yellow = (s: string) => col(93, s)
const purple = (s: string) => col(95, s)
const red    = (s: string) => col(91, s)

const BG_RED   = '\x1b[48;2;65;18;18m'
const BG_GREEN = '\x1b[48;2;14;46;14m'

function syntaxHighlight(code: string): string {
  const FG = '\x1b[39m'
  const kw  = (s: string) => `\x1b[94m${s}${FG}`
  const str = (s: string) => `\x1b[33m${s}${FG}`
  const num = (s: string) => `\x1b[35m${s}${FG}`
  const typ = (s: string) => `\x1b[96m${s}${FG}`
  const cmt = (s: string) => `\x1b[90m${s}${FG}`

  const KEYWORDS = new Set([
    'const','let','var','function','return','if','else','for','while','do','class',
    'import','export','default','from','async','await','new','this','typeof','instanceof',
    'in','of','true','false','null','undefined','void','type','interface','extends',
    'implements','enum','readonly','public','private','protected','static','abstract',
    'override','declare','as','is','throw','try','catch','finally','switch','case',
    'break','continue','delete','yield',
  ])

  // strings first so // inside strings isn't treated as comment
  const TOKEN = /((?:`(?:\\[\s\S]|[^`\\])*`)|(?:"(?:\\[\s\S]|[^"\\])*")|(?:'(?:\\[\s\S]|[^'\\])*'))|(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)(?=\s*\()|([A-Za-z_$][A-Za-z0-9_$]*)/g

  return code.replace(TOKEN, (match, s, lc, bc, n, funcName, word) => {
    if (s)        return str(match)
    if (lc || bc) return cmt(match)
    if (n)        return num(match)
    if (funcName) return KEYWORDS.has(funcName) ? kw(match) : typ(match)
    if (word)     return KEYWORDS.has(word) ? kw(word) : /^[A-Z]/.test(word) ? typ(word) : word
    return match
  })
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6} /gm, '')
}

function formatContent(text: string): string {
  const lines = text.split('\n')
  let inCode = false
  let inToolCall = false
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('<tool_call>')) { inToolCall = true; continue }
    if (line.startsWith('</tool_call>')) { inToolCall = false; continue }
    if (inToolCall) continue
    if (line.startsWith('```')) {
      inCode = !inCode
      out.push('  ' + dim(gray(line)))
    } else if (inCode) {
      out.push('  ' + yellow(line || ' '))
    } else {
      out.push('  ' + stripMarkdown(line || ''))
    }
  }
  return out.join('\n')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function toolArgSummary(args: Record<string, unknown>): string {
  if (args.message) return `"${truncate(String(args.message), 60)}"`
  if (args.path) return String(args.path)
  if (args.command) return truncate(String(args.command), 60)
  if (args.query) return `"${truncate(String(args.query), 60)}"`
  if (args.from) return `${args.from} → ${args.to}`
  const first = Object.values(args)[0]
  return first ? truncate(String(first), 60) : ''
}

export function welcome(cwd: string, version?: string, updateAvailable?: string, linked?: boolean): void {
  const cols = Math.min(process.stdout.columns ?? 80, 100)

  const innerW = cols - 2
  const leftW = Math.floor(innerW * 0.44)
  const rightW = innerW - leftW - 1

  function vis(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, '') }

  function cell(s: string, w: number): string {
    const v = vis(s)
    if (v.length < w) return s + ' '.repeat(w - v.length)
    if (v.length === w) return s
    return v.slice(0, w - 1) + '…'
  }

  function row(l: string, r: string): string {
    return gray('│') + cell(l, leftW) + gray('│') + cell(r, rightW) + gray('│')
  }

  const versionStr = version ? ` v${version}` : ''
  const titleStr = `─ MIII - CLI${versionStr} `
  const dashCount = Math.max(0, cols - 2 - titleStr.length)
  const top    = gray('╭') + gray('─') + bold(cyan(` MIII - CLI${versionStr} `)) + gray('─'.repeat(dashCount) + '╮')
  const bottom = gray('╰' + '─'.repeat(innerW) + '╯')

  const shortCwd = cwd.replace(process.env.HOME ?? '', '~')

  const miniArt = [
    `  ${purple('   ●     ●   ')}`,
    `  ${purple('  ╱ ╲   ╱ ╲  ')}`,
    `  ${purple(' ╱   ╲ ╱   ╲ ')}`,
    `  ${purple('●     ●     ●')}`,
  ]

  const leftLines = [
    '',
    ...miniArt,
    '',
    `  ${gray(shortCwd)}`,
    '',
  ]

  const rightLines = [
    '',
    `  ${bold(yellow('Tips for getting started'))}`,
    `  Type ${cyan('@filename')} to inject file into context`,
    `  Use ${cyan('/skill')} to run a skill or command`,
    `  Use ${cyan('/design teach')} to generate a design system`,
    `  Use ${cyan('/config')} to switch provider, model, or API key`,
    '',
  ]

  const maxLen = Math.max(leftLines.length, rightLines.length)
  const pl = [...leftLines,  ...Array(Math.max(0, maxLen - leftLines.length)).fill('')]
  const pr = [...rightLines, ...Array(Math.max(0, maxLen - rightLines.length)).fill('')]
  const contentRows = pl.map((l, i) => row(l, pr[i]))

  const upgradeCmd = linked ? 'cd <miii-dir> && npm run build' : 'npm install -g miii-cli'
  const updateRow = updateAvailable ? (() => {
    const updateText = bold(yellow(` ⬆  update available: v${updateAvailable}  —  run: ${upgradeCmd}`))
    const pad = Math.max(0, innerW - vis(updateText).length)
    const separator = gray('│') + updateText + ' '.repeat(pad) + gray('│')
    return [gray('├' + '─'.repeat(innerW) + '┤'), separator, gray('├' + '─'.repeat(innerW) + '┤')]
  })() : []

  const lines = [
    top,
    ...contentRows,
    ...updateRow,
    bottom,
  ]

  process.stdout.write(lines.join('\n') + '\n')
}

export function userMsg(text: string): void {
  const atHighlighted = text.replace(/(@[\w./\-]+)/g, (m) => cyan(m))
  write(`\n${gray('>>')} ${atHighlighted}\n`)
}

export function assistantMsg(text: string): void {
  const content = formatContent(text)
  if (!content.trim()) return
  const lines = content.split('\n')
  const idx = lines.findIndex(l => l.trim())
  if (idx === -1) return
  const head = lines[idx].replace(/^ {2}/, '')
  const tail = lines.slice(idx + 1).join('\n')
  write(`\n${blue('●')} ${head}${tail ? '\n' + tail : ''}\n`)
}

export function streamStart(): void { write(`\n${blue('●')} `) }
export function streamChunk(s: string): void { write(s) }
export function streamEnd(): void { write('\n') }

export const EDIT_TOOLS   = new Set(['edit_file', 'update_file', 'create_file'])
export const DELETE_TOOLS = new Set(['delete_file'])

const PERM_DESC: Record<string, string> = {
  delete_file:  'delete this file',
  update_file:  'edit this file',
  create_file:  'create this file',
  edit_file:    'create this file',
  move_file:    'move this file',
  run_command:  'run in shell',
  git_commit:   'commit to git',
}
export function permissionDesc(toolName: string): string {
  return PERM_DESC[toolName] ?? 'allow this action'
}

export function toolLabel(name: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string>
  const short = (s: string, n = 55) => s.length > n ? s.slice(0, n) + '…' : s
  switch (name) {
    case 'read_file':       return `Read(${a.path ?? ''})`
    case 'list_files':      return `List(${a.path || '.'})`
    case 'create_file':     return `Create(${a.path ?? ''})`
    case 'edit_file':       return `Create(${a.path ?? ''})`
    case 'update_file':     return `Update(${a.path ?? ''})`
    case 'delete_file':     return `Delete(${a.path ?? ''})`
    case 'move_file':       return `Move(${a.from} → ${a.to})`
    case 'create_folder':   return `Mkdir(${a.path ?? ''})`
    case 'run_command':     return `Run(${short(a.command ?? '')})`
    case 'git_status':      return 'Git(status)'
    case 'git_diff':        return 'Git(diff)'
    case 'git_log':         return 'Git(log)'
    case 'git_commit':      return `Git(commit: ${short(a.message ?? '')})`
    case 'run_tests':       return a.path ? `Test(${a.path})` : 'Test(suite)'
    case 'web_search':      return `Search(${short(a.query ?? '')})`
    case 'web_extract':     return `Extract(${Array.isArray(a.urls) ? String(a.urls[0] ?? '') : String(a.urls ?? 'url')})`
    case 'deep_think':      return `Think(${short(a.query ?? '')})`
    case 'search_codebase': return `Index(${short(a.query ?? '')})`
    default: {
      const s = toolArgSummary(args)
      return s ? `${name} ${s}` : name
    }
  }
}

export function planSummary(tools: Array<{ name: string; args: Record<string, unknown> }>): void {
  if (!tools.length) return
  const lines: string[] = [gray(`─ plan (${tools.length} action${tools.length === 1 ? '' : 's'})`)]
  for (const t of tools) {
    const dot = DELETE_TOOLS.has(t.name) ? red('◦') : EDIT_TOOLS.has(t.name) ? green('◦') : blue('◦')
    lines.push(`  ${dot} ${gray(toolLabel(t.name, t.args))}`)
  }
  write(lines.join('\n') + '\n')
}

const PREVIEW_LINES = 6

function fallbackDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const out: string[] = [`  ${gray('└')} ${green(`+${newLines.length}`)}${gray(' / ')}${red(`-${oldLines.length}`)}\n`]
  oldLines.forEach(l => out.push(`  ${BG_RED}-${syntaxHighlight(l)}\x1b[0m\n`))
  newLines.forEach(l => out.push(`  ${BG_GREEN}+${syntaxHighlight(l)}\x1b[0m\n`))
  return out.join('')
}

function printUpdateDiff(_filePath: string, oldText: string, newText: string): string {
  const key = `${process.pid}-${Date.now()}`
  const tmpA = join(tmpdir(), `miii-old-${key}`)
  const tmpB = join(tmpdir(), `miii-new-${key}`)
  try {
    writeFileSync(tmpA, oldText)
    writeFileSync(tmpB, newText)
    let diffOut = ''
    try {
      execFileSync('diff', ['-u', tmpA, tmpB], { encoding: 'utf-8' })
    } catch (e: any) {
      if (e.code === 'ENOENT') return fallbackDiff(oldText, newText)
      diffOut = e.stdout || e.stderr || ''
    }
    if (!diffOut) return `  ${gray('└')} (no changes)\n`

    const lines = diffOut.split('\n')
    let added = 0, removed = 0
    for (const l of lines) {
      if (l.startsWith('+') && !l.startsWith('+++')) added++
      if (l.startsWith('-') && !l.startsWith('---')) removed++
    }
    const parts: string[] = []
    if (added > 0) parts.push(green(`+${added}`))
    if (removed > 0) parts.push(red(`-${removed}`))
    const out: string[] = [`  ${gray('└')} ${parts.join(gray(' / '))}\n`]

    for (const line of lines) {
      if (line.startsWith('---') || line.startsWith('+++')) continue
      if (line.startsWith('@@')) out.push(`  ${cyan(line)}\n`)
      else if (line.startsWith('+')) out.push(`  ${BG_GREEN}+${syntaxHighlight(line.slice(1))}\x1b[0m\n`)
      else if (line.startsWith('-')) out.push(`  ${BG_RED}-${syntaxHighlight(line.slice(1))}\x1b[0m\n`)
      else if (line) out.push(`  ${gray(line)}\n`)
    }
    return out.join('')
  } finally {
    try { unlinkSync(tmpA) } catch {}
    try { unlinkSync(tmpB) } catch {}
  }
}

function printEditPreview(content: string): string {
  const lines = content.split('\n')
  const visible = lines.slice(0, PREVIEW_LINES)
  const hidden = lines.length - visible.length
  const out: string[] = [`  ${gray('└')} ${green(`+${lines.length} line${lines.length !== 1 ? 's' : ''}`)}\n`]
  visible.forEach(line => out.push(`  ${BG_GREEN}+ ${syntaxHighlight(line)}\x1b[0m\n`))
  if (hidden > 0) out.push(`  ${gray(`  … ${hidden} more line${hidden !== 1 ? 's' : ''}`)}\n`)
  return out.join('')
}

export function toolCallStart(name: string, args: Record<string, unknown>): void {
  const dot = DELETE_TOOLS.has(name) ? red('●') : EDIT_TOOLS.has(name) ? green('●') : blue('●')
  let out = `\n${dot} ${bold(toolLabel(name, args))}\n`

  const a = args as Record<string, string>
  if (name === 'update_file' && a.old && a.new && a.path) {
    out += printUpdateDiff(a.path, a.old, a.new)
  } else if ((name === 'edit_file' || name === 'create_file') && a.content && a.path) {
    out += printEditPreview(a.content)
  }
  write(out)
}

export function toolResultSummary(name: string, args: Record<string, unknown>, result: string): void {
  const a = args as Record<string, string>
  const lines = result.trim().split('\n').filter(Boolean)
  let summary = ''

  switch (name) {
    case 'edit_file': {
      const n = (a.content ?? '').split('\n').length
      summary = `Wrote ${n} line${n === 1 ? '' : 's'}`
      break
    }
    case 'create_file': {
      const n = (a.content ?? '').split('\n').length
      summary = `Created file · ${n} line${n === 1 ? '' : 's'}`
      break
    }
    case 'update_file':
      summary = lines[0] ?? 'Applied patch'
      break
    case 'delete_file':
      summary = 'Deleted'
      break
    case 'move_file':
      summary = `Moved → ${a.to ?? ''}`
      break
    case 'read_file': {
      const n = lines.length
      summary = `Read ${n} line${n === 1 ? '' : 's'}`
      break
    }
    case 'list_files':
      summary = `Found ${lines.length} file${lines.length === 1 ? '' : 's'}`
      break
    case 'run_command':
    case 'run_tests':
    case 'git_commit':
    case 'git_status':
    case 'git_diff':
    case 'git_log': {
      const first = lines[0]?.slice(0, 80) ?? ''
      const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : ''
      summary = first + more
      break
    }
    case 'web_search':
      summary = `Found ${lines.length} result${lines.length === 1 ? '' : 's'}`
      break
    case 'web_extract':
      summary = `Extracted ${lines.length} line${lines.length === 1 ? '' : 's'}`
      break
    case 'search_codebase':
      summary = lines[0]?.slice(0, 80) ?? 'Done'
      break
    default:
      summary = lines[0]?.slice(0, 80) ?? 'Done'
  }

  if (summary) write(gray(`  ${summary}`) + '\n')
}

export function toolMsg(_name: string, result: string): void {
  const preview = result.length > 600 ? result.slice(0, 600) + '…' : result
  const body = preview.trim()
    ? preview.split('\n').map(l => gray('    ' + l)).join('\n')
    : ''
  if (body) write(body + '\n')
}

export function systemMsg(text: string): void {
  write(gray(`─ ${text}`) + '\n')
}

export function errorMsg(text: string): void {
  write(gray(`error: ${text}`) + '\n')
}

export function divider(): void {
  const cols = process.stdout.columns ?? 80
  write(`${gray('─'.repeat(cols))}\n`)
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`
}
