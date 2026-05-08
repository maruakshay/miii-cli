import type { MicroTask, MacroTask } from './types.js';
export declare class MicroQueue {
    private heap;
    private seq;
    private order;
    push(task: MicroTask): void;
    pop(): MicroTask | undefined;
    peek(): MicroTask | undefined;
    get size(): number;
    toArray(): MicroTask[];
    private _cmp;
    private _up;
    private _down;
}
export declare class MacroQueue {
    private tasks;
    enqueue(task: MacroTask): void;
    dequeue(): MacroTask | undefined;
    peek(): MacroTask | undefined;
    get size(): number;
    list(): MacroTask[];
}
