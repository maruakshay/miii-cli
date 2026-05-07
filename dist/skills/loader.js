import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
const builtin = [
    {
        name: 'caveman',
        ns: 'caveman',
        description: 'Ultra-compressed terse mode',
        execute: (_, ctx) => {
            const cur = ctx.getSystemPrompt();
            ctx.setSystemPrompt(cur + '\n\nRespond ultra-compressed. Drop articles, filler, pleasantries, hedging. Fragments OK. Technical terms exact.');
            return 'Caveman mode active.';
        },
    },
    {
        name: 'normal',
        ns: 'caveman',
        description: 'Revert to normal tone',
        execute: (_, ctx) => {
            const cur = ctx.getSystemPrompt();
            ctx.setSystemPrompt(cur.replace(/\n\nRespond ultra-compressed.*$/s, ''));
            return 'Normal mode.';
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
            return 'Built-in skills: /caveman:caveman /caveman:normal /review /help\nType /list for all loaded skills.';
        },
    },
    {
        name: 'list',
        ns: 'default',
        description: 'List all skills',
        execute: () => '', // handled dynamically in loader.list()
    },
    {
        name: 'models',
        ns: 'default',
        description: 'Choose or pull Ollama models',
        // execute handled specially in App.tsx before skill lookup
    },
];
export class SkillLoader {
    map = new Map();
    constructor() {
        for (const s of builtin) {
            this.map.set(`${s.ns}:${s.name}`, s);
            this.map.set(s.name, s);
        }
    }
    async loadAll() {
        const dirs = [
            join(homedir(), '.config', 'miii', 'skills'),
            join(process.cwd(), '.miii', 'skills'),
        ];
        for (const dir of dirs) {
            if (!existsSync(dir))
                continue;
            for (const entry of readdirSync(dir)) {
                if (!entry.endsWith('.md'))
                    continue;
                const name = basename(entry, '.md');
                const content = readFileSync(join(dir, entry), 'utf-8');
                const skill = {
                    name,
                    ns: 'custom',
                    description: content.split('\n')[0].replace(/^#+\s*/, '').trim(),
                    prompt: content,
                };
                this.map.set(name, skill);
                this.map.set(`custom:${name}`, skill);
            }
        }
    }
    get(ref) {
        return this.map.get(ref);
    }
    list() {
        return [...new Set(this.map.values())];
    }
}
//# sourceMappingURL=loader.js.map