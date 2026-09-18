import { truncate } from './layout.js'
import type { ToolUseDisplay } from './types.js'

/**
 * The technical name of each tool, for the dim `Bash(npm test)` line that only
 * shows once a block is expanded. The headline itself is a sentence — see
 * describeTool.
 */
export const TOOL_LABEL: Record<string, string> = {
  write_file: 'Write',
  edit_file: 'Update',
  read_file: 'Read',
  run_bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  write_todos: 'Todos',
  exit_plan_mode: 'Plan',
}

/** Strip the leading ./ and any wrapping quotes a model likes to add. */
function cleanPath(p: string): string {
  return p.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '')
}

function quote(s: string): string {
  return `“${truncate(s, 60)}”`
}

/**
 * A shell command is opaque — `npm test -- --run` says nothing to someone
 * skimming. The model is asked for a `description` on every run_bash call, but
 * it forgets, and older transcripts have none, so the common shapes are
 * recognised here instead of falling back to the raw command every time.
 */
function describeCommand(raw: string): string {
  const cmd = raw.replace(/\s+/g, ' ').trim()
  // Only the first segment decides the verb; a chained `&&` tail is detail.
  const head = cmd.split(/&&|\|\||;|\|/)[0].trim()
  const words = head.split(' ')
  const [bin, ...rest] = words
  const sub = rest.find((w) => !w.startsWith('-')) ?? ''

  const tests = /\b(test|vitest|jest|pytest|go test|cargo test)\b/
  if (tests.test(head)) return 'Running the tests'
  if (/^(npm|pnpm|yarn|bun)$/.test(bin)) {
    if (sub === 'install' || sub === 'i' || sub === 'add' || sub === 'ci') return 'Installing dependencies'
    if (sub === 'build') return 'Building the project'
    if (sub === 'run') return `Running the ${rest[rest.indexOf('run') + 1] ?? ''} script`.replace(/ +/g, ' ')
    return `Running ${bin} ${sub}`.trim()
  }
  if (bin === 'git') {
    if (sub === 'status') return 'Checking the working tree'
    if (sub === 'diff') return 'Reviewing the changes'
    if (sub === 'log') return 'Reading the commit history'
    if (sub === 'add') return 'Staging changes'
    if (sub === 'commit') return 'Committing the changes'
    if (sub === 'push') return 'Pushing to the remote'
    if (sub === 'pull' || sub === 'fetch') return 'Fetching from the remote'
    if (sub === 'checkout' || sub === 'switch') return 'Switching branch'
    return `Running git ${sub}`.trim()
  }
  if (bin === 'cat' || bin === 'head' || bin === 'tail' || bin === 'less') {
    return sub ? `Reading ${cleanPath(sub)}` : 'Reading a file'
  }
  if (bin === 'ls' || bin === 'tree') return sub ? `Listing ${cleanPath(sub)}` : 'Listing files'
  if (bin === 'grep' || bin === 'rg' || bin === 'ag') return 'Searching the code'
  if (bin === 'find' || bin === 'fd') return 'Looking for files'
  if (bin === 'mkdir') return 'Creating a directory'
  if (bin === 'mv') return 'Moving files'
  if (bin === 'cp') return 'Copying files'
  if (bin === 'rm') return 'Deleting files'
  if (bin === 'tsc') return 'Type-checking'
  if (bin === 'eslint' || bin === 'prettier' || bin === 'ruff' || bin === 'black') return 'Linting'
  if (bin === 'echo') return 'Printing output'
  if (bin === 'curl' || bin === 'wget') return 'Fetching a URL'
  if (bin === 'docker' || bin === 'kubectl' || bin === 'make') return `Running ${bin} ${sub}`.trim()
  return `Running ${truncate(cmd, 60)}`
}

/**
 * What a tool call reads as in plain English, and the technical call behind it.
 *
 * The transcript is something a person skims, so the headline is a sentence —
 * "Running the tests", not "Bash(npm test -- --run)". The exact call is never
 * lost: `technical` is printed under the headline as soon as the block is
 * expanded (click or ctrl+o).
 */
