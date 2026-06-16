import { runScenario } from './runner.js'
import { scenarios } from './scenarios.js'
import { listModels } from '../src/llm/client.js'
import type { Result, Scenario } from './types.js'

// Usage (standalone or via `miii eval`):
//   [models] [scenarioNameSubstring]
//     models: comma list (gemma4:e4b,llama3.1:8b), or "all" for every
//             installed model, or omitted -> $MIII_EVAL_MODEL / "all".
//     scenarioNameSubstring: run only matching scenarios.
// Leading dashes are stripped, so `--gemma4:e4b` == `gemma4:e4b`.

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

async function resolveModels(modelsArg: string): Promise<string[]> {
  if (modelsArg !== 'all') return modelsArg.split(',').map((m) => m.trim()).filter(Boolean)
  // Skip cloud models by default — they're slow/billed and the harness targets
  // local models. Opt back in by naming them explicitly.
  return (await listModels()).filter((m) => !m.includes('cloud'))
}

/** Turn a pass-rate into a plain-language verdict for `miii doctor`. */
function verdict(passed: number, total: number): string {
  const ratio = total === 0 ? 0 : passed / total
  if (ratio === 1) return 'ready'
  if (ratio >= 0.5) return 'marginal — some tasks fail'
  return 'not recommended — weak tool-calling'
}

async function runModel(model: string, picked: Scenario[]): Promise<Result[]> {
  console.log(`\n=== ${model} ===`)
  const results: Result[] = []
  // Sequential — runner chdirs the process; concurrency would corrupt cwd.
  for (const s of picked) {
    const r = await runScenario(model, s)
    results.push(r)
    const mark = r.pass ? 'PASS' : 'FAIL'
    const detail = r.pass ? '' : `  ${r.reason ?? r.error ?? ''}`
    console.log(
      `${mark}  ${pad(r.name, 22)} ${pad(`${r.toolCalls} calls`, 9)} ` +
        `${pad(`${r.evalTokens} tok`, 11)} ${pad(`${r.durationMs}ms`, 8)}${detail}`,
    )
  }
  const passed = results.filter((r) => r.pass).length
  console.log(`  → ${model}: ${passed}/${picked.length} — ${verdict(passed, picked.length)}`)
  return results
}

function printMatrix(models: string[], picked: Scenario[], grid: Map<string, Result[]>) {
  const w = Math.max(...picked.map((s) => s.name.length), 3) + 1
  const modelW = Math.max(...models.map((m) => m.length), 5) + 1
  // Header row: scenario names.
  console.log('\nMatrix\n')
  let header = pad('', modelW)
  for (const s of picked) header += pad(s.name.slice(0, w - 1), w)
  console.log(header + ' score')
  for (const m of models) {
    let row = pad(m, modelW)
    const rs = grid.get(m) ?? []
    let passed = 0
    for (const s of picked) {
      const r = rs.find((x) => x.name === s.name)
      const cell = !r ? '?' : r.pass ? '+' : '.'
      if (r?.pass) passed++
      row += pad(cell, w)
    }
    row += ` ${passed}/${picked.length}`
    console.log(row)
  }
  console.log('\n  + pass   . fail   ? not run')
}

/** Run the eval suite. `args` = [models?, scenarioFilter?]; returns exit code. */
export async function runEval(args: string[]): Promise<number> {
  const strip = (s: string | undefined) => (s ?? '').replace(/^-+/, '')
  const modelsArg = strip(args[0]) || process.env.MIII_EVAL_MODEL || 'all'
  const filter = strip(args[1])

  const picked = filter ? scenarios.filter((s) => s.name.includes(filter)) : scenarios
  if (picked.length === 0) {
    console.error(`No scenarios match "${filter}"`)
    return 1
  }
  const models = await resolveModels(modelsArg)
  if (models.length === 0) {
    console.error('No models to run.')
    return 1
  }

  console.log(`models: ${models.length}   scenarios: ${picked.length}`)
  const grid = new Map<string, Result[]>()
  for (const model of models) grid.set(model, await runModel(model, picked))

  if (models.length > 1) printMatrix(models, picked, grid)

  // Non-zero if any model failed any scenario — useful for CI gating.
  const allPass = [...grid.values()].every((rs) => rs.every((r) => r.pass))
  return allPass ? 0 : 1
}
