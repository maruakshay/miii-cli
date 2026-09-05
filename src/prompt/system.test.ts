import { describe, it, expect } from 'vitest'
import {
  buildSystemPrompt,
  estimateTokens,
  CORE_TOKEN_BUDGET,
  EXTENDED_MIN_CTX,
} from './system.js'
import { TOOLS, toOllamaTools, toolsForMode } from '../tools/registry.js'
import type { ProjectContext } from './context.js'

const CWD = '/home/dev/project'
const small = () => buildSystemPrompt(TOOLS, CWD, undefined, 4096)
const large = () => buildSystemPrompt(TOOLS, CWD, undefined, 32768)

describe('prompt budget', () => {
  it('holds the core tier under its token budget', () => {
    // The whole point of the tier split. If this fails the prompt has grown
    // back into the space the model needs for the user's actual files.
    expect(estimateTokens(small())).toBeLessThanOrEqual(CORE_TOKEN_BUDGET)
  })

  it('leaves the model most of a small window after tool schemas', () => {
    const overhead = estimateTokens(small()) + estimateTokens(JSON.stringify(toOllamaTools(TOOLS)))
    expect(overhead).toBeLessThan(4096 * 0.65)
  })

  it('does not repeat tool descriptions already carried by the schemas', () => {
    const prompt = large()
    for (const t of TOOLS) {
      expect(prompt, `${t.name} description duplicated in system prompt`)
        .not.toContain(t.description)
    }
  })

  it('still names every tool', () => {
    for (const t of TOOLS) expect(small()).toContain(t.name)
  })
})

describe('tiering', () => {
  it('sends core only on a window below the threshold', () => {
    expect(small()).not.toContain('# Task list')
    expect(small()).not.toContain('# Tone')
  })

  it('adds the extended layer on a roomy window', () => {
    const p = large()
    expect(p).toContain('# Task list')
    expect(p).toContain('# Verifying')
    expect(p).toContain('# Tone')
  })

  it('treats an unreported window as roomy', () => {
    expect(buildSystemPrompt(TOOLS, CWD)).toContain('# Task list')
  })

  it('switches exactly at the threshold', () => {
    expect(buildSystemPrompt(TOOLS, CWD, undefined, EXTENDED_MIN_CTX)).toContain('# Tone')
    expect(buildSystemPrompt(TOOLS, CWD, undefined, EXTENDED_MIN_CTX - 1)).not.toContain('# Tone')
  })

  it('keeps the extended layer strictly additive', () => {
    expect(large().startsWith(small())).toBe(true)
  })
})

describe('core carries the load-bearing rules at every size', () => {
  const mustHold = [
    ['tool-call channel', 'native function-calling interface'],
    ['read before write', 'Read a file before you change it'],
    ['targeted edits', 'edit_file'],
    ['scope discipline', 'Do only what was asked'],
    ['no unasked commits', 'Do not commit, push, or create branches unless'],
    ['secrets', 'Never print, log, or write secrets'],
    ['working directory', CWD],
  ] as const

  for (const [label, needle] of mustHold) {
    it(`keeps ${label}`, () => {
      expect(small()).toContain(needle)
      expect(large()).toContain(needle)
    })
  }
})

describe('project context', () => {
  const project: ProjectContext = {
    content: 'Always use tabs.',
    source: '/home/dev/project/MIII.md',
    truncated: false,
  }

  it('is included at every window size — it is the user speaking', () => {
    for (const ctx of [4096, 32768]) {
      const p = buildSystemPrompt(TOOLS, CWD, project, ctx)
      expect(p).toContain('Always use tabs.')
      expect(p).toContain('/home/dev/project/MIII.md')
    }
  })

  it('notes truncation with a real size', () => {
    const p = buildSystemPrompt(TOOLS, CWD, { ...project, truncated: true }, 32768)
    expect(p).toContain('32KB')
  })

  it('is omitted entirely when there is no file', () => {
    expect(buildSystemPrompt(TOOLS, CWD, { content: '', source: null, truncated: false }, 32768))
      .not.toContain('MIII.md')
  })
})

describe('resolved contradictions', () => {
  it('does not both grant and forbid a preamble', () => {
    expect(large()).not.toContain('ONE allowed preamble')
  })

  it('scopes read-before-write to the session, matching the loop guard', () => {
    // loop.ts tracks seenPaths for the whole run, not one turn — the prompt
    // must not promise something stricter than the harness enforces.
    expect(small()).toContain('read in this session')
    expect(small()).not.toContain('read first this turn')
  })

  it('does not order the model to interrogate the user before acting', () => {
    expect(large()).not.toContain('before touching any file')
  })

  it('does not tax every finished turn with a what-next question', () => {
    expect(large()).not.toContain('always close by asking')
  })
})

describe('plan mode', () => {
  const plan = (ctx = 4096) => buildSystemPrompt(toolsForMode('plan'), CWD, undefined, ctx, 'plan')

  it('is sent even on a cramped window', () => {
    // Plan mode changes what the model is *able* to do. A model that is not
    // told spends its turns calling write tools it does not have.
    expect(plan(4096)).toContain('Plan mode')
    expect(plan(4096)).toContain('exit_plan_mode')
  })

  it('still fits the core budget with the plan tier on top', () => {
    expect(estimateTokens(plan(4096))).toBeLessThanOrEqual(CORE_TOKEN_BUDGET)
  })

  it('names only the tools plan mode actually has', () => {
    const prompt = plan(32768)
    for (const t of toolsForMode('plan')) expect(prompt).toContain(t.name)
    // The withheld ones are named in the prose that explains their absence, so
    // check the tool list line itself rather than the whole prompt.
    const toolLine = prompt.split('\n').find((l) => l.includes('read_file, ')) ?? ''
    expect(toolLine).not.toContain('write_file')
    expect(toolLine).not.toContain('edit_file')
  })

  it('says nothing about planning in an ordinary session', () => {
    // exit_plan_mode is not offered outside plan mode; describing it anyway
    // invites the model to stall instead of doing the work.
    const normal = buildSystemPrompt(toolsForMode('default'), CWD, undefined, 32768)
    expect(normal).not.toContain('Plan mode')
    expect(normal).not.toContain('exit_plan_mode')
  })
})
