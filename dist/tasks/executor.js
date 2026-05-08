import { MicroQueue } from './queue.js';
export class TaskExecutor {
    toolMap;
    constructor(tools) {
        this.toolMap = new Map(tools.map(t => [t.name, t]));
    }
    async runMacro(macro, onProgress) {
        const queue = new MicroQueue();
        for (const t of macro.microtasks) {
            t.status = 'pending';
            queue.push(t);
        }
        return this.drain(queue, onProgress);
    }
    async drain(queue, onProgress) {
        const results = new Map();
        const allTasks = queue.toArray();
        while (queue.size > 0) {
            const ready = this._ready(allTasks, results);
            if (!ready.length)
                break;
            // Remove ready tasks from queue — rebuild without them
            const readyIds = new Set(ready.map(t => t.id));
            const remaining = queue.toArray().filter(t => !readyIds.has(t.id));
            // Clear and re-push remaining
            while (queue.pop()) { }
            for (const t of remaining)
                queue.push(t);
            // Execute by priority group
            const byPri = groupBy(ready, t => t.priority);
            for (const pri of [0, 1, 2, 3]) {
                const group = byPri.get(pri) ?? [];
                if (!group.length)
                    continue;
                if (pri === 1) {
                    // Reads run in parallel
                    await Promise.all(group.map(t => this._run(t, results, onProgress)));
                }
                else {
                    // Blocking (0), writes (2), verify (3) — sequential
                    for (const t of group) {
                        await this._run(t, results, onProgress);
                    }
                }
            }
        }
        return results;
    }
    _ready(all, results) {
        return all.filter(t => t.status === 'pending' &&
            t.deps.every(dep => {
                const dt = all.find(x => x.id === dep);
                return !dt || dt.status === 'done' || dt.status === 'skipped';
            }));
    }
    async _run(task, results, onProgress) {
        task.status = 'running';
        const tool = this.toolMap.get(task.tool);
        if (!tool) {
            task.status = 'failed';
            task.error = `unknown tool: ${task.tool}`;
            onProgress({ task, error: task.error });
            return;
        }
        try {
            const result = await tool.execute(task.args);
            task.status = 'done';
            task.result = result;
            results.set(task.id, result);
            onProgress({ task, result });
        }
        catch (e) {
            task.status = 'failed';
            task.error = String(e);
            onProgress({ task, error: task.error });
        }
    }
}
function groupBy(arr, key) {
    const m = new Map();
    for (const v of arr) {
        const k = key(v);
        const g = m.get(k) ?? [];
        g.push(v);
        m.set(k, g);
    }
    return m;
}
