import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { expandCommand, parseFrontmatter } from './custom.js'

const root = mkdtempSync(join(tmpdir(), 'miii-cmds-'))
const home = join(root, 'home')
const project = join(root, 'project')
for (const d of [home, project]) mkdirSync(d, { recursive: true })

const originalHome = process.env.HOME
process.env.HOME = home
// Imported after HOME is redirected: the user-scope directory is resolved from
// it, and a module loaded first would look in the real home directory.
const { loadCustomCommands } = await import('./custom.js')

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(root, { recursive: true, force: true })
})

function write(base: string, name: string, body: string) {
  const dir = join(base, '.miii', 'commands')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body, 'utf-8')
}

beforeEach(() => {
  for (const d of [home, project]) rmSync(join(d, '.miii'), { recursive: true, force: true })
})

describe('loadCustomCommands', () => {
  it('turns a Markdown file into a command named after it', () => {
    write(project, 'review.md', 'Review the staged diff.')
    const [cmd] = loadCustomCommands(project)
    expect(cmd.name).toBe('/review')
    expect(cmd.body).toBe('Review the staged diff.')
    expect(cmd.scope).toBe('project')
  })

  it('reads the description out of frontmatter, and summarises without it', () => {
    write(project, 'a.md', '---\ndescription: check the tests\n---\nRun the suite.')
    write(project, 'b.md', '# Ship it\n\nDo the release.')
    const byName = Object.fromEntries(loadCustomCommands(project).map((c) => [c.name, c]))
    expect(byName['/a'].description).toBe('check the tests')
    expect(byName['/a'].body).toBe('Run the suite.')
    // No frontmatter: the first line stands in, with its heading marker gone.
    expect(byName['/b'].description).toBe('Ship it')
  })

  it('lets a project command shadow a user command of the same name', () => {
    write(home, 'review.md', 'user version')
    write(project, 'review.md', 'project version')
    const found = loadCustomCommands(project).filter((c) => c.name === '/review')
    expect(found).toHaveLength(1)
    expect(found[0].body).toBe('project version')
    expect(found[0].scope).toBe('project')
  })

  it('finds user commands when the project has none', () => {
    write(home, 'standup.md', 'Summarise yesterday.')
    const [cmd] = loadCustomCommands(project)
    expect(cmd.name).toBe('/standup')
    expect(cmd.scope).toBe('user')
  })

  it('skips files that cannot be a command', () => {
    write(project, 'notes.txt', 'not markdown')
    write(project, 'bad name.md', 'has a space')
    write(project, 'empty.md', '   \n  ')
    write(project, 'ok.md', 'fine')
    expect(loadCustomCommands(project).map((c) => c.name)).toEqual(['/ok'])
  })

  it('returns nothing when there is no commands directory', () => {
    expect(loadCustomCommands(project)).toEqual([])
  })
})

describe('parseFrontmatter', () => {
  it('leaves a body with no frontmatter alone', () => {
    expect(parseFrontmatter('just a prompt')).toEqual({ body: 'just a prompt' })
  })

  it('treats an unterminated block as body, not frontmatter', () => {
    const { body, description } = parseFrontmatter('---\ndescription: x\nstill going')
    expect(description).toBeUndefined()
    expect(body).toContain('still going')
  })

  it('strips quotes from the description', () => {
    expect(parseFrontmatter('---\ndescription: "quoted"\n---\nbody').description).toBe('quoted')
  })
})

describe('expandCommand', () => {
  it('substitutes $ARGUMENTS', () => {
    expect(expandCommand('Review $ARGUMENTS please', 'src/a.ts')).toBe('Review src/a.ts please')
  })

  it('substitutes positional words', () => {
    expect(expandCommand('move $1 to $2', ' a.ts b.ts ')).toBe('move a.ts to b.ts')
  })

  it('empties an unfilled positional rather than leaving it as text', () => {
    // A literal "$2" left in the prompt is something the model tries to
    // interpret; an absent argument should simply be absent.
    expect(expandCommand('check $1 and $2', 'a.ts')).toBe('check a.ts and')
  })

  it('appends arguments a body never references, instead of dropping them', () => {
    expect(expandCommand('Review the diff.', 'focus on auth')).toBe('Review the diff.\n\nfocus on auth')
  })

  it('leaves a body alone when nothing was typed after the command', () => {
    expect(expandCommand('Review the diff.', '')).toBe('Review the diff.')
    expect(expandCommand('Review $ARGUMENTS.', '')).toBe('Review .')
  })
})
