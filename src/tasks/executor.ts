import type { MicroTask, MacroTask, TaskPriority } from './types.js'
import { MicroQueue } from './queue.js'
import type { Tool } from '../tools/index.js'

export interface ExecutorProgress {
  task: MicroTask
  result?: string
  error?: string
}

export class TaskExecutor {
  private toolMap: Map<string, Tool>

  constructor(tools: Tool[]) {
    this.toolMap = new Map(tools.map(t => [t.name, t]))
  }

  async runMacro(
    macro: MacroTask,
    onProgress: (p: ExecutorProgress) => void,
  ): Promise<Map<string, string>> {
    const queue = new MicroQueue()
    for (const t of macro.microtasks) {
      t.status = 'pending'
      queue.push(t)
    }
    return this.drain(queue, onProgress)
  }

  async drain(
    queue: MicroQueue,
    onProgress: (p: ExecutorProgress) => void,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>()
    const allTasks = queue.toArray()

    while (queue.size > 0) {
      const ready = this._ready(allTasks, results)
      if (!ready.length) break

      // Remove ready tasks from queue — rebuild without them
      const readyIds = new Set(ready.map(t => t.id))
      const remaining = queue.toArray().filter(t => !readyIds.has(t.id))
      // Clear and re-push remaining
      while (queue.pop()) {}
      for (const t of remaining) queue.push(t)

      // Execute by priority group
      const byPri = groupBy(ready, t => t.priority)

      for (const pri of [0, 1, 2, 3] as TaskPriority[]) {
        const group = byPri.get(pri) ?? []
        if (!group.length) continue

        if (pri === 1) {
          // Reads run in parallel
          await Promise.all(group.map(t => this._run(t, results, onProgress)))
        } else {
          // Blocking (0), writes (2), verify (3) — sequential
          for (const t of group) {
            await this._run(t, results, onProgress)
          }
        }
      }
    }

    return results
  }

  private _ready(all: MicroTask[], results: Map<string, string>): MicroTask[] {
    return all.filter(t =>
      t.status === 'pending' &&
      t.deps.every(dep => {
        const dt = all.find(x => x.id === dep)
        return !dt || dt.status === 'done' || dt.status === 'skipped'
      })
    )
  }

  private async _run(
    task: MicroTask,
    results: Map<string, string>,
    onProgress: (p: ExecutorProgress) => void,
  ): Promise<void> {
    task.status = 'running'
    const tool = this.toolMap.get(task.tool)

    if (!tool) {
      task.status = 'failed'
      task.error = `unknown tool: ${task.tool}`
      onProgress({ task, error: task.error })
      return
    }

    try {
      const result = await tool.execute(task.args)
      task.status = 'done'
      task.result = result
      results.set(task.id, result)
      onProgress({ task, result })
    } catch (e) {
      task.status = 'failed'
      task.error = String(e)
      onProgress({ task, error: task.error })
    }
  }
}

function groupBy<K, V>(arr: V[], key: (v: V) => K): Map<K, V[]> {
  const m = new Map<K, V[]>()
  for (const v of arr) {
    const k = key(v)
    const g = m.get(k) ?? []
    g.push(v)
    m.set(k, g)
  }
  return m
}
