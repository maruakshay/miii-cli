/**
 * Rule scoping, against a real filesystem.
 *
 * These tests exist because the thing being verified is *where* a rule lands,
 * and a mocked fs would only prove the mock. HOME and cwd are redirected into a
 * temp tree before policy.js is imported — the user-scope path is resolved at
 * module load, so the override has to happen first.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const root = mkdtempSync(join(tmpdir(), 'miii-scope-'))
const home = join(root, 'home')
const project = join(root, 'project')
const other = join(root, 'other')
for (const d of [home, project, other]) mkdirSync(d, { recursive: true })

const originalHome = process.env.HOME
const originalCwd = process.cwd()
process.env.HOME = home
process.chdir(project)

const { loadRules, loadScopedRules, addRules, check } = await import('./policy.js')

afterAll(() => {
  process.chdir(originalCwd)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(root, { recursive: true, force: true })
})

function reset() {
  for (const d of [home, project, other]) {
    rmSync(join(d, '.miii'), { recursive: true, force: true })
  }
  process.chdir(project)
}

/** Write a rules file directly, the way a user hand-editing one would. */
function seed(dir: string, rules: Array<{ tool: string; pattern: string }>) {
  mkdirSync(join(dir, '.miii'), { recursive: true })
  writeFileSync(join(dir, '.miii', 'permissions.json'), JSON.stringify({ rules }), 'utf-8')
}

beforeEach(reset)

describe('rule scopes', () => {
  it('writes "always" into the project, not the home directory', () => {
    addRules('run_bash', ['npm test'])
    expect(existsSync(join(project, '.miii', 'permissions.json'))).toBe(true)
    expect(existsSync(join(home, '.miii', 'permissions.json'))).toBe(false)
  })

  it('does not carry a project rule into another project', () => {
    // The reason project scope is the default: a path subject is relative, so a
    // globally stored "src/index.ts" would pre-approve that path in every repo.
    addRules('write_file', ['src/index.ts'])
    expect(loadRules()).toHaveLength(1)
    process.chdir(other)
    expect(loadRules()).toHaveLength(0)
  })

  it('applies a user-scope rule in every project', () => {
    addRules('run_bash', ['git status'], 'user')
    expect(loadScopedRules('user')).toHaveLength(1)
    expect(loadScopedRules('project')).toHaveLength(0)
    process.chdir(other)
    expect(loadRules().map((r) => r.pattern)).toEqual(['git status'])
  })

  it('merges both scopes, project first', () => {
    seed(home, [{ tool: 'run_bash', pattern: 'git status' }])
    seed(project, [{ tool: 'run_bash', pattern: 'npm test' }])
    expect(loadRules().map((r) => r.pattern)).toEqual(['npm test', 'git status'])
  })

  it('does not duplicate a pattern already granted user-wide', () => {
    addRules('run_bash', ['npm test'], 'user')
    addRules('run_bash', ['npm test'])
    expect(loadScopedRules('project')).toHaveLength(0)
  })

  it('survives a corrupt or partial rules file rather than throwing', () => {
    mkdirSync(join(project, '.miii'), { recursive: true })
    writeFileSync(join(project, '.miii', 'permissions.json'), '{not json', 'utf-8')
    expect(loadRules()).toEqual([])
    // And a well-formed file with junk entries keeps only the usable ones.
    seed(project, [{ tool: 'run_bash', pattern: 'ls' }, { tool: '', pattern: '' }])
    expect(loadRules()).toHaveLength(1)
  })

  it('auto-allows a call a stored rule covers, without prompting', async () => {
    seed(project, [{ tool: 'run_bash', pattern: 'npm test *' }])
    const never = async () => { throw new Error('should not have prompted') }
    expect(await check('run_bash', { command: 'npm test src/a' }, { ask: never })).toBe('allow')
  })

  it('persists both the exact command and its glob on "always"', async () => {
    const decision = await check('run_bash', { command: 'npm run build' }, { ask: async () => 'always' })
    expect(decision).toBe('allow')
    const saved = JSON.parse(readFileSync(join(project, '.miii', 'permissions.json'), 'utf-8'))
    expect(saved.rules.map((r: { pattern: string }) => r.pattern)).toEqual(['npm run build', 'npm run *'])
  })
})
