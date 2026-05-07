#!/usr/bin/env node
// Minimal entry — heavy imports lazy-loaded
async function main() {
  const { lazyInit } = await import('./init.js')
  await lazyInit()
}

main().catch(err => {
  process.stderr.write(`fatal: ${err.message}\n`)
  process.exit(1)
})
