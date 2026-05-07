import { workerData, parentPort } from 'worker_threads';
import { createPatch, applyPatch } from 'diff';
const inp = workerData;
if (inp.action === 'diff') {
    const patch = createPatch(inp.filename ?? 'file', inp.oldContent ?? '', inp.newContent ?? '');
    parentPort?.postMessage({ patch });
}
else {
    const result = applyPatch(inp.oldContent ?? '', inp.patch ?? '');
    parentPort?.postMessage({ result: result === false ? null : result });
}
//# sourceMappingURL=diff.worker.js.map