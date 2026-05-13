// ANSI-formatted stdout output — goes into terminal scrollback

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

function indent(text: string, pad = '  '): string {
  return text.split('\n').map(l => pad + l).join('\n')
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

export function welcome(provider: string, model: string, cwd: string, version?: string, updateAvailable?: string, linked?: boolean): void {
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
  const username = process.env.USER ?? 'there'

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
    `  ${gray(model + ' · ' + provider)}`,
    `  ${gray(shortCwd)}`,
    '',
  ]

  const rightLines = [
    '',
    `  ${bold(yellow('Tips for getting started'))}`,
    `  Type ${cyan('@filename')} to inject file into context`,
    `  Use ${cyan('/skill')} to run a skill or command`,
    `  Use ${cyan('/models')} to switch or pull models`,
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

const EDIT_TOOLS   = new Set(['edit_file', 'patch_file', 'create_file', 'write_file'])
const DELETE_TOOLS = new Set(['delete_file', 'remove_file'])

function toolLabel(name: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string>
  const short = (s: string, n = 55) => s.length > n ? s.slice(0, n) + '…' : s
  switch (name) {
    case 'read_file':       return `Reading ${a.path ?? ''}`
    case 'list_files':      return `Listing ${a.path || '.'}`
    case 'create_file':     return `Creating ${a.path ?? ''}`
    case 'edit_file':       return `Writing ${a.path ?? ''}`
    case 'patch_file':      return `Editing ${a.path ?? ''}`
    case 'delete_file':     return `Deleting ${a.path ?? ''}`
    case 'move_file':       return `Moving ${a.from} → ${a.to}`
    case 'create_folder':   return `Creating folder ${a.path ?? ''}`
    case 'run_command':     return `Running ${short(a.command ?? '')}`
    case 'git_status':      return 'Checking git status'
    case 'git_diff':        return 'Reading diff'
    case 'git_log':         return 'Reading commits'
    case 'git_commit':      return `Committing: ${short(a.message ?? '')}`
    case 'run_tests':       return a.path ? `Running tests › ${a.path}` : 'Running tests'
    case 'web_search':      return `Searching: ${short(a.query ?? '')}`
    case 'web_extract':     return `Extracting page`
    case 'deep_think':      return `Researching: ${short(a.query ?? '')}`
    case 'search_codebase': return `Searching codebase: ${short(a.query ?? '')}`
    default: {
      const s = toolArgSummary(args)
      return s ? `${name} ${s}` : name
    }
  }
}

export function toolCallStart(name: string, args: Record<string, unknown>): void {
  const dot = DELETE_TOOLS.has(name) ? red('●') : EDIT_TOOLS.has(name) ? green('●') : blue('●')
  write(`  ${dot} ${toolLabel(name, args)}\n`)
}

export function toolMsg(name: string, result: string): void {
  const preview = result.length > 250 ? result.slice(0, 250) + '…' : result
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
