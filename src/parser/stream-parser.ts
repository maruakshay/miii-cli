export interface ParsedText { type: 'text'; content: string }
export interface ParsedTool { type: 'tool_call'; content: string; toolName: string; toolArgs: Record<string, unknown> }
export type ParsedItem = ParsedText | ParsedTool

const OPEN = '<tool_call>'
const CLOSE = '</tool_call>'

export class StreamParser {
  private buf = ''
  private inTool = false

  feed(token: string): ParsedItem[] {
    this.buf += token
    const out: ParsedItem[] = []

    while (true) {
      if (this.inTool) {
        const end = this.buf.indexOf(CLOSE)
        if (end === -1) break
        const raw = this.buf.slice(0, end).trim()
        this.buf = this.buf.slice(end + CLOSE.length)
        this.inTool = false
        try {
          const obj = JSON.parse(raw) as { name: string; args?: Record<string, unknown> }
          out.push({ type: 'tool_call', content: raw, toolName: obj.name, toolArgs: obj.args ?? {} })
        } catch {
          out.push({ type: 'text', content: `${OPEN}${raw}${CLOSE}` })
        }
      } else {
        const start = this.buf.indexOf(OPEN)
        if (start === -1) {
          const safe = this.buf.length > OPEN.length ? this.buf.slice(0, -OPEN.length) : ''
          if (safe) { out.push({ type: 'text', content: safe }); this.buf = this.buf.slice(safe.length) }
          break
        }
        if (start > 0) {
          out.push({ type: 'text', content: this.buf.slice(0, start) })
          this.buf = this.buf.slice(start)
        }
        this.buf = this.buf.slice(OPEN.length)
        this.inTool = true
      }
    }
    return out
  }

  flush(): ParsedItem[] {
    const out: ParsedItem[] = []
    if (this.buf.trim()) out.push({ type: 'text', content: this.buf })
    this.buf = ''
    this.inTool = false
    return out
  }
}
