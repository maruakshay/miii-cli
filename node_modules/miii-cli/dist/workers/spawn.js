import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.some(a => a.includes('tsx')) || import.meta.url.endsWith('.ts');
const ext = isDev ? '.ts' : '.js';
export function spawnWorker(name, data) {
    return new Promise((resolve, reject) => {
        const path = join(__dir, `${name}.worker${ext}`);
        const w = new Worker(path, {
            workerData: data,
            execArgv: isDev ? ['--import', 'tsx/esm'] : [],
        });
        w.once('message', (r) => { w.terminate(); resolve(r); });
        w.once('error', (e) => { w.terminate(); reject(e); });
    });
}
//# sourceMappingURL=spawn.js.map