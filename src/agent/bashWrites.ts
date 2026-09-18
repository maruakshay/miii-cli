/**
 * Shell commands that clobber a file go through run_bash, which means they
 * bypass edit_file/write_file and with them the read-before-write guard. This
 * finds the paths a command would truncate or rewrite in place, so the guard
 * can cover run_bash too.
 *
 * Deliberately conservative. It reports a target only where it can see one
 * plainly and stays quiet on anything it can't parse: a missed write leaves the
 * hole this narrows, but a false one blocks a legitimate command, and that is
 * the worse failure. Appends (`>>`, `tee -a`) are left out on purpose — they
 * can't revert work the model never saw, which is what the guard exists to stop.
 */

interface Piece {
  kind: 'word' | 'op'
  text: string
}

/** Operators that end one command and begin another. */
const SEPARATORS = new Set([';', '|', '||', '&&', '&', '\n'])

/**
 * Remove heredoc bodies before lexing. The body is data, not shell, and code
 * inside one routinely contains `>` — left in place it reads as a redirect and
 * invents targets that were never written.
 */
export function stripHeredocs(cmd: string): string {
  const lines = cmd.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    out.push(line)
    i++
    const delims = [...line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((m) => m[2])
    for (const delim of delims) {
      while (i < lines.length && lines[i].trim() !== delim) i++
      if (i < lines.length) i++ // drop the delimiter line itself
    }
  }
  return out.join('\n')
}

/**
 * Split a command into words and operators, honouring quotes so a `>` inside a
 * string is text rather than a redirect. Quoting is resolved as the shell would
 * see it, so the word carries the path the command actually writes to.
 */
function lex(cmd: string): Piece[] {
  const out: Piece[] = []
  let buf = ''
  let had = false // buf is a real (possibly empty) word, e.g. the '' in sed -i ''
  const flush = () => {
    if (buf !== '' || had) out.push({ kind: 'word', text: buf })
    buf = ''
    had = false
  }
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]
    if (c === '\\') {
      buf += cmd[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const close = cmd.indexOf(c, i + 1)
      had = true
      if (close === -1) {
        buf += cmd.slice(i + 1)
        break
      }
      buf += cmd.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (c === ' ' || c === '\t') {
      flush()
      i++
      continue
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '>' || c === '<') {
      // A bare fd prefix ('2' in `2>file`) belongs to the operator, not a word.
      if (c === '>' && /^\d+$/.test(buf)) buf = ''
      flush()
      let op = c
      if (c === '>' && cmd[i + 1] === '>') { op = '>>'; i++ }
      else if (c === '|' && cmd[i + 1] === '|') { op = '||'; i++ }
      else if (c === '&' && cmd[i + 1] === '&') { op = '&&'; i++ }
      else if (c === '&' && cmd[i + 1] === '>') { op = '>'; i++ } // `&>file`
      else if (c === '<' && cmd[i + 1] === '<') { op = '<<'; i++ }
      out.push({ kind: 'op', text: op })
      i++
      continue
    }
    buf += c
    i++
  }
  flush()
  return out
}

/** Trailing operands of a command, skipping flags and empty words. */
function operands(words: Piece[]): string[] {
  return words.slice(1).map((w) => w.text).filter((t) => t !== '' && !t.startsWith('-'))
}

/**
 * The paths this command would truncate or rewrite in place. Returned as
 * written, for the caller to resolve and filter — a target that doesn't exist
 * yet is a create, which the guard allows just as it does for write_file.
 */
export function bashWriteTargets(command: string): string[] {
  const pieces = lex(stripHeredocs(command))
  const segments: Piece[][] = []
  let current: Piece[] = []
  for (const p of pieces) {
    if (p.kind === 'op' && SEPARATORS.has(p.text)) {
      segments.push(current)
      current = []
    } else {
      current.push(p)
    }
  }
  segments.push(current)

  const targets: string[] = []
  for (const seg of segments) {
    for (let i = 0; i < seg.length; i++) {
      // `>` truncates; `>>` appends and is deliberately not guarded.
      if (seg[i].kind !== 'op' || seg[i].text !== '>') continue
      const t = seg[i + 1]
      // `>&1` duplicates a descriptor rather than naming a file.
      if (t && t.kind === 'word' && t.text && !t.text.startsWith('&')) targets.push(t.text)
    }

    const words = seg.filter((p) => p.kind === 'word')
    if (words.length === 0) continue
    const name = words[0].text.split('/').pop() ?? ''
    const flags = words.slice(1).map((w) => w.text)

    if (name === 'sed' && flags.some((f) => f === '-i' || f.startsWith('--in-place'))) {
      // The script ('s/a/b/') lands here too; it won't resolve to a real file,
      // so the caller's existence check drops it.
      targets.push(...operands(words))
    } else if (name === 'perl' && flags.some((f) => /^-\w*i/.test(f))) {
      targets.push(...operands(words))
    } else if (name === 'tee' && !flags.some((f) => f === '-a' || f === '--append')) {
      targets.push(...operands(words))
    } else if (name === 'truncate') {
      targets.push(...operands(words))
    }
  }
  return targets
}
