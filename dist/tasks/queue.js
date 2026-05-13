// ─── MicroQueue — min-heap by priority, FIFO within same priority ────────────
export class MicroQueue {
    heap = [];
    seq = 0;
    order = new Map();
    push(task) {
        this.order.set(task.id, this.seq++);
        this.heap.push(task);
        this._up(this.heap.length - 1);
    }
    pop() {
        if (!this.heap.length)
            return undefined;
        const top = this.heap[0];
        this.order.delete(top.id);
        const last = this.heap.pop();
        if (this.heap.length) {
            this.heap[0] = last;
            this._down(0);
        }
        return top;
    }
    peek() { return this.heap[0]; }
    get size() { return this.heap.length; }
    toArray() { return [...this.heap]; }
    _cmp(a, b) {
        if (a.priority !== b.priority)
            return a.priority < b.priority;
        return (this.order.get(a.id) ?? 0) < (this.order.get(b.id) ?? 0);
    }
    _up(i) {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this._cmp(this.heap[i], this.heap[p])) {
                ;
                [this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]];
                i = p;
            }
            else
                break;
        }
    }
    _down(i) {
        const n = this.heap.length;
        while (true) {
            let min = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && this._cmp(this.heap[l], this.heap[min]))
                min = l;
            if (r < n && this._cmp(this.heap[r], this.heap[min]))
                min = r;
            if (min === i)
                break;
            [this.heap[i], this.heap[min]] = [this.heap[min], this.heap[i]];
            i = min;
        }
    }
}
// ─── MacroQueue — priority-sorted list of refactor goals ─────────────────────
export class MacroQueue {
    tasks = [];
    enqueue(task) {
        const i = this.tasks.findIndex(t => t.priority > task.priority);
        if (i === -1)
            this.tasks.push(task);
        else
            this.tasks.splice(i, 0, task);
    }
    dequeue() { return this.tasks.shift(); }
    peek() { return this.tasks[0]; }
    get size() { return this.tasks.length; }
    list() { return [...this.tasks]; }
}
