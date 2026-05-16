import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { createDir, moveFile, writeFile, guardPath } from '../files/ops.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const run = promisify(exec)
export const MIII_HOME = join(homedir(), '.config', 'miii')
const NPM_SKILLS_DIR = MIII_HOME

export interface SkillContext {
  messages: Array<{ role: string; content: string }>
  appendMessage: (role: string, content: string) => void
  setSystemPrompt: (p: string) => void
  getSystemPrompt: () => string
}

export interface Skill {
  name: string
  ns: string
  description: string
  prompt?: string
  execute?: (args: string, ctx: SkillContext) => string | Promise<string>
}

const builtin: Skill[] = [
  {
    name: 'caveman',
    ns: 'caveman',
    description: 'Ultra-compressed terse mode',
    execute: (_, ctx) => {
      const cur = ctx.getSystemPrompt()
      ctx.setSystemPrompt(cur + '\n\nRespond ultra-compressed. Drop articles, filler, pleasantries, hedging. Fragments OK. Technical terms exact.')
      return 'Caveman mode active.'
    },
  },
  {
    name: 'normal',
    ns: 'caveman',
    description: 'Revert to normal tone',
    execute: (_, ctx) => {
      const cur = ctx.getSystemPrompt()
      ctx.setSystemPrompt(cur.replace(/\n\nRespond ultra-compressed.*$/s, ''))
      return 'Normal mode.'
    },
  },
  {
    name: 'review',
    ns: 'default',
    description: 'Review codebase for bugs/security/quality',
    prompt: 'Review the code in this project. Look for bugs, security issues, performance problems, and quality issues. Be specific and actionable. List findings grouped by severity.',
  },
  {
    name: 'help',
    ns: 'default',
    description: 'Show available commands',
    execute: (_, ctx) => {
      return 'Built-in: /review /mkdir /mv /touch /models /sessions /session /clear /list /help\nType /list for all loaded skills.'
    },
  },
  {
    name: 'list',
    ns: 'default',
    description: 'List all skills',
    execute: () => '',  // handled dynamically in loader.list()
  },
  {
    name: 'models',
    ns: 'default',
    description: 'Choose or pull Ollama models',
    // execute handled specially in InputBar before skill lookup
  },
  {
    name: 'mkdir',
    ns: 'default',
    description: 'Create a folder — usage: /mkdir <path>',
    execute: (args) => {
      const p = args.trim()
      if (!p) return 'Usage: /mkdir <path>'
      createDir(guardPath(p))
      return `created: ${p}`
    },
  },
  {
    name: 'mv',
    ns: 'default',
    description: 'Move or rename file/folder — usage: /mv <from> <to>',
    execute: (args) => {
      const parts = args.trim().split(/\s+/)
      if (parts.length < 2) return 'Usage: /mv <from> <to>'
      const [from, to] = parts
      moveFile(guardPath(from), guardPath(to))
      return `moved: ${from} → ${to}`
    },
  },
  {
    name: 'test',
    ns: 'builtin',
    description: 'Run test suite — usage: /test [path]',
  },
  {
    name: 'touch',
    ns: 'default',
    description: 'Create empty file — usage: /touch <path>',
    execute: (args) => {
      const p = args.trim()
      if (!p) return 'Usage: /touch <path>'
      writeFile(guardPath(p), '')
      return `created: ${p}`
    },
  },
]

export class SkillLoader {
  private map = new Map<string, Skill>()

  constructor() {
    for (const s of builtin) {
      this.map.set(`${s.ns}:${s.name}`, s)
      this.map.set(s.name, s)
    }
  }

  async loadAll(): Promise<void> {
    // 1. Markdown skills from ~/.config/miii/skills/ and .miii/skills/
    const dirs = [
      join(homedir(), '.config', 'miii', 'skills'),
      join(process.cwd(), '.miii', 'skills'),
    ]
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.md')) continue
        const name = basename(entry, '.md')
        const content = readFileSync(join(dir, entry), 'utf-8')
        const skill: Skill = {
          name,
          ns: 'custom',
          description: content.split('\n')[0].replace(/^#+\s*/, '').trim(),
          prompt: content,
        }
        this.map.set(name, skill)
        this.map.set(`custom:${name}`, skill)
      }
    }

    // 2. npm skill packages: miii-skill-* installed in ~/.config/miii/node_modules/
    const nmDir = join(NPM_SKILLS_DIR, 'node_modules')
    if (existsSync(nmDir)) {
      for (const pkg of readdirSync(nmDir)) {
        if (!pkg.startsWith('miii-skill-')) continue
        const pkgDir = join(nmDir, pkg)
        try {
          const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'))
          const main = pkgJson.main ?? 'index.js'
          const entry = join(pkgDir, main)
          if (!existsSync(entry)) continue
          const mod = await import(entry)
          const exported: Skill | Skill[] = mod.default ?? mod.skill ?? mod.skills
          const skillList: Skill[] = Array.isArray(exported) ? exported : [exported]
          for (const s of skillList) {
            if (!s?.name || !s?.description) continue
            const ns = s.ns ?? 'npm'
            const skill: Skill = { ...s, ns }
            this.map.set(s.name, skill)
            this.map.set(`${ns}:${s.name}`, skill)
          }
        } catch {}
      }
    }
  }

  async installSkill(nameOrPkg: string): Promise<string> {
    const pkg = nameOrPkg.includes('/') || nameOrPkg.startsWith('miii-skill-')
      ? nameOrPkg
      : `miii-skill-${nameOrPkg}`
    createDir(NPM_SKILLS_DIR)
    const { stdout, stderr } = await run(`npm install --prefix ${JSON.stringify(NPM_SKILLS_DIR)} ${pkg}`)
    const out = (stdout + stderr).trim()
    // Reload newly installed skill
    await this.loadAll()
    return `installed ${pkg}\n${out}`
  }

  async uninstallSkill(nameOrPkg: string): Promise<string> {
    const pkg = nameOrPkg.includes('/') || nameOrPkg.startsWith('miii-skill-')
      ? nameOrPkg
      : `miii-skill-${nameOrPkg}`
    const { stdout, stderr } = await run(`npm uninstall --prefix ${JSON.stringify(NPM_SKILLS_DIR)} ${pkg}`)
    const out = (stdout + stderr).trim()
    // Remove from map
    const shortName = pkg.replace(/^miii-skill-/, '')
    this.map.delete(shortName)
    this.map.delete(`npm:${shortName}`)
    this.map.delete(pkg)
    return `uninstalled ${pkg}\n${out}`
  }

  listNpmSkills(): string[] {
    const nmDir = join(NPM_SKILLS_DIR, 'node_modules')
    if (!existsSync(nmDir)) return []
    return readdirSync(nmDir).filter(p => p.startsWith('miii-skill-'))
  }

  get(ref: string): Skill | undefined {
    return this.map.get(ref)
  }

  list(): Skill[] {
    return [...new Set(this.map.values())]
  }
}
