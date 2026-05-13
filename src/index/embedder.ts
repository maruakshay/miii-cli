export async function embed(baseUrl: string, model: string, text: string): Promise<number[]> {
  // Try newer /api/embed endpoint first, fall back to /api/embeddings
  try {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    })
    if (res.ok) {
      const obj = await res.json() as { embeddings?: number[][]; embedding?: number[] }
      const vec = obj.embeddings?.[0] ?? obj.embedding
      if (vec?.length) return vec
    }
  } catch {}

  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  })
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`)
  const obj = await res.json() as { embedding: number[] }
  if (!obj.embedding?.length) throw new Error('empty embedding response')
  return obj.embedding
}
