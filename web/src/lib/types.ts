/**
 * Wire types for the `miii web` API. The source of truth is src/web/session.ts;
 * these are copied rather than imported so the browser build never pulls in
 * the agent's Node-only modules.
 */
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypass'
export type Effort = 'low' | 'medium' | 'high'
export type Answer = 'yes' | 'no' | 'always'

export interface DiffLine { sign: '+' | '-' | ' '; oldNo: number | null; newNo: number | null; text: string }
export interface FileDiff { path: string; added: number; removed: number; hunks: Array<{ lines: DiffLine[] }>; truncated?: number }

export interface WebTool {
  id: string
  name: string
  input: Record<string, unknown>
  label: string
  technical: string
  result?: { content: string; is_error?: boolean; diff?: FileDiff }
}

export interface WebMessage {
  id: number
  role: 'user' | 'assistant' | 'notice'
  content: string
  thinking?: string
  tools?: WebTool[]
  images?: number
  /** On a user message: what `rewind` takes to drop back to before it. */
  turn?: number
  live?: boolean
  tokens?: { prompt: number; eval: number }
  duration?: number
}

export interface PendingPermission {
  id: number
  toolName: string
  input: unknown
  label: string
  /** Globs an "always" answer remembers, one per part of the command. */
  rules: string[]
  plan?: string
}

export interface WebState {
  cwd: string
  sessionId: string
  title: string
  busy: boolean
  status?: string
  mode: PermissionMode
  model?: string
  provider: string
  effort: Effort
  ctx: number | null
  usedTokens: number
  totals: { input: number; output: number; turns: number; ms: number }
  queued: string[]
  pending: PendingPermission | null
  error: string | null
}

export interface Checkpoint { turn: number; ts: string; files: string[] }
export interface SessionMeta { id: string; createdAt: string; updatedAt: string; title: string; messageCount: number }
export interface Command { name: string; description: string }
export interface ModeInfo { mode: PermissionMode; label: string; hint: string }
export interface ProviderInfo { name: string; kind: string; baseUrl: string; active: boolean }

export interface Hello {
  state: WebState
  messages: WebMessage[]
  sessions: SessionMeta[]
  commands: Command[]
  modes: ModeInfo[]
}
