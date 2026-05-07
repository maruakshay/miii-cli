import { execSync, spawn } from 'child_process'

export interface OllamaModel {
  name: string
  size: number
  modified_at: string
  digest?: string
}

export async function listModels(baseUrl: string): Promise<OllamaModel[]> {
  const res = await fetch(`${baseUrl}/api/tags`)
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { models?: OllamaModel[] }
  return data.models ?? []
}

export async function pullModel(
  baseUrl: string,
  name: string,
  onProgress: (status: string, pct: number | undefined) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, stream: true }),
    signal,
  })
  if (!res.ok) throw new Error(`pull failed: ${res.status} ${await res.text()}`)

  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line) as { status?: string; completed?: number; total?: number }
          const pct = obj.total ? Math.round(((obj.completed ?? 0) / obj.total) * 100) : undefined
          onProgress(obj.status ?? '', pct)
        } catch {}
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function ensureOllama(baseUrl: string): Promise<void> {
  if (await isReachable(baseUrl)) return

  if (!isBinaryInstalled()) {
    process.stderr.write('\nOllama not found. Install it:\n\n')
    if (process.platform === 'darwin') {
      process.stderr.write('  brew install ollama\n')
      process.stderr.write('  — or download: https://ollama.ai/download\n')
    } else if (process.platform === 'linux') {
      process.stderr.write('  curl -fsSL https://ollama.ai/install.sh | sh\n')
    } else {
      process.stderr.write('  https://ollama.ai/download\n')
    }
    process.stderr.write('\nThen run: ollama serve\n\n')
    process.exit(1)
  }

  process.stderr.write('Ollama not running — starting ollama serve...\n')
  spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref()

  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await isReachable(baseUrl)) {
      process.stderr.write('Ollama ready.\n')
      return
    }
  }

  process.stderr.write('Could not start Ollama. Run manually: ollama serve\n')
  process.exit(1)
}

async function isReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

function isBinaryInstalled(): boolean {
  try {
    execSync(process.platform === 'win32' ? 'where ollama' : 'which ollama', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`
  return `${(bytes / 1e3).toFixed(0)}KB`
}
