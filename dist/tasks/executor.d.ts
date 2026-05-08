import type { MicroTask, MacroTask } from './types.js';
import { MicroQueue } from './queue.js';
import type { Tool } from '../tools/index.js';
export interface ExecutorProgress {
    task: MicroTask;
    result?: string;
    error?: string;
}
export declare class TaskExecutor {
    private toolMap;
    constructor(tools: Tool[]);
    runMacro(macro: MacroTask, onProgress: (p: ExecutorProgress) => void): Promise<Map<string, string>>;
    drain(queue: MicroQueue, onProgress: (p: ExecutorProgress) => void): Promise<Map<string, string>>;
    private _ready;
    private _run;
}
