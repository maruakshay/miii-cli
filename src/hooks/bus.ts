import type { ToolUse, ToolResultBlock } from '../agent/types.js'
import type { HookEvent } from '../settings.js'
import { runHooks, hasHooks, type HookOutcome, type HookPayload } from './run.js'

export type PreToolHook = (use: ToolUse) => void | Promise<void>
export type PostToolHook = (use: ToolUse, result: ToolResultBlock) => void | Promise<void>

const CLEAN: HookOutcome = { blocked: false, warnings: [] }

/**
 * Where hooks are fired from.
 *
 * Two kinds meet here. In-process listeners (onPreTool/onPostTool) are how the
 * app itself watches tool traffic — the checkpointer registers one. Shell hooks
 * come from the user's settings and can refuse a call outright; see hooks/run.ts
 * for the exit-code contract.
 *
 * In-process listeners run first and cannot block: they are observers, and a
 * throwing one must never break the tool_use → tool_result pairing the model
 * depends on. The user's own hooks get the last word.
 */
export class HookBus {
  private pre: PreToolHook[] = []
  private post: PostToolHook[] = []

  constructor(
    /** Passed through to every shell hook so it can key off the session. */
    private readonly session: { id?: string; cwd: string } = { cwd: process.cwd() },
  ) {}

  onPreTool(fn: PreToolHook): void { this.pre.push(fn) }
  onPostTool(fn: PostToolHook): void { this.post.push(fn) }

  private payload(event: HookEvent, extra: Partial<HookPayload> = {}): HookPayload {
    return {
      hook_event_name: event,
      cwd: this.session.cwd,
      ...(this.session.id ? { session_id: this.session.id } : {}),
      ...extra,
    }
  }

  async firePre(use: ToolUse): Promise<HookOutcome> {
    for (const fn of this.pre) {
      try { await fn(use) } catch { /* observer failure is not the turn's problem */ }
    }
    if (!hasHooks('PreToolUse', use.name, this.session.cwd)) return CLEAN
    return runHooks(this.payload('PreToolUse', { tool_name: use.name, tool_input: use.input }))
  }

  async firePost(use: ToolUse, result: ToolResultBlock): Promise<HookOutcome> {
    for (const fn of this.post) {
      try { await fn(use, result) } catch { /* see above */ }
    }
    if (!hasHooks('PostToolUse', use.name, this.session.cwd)) return CLEAN
    return runHooks(
      this.payload('PostToolUse', {
        tool_name: use.name,
        tool_input: use.input,
        tool_response: { content: result.content, ...(result.is_error ? { is_error: true } : {}) },
      }),
    )
  }

  /** Fired before the user's message reaches the model. A block drops the turn. */
  async firePrompt(prompt: string): Promise<HookOutcome> {
    if (!hasHooks('UserPromptSubmit', undefined, this.session.cwd)) return CLEAN
    return runHooks(this.payload('UserPromptSubmit', { prompt }))
  }

  /** Fired when the agent means to stop. A block sends it back to work. */
  async fireStop(): Promise<HookOutcome> {
    if (!hasHooks('Stop', undefined, this.session.cwd)) return CLEAN
    return runHooks(this.payload('Stop'))
  }

  /** Fired once when a session opens. stdout becomes context for the first turn. */
  async fireSessionStart(source: 'startup' | 'resume' | 'clear'): Promise<HookOutcome> {
    if (!hasHooks('SessionStart', undefined, this.session.cwd)) return CLEAN
    return runHooks(this.payload('SessionStart', { source }))
  }
}
