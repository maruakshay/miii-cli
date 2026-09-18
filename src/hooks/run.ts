/**
 * Shell hooks — the settings-driven half of the hook bus.
 *
 * A hook is a command the harness runs at a fixed point in a turn. It exists
 * because some rules should not be requests: "run prettier after every edit",
 * "never let the agent touch prisma/migrations", "log every command to the audit
 * file". Put those in the system prompt and a 7B model follows them most of the
 * time, which is the same as not having them. Put them here and they are
 * mechanical.
 *
 *   "hooks": {
 *     "PostToolUse": [
 *       { "matcher": "edit_file|write_file",
 *         "hooks": [{ "command": "npx prettier --write $MIII_TOOL_PATH" }] }
 *     ]
 *   }
 *
 * The event arrives as JSON on stdin. What the hook does with its exit code is
 * the whole contract:
 *
 *   0  — fine. stdout is fed back as context where that makes sense
 *        (UserPromptSubmit, SessionStart) and shown to the user otherwise.
 *   2  — block. stderr is handed to the MODEL as the reason, so it can adapt
 *        instead of retrying into the same wall.
 *   *  — the hook itself is broken. Surfaced to the user, never to the model,
 *        and the turn carries on: a typo in a hook must not brick the session.
 */
import { execa } from 'execa'
import type { HookCommand, HookEvent, HookMatcher } from '../settings.js'
import { loadSettings, settingsEnv } from '../settings.js'

/** Seconds a hook may run before it is killed. */
const DEFAULT_TIMEOUT = 30

export interface HookPayload {
  hook_event_name: HookEvent
  session_id?: string
  cwd: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: { content: string; is_error?: boolean }
  prompt?: string
  source?: string
}

export interface HookOutcome {
  /** A hook exited 2. The caller must not proceed with whatever it was doing. */
  blocked: boolean
  /** Why it was blocked — written for the model, from the hook's stderr. */
  reason?: string
  /** stdout from hooks that succeeded, joined. Fed to the model where it fits. */
  context?: string
  /** Hook failures the user should see. Never shown to the model. */
  warnings: string[]
}

const CLEAN: HookOutcome = { blocked: false, warnings: [] }

/**
 * Does this matcher apply to this tool? Anchored so "edit_file" does not also
 * fire on a tool called "edit_file_bulk". An absent matcher, "" or "*" means
 * every tool — and for events with no tool at all, every matcher applies.
 */
export function matches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === '*') return true
  if (!toolName) return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName)
  } catch {
    // A malformed regex matches nothing rather than everything: a hook that
    // fires on every tool because its pattern failed to compile is the more
    // dangerous reading of the mistake.
    return false
  }
}

/** The hook commands configured for this event and tool, in file order. */
export function hooksFor(event: HookEvent, toolName?: string, cwd?: string): HookCommand[] {
  const groups: HookMatcher[] = loadSettings(cwd).hooks?.[event] ?? []
  const out: HookCommand[] = []
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) continue
    if (!matches(group.matcher, toolName)) continue
    for (const hook of group.hooks) {
      if (hook && typeof hook.command === 'string' && hook.command.trim()) out.push(hook)
    }
  }
  return out
}

/**
 * Convenience environment for the hook, so the common case does not need a JSON
 * parser. The full event is still on stdin for anything more than a path.
 */
function hookEnv(payload: HookPayload): Record<string, string> {
  const path = payload.tool_input?.path
  const command = payload.tool_input?.command
  return {
    ...settingsEnv(payload.cwd),
    MIII_PROJECT_DIR: payload.cwd,
    MIII_HOOK_EVENT: payload.hook_event_name,
    ...(payload.tool_name ? { MIII_TOOL_NAME: payload.tool_name } : {}),
    ...(typeof path === 'string' ? { MIII_TOOL_PATH: path } : {}),
    ...(typeof command === 'string' ? { MIII_TOOL_COMMAND: command } : {}),
  }
}

/**
 * Run every hook registered for this event. Hooks run in sequence, not in
 * parallel: they are side effects on one working tree, and a formatter racing a
 * linter over the same file is a bug report nobody can reproduce.
 *
 * The first block short-circuits the rest — once the call is refused there is
 * nothing left for a later hook to have an opinion about.
 */
export async function runHooks(payload: HookPayload): Promise<HookOutcome> {
  const hooks = hooksFor(payload.hook_event_name, payload.tool_name, payload.cwd)
  if (hooks.length === 0) return CLEAN

  const json = JSON.stringify(payload)
  const warnings: string[] = []
  const stdouts: string[] = []

  for (const hook of hooks) {
    const timeout = (hook.timeout ?? DEFAULT_TIMEOUT) * 1000
    try {
      const result = await execa(hook.command, {
        shell: true,
        input: json,
        cwd: payload.cwd,
        timeout,
        reject: false,
        env: hookEnv(payload),
      })
      const stdout = (result.stdout ?? '').trim()
      const stderr = (result.stderr ?? '').trim()

      if (result.exitCode === 2) {
        return {
          blocked: true,
          reason: stderr || `A ${payload.hook_event_name} hook refused this (\`${hook.command}\`) and gave no reason.`,
          ...(stdouts.length ? { context: stdouts.join('\n') } : {}),
          warnings,
        }
      }
      if (result.exitCode !== 0) {
        warnings.push(`hook failed (exit ${result.exitCode ?? '?'}): ${hook.command}${stderr ? ` — ${stderr}` : ''}`)
        continue
      }
      if (stdout) stdouts.push(stdout)
    } catch (err) {
      warnings.push(`hook errored: ${hook.command} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    blocked: false,
    ...(stdouts.length ? { context: stdouts.join('\n') } : {}),
    warnings,
  }
}

/** Is any hook configured for this event? Lets callers skip building a payload. */
export function hasHooks(event: HookEvent, toolName?: string, cwd?: string): boolean {
  return hooksFor(event, toolName, cwd).length > 0
}
