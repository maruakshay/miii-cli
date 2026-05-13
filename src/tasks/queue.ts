import type { MicroTask, MacroTask } from './types.js'

// ─── MicroQueue — min-heap by priority, FIFO within same priority ────────────

export class MicroQueue {
  private heap: MicroTask[] = []
  private seq = 0
  private order = new Map<string, number>()

  push(task: MicroTask): void {
    this.order.set(task.id, this.seq++)
    this.heap.push(task)
    this._up(this.heap.length - 1)
  }

  pop(): MicroTask | undefined {
    if (!this.heap.length) return undefined
    const top = this.heap[0]
    this.order.delete(top.id)
    const last = this.heap.pop()!
    if (this.heap.length) {
      this.heap[0] = last
      this._down(0)
    }
    return top
  }

  peek(): MicroTask | undefined { return this.heap[0] }

  get size(): number { return this.heap.length }

  toArray(): MicroTask[] { return [...this.heap] }

  private _cmp(a: MicroTask, b: MicroTask): boolean {
    if (a.priority !== b.priority) return a.priority < b.priority
    return (this.order.get(a.id) ?? 0) < (this.order.get(b.id) ?? 0)
  }

  private _up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this._cmp(this.heap[i], this.heap[p])) {
        ;[this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]]
        i = p
      } else break
    }
  }

  private _down(i: number): void {
    const n = this.heap.length
    while (true) {
      let min = i
      const l = 2 * i + 1, r = 2 * i + 2
      if (l < n && this._cmp(this.heap[l], this.heap[min])) min = l
      if (r < n && this._cmp(this.heap[r], this.heap[min])) min = r
      if (min === i) break
      ;[this.heap[i], this.heap[min]] = [this.heap[min], this.heap[i]]
      i = min
    }
  }
}

// ─── MacroQueue — priority-sorted list of refactor goals ─────────────────────

export class MacroQueue {
  private tasks: MacroTask[] = []

  enqueue(task: MacroTask): void {
    const i = this.tasks.findIndex(t => t.priority > task.priority)
    if (i === -1) this.tasks.push(task)
    else this.tasks.splice(i, 0, task)
  }

  dequeue(): MacroTask | undefined { return this.tasks.shift() }

  peek(): MacroTask | undefined { return this.tasks[0] }

  get size(): number { return this.tasks.length }

  list(): MacroTask[] { return [...this.tasks] }
}
