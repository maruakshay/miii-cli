import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
const SESSIONS_DIR = join(homedir(), '.config', 'miii', 'sessions');
function ensureDir() {
    mkdirSync(SESSIONS_DIR, { recursive: true });
}
export function listSessions() {
    ensureDir();
    return readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
        const name = f.replace('.json', '');
        const p = join(SESSIONS_DIR, f);
        let messageCount = 0;
        let updatedAt = 0;
        try {
            updatedAt = statSync(p).mtimeMs;
            const msgs = JSON.parse(readFileSync(p, 'utf-8'));
            messageCount = Array.isArray(msgs) ? msgs.length : 0;
        }
        catch { }
        return { name, messageCount, updatedAt };
    })
        .sort((a, b) => b.updatedAt - a.updatedAt);
}
export function loadSession(name) {
    ensureDir();
    const p = join(SESSIONS_DIR, `${name}.json`);
    if (!existsSync(p))
        return [];
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    }
    catch {
        return [];
    }
}
export function saveSession(name, messages) {
    ensureDir();
    writeFileSync(join(SESSIONS_DIR, `${name}.json`), JSON.stringify(messages));
}
export function deleteSession(name) {
    const p = join(SESSIONS_DIR, `${name}.json`);
    if (existsSync(p))
        unlinkSync(p);
}
//# sourceMappingURL=sessions.js.map