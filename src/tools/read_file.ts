import { readFileShell } from './shellFs.js'
import { confinePath } from './paths.js'
import { DEFAULT_NUM_CTX_CAP } from '../config.js'
import type { Tool } from './types.js'

interface Input {
  path: string
  offset?: number
  limit?: number
}

/** Left-pad a line number to width for stable, greppable columns. */
function numbered(lines: string[], start: number): string {
  const width = String(start + lines.length - 1).length
  return lines
    .map((l, i) => `${String(start + i).padStart(width, ' ')}\t${l}`)
    .join('\n')
}

// Raster formats a vision model can consume. SVG is intentionally excluded — it
// is text, so it falls through to the normal text path (and is more useful read
// as source anyway).
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
// Base64 roughly quadruples size and rides in the prompt; refuse oversized images
// rather than blow the context window.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

// One read may take this share of the context window. A whole large file sent
// inline overflows num_ctx; Ollama then silently drops the front of the prompt
// (system prompt, the request) and the model answers with nothing at all.
const READ_CTX_SHARE = 0.35
const CHARS_PER_TOKEN = 4
const HARD_MAX_CHARS = 200_000

/** Chars one read may inline, sized to the window this run actually negotiated. */
export function readBudget(numCtx?: number): number {
  const ctx = numCtx && numCtx > 0 ? numCtx : DEFAULT_NUM_CTX_CAP
  return Math.min(HARD_MAX_CHARS, Math.floor(ctx * READ_CTX_SHARE * CHARS_PER_TOKEN))
}

/** Sniff the leading magic bytes so an image with a wrong/missing extension is still caught. */
function looksImage(buf: Buffer): boolean {
  if (buf.length < 4) return false
  if (buf[0] === 0x89 && buf[1] === 0x50) return true // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49) return true // GIF
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true // BMP
  // WEBP: "RIFF"...."WEBP"
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true
  return false
}

export const read_file: Tool<Input> = {
  name: 'read_file',
  description:
    'Read file contents as UTF-8 text with line numbers. Use offset/limit to read a range of a large file instead of the whole thing.',
  input_schema: {
    type: 'object',
    properties: {
      path:   { type: 'string', description: 'File path' },
      offset: { type: 'number', description: '1-based line to start from (default 1)' },
      limit:  { type: 'number', description: 'Max lines to return (default all / capped)' },
    },
    required: ['path'],
  },
  handler: ({ path, offset, limit }, ctx) => {
    try {
      const maxChars = readBudget(ctx?.run?.num_ctx)
      const buf = readFileShell(confinePath(path))

      // Image: hand the raw pixels back as a base64 attachment for a vision model
      // rather than refusing it as binary. Extension OR magic bytes qualifies.
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      if (IMAGE_EXT.has(ext) || looksImage(buf)) {
        if (buf.length > MAX_IMAGE_BYTES) {
          return {
            content: `${path} is an image, but at ${buf.length} bytes it's too big to attach (limit is ${MAX_IMAGE_BYTES}). Resize it and try again.`,
            is_error: true,
          }
        }
        return {
          content: `[image ${path} — ${buf.length} bytes, attached for viewing]`,
          images: [buf.toString('base64')],
        }
      }

      // Refuse binary — NUL byte in the head is the cheap, reliable signal.
      if (buf.subarray(0, 8000).includes(0)) {
        return { content: `${path} looks like a binary file (${buf.length} bytes), so I'm not reading it as text.`, is_error: true }
      }
      // Normalize CRLF so the \r doesn't ride along on every numbered line.
      const raw = buf.toString('utf-8').replace(/\r\n/g, '\n')
      const allLines = raw.split('\n')
      const total = allLines.length

      const start = Math.max(1, Math.floor(offset ?? 1))
      const ranged = offset != null || limit != null
      const count = limit != null ? Math.max(0, Math.floor(limit)) : total
      const slice = allLines.slice(start - 1, start - 1 + count)

      // Cut on a line boundary so the model never sees half a line, and say
      // exactly where to resume rather than leaving it to guess.
      let shown = slice
      let used = 0
      for (let i = 0; i < slice.length; i++) {
        used += slice[i].length + 8
        if (used > maxChars) { shown = slice.slice(0, Math.max(1, i)); break }
      }
      let body = numbered(shown, start)
      if (body.length > maxChars) body = body.slice(0, maxChars)
      if (shown.length < slice.length) {
        const end = start - 1 + shown.length
        return {
          content:
            `${body}\n[Showing lines ${start}-${end} of ${total} — the file is too large to read whole ` +
            `within the context window. Continue with offset=${end + 1}, or use grep to find the part you need.]`,
        }
      }
      if (ranged) {
        const end = start - 1 + slice.length
        body += `\n[showing lines ${start}-${end} of ${total}]`
      }
      return { content: body }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), is_error: true }
    }
  },
}