export function describeTool(
  name: string,
  input: Record<string, unknown> | undefined,
): { text: string; technical: string; subject: string } {
  const inp = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof inp[k] === 'string' ? (inp[k] as string) : '')
  const label = TOOL_LABEL[name] ?? name

  let text: string
  let arg = ''
  switch (name) {
    case 'read_file': {
      const path = cleanPath(str('path') || str('file_path'))
      arg = path
      text = path ? `Reading ${path}` : 'Reading a file'
      break
    }
    case 'write_file': {
      const path = cleanPath(str('path') || str('file_path'))
      arg = path
      text = path ? `Writing ${path}` : 'Writing a file'
      break
    }
    case 'edit_file': {
      const path = cleanPath(str('path') || str('file_path'))
      arg = path
      const n = Array.isArray(inp.edits) ? (inp.edits as unknown[]).length : 1
      text = path
        ? `Editing ${path}${n > 1 ? ` (${n} changes)` : ''}`
        : 'Editing a file'
      break
    }
    case 'run_bash': {
      const cmd = str('command').replace(/\s+/g, ' ')
      arg = truncate(cmd, 120)
      // A description the model wrote beats anything inferred from the command.
      const given = str('description').trim()
      text = given || describeCommand(cmd)
      break
    }
    case 'grep': {
      const pattern = str('pattern')
      arg = truncate(pattern, 120)
      const where = cleanPath(str('path'))
      const filter = str('glob') || str('type')
      text = `Searching for ${quote(pattern)}`
      if (filter) text += ` in ${filter} files`
      if (where && where !== '.') text += ` under ${where}`
      break
    }
    case 'glob': {
      const pattern = str('pattern')
      arg = truncate(pattern, 120)
      text = `Finding files matching ${quote(pattern)}`
      break
    }
    case 'write_todos': {
      const todos = Array.isArray(inp.todos) ? (inp.todos as unknown[]).length : 0
      arg = `${todos} items`
      text = 'Updating the task list'
      break
    }
    case 'exit_plan_mode':
      text = 'Presenting a plan'
      break
    default: {
      arg = truncate(JSON.stringify(inp), 80)
      text = `Running ${label}`
    }
  }
  return { text, technical: arg ? `${label}(${arg})` : label, subject: arg || text }
}

/**
 * Calls the transcript counts rather than lists.
 *
 * A turn that reads six files is one action to the person watching — "Read 6
 * files", not six near-identical rows to scroll past. Reads, searches and shell
 * commands collapse that way; edits never do, because each one is a change to
 * the code and deserves its own diff.
 */
const GROUP_NOUN: Record<string, [one: string, many: string]> = {
  run_bash: ['shell command', 'shell commands'],
  read_file: ['file', 'files'],
  grep: ['search', 'searches'],
  glob: ['file search', 'file searches'],
}

const GROUP_VERB: Record<string, [running: string, done: string]> = {
  run_bash: ['Running', 'Ran'],
  read_file: ['Reading', 'Read'],
  grep: ['Running', 'Ran'],
  glob: ['Running', 'Ran'],
}

export function isGroupable(name: string): boolean {
  return name in GROUP_NOUN
}

/**
 * The counted headline for a run of calls: "Running 1 shell command…" while one
 * is still out, "Read 3 files" once they are all back. The ellipsis is the
 * tense — it says the count may still grow.
 */
export function groupHeadline(name: string, count: number, pending: boolean): string {
  const noun = GROUP_NOUN[name]
  const verb = GROUP_VERB[name]
  if (!noun || !verb) return `${pending ? 'Running' : 'Ran'} ${name}`
  const word = count === 1 ? noun[0] : noun[1]
  return pending ? `${verb[0]} ${count} ${word}…` : `${verb[1]} ${count} ${word}`
}

/**
 * Split a turn's calls into the blocks the transcript draws: consecutive calls
 * to the same groupable tool become one block, everything else stands alone.
 * Consecutive, not merely same-tool, so the blocks stay in the order the agent
 * worked in — a read, an edit, then another read is three blocks, not two.
 */
export function groupToolUses(uses: ToolUseDisplay[]): ToolUseDisplay[][] {
  const groups: ToolUseDisplay[][] = []
  for (const use of uses) {
    const last = groups[groups.length - 1]
    if (last && isGroupable(use.name) && last[0].name === use.name) last.push(use)
    else groups.push([use])
  }
  return groups
}
