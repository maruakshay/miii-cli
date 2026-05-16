import { readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, statSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
const PROJECTS_DIR = join(homedir(), '.config', 'miii', 'projects');
export function getProjectDir(cwd) {
    const slug = cwd.replace(/\//g, '-').replace(/^-/, '').replace(/[^a-zA-Z0-9_.-]/g, '-') || 'default';
    return join(PROJECTS_DIR, slug);
}
function sessionsDir(projectDir) {
    return join(projectDir, 'sessions');
}
function ensureProjectDir(projectDir) {
    mkdirSync(sessionsDir(projectDir), { recursive: true, mode: 0o700 });
    chmodSync(projectDir, 0o700);
}
function sanitizeName(name) {
    if (!/^[\w-]+$/.test(name))
        throw new Error(`invalid session name: ${name}`);
    return name;
}
export function listSessions(projectDir) {
    ensureProjectDir(projectDir);
    const dir = sessionsDir(projectDir);
    return readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
        const name = f.replace('.json', '');
        const p = join(dir, f);
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
export function loadSession(projectDir, name) {
    ensureProjectDir(projectDir);
    const p = join(sessionsDir(projectDir), `${sanitizeName(name)}.json`);
    if (!existsSync(p))
        return [];
    try {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        process.stderr.write(`Warning: corrupt session file at ${p} — starting fresh\n`);
        return [];
    }
}
export function saveSession(projectDir, name, messages) {
    const safeName = sanitizeName(name);
    ensureProjectDir(projectDir);
    try {
        writeFileSync(join(sessionsDir(projectDir), `${safeName}.json`), JSON.stringify(messages), { mode: 0o600 });
    }
    catch { }
}
export function deleteSession(projectDir, name) {
    const p = join(sessionsDir(projectDir), `${sanitizeName(name)}.json`);
    if (existsSync(p))
        unlinkSync(p);
}
export function deleteAllSessions(projectDir, exceptName) {
    ensureProjectDir(projectDir);
    const dir = sessionsDir(projectDir);
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    let count = 0;
    for (const f of files) {
        const name = f.replace('.json', '');
        if (exceptName && name === exceptName)
            continue;
        try {
            unlinkSync(join(dir, f));
            count++;
        }
        catch { }
    }
    return count;
}
