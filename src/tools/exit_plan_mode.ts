import type { Tool } from './types.js'

interface Input {
  plan: string
}

/**
 * The way out of plan mode.
 *
 * Plan mode is read-only, so the agent cannot finish a task from inside it — it
 * researches, then calls this with what it intends to do. The agent loop
 * intercepts the call, shows the plan to the user for approval, and only leaves
 * plan mode if they accept. The handler below therefore normally never runs:
 * it is the answer for a model that calls the tool when it isn't planning,
 * which happens with small models that have seen the name in the transcript.
 */
export const exit_plan_mode: Tool<Input> = {
  name: 'exit_plan_mode',
  description:
    'Present your finished implementation plan and ask the user to approve starting work. ' +
    'Only for plan mode, and only once research is done — the plan is what you intend to ' +
    'change, in order. Do not call it to report work you have already finished.',
  input_schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'The plan, as terminal Markdown. Concise: the steps you will take, in order, ' +
          'naming the files each one touches.',
      },
    },
    required: ['plan'],
  },
  handler: () => ({
    content:
      "You're not in plan mode, so there is nothing to exit — this tool does nothing here. " +
      'Carry out the work directly with the file and command tools.',
    is_error: true,
  }),
}
