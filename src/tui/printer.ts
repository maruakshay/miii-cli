// ANSI-formatted stdout output — goes into terminal scrollback

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
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('<tool_call>') || line.startsWith('</tool_call>')) continue
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

export function welcome(provider: string, model: string, cwd: string): void {
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

  function blank(): string {
    return gray('│') + ' '.repeat(leftW) + gray('│') + ' '.repeat(rightW) + gray('│')
  }

  function rcmd(key: string, desc: string, keyW = 10): string {
    return '  ' + cyan(key) + ' '.repeat(Math.max(1, keyW - key.length)) + gray(desc)
  }

  const titleStr = '─ MIII - CLI '
  const dashCount = Math.max(0, cols - 2 - titleStr.length)
  const top    = gray('╭') + gray('─') + bold(cyan(' MIII - CLI ')) + gray('─'.repeat(dashCount) + '╮')
  const bottom = gray('╰' + '─'.repeat(innerW) + '╯')

  const shortCwd = cwd.replace(process.env.HOME ?? '', '~')

  const lines = [
    top,
    blank(),
    row(`  ${bold(cyan('MIII - CLI'))}`,             `  ${bold(yellow('Getting started'))}`),
    row(`  ${gray('Claude Code-level terminal')}`,    rcmd('@filename', 'inject file into context')),
    row(`  ${gray('workflows, local models.')}`,      rcmd('/skill',    'run a skill or command')),
    row('',                                            rcmd('/models',   'switch or pull models')),
    row('',                                            rcmd('/list',     'list all skills')),
    row('',                                            rcmd('/session',  'manage sessions')),
    blank(),
    row(`  ${gray(provider + '/' + model)}`,          `  ${bold(yellow('Tips'))}`),
    row(`  ${gray(shortCwd)}`,                         rcmd('ctrl+c',   'stop streaming')),
    row('',                                            rcmd('ctrl+c x2','exit')),
    blank(),
    bottom,
  ]

  process.stdout.write(lines.join('\n') + '\n')
}

export function userMsg(text: string): void {
  const atHighlighted = text.replace(/(@[\w./\-]+)/g, (m) => cyan(m))
  console.log(`\n${bold(blue('You'))}\n${indent(atHighlighted)}`)
}

export function assistantMsg(text: string): void {
  console.log(`\n${bold(green('miii'))}\n${formatContent(text)}`)
}

export function toolMsg(name: string, result: string): void {
  const preview = result.length > 250 ? result.slice(0, 250) + '…' : result
  const body = preview.trim()
    ? preview.split('\n').map(l => gray('    ' + l)).join('\n')
    : ''
  console.log(`  ${green('✓')} ${cyan(name)}${body ? '\n' + body : ''}`)
}

export function systemMsg(text: string): void {
  console.log(gray(`─ ${text}`))
}

export function errorMsg(text: string): void {
  console.log(gray(`error: ${text}`))
}

export function divider(): void {
  const cols = process.stdout.columns ?? 80
  process.stdout.write(`${gray('─'.repeat(cols))}\n`)
}
