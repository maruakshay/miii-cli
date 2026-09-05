import type { JsonSchema, PropSpec } from '../tools/types.js'

/**
 * Tool-call comprehension layer.
 *
 * Small local models get the *intent* of a tool call right far more often than
 * they get its *spelling* right: they call `readFile` instead of `read_file`,
 * pass `file_path` instead of `path`, send `"10"` where a number is declared,
 * or wrap the whole call in an envelope. Every one of those costs a full round
 * trip — a rejected call, an error message, a retry — which on a 4k–8k context
 * is the difference between finishing the task and running out of room.
 *
 * So instead of rejecting a near-miss and spending a turn teaching the model to
 * spell, we repair what is unambiguous here and run the call. Repairs are
 * deliberately conservative: a rename only happens when the target field is
 * declared by the schema AND absent, so a repair can never overwrite something
 * the model actually said.
 */

// ---------------------------------------------------------------------------
// Tool name resolution
// ---------------------------------------------------------------------------

/** Lowercase, strip any namespace prefix and every non-alphanumeric character. */
function canon(s: string): string {
  return s
    .trim()
    .replace(/^(functions?|tools?|namespace)[.:/]/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Canonical-form aliases → miii tool name. These are the names other agent
 * harnesses use (Claude Code, Cursor, Aider, OpenAI function samples); a model
 * trained on those transcripts reaches for them by reflex.
 */
const NAME_ALIASES: Record<string, string> = {
  // run_bash
  bash: 'run_bash', sh: 'run_bash', shell: 'run_bash', exec: 'run_bash',
  execute: 'run_bash', executecommand: 'run_bash', runcommand: 'run_bash',
  runshell: 'run_bash', runterminalcmd: 'run_bash', terminal: 'run_bash',
  command: 'run_bash', cmd: 'run_bash', shellexec: 'run_bash',
  // read_file
  read: 'read_file', cat: 'read_file', view: 'read_file', viewfile: 'read_file',
  openfile: 'read_file', getfile: 'read_file', filecontents: 'read_file',
  readfilecontents: 'read_file', showfile: 'read_file',
  // write_file
  write: 'write_file', create: 'write_file', createfile: 'write_file',
  savefile: 'write_file', newfile: 'write_file', putfile: 'write_file',
  filewrite: 'write_file', writetofile: 'write_file',
  // edit_file
  edit: 'edit_file', patch: 'edit_file', applypatch: 'edit_file',
  applydiff: 'edit_file', strreplace: 'edit_file', strreplaceeditor: 'edit_file',
  replaceinfile: 'edit_file', modifyfile: 'edit_file', updatefile: 'edit_file',
  searchreplace: 'edit_file',
  // grep
  search: 'grep', searchfiles: 'grep', searchtext: 'grep', ripgrep: 'grep',
  rg: 'grep', findinfiles: 'grep', codesearch: 'grep', grepsearch: 'grep',
  // glob
  find: 'glob', findfiles: 'glob', listfiles: 'glob', ls: 'glob',
  listdir: 'glob', listdirectory: 'glob', filesearch: 'glob', globsearch: 'glob',
  // write_todos
  todo: 'write_todos', todos: 'write_todos', todowrite: 'write_todos',
  writetodo: 'write_todos', settodos: 'write_todos', updatetodos: 'write_todos',
  tasklist: 'write_todos', updatetasklist: 'write_todos',
}

/** Levenshtein distance, capped — we only ever care about "is it ≤ 2". */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * Map whatever the model called the tool onto a real tool name, or null if it
 * plainly meant something else.
 *
 * Tiers, most to least certain: exact → canonical form (case/underscore/dot
 * noise) → known alias from another harness → nearest name within edit distance
 * 2, and only when exactly one candidate is that close.
 *
 * `fuzzy` gates that last tier. It is on for structured tool calls, where the
 * model has unmistakably committed to calling *a* tool and the only question is
 * which. It is off when we are salvaging a call out of prose, where a loose
 * match could turn an ordinary sentence into a filesystem write.
 */
export function resolveToolName(
  raw: string,
  known: string[],
  fuzzy = true,
): string | null {
  if (!raw) return null
  if (known.includes(raw)) return raw

  const c = canon(raw)
  if (!c) return null

  for (const name of known) if (canon(name) === c) return name

  const alias = NAME_ALIASES[c]
  if (alias && known.includes(alias)) return alias

  if (!fuzzy) return null

  let best: string | null = null
  let bestScore = 3
  let tied = false
  for (const name of known) {
    const d = distance(c, canon(name))
    if (d < bestScore) { bestScore = d; best = name; tied = false }
    else if (d === bestScore) tied = true
  }
  return tied ? null : best
}

// ---------------------------------------------------------------------------
// Envelope unwrapping
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = new Set([
  'name', 'tool', 'tool_name', 'toolname', 'function', 'recipient_name',
])
const ARG_KEYS = ['arguments', 'args', 'parameters', 'params', 'input', 'tool_input']

/**
 * Best-effort close of a JSON document that was cut off mid-write: terminate an
 * open string, drop a dangling key or comma, then close every open bracket.
 * Recovers the fields that *did* arrive from a response that hit the token cap.
 */
export function repairJson(raw: string): Record<string, unknown> | null {
  const s = raw.trim()
  if (!s.startsWith('{')) return null
  try { return JSON.parse(s) as Record<string, unknown> } catch { /* fall through */ }

  const stack: string[] = []
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }

  let body = s
  // An escape half-written at the cut point would make the closing quote escape
  // itself, so drop it before terminating the string.
  if (esc) body = body.slice(0, -1)
  if (inStr) body += '"'
  // Trailing `, "key":` or `,` — a field the model never got to finish.
  body = body.replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/,\s*$/, '')
  body += stack.reverse().join('')

  try {
    const parsed = JSON.parse(body) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') return repairJson(v)
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

/**
 * Peel the call envelope some models emit in place of bare arguments —
 * `{name, arguments}`, `{tool, args}`, `{function: {name, arguments}}`, or an
 * `arguments` field that is itself a JSON string. Also recovers `_raw`, which
 * is what the OpenAI adapter stores when streamed argument JSON fails to parse.
 *
 * Bails the moment the object carries a key that isn't envelope machinery, so a
 * genuine payload that happens to have a `name` field is left alone.
 */
export function unwrapEnvelope(input: Record<string, unknown>): Record<string, unknown> {
  let cur = input
  for (let depth = 0; depth < 4; depth++) {
    if (typeof cur._raw === 'string' && Object.keys(cur).length === 1) {
      const repaired = repairJson(cur._raw)
      if (!repaired) return cur
      cur = repaired
      continue
    }

    const fn = asObject(cur.function)
    if (fn && Object.keys(cur).every((k) => ENVELOPE_KEYS.has(k))) {
      cur = fn
      continue
    }

    const argKey = ARG_KEYS.find((k) => k in cur)
    if (!argKey) return cur
    // Every other key must be envelope machinery, or this is a real payload
    // that merely happens to declare an `input`/`args` field of its own.
    if (!Object.keys(cur).every((k) => k === argKey || ENVELOPE_KEYS.has(k))) return cur
    const inner = asObject(cur[argKey])
    if (!inner) return cur
    cur = inner
  }
  return cur
}

// ---------------------------------------------------------------------------
// Argument key aliasing
// ---------------------------------------------------------------------------

/**
 * Canonical field name → the spellings models reach for instead, in canonical
 * form. An entry only ever applies when the tool actually declares that field
 * and the model didn't already fill it, so overlapping names across tools
 * (grep's `max_results` vs read_file's `limit`) resolve per-schema on their own.
 */
const KEY_ALIASES: Record<string, string[]> = {
  path: ['filepath', 'file', 'filename', 'targetfile', 'fname', 'src', 'source', 'directory', 'dir', 'rootpath', 'root', 'location'],
  content: ['contents', 'text', 'data', 'body', 'filecontent', 'filecontents', 'newcontent', 'code', 'value', 'task', 'title', 'label', 'step', 'item', 'todo', 'description'],
  command: ['cmd', 'shellcommand', 'bashcommand', 'script', 'commandline', 'run', 'commandtorun'],
  pattern: ['query', 'regex', 'regexp', 'searchpattern', 'searchstring', 'expression', 'globpattern', 'term', 'keyword', 'q', 'search', 'filepattern'],
  old_str: ['oldstring', 'old', 'oldtext', 'searchtext', 'find', 'from', 'original', 'target', 'oldcontent'],
  new_str: ['newstring', 'new', 'newtext', 'replace', 'replacement', 'to', 'replacewith', 'newcontent'],
  replace_all: ['all', 'global', 'replaceevery', 'alloccurrences'],
  edits: ['changes', 'replacements', 'patches', 'diffs'],
  offset: ['start', 'startline', 'fromline', 'begin', 'linestart', 'skip'],
  limit: ['numlines', 'linecount', 'maxlines', 'nlines', 'head', 'count'],
  max_results: ['maxmatches', 'maxcount', 'headlimit', 'max', 'limit', 'topk'],
  case_insensitive: ['ignorecase', 'caseinsensitivesearch', 'nocase', 'i'],
  files_only: ['fileswithmatches', 'filenamesonly', 'listfiles', 'namesonly', 'l'],
  fixed_strings: ['literal', 'fixed', 'plaintext', 'nonregex', 'f'],
  multiline: ['multi', 'dotall', 'spanlines'],
  context: ['contextlines', 'around', 'nearby', 'c'],
  glob: ['fileglob', 'include', 'filefilter', 'filesglob'],
  type: ['filetype', 'lang', 'language', 'ext'],
  todos: ['tasks', 'items', 'todolist', 'tasklist', 'list', 'plan'],
  status: ['state'],
  timeout_ms: ['timeout', 'timeoutms', 'maxtime'],
}

/** Build canonical-alias → field lookup for one property set. */
function aliasLookup(props: Record<string, PropSpec>): Map<string, string> {
  const declared = new Set(Object.keys(props).map(canon))
  const map = new Map<string, string>()
  for (const [field, aliases] of Object.entries(KEY_ALIASES)) {
    if (!(field in props)) continue
    for (const a of aliases) {
      // A spelling that is itself a declared field of this tool means what it
      // says (grep declares both `glob` and `pattern`) — never remap it.
      if (declared.has(a)) continue
      if (!map.has(a)) map.set(a, field)
    }
  }
  return map
}

/**
 * Rename near-miss keys onto the fields the schema declares. Runs the alias
 * table first, then falls back to edit distance for typos and casing variants
 * the table doesn't list. Never clobbers a field the model already set, and
 * leaves genuinely unrecognised keys in place — validation is permissive about
 * extras, and a stray key is far cheaper than a wrong rename.
 */
function alignKeys(
  props: Record<string, PropSpec>,
  input: Record<string, unknown>,
  repairs: string[],
): Record<string, unknown> {
  const lookup = aliasLookup(props)
  const out: Record<string, unknown> = {}
  const declared = Object.keys(props)

  for (const [key, value] of Object.entries(input)) {
    if (key in props) { out[key] = value; continue }

    const c = canon(key)
    let target = declared.find((d) => canon(d) === c) ?? lookup.get(c)

    if (!target) {
      let best: string | null = null
      let bestScore = 3
      let tied = false
      for (const d of declared) {
        const dist = distance(c, canon(d))
        if (dist < bestScore) { bestScore = dist; best = d; tied = false }
        else if (dist === bestScore) tied = true
      }
      if (best && !tied) target = best
    }

    if (target && target !== key && !(target in out) && !(target in input)) {
      out[target] = value
      repairs.push(`${key} → ${target}`)
    } else {
      out[key] = value
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Type coercion
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['true', 'yes', 'y', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'n', 'off', '0'])

/**
 * Coerce a value to the type the schema declares, when the model's intent is
 * unambiguous — JSON handed over as a string, `"12"` for a number, `"true"` for
 * a boolean, a bare item where a list is expected, a list of lines where a
 * string is expected. Anything ambiguous is returned untouched for validation
 * to reject properly.
 */
function coerce(spec: PropSpec, value: unknown, path: string, repairs: string[]): unknown {
  if (value === null || value === undefined) return value
  const note = (what: string) => repairs.push(`${path}: ${what}`)

  switch (spec.type) {
    case 'string': {
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') {
        note('stringified')
        return String(value)
      }
      // A file body handed over as an array of lines — join it rather than
      // failing the call and making the model resend the whole thing.
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        note('joined lines')
        return value.join('\n')
      }
      if (typeof value === 'object') {
        note('serialised object')
        return JSON.stringify(value, null, 2)
      }
      return value
    }
    case 'number':
    case 'integer': {
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        note('parsed number')
        return Number(value)
      }
      return value
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'number' && (value === 0 || value === 1)) {
        note('parsed boolean')
        return value === 1
      }
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase()
        if (TRUE_WORDS.has(v)) { note('parsed boolean'); return true }
        if (FALSE_WORDS.has(v)) { note('parsed boolean'); return false }
      }
      return value
    }
    case 'array': {
      let arr = value
      if (typeof arr === 'string') {
        try {
          const parsed = JSON.parse(arr)
          if (Array.isArray(parsed)) { note('parsed JSON array'); arr = parsed }
        } catch { /* not JSON — fall through to the wrap below */ }
      }
      if (!Array.isArray(arr)) {
        // A single edit / single todo sent bare instead of in a list.
        if (typeof arr === 'object' || typeof arr === 'string') { note('wrapped in array'); arr = [arr] }
        else return arr
      }
      const items = spec.items
      if (!items?.properties) return arr
      return (arr as unknown[]).map((el, i) => {
        const obj = asObject(el)
        if (!obj) return el
        return normalizeAgainst(
          { type: 'object', properties: items.properties!, required: items.required },
          obj,
          `${path}[${i}]`,
          repairs,
        )
      })
    }
    case 'object': {
      if (typeof value === 'string') {
        const parsed = repairJson(value)
        if (parsed) { note('parsed JSON object'); return parsed }
      }
      return value
    }
    default:
      return value
  }
}

