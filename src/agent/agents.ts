/**
 * Subagent definitions.
 *
 * A subagent is a second agent loop with its own context window, its own system
 * prompt and a narrower set of tools. It exists for one reason: context is the
 * scarce resource here. "Find every place we parse a config file" costs twenty
 * greps and ten partial reads, and on a 16k window that search is the whole
 * budget — the model finds the answer and then has no room left to use it. Run
 * it in a subagent and the main conversation gets back three lines: the answer.
 *
 * Definitions are Markdown files, the same idea as the custom commands:
 *
 *   <cwd>/.miii/agents/*.md   project scope — checked in, shared with the team
 *   ~/.miii/agents/*.md       user scope — yours, in every project
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for correctness bugs. Use after writing code.
 *   tools: read_file, grep, glob, run_bash
 *   ---
 *   You are a code reviewer. Read the diff and report only real defects…
 *
 * `description` is what the main model reads when choosing an agent, so it says
 * when to use it, not what it is. Two built-ins ship so `task` works on a fresh
 * install with no files at all.
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'

export interface AgentDef {
  name: string
  description: string
  /** Tool names this agent may use. Empty means the default set for its kind. */
  tools: string[]
  /** System prompt body. */
  prompt: string
  /** Override the session model — e.g. a small fast one for search. */
  model?: string
  source: 'builtin' | 'project' | 'user'
}

/**
 * Tools a subagent gets when its definition does not say. `task` is never in
 * the list: subagents spawning subagents is a context leak with a recursion
 * bound bolted on, and nothing miii does needs it.
 */
export const DEFAULT_SUBAGENT_TOOLS = [
  'read_file', 'grep', 'glob', 'run_bash', 'write_todos', 'write_file', 'edit_file',
]

/** The read-only subset — what a research agent is held to. */
export const READ_ONLY_SUBAGENT_TOOLS = ['read_file', 'grep', 'glob', 'run_bash', 'write_todos']

const BUILTIN: AgentDef[] = [
  {
    name: 'explore',
    description:
      'Searches the codebase and reports back what it found. Use for any question that would ' +
      'take several greps and partial reads to answer — "where is X handled", "what calls Y", ' +
      '"how does this project do Z". Read-only: it cannot change anything.',
    tools: READ_ONLY_SUBAGENT_TOOLS,
    source: 'builtin',
    prompt:
      'You are a code search agent. You are answering one question for another engineer who ' +
      'cannot see your work — only your final message reaches them.\n\n' +
      '- Search widely before you conclude: grep for the obvious names, then for the ones the ' +
      'project would plausibly have used instead. Read the files you hit, not just the match line.\n' +
      '- Answer with what you actually found, citing `path:line` for every claim. If the answer ' +
      'is "this does not exist here", say that plainly rather than reporting the nearest thing.\n' +
      '- Your final message is the entire deliverable. Lead with the answer in one or two ' +
      'sentences, then the specifics. No preamble, no narration of your search.',
  },
  {
    name: 'general',
    description:
      'Carries out a self-contained piece of work end to end and reports the result. Use when ' +
      'the task is separable from what you are doing and you only need its outcome.',
    tools: DEFAULT_SUBAGENT_TOOLS,
    source: 'builtin',
    prompt:
      'You are a senior engineer given one self-contained task by another agent, who cannot see ' +
      'your work — only your final message reaches them.\n\n' +
      '- Do exactly what was asked, no more. You have no way to ask a follow-up question, so ' +
      'where the task is ambiguous, pick the reading the codebase supports and say which you took.\n' +
      '- Verify before you report: run the relevant tests or the affected entry point.\n' +
      '- Your final message is the entire deliverable. State what you did, what changed (with ' +
      'paths), and anything the caller must know. No preamble.',
  },
]

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i

/** Split `---` frontmatter into keys. Same tolerance as the command loader. */
function parseFrontmatter(text: string): { keys: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { keys: {}, body: normalized.trim() }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { keys: {}, body: normalized.trim() }
  const keys: Record<string, string> = {}
  for (const line of normalized.slice(4, end).split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    keys[m[1].toLowerCase()] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { keys, body: normalized.slice(normalized.indexOf('\n', end + 1) + 1).trim() }
}

function loadScope(scope: 'project' | 'user', cwd: string): AgentDef[] {
  const dir = scope === 'user' ? join(homedir(), '.miii', 'agents') : join(cwd, '.miii', 'agents')
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const out: AgentDef[] = []
  for (const file of files.sort()) {
    let raw: string
    try {
      raw = readFileSync(join(dir, file), 'utf-8')
    } catch {
      continue
    }
    const { keys, body } = parseFrontmatter(raw)
    const name = (keys.name || basename(file, '.md')).toLowerCase()
    if (!NAME_RE.test(name) || !body) continue
    out.push({
      name,
      description: keys.description || `custom ${name} agent`,
      tools: keys.tools ? keys.tools.split(',').map((t) => t.trim()).filter(Boolean) : [],
      prompt: body,
      ...(keys.model ? { model: keys.model } : {}),
      source: scope,
    })
  }
  return out
}

/**
 * Every agent available here. Project definitions shadow user ones, and both
 * shadow a built-in of the same name — a repo that ships its own `explore`
 * meant to replace ours.
 */
export function loadAgents(cwd: string = process.cwd()): AgentDef[] {
  const project = loadScope('project', cwd)
  const taken = new Set(project.map((a) => a.name))
  const user = loadScope('user', cwd).filter((a) => !taken.has(a.name))
  for (const a of user) taken.add(a.name)
  const builtin = BUILTIN.filter((a) => !taken.has(a.name))
  return [...project, ...user, ...builtin]
}

export function findAgent(name: string, cwd?: string): AgentDef | undefined {
  return loadAgents(cwd).find((a) => a.name === name.toLowerCase())
}
