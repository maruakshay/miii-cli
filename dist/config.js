import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const defaults = {
    model: 'llama3.2',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
};
const ALLOWED_KEYS = new Set(['model', 'provider', 'baseUrl', 'systemPrompt', 'apiKey', 'gitContext', 'streaming', 'tavilyApiKey', 'embedModel']);
const PROJECT_CONFIG = join(process.cwd(), '.miii.json');
const GLOBAL_CONFIG = join(homedir(), '.config', 'miii', 'config.json');
export function saveConfig(config) {
    mkdirSync(join(homedir(), '.config', 'miii'), { recursive: true });
    const existing = existsSync(GLOBAL_CONFIG)
        ? (() => { try {
            return JSON.parse(readFileSync(GLOBAL_CONFIG, 'utf-8'));
        }
        catch {
            return {};
        } })()
        : {};
    const merged = { ...existing };
    for (const key of ALLOWED_KEYS) {
        if (key in config)
            merged[key] = config[key];
    }
    writeFileSync(GLOBAL_CONFIG, JSON.stringify(merged, null, 2), { mode: 0o600 });
}
export function loadConfig() {
    const candidates = [PROJECT_CONFIG, GLOBAL_CONFIG];
    for (const p of candidates) {
        if (existsSync(p)) {
            try {
                const raw = JSON.parse(readFileSync(p, 'utf-8'));
                if (p === PROJECT_CONFIG && ('apiKey' in raw || 'tavilyApiKey' in raw)) {
                    process.stderr.write('Warning: API keys found in .miii.json — add .miii.json to .gitignore to avoid committing secrets\n');
                }
                const safe = {};
                for (const key of ALLOWED_KEYS) {
                    if (key in raw)
                        safe[key] = raw[key];
                }
                return { ...defaults, ...safe };
            }
            catch {
                process.stderr.write(`Warning: could not parse config at ${p} — using defaults\n`);
            }
        }
    }
    return { ...defaults };
}