/**
 * Last resort, after aliasing and typo-matching have both come up empty: the
 * call is missing exactly one required field and carries exactly one key the
 * schema doesn't recognise, whose value is already the right type. There is
 * only one thing the model can have meant — a tiny model inventing its own name
 * for the single argument the tool takes — so adopt it rather than spending a
 * turn asking. Any ambiguity (two missing, two leftovers, wrong type) and this
 * does nothing.
 */
function adoptLoneArgument(
  schema: JsonSchema,
  obj: Record<string, unknown>,
  repairs: string[],
): void {
  const missing = (schema.required ?? []).filter((k) => obj[k] === undefined)
  const leftover = Object.keys(obj).filter((k) => !(k in schema.properties))
  if (missing.length !== 1 || leftover.length !== 1) return

  const spec = schema.properties[missing[0]]
  const value = obj[leftover[0]]
  if (!spec) return
  const ok =
    spec.type === 'string' ? typeof value === 'string'
      : spec.type === 'number' || spec.type === 'integer' ? typeof value === 'number'
        : spec.type === 'boolean' ? typeof value === 'boolean'
          : spec.type === 'array' ? Array.isArray(value)
            : false
  if (!ok) return

  obj[missing[0]] = value
  delete obj[leftover[0]]
  repairs.push(`${leftover[0]} → ${missing[0]} (only field left unfilled)`)
}

