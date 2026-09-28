import { relative, resolve } from 'node:path'
import type { ToolResultDisplay, ToolUseDisplay, TurnSummary } from './types.js'

/**
 * Commands that run a test suite. Matched on the shell command a run_bash call
 * carried, so "tests passed" in the summary means a runner actually ran — not
 * that the model said so.
 */
const TEST_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|npx\s+(?:vitest|jest|mocha)|vitest|jest|mocha|pytest|py\.test|go\s+test|cargo\s+(?:test|nextest)|mvn\s+(?:\S+\s+)*test|gradlew?\s+(?:\S+\s+)*test|dotnet\s+test|rspec|phpunit|mix\s+test|deno\s+test|python3?\s+-m\s+(?:pytest|unittest))\b/

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

/**
 * Folds one turn's tool activity into what the user wants to know when it ends:
 * which files changed and by how much, and whether the last test run passed.
 * Built up call by call, since a turn's steps are committed one at a time.
 */
export class TurnSummaryBuilder {
  constructor(private cwd = process.cwd()) {}

  private files = new Map<string, { added: number; removed: number }>()
  private tests: TurnSummary['tests']

  add(use: ToolUseDisplay | undefined, result: ToolResultDisplay): void {
    if (result.diff && !result.is_error) {
      // The path is as the model wrote it — "a.ts", "./a.ts" and an absolute
      // path are one file, and should count as one.
      const path = relative(this.cwd, resolve(this.cwd, result.diff.path)) || result.diff.path
      const prev = this.files.get(path) ?? { added: 0, removed: 0 }
      this.files.set(path, {
        added: prev.added + result.diff.added,
        removed: prev.removed + result.diff.removed,
      })
    }
    const command = use?.name === 'run_bash' ? String(use.input.command ?? '') : ''
    // The LAST run is the verdict: failing, fixing and re-running is the loop
    // working, and the summary should say where it ended up.
    if (command && isTestCommand(command)) this.tests = result.is_error ? 'failed' : 'passed'
  }

  build(): TurnSummary {
    return {
      files: [...this.files].map(([path, n]) => ({ path, ...n })),
      tests: this.tests,
    }
  }
}

/** One piece of the closing line; `tone` colours the parts worth a glance. */
export interface SummaryPart { text: string; tone?: 'good' | 'bad' }

/**
 * A finished turn's closing line, in the order a reviewer asks: what changed,
 * did the tests pass, what did it cost, how do I back it out.
 *
 *   ↳ Changed src/a.ts, src/b.ts (+42 −10) · tests passed · 1.5k tokens · 4.2s · /rewind last to undo
 */
export function summaryParts(
  summary: TurnSummary | undefined,
  tokens: string,
  duration: string | undefined,
): SummaryPart[] {
  const parts: SummaryPart[] = []
  const files = summary?.files ?? []
  if (files.length) {
    const added = files.reduce((n, f) => n + f.added, 0)
    const removed = files.reduce((n, f) => n + f.removed, 0)
    // Two paths still read at a glance; past that the count says more.
    const what = files.length <= 2 ? files.map((f) => f.path).join(', ') : `${files.length} files`
    parts.push({ text: `Changed ${what} (+${added}${removed ? ` −${removed}` : ''})` })
  } else {
    parts.push({ text: 'Completed' })
  }
  if (summary?.tests === 'passed') parts.push({ text: 'tests passed', tone: 'good' })
  if (summary?.tests === 'failed') parts.push({ text: 'tests failed', tone: 'bad' })
  parts.push({ text: `${tokens} tokens` })
  if (duration) parts.push({ text: duration })
  if (files.length) parts.push({ text: '/rewind last to undo' })
  return parts
}
