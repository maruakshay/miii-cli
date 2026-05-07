import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const defaults = {
    model: 'llama3.2',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
};
export function loadConfig() {
    const candidates = [
        join(process.cwd(), '.miii.json'),
        join(homedir(), '.config', 'miii', 'config.json'),
    ];
    for (const p of candidates) {
        if (existsSync(p)) {
            try {
                return { ...defaults, ...JSON.parse(readFileSync(p, 'utf-8')) };
            }
            catch { }
        }
    }
    return { ...defaults };
}
//# sourceMappingURL=config.js.map