function normalizeAgainst(
  schema: JsonSchema,
  input: Record<string, unknown>,
  prefix: string,
  repairs: string[],
): Record<string, unknown> {
  const aligned = alignKeys(schema.properties, input, repairs)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(aligned)) {
    const spec = schema.properties[key]
    out[key] = spec ? coerce(spec, value, prefix ? `${prefix}.${key}` : key, repairs) : value
  }
  adoptLoneArgument(schema, out, repairs)
  return out
}

export interface Normalized {
  input: Record<string, unknown>
  /** Human-readable list of what was repaired; empty when the call arrived clean. */
  repairs: string[]
}

/**
 * Full repair pass for one tool call's arguments: unwrap any envelope, rename
 * near-miss keys onto declared fields, then coerce each value to its declared
 * type. Purely additive — a call that was already well-formed comes back
 * unchanged with no repairs listed.
 */
export function normalizeToolInput(schema: JsonSchema, input: unknown): Normalized {
  const repairs: string[] = []
  const obj = asObject(input)
  if (!obj) return { input: (input ?? {}) as Record<string, unknown>, repairs }
  const unwrapped = unwrapEnvelope(obj)
  if (unwrapped !== obj) repairs.push('unwrapped call envelope')
  return { input: normalizeAgainst(schema, unwrapped, '', repairs), repairs }
}
