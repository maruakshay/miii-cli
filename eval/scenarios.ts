import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Scenario } from './types.js'

const read = (dir: string, f: string) =>
  existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf-8') : null

// Keep scenarios small, deterministic, and outcome-checked. One capability each.
// A scenario should fail loudly if the agent drifts, over-edits, or stops early.
export const scenarios: Scenario[] = [
  {
    name: 'edit-exact-string',
    maxToolCalls: 6,
    prompt: 'In config.js, change the port from 3000 to 8080. Change nothing else.',
    files: { 'config.js': 'export const port = 3000\nexport const host = "localhost"\n' },
    check: (dir) => {
      const out = read(dir, 'config.js')
      if (out == null) return 'config.js missing'
      if (!out.includes('8080')) return 'port not changed to 8080'
      if (out.includes('3000')) return 'old port 3000 still present'
      if (!out.includes('host = "localhost"')) return 'unrelated line damaged'
      return true
    },
  },
  {
    name: 'read-then-answer',
    maxToolCalls: 4,
    prompt: 'What is the value of the MAX_RETRIES constant in limits.js? Reply with just the number.',
    files: { 'limits.js': 'export const MAX_RETRIES = 7\n' },
    check: (dir, finalText) => {
      if (read(dir, 'limits.js')?.includes('MAX_RETRIES = 7') !== true)
        return 'agent mutated a read-only task'
      if (!/\b7\b/.test(finalText)) return `answer missing "7": ${JSON.stringify(finalText)}`
      return true
    },
  },
  {
    name: 'create-new-file',
    maxToolCalls: 4,
    prompt: 'Create a file named greeting.txt containing exactly the text: hello world',
    check: (dir) => {
      const out = read(dir, 'greeting.txt')
      if (out == null) return 'greeting.txt not created'
      if (out.trim() !== 'hello world') return `wrong content: ${JSON.stringify(out)}`
      return true
    },
  },
  {
    name: 'grep-locate',
    maxToolCalls: 6,
    prompt: 'Which file defines a function called computeTax? Reply with just the filename.',
    files: {
      'a.js': 'export function formatDate() {}\n',
      'b.js': 'export function computeTax(x) { return x * 0.1 }\n',
      'c.js': 'export function parseArgs() {}\n',
    },
    check: (dir, finalText) => {
      if (read(dir, 'b.js')?.includes('computeTax') !== true) return 'b.js damaged'
      if (!/\bb\.js\b/.test(finalText)) return `answer missing "b.js": ${JSON.stringify(finalText)}`
      return true
    },
  },
  // ---- adversarial: the paths the harness exists to survive ----------------
  // Each of these targets one recovery path. They are expected to cost more
  // turns than the happy-path scenarios — the budget is what stops "recovered"
  // from quietly becoming "flailed and got there anyway".
  {
    // old_str almost never comes back with the indentation the file actually
    // has. Exercises the whitespace-tolerant match in edit_file, and the
    // near-miss context that gets printed when even that fails.
    name: 'edit-indented-block',
    prompt: 'In server.js, change the retry count from 3 to 10. Change nothing else.',
    files: {
      'server.js':
        'export function connect(opts) {\n' +
        '    if (opts.secure) {\n' +
        '        return {\n' +
        '            retries: 3,\n' +
        '            timeout: 5000,\n' +
        '        }\n' +
        '    }\n' +
        '}\n',
    },
    maxToolCalls: 8,
    check: (dir) => {
      const out = read(dir, 'server.js')
      if (out == null) return 'server.js missing'
      if (!/retries:\s*10/.test(out)) return 'retries not changed to 10'
      if (!/timeout:\s*5000/.test(out)) return 'unrelated line damaged'
      if (!out.includes('    if (opts.secure) {')) return 'indentation destroyed'
      return true
    },
  },
  {
    // The literal appears twice, so a bare old_str is ambiguous and edit_file
    // refuses it. Passing means the model widened its match instead of
    // resending the same call — the exact loop the repeat gate now stops.
    name: 'edit-one-of-two',
    prompt:
      'In math.js there are two functions. Change the multiplier to 3 in scaleUp only. ' +
      'scaleDown must keep its multiplier of 2.',
    files: {
      'math.js':
        'export function scaleUp(x) {\n  const factor = 2\n  return x * factor\n}\n\n' +
        'export function scaleDown(x) {\n  const factor = 2\n  return x / factor\n}\n',
    },
    maxToolCalls: 10,
    check: (dir) => {
      const out = read(dir, 'math.js')
      if (out == null) return 'math.js missing'
      const up = out.slice(out.indexOf('scaleUp'), out.indexOf('scaleDown'))
      const down = out.slice(out.indexOf('scaleDown'))
      if (!/factor = 3/.test(up)) return 'scaleUp multiplier not changed to 3'
      if (!/factor = 2/.test(down)) return 'scaleDown multiplier was changed too'
      return true
    },
  },
  {
    // The stale-read case: the agent reads the file, then something else
    // rewrites it, then it edits. A harness that tracks paths but not their
    // state lets that edit land on the stale copy and silently drop the
    // appended line — which is exactly what this checks for.
    name: 'edit-after-shell-change',
    prompt:
      "Do these in order: 1) read notes.txt. 2) append a line reading gamma to notes.txt " +
      "using run_bash with echo. 3) then use edit_file to change the word alpha to ALPHA. " +
      'Keep every line.',
    files: { 'notes.txt': 'alpha\nbeta\n' },
    maxToolCalls: 10,
    check: (dir) => {
      const out = read(dir, 'notes.txt')
      if (out == null) return 'notes.txt missing'
      if (!out.includes('ALPHA')) return 'alpha not changed to ALPHA'
      if (!/^gamma$/m.test(out)) return 'the appended gamma line was clobbered by a stale edit'
      if (!/^beta$/m.test(out)) return 'beta line lost'
      return true
    },
  },
  {
    // Nothing to fix: the model must find that out and say so rather than
    // inventing the file or retrying the same failing edit until MAX_TURNS.
    name: 'report-missing-file',
    prompt:
      'Change the timeout to 60 in settings.json. If that file does not exist, do not create ' +
      'it — just tell me it is missing.',
    files: { 'readme.md': 'no settings here\n' },
    maxToolCalls: 8,
    check: (dir, finalText) => {
      if (existsSync(join(dir, 'settings.json'))) return 'agent invented settings.json'
      if (!/missing|does not exist|doesn't exist|not found|no settings\.json/i.test(finalText))
        return `never reported the file missing: ${JSON.stringify(finalText)}`
      return true
    },
  },
  {
    // Two files, one answer. Cheap on its own; the budget is the point — a
    // model that greps the same thing five times still gets the answer right.
    name: 'read-two-files',
    prompt:
      'config.json sets a base timeout and overrides.json multiplies it. What is the ' +
      'effective timeout in milliseconds? Reply with just the number.',
    files: {
      'config.json': '{ "timeoutMs": 250 }\n',
      'overrides.json': '{ "timeoutMultiplier": 4 }\n',
    },
    maxToolCalls: 6,
    check: (dir, finalText) => {
      if (!/\b1000\b/.test(finalText)) return `answer missing "1000": ${JSON.stringify(finalText)}`
      return true
    },
  },
]
