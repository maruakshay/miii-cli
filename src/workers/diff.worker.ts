import { workerData, parentPort } from 'worker_threads'
import { createPatch, applyPatch } from 'diff'

interface Input {
  action: 'diff' | 'apply'
  filename?: string
  oldContent?: string
  newContent?: string
  patch?: string
}

const inp = workerData as Input

if (inp.action === 'diff') {
  const patch = createPatch(inp.filename ?? 'file', inp.oldContent ?? '', inp.newContent ?? '')
  parentPort?.postMessage({ patch })
} else {
  const result = applyPatch(inp.oldContent ?? '', inp.patch ?? '')
  parentPort?.postMessage({ result: result === false ? null : result })
}
