export type TaskPriority = 0 | 1 | 2 | 3;
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface MicroTask {
    id: string;
    priority: TaskPriority;
    tool: string;
    args: Record<string, unknown>;
    deps: string[];
    status: TaskStatus;
    result?: string;
    error?: string;
}
export interface MacroTask {
    id: string;
    goal: string;
    priority: number;
    microtasks: MicroTask[];
    status: TaskStatus;
    summary?: string;
}
