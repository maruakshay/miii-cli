/**
 * task — run a subagent and return only its answer.
 *
 * The point is context, not parallelism. A question like "where does this
 * project handle retries" costs a dozen greps and half a dozen partial reads to
 * answer, and every one of them stays in the main conversation forever after.
 * On the small local models miii targets, that search *is* the context budget:
 * the model finds the answer and then has no room left to act on it. Run the
 * same search in a subagent and the main history gains three lines.
 *
 * So the contract is deliberately narrow: one prompt in, one final message out.
 * The subagent's tool calls, its dead ends and its file reads are discarded when
 * it finishes. Anything the caller needs has to be in that last message, which
 * is why every agent prompt in agents.ts says so.
 */
import { loadAgents, findAgent, DEFAULT_SUBAGENT_TOOLS } from '../agent/agents.js'
import { buildSubagentPrompt } from '../prompt/system.js'
import { loadProjectContext } from '../prompt/context.js'
import { spillIfLarge } from './spill.js'
import type { Tool } from './types.js'

interface Input {
  description?: string
  prompt: string
  subagent_type?: string
}

/**
 * Turns a subagent spends before it is cut off. Lower than the main loop's 25:
 * a subagent that has taken fifteen turns has lost the plot, and unlike the main
 * loop there is no user watching who can stop it.
 */
const SUBAGENT_MAX_TURNS = 15

/** Built lazily so a new .miii/agents file shows up without a restart. */
function describeAgents(cwd: string): string {
  return loadAgents(cwd)
    .map((a) => `- ${a.name}: ${a.description}`)
    .join('\n')
}

export const task: Tool<Input> = {
  name: 'task',
  get description(): string {
    return (
      'Hand a self-contained task to a subagent and get back only its final report. ' +
      'Use it when answering would take many searches and reads whose details you do not need to keep — ' +
      'the subagent burns its own context, not yours. Give it a complete, standalone brief: it cannot see ' +
      'this conversation and cannot ask you anything. Do not use it for a single read or grep, or when you ' +
      'need to see the intermediate results yourself.\n\nAvailable agents:\n' +
      describeAgents(process.cwd())
    )
  },
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'What this delegation is for, in 3-6 plain words — shown to the user while it runs.',
      },
      prompt: {
        type: 'string',
        description:
          'The complete brief for the subagent. It sees nothing of this conversation, so restate every ' +
          'path, name and constraint it needs, and say exactly what its final message should contain.',
      },
      subagent_type: {
        type: 'string',
        description: 'Which agent to use. Defaults to "explore" (read-only search).',
      },
    },
    required: ['prompt'],
  },
  handler: async ({ prompt, subagent_type }, ctx) => {
    const run = ctx?.run
    if (!run) {
      return {
        content: 'task is only available inside a running session.',
        is_error: true,
      }
    }

    const wanted = (subagent_type ?? 'explore').toLowerCase()
    const agent = findAgent(wanted, run.cwd)
    if (!agent) {
      return {
        content:
          `There's no subagent called "${wanted}". Available:\n${describeAgents(run.cwd)}\n` +
          `Pick one of those, or do the work yourself.`,
        is_error: true,
      }
    }

    // Imported here rather than at module scope: the loop imports the tool
    // registry, which imports this file. The cycle is harmless at call time and
    // an eval-time hazard at import time.
    const { runAgent } = await import('../agent/loop.js')
    const allowed = new Set(agent.tools.length ? agent.tools : DEFAULT_SUBAGENT_TOOLS)
    const project = loadProjectContext(run.cwd)

    let finalText = ''
    let toolCalls = 0
    let failed: string | null = null

    try {
      const gen = runAgent({
        model: agent.model ?? run.model,
        cwd: run.cwd,
        history: [],
        userText: prompt,
        permissions: run.permissions,
        // A subagent inherits the caller's mode. It must not be a way around
        // plan mode: "research read-only" would mean very little if the model
        // could delegate the writing.
        mode: run.mode,
        hooks: run.hooks,
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
        ...(run.num_ctx !== undefined ? { num_ctx: run.num_ctx } : {}),
        maxTurns: SUBAGENT_MAX_TURNS,
        judge: false,
        toolFilter: (name) => allowed.has(name),
        buildSystem: (tools) => buildSubagentPrompt(agent.prompt, tools, run.cwd, project),
      })

      for (;;) {
        const step = await gen.next()
        if (step.done) break
        const ev = step.value
        // Only the last turn's text is the report; earlier turns are the
        // subagent thinking out loud between tool calls and are thrown away.
        if (ev.type === 'text-delta') finalText += ev.text
        else if (ev.type === 'tool-use') toolCalls++
        else if (ev.type === 'turn-end' && ev.stop_reason === 'tool_use') finalText = ''
        else if (ev.type === 'error') failed = ev.message
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err)
    }

    const report = finalText.trim()
    if (!report) {
      return {
        content:
          `The ${agent.name} subagent finished without reporting anything` +
          (failed ? ` (${failed})` : '') +
          `. Nothing was learned from it — do the work directly instead of delegating it again.`,
        is_error: true,
      }
    }

    const note = failed ? `\n\n[The subagent stopped early: ${failed}]` : ''
    return {
      content: spillIfLarge(
        `${report}${note}\n\n[${agent.name} subagent · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}]`,
        'subagent report',
      ),
      ...(failed ? { is_error: true } : {}),
    }
  },
}
