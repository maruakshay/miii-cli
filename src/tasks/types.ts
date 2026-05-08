export type TaskPriority = 0 | 1 | 2 | 3
// 0 = blocking dep  1 = read/gather  2 = write/apply  3 = verify

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface MicroTask {
  id: string
  priority: TaskPriority
  tool: string
  args: Record<string, unknown>
  deps: string[]       // micro task IDs that must be 'done' before this runs
  status: TaskStatus
  result?: string
  error?: string
}

export interface MacroTask {
  id: string
  goal: string
  priority: number     // lower = higher priority in MacroQueue
  microtasks: MicroTask[]
  status: TaskStatus
  summary?: string     // compacted summary of completed work
}
