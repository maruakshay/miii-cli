import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const defaults = {
    model: 'llama3.2',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
};
const ALLOWED_KEYS = new Set(['model', 'provider', 'baseUrl', 'systemPrompt', 'apiKey', 'gitContext', 'tavilyApiKey']);
export function loadConfig() {
    const candidates = [
        join(process.cwd(), '.miii.json'),
        join(homedir(), '.config', 'miii', 'config.json'),
    ];
    for (const p of candidates) {
        if (existsSync(p)) {
            try {
                const raw = JSON.parse(readFileSync(p, 'utf-8'));
                const safe = {};
                for (const key of ALLOWED_KEYS) {
                    if (key in raw)
                        safe[key] = raw[key];
                }
                return { ...defaults, ...safe };
            }
            catch { }
        }
    }
    return { ...defaults };
}
