import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const KEY_FILE = join(homedir(), '.config', 'miii', 'tavily.key')

export function getTavilyKey(): string | undefined {
  if (existsSync(KEY_FILE)) {
    const k = readFileSync(KEY_FILE, 'utf-8').trim()
    if (k) return k
  }
  return undefined
}

export function saveTavilyKey(key: string): void {
  mkdirSync(join(homedir(), '.config', 'miii'), { recursive: true })
  writeFileSync(KEY_FILE, key.trim(), { encoding: 'utf-8', mode: 0o600 })
}

interface SearchResult {
  title: string
  url: string
  content: string
  score: number
  published_date?: string
}

interface SearchResponse {
  answer?: string
  results: SearchResult[]
}

interface ExtractResult {
  url: string
  raw_content: string
  failed?: boolean
}

interface ExtractResponse {
  results: ExtractResult[]
  failed_results: ExtractResult[]
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.tavily.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Tavily API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export async function tavilySearch(opts: {
  apiKey: string
  query: string
  searchDepth?: 'basic' | 'advanced'
  maxResults?: number
  includeAnswer?: boolean
  includeDomains?: string[]
  excludeDomains?: string[]
}): Promise<string> {
  const data = await post<SearchResponse>('/search', {
    api_key: opts.apiKey,
    query: opts.query,
    search_depth: opts.searchDepth ?? 'basic',
    max_results: Math.min(opts.maxResults ?? 5, 10),
    include_answer: opts.includeAnswer ?? true,
    include_raw_content: false,
    include_domains: opts.includeDomains ?? [],
    exclude_domains: opts.excludeDomains ?? [],
  })

  const parts: string[] = []
  if (data.answer) parts.push(`Answer: ${data.answer}\n`)
  for (const r of data.results) {
    parts.push(`[${r.title}] ${r.url}\n${r.content}`)
  }
  return parts.join('\n\n').trim() || '(no results)'
}

export async function tavilyExtract(opts: {
  apiKey: string
  urls: string[]
}): Promise<string> {
  const data = await post<ExtractResponse>('/extract', {
    api_key: opts.apiKey,
    urls: opts.urls.slice(0, 20),
  })

  const parts: string[] = []
  for (const r of data.results) {
    const truncated = r.raw_content.length > 8000
      ? r.raw_content.slice(0, 8000) + '\n…[truncated at 8k]'
      : r.raw_content
    parts.push(`[${r.url}]\n${truncated}`)
  }
  if (data.failed_results?.length) {
    parts.push(`Failed URLs: ${data.failed_results.map(r => r.url).join(', ')}`)
  }
  return parts.join('\n\n---\n\n').trim() || '(no content extracted)'
}
